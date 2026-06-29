import * as mediasoup from 'mediasoup';

/**
 * Codecs the SFU routers accept. Opus for audio; VP8 + H264 for video so
 * browsers can negotiate simulcast layers.
 */
export const mediaCodecs: mediasoup.types.RouterRtpCodecCapability[] = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: { 'x-google-start-bitrate': 1000 },
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42e01f',
      'level-asymmetry-allowed': 1,
    },
  },
];

/**
 * Creates a router (one per room for this MVP) on the given worker.
 * @param {mediasoup.types.Worker} worker Worker that will own the router.
 * @returns {Promise<mediasoup.types.Router>} The created router.
 */
export async function createRouter(worker: mediasoup.types.Worker): Promise<mediasoup.types.Router> {
  return worker.createRouter({ mediaCodecs });
}
