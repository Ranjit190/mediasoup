import { io, Socket } from 'socket.io-client';
import { Device, types } from 'mediasoup-client';

export interface RemoteStream {
  peerId: string;
  displayName: string;
  stream: MediaStream;
  videoActive: boolean;
  speaking: boolean;
  pinned: boolean;
}

interface JoinResponse {
  peerId: string;
  rtpCapabilities: types.RtpCapabilities;
  peers: { peerId: string; displayName: string }[];
  producers: { producerId: string; peerId: string; displayName: string; kind: types.MediaKind; source: string }[];
}

interface TransportParams {
  id: string;
  iceParameters: types.IceParameters;
  iceCandidates: types.IceCandidate[];
  dtlsParameters: types.DtlsParameters;
}

interface ConsumerEntry {
  consumer: types.Consumer;
  peerId: string;
  kind: types.MediaKind;
  source: string;
  resumed: boolean;
  preferredSpatial: number;
}

/**
 * Browser-side controller that runs the full mediasoup handshake over
 * Socket.IO and applies a last-N policy: only the N most-relevant video
 * consumers stay resumed (the rest are paused), and the active speaker /
 * pinned tiles get the top simulcast layer. Keeps React in sync via onChange.
 */
export class RoomClient {
  private socket: Socket;
  private device: Device;
  private sendTransport?: types.Transport;
  private recvTransport?: types.Transport;
  private localStream?: MediaStream;
  private screenStream?: MediaStream;
  private producers = new Map<string, types.Producer>();
  private consumers = new Map<string, ConsumerEntry>();
  private remote = new Map<string, { peerId: string; displayName: string; stream: MediaStream }>();
  private recent: string[] = [];
  private pinned = new Set<string>();
  private activeSpeakerId: string | null = null;
  private readonly maxVideo = 9;
  public peerId = '';
  public micEnabled = true;
  public camEnabled = true;
  public screenSharing = false;

  /**
   * @param {string} serverUrl Signaling server URL.
   * @param {string} roomId Room to join.
   * @param {string} displayName Display name for this peer.
   * @param {() => void} onChange Invoked whenever UI-relevant state changes.
   */
  constructor(
    private serverUrl: string,
    private roomId: string,
    private displayName: string,
    private onChange: () => void,
  ) {
    this.socket = io(serverUrl, { transports: ['websocket'], autoConnect: false });
    this.device = new Device();
  }

  /**
   * Emits an event and resolves with the server's ack payload.
   * @param {string} event Event name.
   * @param {unknown} data Payload.
   * @returns {Promise<T>} Server response.
   */
  private request<T>(event: string, data?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      this.socket.emit(event, data, (response: any) => {
        if (response && response.error) reject(new Error(response.error));
        else resolve(response as T);
      });
    });
  }

  /**
   * Opens the socket connection.
   * @returns {Promise<void>} Resolves on connect.
   */
  private connectSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.once('connect', () => resolve());
      this.socket.once('connect_error', (err) => reject(err));
      this.socket.connect();
    });
  }

  /**
   * Full join flow: connect, load device, set up transports, publish media,
   * register server events, and consume what already exists.
   * @returns {Promise<void>} Resolves once joined and publishing.
   */
  async join(): Promise<void> {
    await this.connectSocket();
    const res = await this.request<JoinResponse>('join', { roomId: this.roomId, displayName: this.displayName });
    this.peerId = res.peerId;
    await this.device.load({ routerRtpCapabilities: res.rtpCapabilities });
    await this.createSendTransport();
    await this.createRecvTransport();
    this.registerServerEvents();
    await this.produceLocalMedia();
    res.peers.forEach((peer) => this.ensureRemote(peer.peerId, peer.displayName));
    for (const producer of res.producers) {
      await this.consume(producer.producerId, producer.peerId, producer.displayName, producer.source);
    }
    this.onChange();
  }

  /**
   * Creates the send transport and wires its connect/produce signaling.
   * @returns {Promise<void>} Resolves once created.
   */
  private async createSendTransport(): Promise<void> {
    const params = await this.request<TransportParams>('createWebRtcTransport', { direction: 'send' });
    this.sendTransport = this.device.createSendTransport(params);
    this.sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
      this.request('connectTransport', { transportId: this.sendTransport!.id, dtlsParameters })
        .then(() => callback())
        .catch(errback);
    });
    this.sendTransport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
      this.request<{ id: string }>('produce', {
        transportId: this.sendTransport!.id,
        kind,
        rtpParameters,
        source: (appData as { source?: string }).source ?? 'webcam',
      })
        .then(({ id }) => callback({ id }))
        .catch(errback);
    });
  }

  /**
   * Creates the recv transport and wires its connect signaling.
   * @returns {Promise<void>} Resolves once created.
   */
  private async createRecvTransport(): Promise<void> {
    const params = await this.request<TransportParams>('createWebRtcTransport', { direction: 'recv' });
    this.recvTransport = this.device.createRecvTransport(params);
    this.recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
      this.request('connectTransport', { transportId: this.recvTransport!.id, dtlsParameters })
        .then(() => callback())
        .catch(errback);
    });
  }

  /**
   * Captures mic + camera and produces them, using simulcast layers for video.
   * @returns {Promise<void>} Resolves once producing.
   */
  private async produceLocalMedia(): Promise<void> {
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { width: { ideal: 640 }, height: { ideal: 360 } },
    });
    const audioTrack = this.localStream.getAudioTracks()[0];
    const videoTrack = this.localStream.getVideoTracks()[0];
    if (audioTrack) {
      const producer = await this.sendTransport!.produce({ track: audioTrack, appData: { source: 'mic' } });
      this.producers.set('mic', producer);
    }
    if (videoTrack) {
      const producer = await this.sendTransport!.produce({
        track: videoTrack,
        encodings: [
          { maxBitrate: 100_000, scaleResolutionDownBy: 4 },
          { maxBitrate: 300_000, scaleResolutionDownBy: 2 },
          { maxBitrate: 900_000 },
        ],
        codecOptions: { videoGoogleStartBitrate: 1000 },
        appData: { source: 'webcam' },
      });
      this.producers.set('webcam', producer);
    }
  }

  /**
   * Consumes a remote producer (paused) and attaches its track. Audio is
   * resumed immediately; video defers to the last-N reconciler.
   * @param {string} producerId Remote producer id.
   * @param {string} peerId Owning peer id.
   * @param {string} displayName Owning peer display name.
   * @param {string} source Media source (mic/webcam/screen).
   * @returns {Promise<void>} Resolves once consuming.
   */
  private async consume(producerId: string, peerId: string, displayName: string, source: string): Promise<void> {
    if (!this.recvTransport) return;
    const data = await this.request<{ id: string; producerId: string; kind: types.MediaKind; rtpParameters: types.RtpParameters }>('consume', {
      transportId: this.recvTransport.id,
      producerId,
      rtpCapabilities: this.device.rtpCapabilities,
    });
    const consumer = await this.recvTransport.consume({ id: data.id, producerId: data.producerId, kind: data.kind, rtpParameters: data.rtpParameters });
    const entry: ConsumerEntry = { consumer, peerId, kind: data.kind, source, resumed: false, preferredSpatial: -1 };
    this.consumers.set(consumer.id, entry);
    this.ensureRemote(peerId, displayName).stream.addTrack(consumer.track);
    consumer.on('transportclose', () => this.consumers.delete(consumer.id));
    if (data.kind === 'audio') {
      entry.resumed = true;
      await this.request('resumeConsumer', { consumerId: consumer.id });
      this.onChange();
    } else {
      this.recent = [peerId, ...this.recent.filter((id) => id !== peerId)].slice(0, 64);
      this.reconcileLastN();
    }
  }

  /**
   * Returns the remote entry for a peer, creating it if needed.
   * @param {string} peerId Peer id.
   * @param {string} displayName Peer display name.
   * @returns {{peerId: string, displayName: string, stream: MediaStream}} The entry.
   */
  private ensureRemote(peerId: string, displayName: string): { peerId: string; displayName: string; stream: MediaStream } {
    let entry = this.remote.get(peerId);
    if (!entry) {
      entry = { peerId, displayName, stream: new MediaStream() };
      this.remote.set(peerId, entry);
    }
    return entry;
  }

  /**
   * Applies the last-N policy: rank video peers (pinned, active speaker, then
   * recency) and resume only the top N video consumers; pause the rest. Screen
   * shares are always shown. Adjusts the preferred simulcast layer per tile.
   * @returns {void}
   */
  private reconcileLastN(): void {
    const webcamPeers = new Set<string>();
    for (const entry of this.consumers.values()) {
      if (entry.kind === 'video' && entry.source !== 'screen') webcamPeers.add(entry.peerId);
    }
    const order: string[] = [];
    const push = (id: string | null) => {
      if (id && webcamPeers.has(id) && !order.includes(id)) order.push(id);
    };
    this.pinned.forEach(push);
    push(this.activeSpeakerId);
    this.recent.forEach(push);
    webcamPeers.forEach(push);
    const visible = new Set(order.slice(0, this.maxVideo));
    for (const entry of this.consumers.values()) {
      if (entry.kind !== 'video') continue;
      this.applyConsumerVisibility(entry, entry.source === 'screen' || visible.has(entry.peerId));
    }
    this.onChange();
  }

  /**
   * Resumes/pauses a single video consumer and sets its preferred layer.
   * @param {ConsumerEntry} entry Consumer entry.
   * @param {boolean} show Whether the tile should show live video.
   * @returns {void}
   */
  private applyConsumerVisibility(entry: ConsumerEntry, show: boolean): void {
    if (show && !entry.resumed) {
      entry.resumed = true;
      void this.request('resumeConsumer', { consumerId: entry.consumer.id }).catch(() => undefined);
    } else if (!show && entry.resumed) {
      entry.resumed = false;
      void this.request('pauseConsumer', { consumerId: entry.consumer.id }).catch(() => undefined);
    }
    if (!show) return;
    const high = entry.source === 'screen' || this.pinned.has(entry.peerId) || this.activeSpeakerId === entry.peerId;
    const desired = high ? 2 : 0;
    if (entry.preferredSpatial !== desired) {
      entry.preferredSpatial = desired;
      void this.request('setPreferredLayers', { consumerId: entry.consumer.id, spatialLayer: desired }).catch(() => undefined);
    }
  }

  /**
   * Registers server-pushed events (peers, producers, active speaker, closures).
   * @returns {void}
   */
  private registerServerEvents(): void {
    this.socket.on('newPeer', (data: { peerId: string; displayName: string }) => {
      this.ensureRemote(data.peerId, data.displayName);
      this.onChange();
    });
    this.socket.on('newProducer', (data: { producerId: string; peerId: string; displayName: string; source: string }) => {
      void this.consume(data.producerId, data.peerId, data.displayName, data.source);
    });
    this.socket.on('activeSpeaker', (data: { peerId: string | null }) => {
      this.activeSpeakerId = data.peerId;
      if (data.peerId) this.recent = [data.peerId, ...this.recent.filter((id) => id !== data.peerId)].slice(0, 64);
      this.reconcileLastN();
    });
    this.socket.on('producerClosed', (data: { producerId: string; peerId: string }) => this.onProducerClosed(data));
    this.socket.on('peerClosed', (data: { peerId: string }) => this.onPeerClosed(data.peerId));
    this.socket.on('consumerClosed', (data: { consumerId: string }) => {
      const entry = this.consumers.get(data.consumerId);
      if (entry) {
        entry.consumer.close();
        this.consumers.delete(data.consumerId);
      }
      this.onChange();
    });
  }

  /**
   * Removes the consumer for a closed remote producer.
   * @param {{producerId: string, peerId: string}} data Event payload.
   * @returns {void}
   */
  private onProducerClosed(data: { producerId: string; peerId: string }): void {
    for (const [id, entry] of this.consumers) {
      if (entry.consumer.producerId !== data.producerId) continue;
      const remote = this.remote.get(data.peerId);
      if (remote) remote.stream.removeTrack(entry.consumer.track);
      entry.consumer.close();
      this.consumers.delete(id);
    }
    this.reconcileLastN();
  }

  /**
   * Removes a peer that left, closing its consumers and clearing its state.
   * @param {string} peerId Peer id.
   * @returns {void}
   */
  private onPeerClosed(peerId: string): void {
    for (const [id, entry] of this.consumers) {
      if (entry.peerId !== peerId) continue;
      entry.consumer.close();
      this.consumers.delete(id);
    }
    this.remote.delete(peerId);
    this.pinned.delete(peerId);
    this.recent = this.recent.filter((id) => id !== peerId);
    this.reconcileLastN();
  }

  /**
   * Toggles the microphone producer.
   * @returns {void}
   */
  toggleMic(): void {
    const producer = this.producers.get('mic');
    if (!producer) return;
    this.micEnabled = producer.paused;
    if (producer.paused) producer.resume();
    else producer.pause();
    this.onChange();
  }

  /**
   * Toggles the camera producer.
   * @returns {void}
   */
  toggleCam(): void {
    const producer = this.producers.get('webcam');
    if (!producer) return;
    this.camEnabled = producer.paused;
    if (producer.paused) producer.resume();
    else producer.pause();
    this.onChange();
  }

  /**
   * Pins/unpins a peer so its video stays in the last-N visible set.
   * @param {string} peerId Peer id to toggle.
   * @returns {void}
   */
  togglePin(peerId: string): void {
    if (this.pinned.has(peerId)) this.pinned.delete(peerId);
    else this.pinned.add(peerId);
    this.reconcileLastN();
  }

  /**
   * Starts or stops screen sharing.
   * @returns {Promise<void>} Resolves once the share state changes.
   */
  async toggleScreen(): Promise<void> {
    if (this.screenSharing) {
      const producer = this.producers.get('screen');
      if (producer) {
        await this.request('closeProducer', { producerId: producer.id });
        producer.close();
        this.producers.delete('screen');
      }
      this.screenStream?.getTracks().forEach((track) => track.stop());
      this.screenStream = undefined;
      this.screenSharing = false;
      this.onChange();
      return;
    }
    this.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const track = this.screenStream.getVideoTracks()[0];
    const producer = await this.sendTransport!.produce({ track, appData: { source: 'screen' } });
    this.producers.set('screen', producer);
    track.onended = () => void this.toggleScreen();
    this.screenSharing = true;
    this.onChange();
  }

  /**
   * @returns {MediaStream|undefined} Local camera/mic stream.
   */
  getLocalStream(): MediaStream | undefined {
    return this.localStream;
  }

  /**
   * @param {string} peerId Peer id.
   * @returns {boolean} True if the peer has a resumed video consumer.
   */
  private hasResumedVideo(peerId: string): boolean {
    for (const entry of this.consumers.values()) {
      if (entry.peerId === peerId && entry.kind === 'video' && entry.resumed) return true;
    }
    return false;
  }

  /**
   * @returns {RemoteStream[]} Remote peers enriched with last-N/active-speaker UI state.
   */
  getRemoteStreams(): RemoteStream[] {
    return [...this.remote.values()].map((entry) => ({
      peerId: entry.peerId,
      displayName: entry.displayName,
      stream: entry.stream,
      videoActive: this.hasResumedVideo(entry.peerId),
      speaking: this.activeSpeakerId === entry.peerId,
      pinned: this.pinned.has(entry.peerId),
    }));
  }

  /**
   * Tears down all media and disconnects.
   * @returns {void}
   */
  leave(): void {
    this.producers.forEach((producer) => producer.close());
    this.consumers.forEach((entry) => entry.consumer.close());
    this.sendTransport?.close();
    this.recvTransport?.close();
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.screenStream?.getTracks().forEach((track) => track.stop());
    this.socket.disconnect();
  }
}
