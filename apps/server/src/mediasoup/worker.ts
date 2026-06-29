import * as os from 'os';
import * as mediasoup from 'mediasoup';
import { config } from '../config';
import { logger } from '../logger';

const workers: mediasoup.types.Worker[] = [];
let nextWorkerIndex = 0;

/**
 * Spawns mediasoup workers (one per CPU core by default). Each worker is a
 * separate C++ subprocess; CPU-bound media work is spread across them.
 * @returns {Promise<void>} Resolves once all workers are created.
 */
export async function createWorkers(): Promise<void> {
  const count = config.mediasoup.numWorkers > 0 ? config.mediasoup.numWorkers : os.cpus().length;
  for (let i = 0; i < count; i++) {
    const worker = await mediasoup.createWorker({
      logLevel: 'warn',
      rtcMinPort: config.mediasoup.rtcMinPort,
      rtcMaxPort: config.mediasoup.rtcMaxPort,
    });
    worker.on('died', () => {
      logger.error('mediasoup worker died — exiting process', JSON.stringify({ pid: worker.pid }));
      setTimeout(() => process.exit(1), 2000);
    });
    workers.push(worker);
  }
  logger.info('mediasoup workers created', JSON.stringify({ count: workers.length }));
}

/**
 * Returns the next worker round-robin so rooms spread across workers.
 * @returns {mediasoup.types.Worker} A mediasoup worker.
 */
export function getNextWorker(): mediasoup.types.Worker {
  const worker = workers[nextWorkerIndex];
  nextWorkerIndex = (nextWorkerIndex + 1) % workers.length;
  return worker;
}

/**
 * @returns {number} The number of mediasoup workers (i.e. usable cores).
 */
export function getWorkerCount(): number {
  return workers.length;
}

/**
 * Returns a worker by index (wrapping). Used so a room places each of its
 * routers on a distinct worker, which pipeToRouter (keepId) requires.
 * @param {number} index Worker index.
 * @returns {mediasoup.types.Worker} The selected worker.
 */
export function getWorkerByIndex(index: number): mediasoup.types.Worker {
  return workers[index % workers.length];
}
