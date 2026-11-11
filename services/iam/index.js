// Identity & access: signup, login, issues JWT tokens that all other services trust
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('./shared/config');
const { pool } = require('./shared/database');
const { HttpError, asyncHandler, createApp } = require('./shared/http');
const { startService } = require('./shared/service');
const { ROLES } = require('./shared/constants');

const PASSWORD_HASH_ROUNDS = 10;
const UNIQUE_VIOLATION = '23505';
const app = createApp('iam');

const buildLoginResponse = (user) => ({
  token: jwt.sign({ id: user.id, name: user.name, role: user.role }, config.jwtSecret, { expiresIn: '12h' }),
  user: { id: user.id, name: user.name, role: user.role },
});

app.post('/signup', asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const { password, role } = req.body;

  if (!name || name.length > 100) throw new HttpError(400, 'Name is required (max 100 characters)');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'A valid email is required');
  if (typeof password !== 'string' || password.length < 6 || password.length > 72) throw new HttpError(400, 'Password must be 6-72 characters');
  if (!Object.values(ROLES).includes(role)) throw new HttpError(400, 'Role must be passenger or rider');

  try {
    const passwordHash = await bcrypt.hash(password, PASSWORD_HASH_ROUNDS);
    const { rows: [user] } = await pool.query(
      'INSERT INTO iam.users(name, email, password_hash, role) VALUES($1, $2, $3, $4) RETURNING id, name, role',
      [name, email, passwordHash, role]);
    res.status(201).json(buildLoginResponse(user));
  } catch (error) {
    if (error.code === UNIQUE_VIOLATION) throw new HttpError(409, 'Email is already registered');
    throw error;
  }
}));

app.post('/login', asyncHandler(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const { rows: [user] } = await pool.query('SELECT * FROM iam.users WHERE email = $1', [email]);
  const passwordMatches = user && await bcrypt.compare(String(req.body.password || ''), user.password_hash);
  if (!passwordMatches) throw new HttpError(401, 'Invalid email or password');
  res.json(buildLoginResponse(user));
}));

startService({
  serviceName: 'iam', app,
  schemaSql: `CREATE SCHEMA IF NOT EXISTS iam;
    CREATE TABLE IF NOT EXISTS iam.users(
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('passenger', 'rider')), created_at TIMESTAMPTZ DEFAULT now())`,
});
