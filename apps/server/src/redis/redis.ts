import { Redis } from 'ioredis';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Server } from 'socket.io';
import { config } from '../config';
import { logger } from '../logger';

/**
 * Builds an ioredis client from config.
 * @returns {Redis} Configured Redis client.
 */
function buildClient(): Redis {
  return new Redis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    tls: config.redis.tls ? {} : undefined,
    lazyConnect: false,
  });
}

/**
 * Attaches the Redis Socket.IO adapter so signaling state fans out across
 * pods. No-op when ENABLE_REDIS is false (single-instance local dev).
 * @param {Server} io Socket.IO server instance.
 * @returns {Promise<void>} Resolves once the adapter is attached or skipped.
 */
export async function maybeAttachRedisAdapter(io: Server): Promise<void> {
  if (!config.redis.enabled) {
    logger.info('Redis disabled — running single-instance (no cross-pod adapter)');
    return;
  }
  const pubClient = buildClient();
  const subClient = pubClient.duplicate();
  io.adapter(createAdapter(pubClient, subClient));
  logger.info('Redis Socket.IO adapter attached', JSON.stringify({ host: config.redis.host }));
}
