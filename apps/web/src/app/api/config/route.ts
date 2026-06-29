import { NextResponse } from 'next/server';

// Always evaluated at request time so it reads the container's env, never cached.
export const dynamic = 'force-dynamic';

/**
 * Runtime config endpoint. The browser fetches this to learn the backend URL,
 * so a single build works in any environment — SERVER_URL is read from the
 * container environment at request time, not baked in at build time.
 * @returns {NextResponse} JSON { serverUrl }.
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ serverUrl: process.env.SERVER_URL ?? 'http://localhost:4000' });
}
