const config = require('./config');
const { pool } = require('./database');
const { connectBroker, startOutboxPublisher } = require('./messaging');
const { addErrorHandling } = require('./http');

async function startService({ serviceName, app, schemaSql, subscribeToBroker }) {
  try {
    await pool.query(schemaSql);
    if (subscribeToBroker) {
      await pool.query(`CREATE TABLE IF NOT EXISTS public.integration_outbox(
        id BIGSERIAL PRIMARY KEY, event_name TEXT NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await connectBroker();
      await subscribeToBroker();
      startOutboxPublisher();
    }
    addErrorHandling(app);
    const server = app.listen(config.port, () => console.log(`${serviceName} service listening on ${config.port}`));
    process.on('SIGTERM', () => server.close(() => pool.end().then(() => process.exit(0))));
  } catch (error) {
    console.error(`${serviceName} failed to start:`, error);
    process.exit(1);
  }
}

module.exports = { startService };
