const { pool, inTransaction, queryOne } = require('./shared/database');
const { enqueueEvent, subscribeToEvents } = require('./shared/messaging');
const { requireAuth } = require('./shared/http');
const { startService } = require('./shared/service');
const { ROLES } = require('./shared/constants');
const { createRideStore } = require('./rideStore');
const { createUserService } = require('./app');

const rideStore = createRideStore({
  database: { pool, inTransaction, queryOne },
  enqueueEvent,
});
const service = createUserService({
  rideStore,
  subscribeToEvents,
  passengerAuth: requireAuth(ROLES.PASSENGER),
});

startService({ serviceName: 'user', ...service });
