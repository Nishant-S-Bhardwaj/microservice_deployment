const amqp = require('amqplib');
const config = require('./config');
const { inTransaction, queryOne } = require('./database');

const EXCHANGE = 'rides';
const DEAD_LETTER_EXCHANGE = 'rides.dead';
const DEAD_LETTER_QUEUE = 'rides.dead.q';

let channel;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connectBroker() {
  for (;;) {
    try {
      const connection = await amqp.connect(config.amqpUrl);
      connection.on('close', () => { console.error('RabbitMQ connection closed'); process.exit(1); });
      connection.on('error', (error) => console.error('RabbitMQ error:', error.message));
      channel = await connection.createConfirmChannel();
      await channel.prefetch(10);
      await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
      await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'fanout', { durable: true });
      await channel.assertQueue(DEAD_LETTER_QUEUE, { durable: true });
      await channel.bindQueue(DEAD_LETTER_QUEUE, DEAD_LETTER_EXCHANGE, '');
      return;
    } catch {
      await sleep(2000);
    }
  }
}

function publishEvent(eventName, payload) {
  return new Promise((resolve, reject) => {
    channel.publish(EXCHANGE, eventName, Buffer.from(JSON.stringify(payload)), { persistent: true },
      (error) => (error ? reject(error) : resolve()));
  });
}

async function enqueueEvent(db, eventName, payload) {
  await db.query(
    'INSERT INTO public.integration_outbox(event_name, payload) VALUES($1, $2)',
    [eventName, payload]);
}

async function publishNextOutboxEvent() {
  return inTransaction(async (db) => {
    const event = await queryOne(db,
      'SELECT id, event_name, payload FROM public.integration_outbox ORDER BY id LIMIT 1 FOR UPDATE');
    if (!event) return false;
    await publishEvent(event.event_name, event.payload);
    await db.query('DELETE FROM public.integration_outbox WHERE id = $1', [event.id]);
    return true;
  });
}

function startOutboxPublisher() {
  const run = async () => {
    for (;;) {
      try {
        const published = await publishNextOutboxEvent();
        if (!published) await sleep(250);
      } catch (error) {
        console.error('Failed to publish an outbox event:', error);
        await sleep(1000);
      }
    }
  };
  void run();
}

async function subscribeToEvents(queueName, handlersByEvent) {
  await channel.assertQueue(queueName, { durable: true, deadLetterExchange: DEAD_LETTER_EXCHANGE });
  for (const eventName of Object.keys(handlersByEvent)) await channel.bindQueue(queueName, EXCHANGE, eventName);
  await channel.consume(queueName, async (message) => {
    const eventName = message.fields.routingKey;
    try {
      await handlersByEvent[eventName](JSON.parse(message.content.toString()));
      channel.ack(message);
    } catch (error) {
      console.error(`[${queueName}] failed handling ${eventName}:`, error.message);
      channel.nack(message, false, false);
    }
  });
}

module.exports = { connectBroker, enqueueEvent, startOutboxPublisher, subscribeToEvents };
