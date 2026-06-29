import * as mediasoup from 'mediasoup';
import { config } from '../config';

/**
 * Creates a WebRtcTransport and returns it with the client-facing parameters
 * needed to establish the DTLS/ICE connection.
 * @param {mediasoup.types.Router} router Router that owns the transport.
 * @returns {Promise<{transport: mediasoup.types.WebRtcTransport, params: object}>} Transport and its client params.
 */
export async function createWebRtcTransport(router: mediasoup.types.Router): Promise<{
  transport: mediasoup.types.WebRtcTransport;
  params: {
    id: string;
    iceParameters: mediasoup.types.IceParameters;
    iceCandidates: mediasoup.types.IceCandidate[];
    dtlsParameters: mediasoup.types.DtlsParameters;
  };
}> {
  const transport = await router.createWebRtcTransport({
    listenIps: [{ ip: config.mediasoup.listenIp, announcedIp: config.mediasoup.announcedIp }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 1_000_000,
  });
  return {
    transport,
    params: {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    },
  };
}
