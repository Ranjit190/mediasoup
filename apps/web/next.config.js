/** @type {import('next').NextConfig} */
const nextConfig = {
  // StrictMode double-invokes effects in dev, which would run the WebRTC join
  // flow twice. Disabled so the single RoomClient lifecycle is predictable.
  reactStrictMode: false,
  output: 'standalone',
};

module.exports = nextConfig;
