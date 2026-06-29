/**
 * Minimal structured logger. Objects are stringified by the caller via
 * JSON.stringify so log lines stay greppable.
 */
export const logger = {
  info: (...args: unknown[]): void => console.log('[INFO]', ...args),
  warn: (...args: unknown[]): void => console.warn('[WARN]', ...args),
  error: (...args: unknown[]): void => console.error('[ERROR]', ...args),
};
