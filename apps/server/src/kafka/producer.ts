import { Kafka, Producer } from 'kafkajs';
import { config } from '../config';
import { logger } from '../logger';
import { persistEvent } from '../db/mongo';

let producer: Producer | null = null;

/**
 * Connects the Kafka producer used for non-realtime call events
 * (analytics, recording triggers, audit). No-op when ENABLE_KAFKA is false.
 * @returns {Promise<void>} Resolves once connected or skipped.
 */
export async function initKafka(): Promise<void> {
  if (!config.kafka.enabled) {
    logger.info('Kafka disabled — call events will not be published');
    return;
  }
  const kafka = new Kafka({ clientId: config.kafka.clientId, brokers: config.kafka.brokers });
  producer = kafka.producer();
  await producer.connect();
  logger.info('Kafka producer connected', JSON.stringify({ brokers: config.kafka.brokers }));
}

/**
 * Records a call event to all sinks: persists to MongoDB and publishes to
 * Kafka. Both are optional and swallow errors so signaling is never blocked by
 * the analytics path.
 * @param {string} type Event type, e.g. "participant.joined".
 * @param {Record<string, unknown>} payload Event payload.
 * @returns {Promise<void>} Resolves after the send/persist attempts.
 */
export async function emitCallEvent(type: string, payload: Record<string, unknown>): Promise<void> {
  await persistEvent(type, payload);
  if (!producer) return;
  try {
    await producer.send({
      topic: config.kafka.eventsTopic,
      messages: [{ key: String(payload.roomId ?? ''), value: JSON.stringify({ type, ...payload }) }],
    });
  } catch (err) {
    logger.error('Kafka emit failed', JSON.stringify({ type, error: String(err) }));
  }
}
