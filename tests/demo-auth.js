const assert = require('node:assert/strict');

Object.assign(process.env, {
  POSTGRES_USER: 'demo',
  POSTGRES_PASSWORD: 'demo',
  POSTGRES_DB: 'demo',
  RABBITMQ_DEFAULT_USER: 'demo',
  RABBITMQ_DEFAULT_PASS: 'demo',
  JWT_SECRET: 'demo-test-secret',
  DEMO_AUTH_DISABLED: 'true',
});

for (const [service, role, id] of [
  ['user', 'passenger', 1],
  ['rider', 'rider', 2],
]) {
  const { requireAuth } = require(`../services/${service}/shared/http`);
  const req = { headers: {} };
  let passed = false;
  requireAuth(role)(req, {}, () => { passed = true; });
  assert.equal(passed, true);
  assert.deepEqual(req.user, {
    id,
    name: role === 'rider' ? 'Demo Rider' : 'Demo Passenger',
    role,
  });
}

process.env.DEMO_AUTH_DISABLED = 'false';
const { requireAuth } = require('../services/user/shared/http');
let authError;
requireAuth('passenger')({ headers: {} }, {}, (error) => { authError = error; });
assert.equal(authError.status, 401);

console.log('Demo auth bypass and default JWT protection passed');
