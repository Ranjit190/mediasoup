import { Room } from './Room';
import { getWorkerByIndex, getWorkerCount } from '../mediasoup/worker';
import { createRouter } from '../mediasoup/router';
import { config } from '../config';
import { logger } from '../logger';

const rooms = new Map<string, Room>();

/**
 * Returns the room for the given id, creating it if needed. A room can shard
 * across up to one router per worker; each router lands on a distinct worker
 * (required by pipeToRouter), and producers are piped between them on demand.
 * @param {string} roomId Room id.
 * @returns {Promise<Room>} The room.
 */
export async function getOrCreateRoom(roomId: string): Promise<Room> {
  const existing = rooms.get(roomId);
  if (existing) return existing;
  const room = new Room(roomId, {
    maxPeersPerRouter: config.bigRoom.maxPeersPerRouter,
    maxRouters: getWorkerCount(),
    createRouter: (workerIndex: number) => createRouter(getWorkerByIndex(workerIndex)),
  });
  rooms.set(roomId, room);
  logger.info('room created', JSON.stringify({ roomId }));
  return room;
}

/**
 * Removes the room from the registry and closes its routers.
 * @param {string} roomId Room id.
 * @returns {void}
 */
export function disposeRoom(roomId: string): void {
  const room = rooms.get(roomId);
  if (!room) return;
  room.close();
  rooms.delete(roomId);
  logger.info('room disposed', JSON.stringify({ roomId }));
}
