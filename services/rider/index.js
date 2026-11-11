// Rider service: a rider goes online, receives offers, accepts/rejects, starts and completes trips.
const { pool, inTransaction, queryOne } = require('./shared/database');
const { HttpError, asyncHandler, requireAuth, createApp } = require('./shared/http');
const { enqueueEvent, subscribeToEvents } = require('./shared/messaging');
const { startService } = require('./shared/service');
const { isValidCoordinate } = require('./shared/geo');
const { ROLES, RIDER_STATUS, EVENTS } = require('./shared/constants');

const app = createApp('rider');
const onlyRiders = requireAuth(ROLES.RIDER);

/**
 * Every action below changes the rider's row AND records an outbox event in one transaction.
 */
const conflict = (message) => new HttpError(409, message);

app.post('/online', onlyRiders, asyncHandler(async (req, res) => {
  const location = { lat: Number(req.body.lat), lng: Number(req.body.lng) };
  if (!isValidCoordinate(location)) throw new HttpError(400, 'Valid lat/lng required');

  const rider = await inTransaction(async (db) => {
    const saved = await queryOne(db,
      `INSERT INTO riders.riders AS rider(id, name, lat, lng, status) VALUES($1, $2, $3, $4, '${RIDER_STATUS.AVAILABLE}')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name,
         lat = CASE WHEN rider.status = '${RIDER_STATUS.AVAILABLE}' THEN EXCLUDED.lat ELSE rider.lat END,
         lng = CASE WHEN rider.status = '${RIDER_STATUS.AVAILABLE}' THEN EXCLUDED.lng ELSE rider.lng END
       RETURNING *`, [req.user.id, req.user.name, location.lat, location.lng]);
    await enqueueEvent(db, EVENTS.RIDER_WENT_ONLINE, { riderId: req.user.id, name: req.user.name, ...location });
    return saved;
  });
  res.json(rider);
}));

app.get('/me', onlyRiders, asyncHandler(async (req, res) => {
  const rider = await queryOne(pool, 'SELECT * FROM riders.riders WHERE id = $1', [req.user.id]);
  res.json(rider || { status: 'OFFLINE' });
}));

app.post('/offer/accept', onlyRiders, asyncHandler(async (req, res) => {
  const rider = await inTransaction(async (db) => {
    const accepted = await queryOne(db,
      `UPDATE riders.riders SET status = '${RIDER_STATUS.BUSY}' WHERE id = $1 AND status = '${RIDER_STATUS.OFFERED}' RETURNING *`, [req.user.id]);
    if (!accepted) throw conflict('There is no pending offer to accept');
    await enqueueEvent(db, EVENTS.RIDE_ACCEPTED, { rideId: accepted.current_offer.rideId, riderId: req.user.id });
    return accepted;
  });
  res.json(rider);
}));

app.post('/offer/reject', onlyRiders, asyncHandler(async (req, res) => {
  await inTransaction(async (db) => {
    const offered = await queryOne(db, `SELECT * FROM riders.riders WHERE id = $1 AND status = '${RIDER_STATUS.OFFERED}' FOR UPDATE`, [req.user.id]);
    if (!offered) throw conflict('There is no pending offer to reject');
    await db.query(`UPDATE riders.riders SET status = '${RIDER_STATUS.AVAILABLE}', current_offer = NULL WHERE id = $1`, [req.user.id]);
    await enqueueEvent(db, EVENTS.RIDE_REJECTED, { rideId: offered.current_offer.rideId, riderId: req.user.id });
  });
  res.json({ ok: true });
}));

app.post('/offer/start', onlyRiders, asyncHandler(async (req, res) => {
  const rider = await inTransaction(async (db) => {
    const started = await queryOne(db,
      `UPDATE riders.riders SET trip_started_at = now()
       WHERE id = $1 AND status = '${RIDER_STATUS.BUSY}' AND trip_started_at IS NULL RETURNING *`, [req.user.id]);
    if (!started) throw conflict('Accept a ride before starting it');
    await enqueueEvent(db, EVENTS.RIDE_STARTED, { rideId: started.current_offer.rideId, riderId: req.user.id });
    return started;
  });
  res.json(rider);
}));

app.post('/offer/complete', onlyRiders, asyncHandler(async (req, res) => {
  // demoTripMinutes lets you test time-based pricing without waiting; remove it for production use.
  const demoTripMinutes = Number(req.body.demoTripMinutes);
  await inTransaction(async (db) => {
    const rider = await queryOne(db,
      `SELECT * FROM riders.riders WHERE id = $1 AND status = '${RIDER_STATUS.BUSY}' AND trip_started_at IS NOT NULL FOR UPDATE`, [req.user.id]);
    if (!rider) throw conflict('There is no trip in progress');

    const { rideId, tripDistanceKm, dropoff } = rider.current_offer;
    const elapsedMinutes = (Date.now() - rider.trip_started_at.getTime()) / 60000;
    await enqueueEvent(db, EVENTS.RIDE_COMPLETED, {
      rideId, riderId: req.user.id, distanceKm: tripDistanceKm, durationMinutes: demoTripMinutes > 0 ? demoTripMinutes : elapsedMinutes, dropoff });
    await db.query(
      `UPDATE riders.riders SET status = '${RIDER_STATUS.AVAILABLE}', current_offer = NULL, trip_started_at = NULL, lat = $2, lng = $3 WHERE id = $1`,
      [req.user.id, dropoff.lat, dropoff.lng]);
  });
  res.json({ ok: true });
}));

const handleEvents = {
  [EVENTS.RIDE_OFFERED]: (event) => inTransaction(async (db) => {
    const recorded = await queryOne(db,
      `INSERT INTO riders.handled_offers(rider_id, ride_id) VALUES($1, $2)
       ON CONFLICT DO NOTHING RETURNING ride_id`, [event.riderId, event.rideId]);
    if (!recorded) return;

    const updated = await queryOne(db,
      `UPDATE riders.riders SET status = '${RIDER_STATUS.OFFERED}', current_offer = $2
       WHERE id = $1 AND status = '${RIDER_STATUS.AVAILABLE}' RETURNING id`,
      [event.riderId, { rideId: event.rideId, pickup: event.pickup, dropoff: event.dropoff,
        tripDistanceKm: event.tripDistanceKm, pickupEtaMinutes: event.pickupEtaMinutes }]);
    if (!updated) throw new Error(`Cannot apply ride offer ${event.rideId} to rider ${event.riderId}`);
  }),
  [EVENTS.PAYMENT_COMPLETED]: (event) => pool.query('UPDATE riders.riders SET last_fare = $2 WHERE id = $1', [event.riderId, event.fare]),
};

startService({
  serviceName: 'rider', app,
  schemaSql: `CREATE SCHEMA IF NOT EXISTS riders;
    CREATE TABLE IF NOT EXISTS riders.riders(
      id INT PRIMARY KEY, name TEXT, lat DOUBLE PRECISION, lng DOUBLE PRECISION, status TEXT NOT NULL DEFAULT '${RIDER_STATUS.AVAILABLE}',
      current_offer JSONB, trip_started_at TIMESTAMPTZ, last_fare DOUBLE PRECISION);
    CREATE TABLE IF NOT EXISTS riders.handled_offers(
      rider_id INT NOT NULL, ride_id INT NOT NULL, PRIMARY KEY(rider_id, ride_id))`,
  subscribeToBroker: () => subscribeToEvents('rider.q', handleEvents),
});
