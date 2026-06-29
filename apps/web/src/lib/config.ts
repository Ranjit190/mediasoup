let cached: string | null = null;

/**
 * Fetches the backend (signaling/SFU) URL from the runtime config endpoint and
 * caches it for the session. Falls back to localhost if the endpoint is
 * unreachable.
 * @returns {Promise<string>} The signaling/SFU server URL.
 */
export async function getServerUrl(): Promise<string> {
  if (cached) return cached;
  try {
    const res = await fetch('/api/config', { cache: 'no-store' });
    const data = (await res.json()) as { serverUrl: string };
    cached = data.serverUrl;
  } catch {
    cached = 'http://localhost:4000';
  }
  return cached;
}
