const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const config = require('./config');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const asyncHandler = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);

const requireAuth = (requiredRole) => (req, res, next) => {
  // Local integration demo only; never enable on an untrusted deployment.
  if (process.env.DEMO_AUTH_DISABLED === 'true' && ['passenger', 'rider'].includes(requiredRole)) {
    req.user = {
      id: requiredRole === 'rider' ? 2 : 1,
      name: requiredRole === 'rider' ? 'Demo Rider' : 'Demo Passenger',
      role: requiredRole,
    };
    return next();
  }
  try {
    req.user = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), config.jwtSecret);
  } catch {
    return next(new HttpError(401, 'Please log in'));
  }
  if (requiredRole && req.user.role !== requiredRole) return next(new HttpError(403, `Only ${requiredRole}s can do this`));
  next();
};

function createApp(serviceName) {
  const app = express();
  app.use(cors(), express.json());
  app.get('/health', (req, res) => res.json({ service: serviceName, ok: true }));
  return app;
}

function addErrorHandling(app) {
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((error, req, res, next) => {
    const status = error.status || (error.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(error);
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : error.message });
  });
}

module.exports = { HttpError, asyncHandler, requireAuth, createApp, addErrorHandling };
