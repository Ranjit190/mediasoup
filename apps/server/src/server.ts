import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
import { config } from './config';
import { logger } from './logger';
import { createWorkers } from './mediasoup/worker';
import { maybeAttachRedisAdapter } from './redis/redis';
import { initKafka } from './kafka/producer';
import { initMongo } from './db/mongo';
import { registerSocketHandlers } from './signaling/socketHandlers';

/**
 * Boots the combined signaling + SFU service: Express health endpoint,
 * Socket.IO (optionally Redis-backed), mediasoup workers, Kafka events.
 * @returns {Promise<void>} Resolves once the server is listening.
 */
async function main(): Promise<void> {
  const app = express();
  app.use(cors({ origin: config.corsOrigin }));
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: config.corsOrigin } });
  await createWorkers();
  await maybeAttachRedisAdapter(io);
  await initKafka();
  await initMongo();
  registerSocketHandlers(io);
  server.listen(config.port, () => {
    logger.info('signaling/SFU listening', JSON.stringify({ port: config.port, announcedIp: config.mediasoup.announcedIp }));
  });
}

main().catch((err) => {
  logger.error('fatal startup error', JSON.stringify({ error: String(err) }));
  process.exit(1);
});
