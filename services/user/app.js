const { HttpError, asyncHandler, createApp } = require('./shared/http');
const { isValidCoordinate } = require('./shared/geo');
const { RIDE_STATUS, EVENTS } = require('./shared/constants');

const UNIQUE_VIOLATION = '23505';

function createUserService({ rideStore, subscribeToEvents, passengerAuth }) {
  const app = createApp('user');

  app.post('/rides', passengerAuth, asyncHandler(async (req, res) => {
    const { pickup, dropoff } = req.body;
    if (!isValidCoordinate(pickup) || !isValidCoordinate(dropoff)) {
      throw new HttpError(400, 'pickup and dropoff need valid lat/lng');
    }

    try {
      const ride = await rideStore.createRide({
        passengerId: req.user.id, passengerName: req.user.name, pickup, dropoff,
      });
      res.status(201).json(ride);
    } catch (error) {
      if (error.code === UNIQUE_VIOLATION) throw new HttpError(409, 'You already have an active ride');
      throw error;
    }
  }));

  app.get('/rides', passengerAuth, asyncHandler(async (req, res) => {
    res.json(await rideStore.listPassengerRides(req.user.id));
  }));

  app.get('/rides/:rideId', passengerAuth, asyncHandler(async (req, res) => {
    if (!/^[1-9]\d*$/.test(req.params.rideId)) throw new HttpError(400, 'Invalid ride id');
    const rideId = Number(req.params.rideId);
    if (!Number.isSafeInteger(rideId)) throw new HttpError(400, 'Invalid ride id');
    const ride = await rideStore.findPassengerRide(rideId, req.user.id);
    if (!ride) throw new HttpError(404, 'Ride not found');
    res.json(ride);
  }));

  const handleEvents = {
    [EVENTS.RIDE_OFFERED]: (event) => rideStore.updateRide(event.rideId, {
      status: RIDE_STATUS.ASSIGNED, rider_id: event.riderId, rider_name: event.riderName,
      distance_km: event.tripDistanceKm, eta_minutes: event.totalEtaMinutes },
    [RIDE_STATUS.REQUESTED, RIDE_STATUS.ASSIGNED]),
    [EVENTS.RIDE_NO_RIDERS]: (event) => rideStore.updateRide(event.rideId, { status: RIDE_STATUS.NO_RIDERS },
      [RIDE_STATUS.REQUESTED, RIDE_STATUS.ASSIGNED]),
    [EVENTS.RIDE_ACCEPTED]: (event) => rideStore.updateRide(event.rideId, { status: RIDE_STATUS.ACCEPTED },
      [RIDE_STATUS.ASSIGNED]),
    [EVENTS.RIDE_STARTED]: (event) => rideStore.updateRide(event.rideId, { status: RIDE_STATUS.IN_PROGRESS },
      [RIDE_STATUS.ACCEPTED, RIDE_STATUS.IN_PROGRESS]),
    [EVENTS.PAYMENT_COMPLETED]: (event) => rideStore.updateRide(event.rideId,
      { status: RIDE_STATUS.COMPLETED, fare: event.fare },
      [RIDE_STATUS.IN_PROGRESS, RIDE_STATUS.COMPLETED]),
  };

  return {
    app,
    schemaSql: rideStore.schemaSql,
    subscribeToBroker: () => subscribeToEvents('user.q', handleEvents),
  };
}

module.exports = { createUserService };
