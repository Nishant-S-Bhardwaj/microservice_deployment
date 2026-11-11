// Payment service: prices a finished trip by distance and time. Purely event-driven.
const { inTransaction, queryOne } = require('./shared/database');
const { createApp } = require('./shared/http');
const { enqueueEvent, subscribeToEvents } = require('./shared/messaging');
const { startService } = require('./shared/service');
const { EVENTS } = require('./shared/constants');

const BASE_FARE = Number(process.env.BASE_FARE) || 40;
const PRICE_PER_KM = Number(process.env.PRICE_PER_KM) || 12;
const PRICE_PER_MINUTE = Number(process.env.PRICE_PER_MINUTE) || 1.5;
const MINIMUM_FARE = Number(process.env.MINIMUM_FARE) || 80;
const app = createApp('payment');

const calculateFare = (distanceKm, durationMinutes) =>
  Number(Math.max(MINIMUM_FARE, BASE_FARE + distanceKm * PRICE_PER_KM + durationMinutes * PRICE_PER_MINUTE).toFixed(2));

const handleEvents = {
  [EVENTS.RIDE_COMPLETED]: (event) => inTransaction(async (db) => {
    // Idempotent: a duplicate event for the same ride is ignored and the stored fare is re-published.
    await db.query(
      'INSERT INTO payments.payments(ride_id, distance_km, duration_minutes, fare) VALUES($1, $2, $3, $4) ON CONFLICT DO NOTHING',
      [event.rideId, event.distanceKm, event.durationMinutes, calculateFare(event.distanceKm, event.durationMinutes)]);
    const payment = await queryOne(db, 'SELECT * FROM payments.payments WHERE ride_id = $1', [event.rideId]);
    await enqueueEvent(db, EVENTS.PAYMENT_COMPLETED, { rideId: event.rideId, riderId: event.riderId, fare: payment.fare });
  }),
};

startService({
  serviceName: 'payment', app,
  schemaSql: `CREATE SCHEMA IF NOT EXISTS payments;
    CREATE TABLE IF NOT EXISTS payments.payments(
      ride_id INT PRIMARY KEY, distance_km DOUBLE PRECISION, duration_minutes DOUBLE PRECISION, fare DOUBLE PRECISION, created_at TIMESTAMPTZ DEFAULT now())`,
  subscribeToBroker: () => subscribeToEvents('payment.q', handleEvents),
});
