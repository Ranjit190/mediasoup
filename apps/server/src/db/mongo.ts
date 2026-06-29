import { MongoClient, Db } from 'mongodb';
import { config } from '../config';
import { logger } from '../logger';

let db: Db | null = null;

/**
 * Connects to MongoDB for persisting meeting/call metadata. No-op when
 * ENABLE_MONGO is false (lets the app run without a database locally).
 * @returns {Promise<void>} Resolves once connected or skipped.
 */
export async function initMongo(): Promise<void> {
  if (!config.mongo.enabled) {
    logger.info('Mongo disabled — call metadata will not be persisted');
    return;
  }
  const client = new MongoClient(config.mongo.uri);
  await client.connect();
  db = client.db(config.mongo.dbName);
  logger.info('MongoDB connected', JSON.stringify({ db: config.mongo.dbName }));
}

/**
 * Persists a call event to the `events` collection and upserts a per-room
 * `meetings` summary. Errors are swallowed so persistence never blocks
 * signaling. No-op when Mongo is disabled/unconnected.
 * @param {string} type Event type, e.g. "participant.joined".
 * @param {Record<string, unknown>} payload Event payload (expects roomId).
 * @returns {Promise<void>} Resolves after the write attempt.
 */
export async function persistEvent(type: string, payload: Record<string, unknown>): Promise<void> {
  if (!db) return;
  try {
    await db.collection('events').insertOne({ type, ...payload, createdAt: new Date() });
    if (payload.roomId) {
      await db.collection('meetings').updateOne(
        { roomId: payload.roomId },
        {
          $setOnInsert: { roomId: payload.roomId, startedAt: new Date() },
          $set: { lastEventAt: new Date(), lastEventType: type },
        },
        { upsert: true },
      );
    }
  } catch (err) {
    logger.error('Mongo persist failed', JSON.stringify({ type, error: String(err) }));
  }
}
