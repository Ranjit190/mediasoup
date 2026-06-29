import * as mediasoup from 'mediasoup';

export type MediaSource = 'mic' | 'webcam' | 'screen';

export interface Peer {
  id: string;
  socketId: string;
  displayName: string;
  routerId: string;
  transports: Map<string, mediasoup.types.WebRtcTransport>;
  producers: Map<string, mediasoup.types.Producer>;
  consumers: Map<string, mediasoup.types.Consumer>;
}

export interface ProducerInfo {
  producerId: string;
  peerId: string;
  displayName: string;
  kind: mediasoup.types.MediaKind;
  source: MediaSource;
}
