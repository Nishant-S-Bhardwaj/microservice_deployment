// Route/dispatch service: plans the trip and offers it to the nearest available rider.
// It keeps its own copy of rider availability, built from events (it never reads the rider service's tables).
const { pool, inTransaction, queryOne } = require('./shared/database');
const { createApp } = require('./shared/http');
const { enqueueEvent, subscribeToEvents } = require('./shared/messaging');
const { startService } = require('./shared/service');
const { distanceKm } = require('./shared/geo');
const { RIDER_STATUS, EVENTS } = require('./shared/constants');

const AVERAGE_SPEED_KMH = Number(process.env.AVERAGE_SPEED_KMH) || 25;
const ROAD_DETOUR_FACTOR = 1.3;   // straight-line distance -> approximate road distance
const app = createApp('route');

const minutesToTravel = (km) => Math.max(1, Math.round((km / AVERAGE_SPEED_KMH) * 60));

/** Swap this one function for OSRM / Google Directions to get real road routing. */
function planRoute(from, to) {
  const roadDistanceKm = Number((distanceKm(from, to) * ROAD_DETOUR_FACTOR).toFixed(2));
  return { distanceKm: roadDistanceKm, durationMinutes: minutesToTravel(roadDistanceKm) };
}

/** Claims the nearest AVAILABLE rider (skipping `declinedRiderIds`) and queues the offer, or "no riders". */
async function offerRideToNearestRider(db, { rideId, pickup, dropoff, declinedRiderIds = [] }) {
  // SKIP LOCKED: concurrent dispatches never pick the same rider. Squared degree distance is fine for ranking at city scale.
  const rider = await queryOne(db,
    `UPDATE route.riders SET status = '${RIDER_STATUS.OFFERED}', current_ride_id = $4 WHERE id = (
       SELECT id FROM route.riders
       WHERE status = '${RIDER_STATUS.AVAILABLE}' AND id <> ALL($1)
       ORDER BY (lat - $2) ^ 2 + (lng - $3) ^ 2 LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING *`, [declinedRiderIds, pickup.lat, pickup.lng, rideId]);

  if (!rider) return enqueueEvent(db, EVENTS.RIDE_NO_RIDERS, { rideId });

  const trip = planRoute(pickup, dropoff);
  const pickupDistanceKm = distanceKm({ lat: rider.lat, lng: rider.lng }, pickup) * ROAD_DETOUR_FACTOR;
  const pickupEtaMinutes = minutesToTravel(pickupDistanceKm);
  return enqueueEvent(db, EVENTS.RIDE_OFFERED, {
    rideId, riderId: rider.id, riderName: rider.name, pickup, dropoff,
    tripDistanceKm: trip.distanceKm, pickupEtaMinutes, totalEtaMinutes: pickupEtaMinutes + trip.durationMinutes,
  });
}

const handleEvents = {
  [EVENTS.RIDER_WENT_ONLINE]: (event) => pool.query(
    `INSERT INTO route.riders AS rider(id, name, lat, lng) VALUES($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name,
       lat = CASE WHEN rider.status = '${RIDER_STATUS.AVAILABLE}' THEN EXCLUDED.lat ELSE rider.lat END,
       lng = CASE WHEN rider.status = '${RIDER_STATUS.AVAILABLE}' THEN EXCLUDED.lng ELSE rider.lng END`,
    [event.riderId, event.name, event.lat, event.lng]),

  [EVENTS.RIDE_REQUESTED]: (event) => inTransaction(async (db) => {
    // Duplicate delivery of the same event must not create a second offer.
    const isNewRequest = await queryOne(db,
      `INSERT INTO route.dispatches(ride_id, pickup, dropoff) VALUES($1, $2, $3) ON CONFLICT DO NOTHING RETURNING ride_id`,
      [event.rideId, event.pickup, event.dropoff]);
    if (isNewRequest) await offerRideToNearestRider(db, event);
  }),

  [EVENTS.RIDE_ACCEPTED]: (event) => pool.query(
    `UPDATE route.riders SET status = '${RIDER_STATUS.BUSY}'
     WHERE id = $1 AND current_ride_id = $2 AND status = '${RIDER_STATUS.OFFERED}'`,
    [event.riderId, event.rideId]),

  [EVENTS.RIDE_COMPLETED]: (event) => pool.query(
    `UPDATE route.riders SET status = '${RIDER_STATUS.AVAILABLE}', current_ride_id = NULL, lat = $2, lng = $3
     WHERE id = $1 AND current_ride_id = $4 AND status = '${RIDER_STATUS.BUSY}'`,
    [event.riderId, event.dropoff.lat, event.dropoff.lng, event.rideId]),

  [EVENTS.RIDE_REJECTED]: (event) => inTransaction(async (db) => {
    const wasOffered = await queryOne(db,
      `UPDATE route.riders SET status = '${RIDER_STATUS.AVAILABLE}', current_ride_id = NULL
       WHERE id = $1 AND status = '${RIDER_STATUS.OFFERED}' AND current_ride_id = $2 RETURNING id`,
      [event.riderId, event.rideId]);
    if (!wasOffered) return;   // duplicate/stale rejection
    const dispatch = await queryOne(db,
      'UPDATE route.dispatches SET declined_rider_ids = array_append(declined_rider_ids, $2) WHERE ride_id = $1 RETURNING *',
      [event.rideId, event.riderId]);
    await offerRideToNearestRider(db, { rideId: event.rideId, pickup: dispatch.pickup, dropoff: dispatch.dropoff, declinedRiderIds: dispatch.declined_rider_ids });
  }),
};

startService({
  serviceName: 'route', app,
  schemaSql: `CREATE SCHEMA IF NOT EXISTS route;
    CREATE TABLE IF NOT EXISTS route.riders(
    id INT PRIMARY KEY, name TEXT, lat DOUBLE PRECISION, lng DOUBLE PRECISION, status TEXT NOT NULL DEFAULT '${RIDER_STATUS.AVAILABLE}',
    current_ride_id INT);
  ALTER TABLE route.riders ADD COLUMN IF NOT EXISTS current_ride_id INT;
    CREATE TABLE IF NOT EXISTS route.dispatches(
      ride_id INT PRIMARY KEY, pickup JSONB NOT NULL, dropoff JSONB NOT NULL, declined_rider_ids INT[] NOT NULL DEFAULT '{}')`,
  subscribeToBroker: () => subscribeToEvents('route.q', handleEvents),
});
