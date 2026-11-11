const requireEnv = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const databaseUrl = process.env.DATABASE_URL ||
  `postgresql://${requireEnv('POSTGRES_USER')}:${requireEnv('POSTGRES_PASSWORD')}@localhost:5432/${requireEnv('POSTGRES_DB')}`;
const amqpUrl = process.env.AMQP_URL ||
  `amqp://${requireEnv('RABBITMQ_DEFAULT_USER')}:${requireEnv('RABBITMQ_DEFAULT_PASS')}@localhost:5672`;

module.exports = {
  port: Number(process.env.PORT) || 3000,
  databaseUrl,
  amqpUrl,
  jwtSecret: requireEnv('JWT_SECRET'),
};
