const { RIDE_STATUS, FINISHED_RIDE_STATUSES, EVENTS } = require('./shared/constants');

const sqlList = (values) => values.map((value) => `'${value}'`).join(', ');

function createRideStore({ database, enqueueEvent }) {
  const { pool, inTransaction, queryOne } = database;

  async function createRide({ passengerId, passengerName, pickup, dropoff }) {
    return inTransaction(async (db) => {
      const ride = await queryOne(db,
        `INSERT INTO rides.rides(passenger_id, passenger_name, pickup_label, dropoff_label) VALUES($1, $2, $3, $4) RETURNING *`,
        [passengerId, passengerName, pickup.label || '', dropoff.label || '']);
      await enqueueEvent(db, EVENTS.RIDE_REQUESTED, { rideId: ride.id, pickup, dropoff });
      return ride;
    });
  }

  async function listPassengerRides(passengerId) {
    const { rows } = await pool.query(
      'SELECT * FROM rides.rides WHERE passenger_id = $1 ORDER BY id DESC LIMIT 20', [passengerId]);
    return rows;
  }

  return {
    createRide,
    listPassengerRides,
    findPassengerRide: (rideId, passengerId) =>
      queryOne(pool, 'SELECT * FROM rides.rides WHERE id = $1 AND passenger_id = $2', [rideId, passengerId]),
    updateRide(rideId, fields, allowedStatuses) {
      const columns = Object.keys(fields);
      const assignments = columns.map((column, index) => `${column} = $${index + 2}`).join(', ');
      const statusParameters = allowedStatuses.map((_, index) => `$${columns.length + index + 2}`).join(', ');
      return pool.query(
        `UPDATE rides.rides SET ${assignments} WHERE id = $1 AND status IN (${statusParameters})`,
        [rideId, ...columns.map((column) => fields[column]), ...allowedStatuses]);
    },
    schemaSql: `CREATE SCHEMA IF NOT EXISTS rides;
      CREATE TABLE IF NOT EXISTS rides.rides(
        id SERIAL PRIMARY KEY, passenger_id INT NOT NULL, passenger_name TEXT, status TEXT NOT NULL DEFAULT '${RIDE_STATUS.REQUESTED}',
        pickup_label TEXT, dropoff_label TEXT, rider_id INT, rider_name TEXT,
        distance_km DOUBLE PRECISION, eta_minutes DOUBLE PRECISION, fare DOUBLE PRECISION, created_at TIMESTAMPTZ DEFAULT now());
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_ride_per_passenger ON rides.rides(passenger_id)
        WHERE status NOT IN (${sqlList(FINISHED_RIDE_STATUSES)})`,
  };
}

module.exports = { createRideStore };
