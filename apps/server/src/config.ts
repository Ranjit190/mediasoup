import 'dotenv/config';

/**
 * Parses a boolean-ish environment variable.
 * @param {string|undefined} value Raw env value.
 * @param {boolean} fallback Default when unset.
 * @returns {boolean} Parsed boolean.
 */
function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === 'true' || value === '1';
}

/**
 * Parses an integer environment variable.
 * @param {string|undefined} value Raw env value.
 * @param {number} fallback Default when unset or invalid.
 * @returns {number} Parsed integer.
 */
function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export const config = {
  port: int(process.env.PORT, 4000),
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
  mediasoup: {
    numWorkers: int(process.env.MEDIASOUP_NUM_WORKERS, 0),
    listenIp: process.env.MEDIASOUP_LISTEN_IP ?? '0.0.0.0',
    announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP ?? '127.0.0.1',
    rtcMinPort: int(process.env.MEDIASOUP_RTC_MIN_PORT, 40000),
    rtcMaxPort: int(process.env.MEDIASOUP_RTC_MAX_PORT, 40249),
  },
  bigRoom: {
    // When a room's current routers are all full, a new router is spun on the
    // next worker (capped at the worker count) and producers are piped to it.
    maxPeersPerRouter: int(process.env.MAX_PEERS_PER_ROUTER, 30),
  },
  redis: {
    enabled: bool(process.env.ENABLE_REDIS, false),
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: int(process.env.REDIS_PORT, 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    tls: bool(process.env.REDIS_TLS, false),
  },
  kafka: {
    enabled: bool(process.env.ENABLE_KAFKA, false),
    brokers: (process.env.KAFKA_BROKERS ?? '127.0.0.1:9092').split(','),
    clientId: process.env.KAFKA_CLIENT_ID ?? 'video-call-sfu',
    eventsTopic: process.env.KAFKA_EVENTS_TOPIC ?? 'call-events',
  },
  mongo: {
    enabled: bool(process.env.ENABLE_MONGO, false),
    uri: process.env.MONGO_URI ?? 'mongodb://127.0.0.1:27017',
    dbName: process.env.MONGO_DB ?? 'videocall',
  },
};
