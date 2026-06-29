import { EventEmitter } from 'events';
import * as mediasoup from 'mediasoup';
import { Peer, ProducerInfo } from './types';
import { logger } from '../logger';

export interface RoomOptions {
  maxPeersPerRouter: number;
  maxRouters: number;
  createRouter: (workerIndex: number) => Promise<mediasoup.types.Router>;
}

interface RouterEntry {
  router: mediasoup.types.Router;
  audioLevelObserver: mediasoup.types.AudioLevelObserver;
  peerCount: number;
  loudest: { peerId: string; volume: number } | null;
}

/**
 * A single call. Holds one or more mediasoup routers (sharded across workers)
 * and the peers on them. Producers are piped between routers on demand so any
 * peer can consume any producer regardless of which router it lives on.
 * Emits "broadcast" with (event, payload) for room-wide pushes (active speaker).
 */
export class Room extends EventEmitter {
  public readonly id: string;
  private readonly opts: RoomOptions;
  private readonly peers = new Map<string, Peer>();
  private readonly routers = new Map<string, RouterEntry>();
  private readonly producerHomeRouter = new Map<string, string>();
  private readonly pipedKeys = new Set<string>();
  private activeSpeakerId: string | null = null;

  /**
   * @param {string} id Room id.
   * @param {RoomOptions} opts Sharding limits and router factory.
   */
  constructor(id: string, opts: RoomOptions) {
    super();
    this.id = id;
    this.opts = opts;
  }

  /**
   * Creates a new router (on the next worker index) plus its AudioLevelObserver,
   * wired to feed room-wide active-speaker aggregation.
   * @returns {Promise<string>} The new router's id.
   */
  private async createRouterEntry(): Promise<string> {
    const router = await this.opts.createRouter(this.routers.size);
    const audioLevelObserver = await router.createAudioLevelObserver({ maxEntries: 1, threshold: -50, interval: 800 });
    const entry: RouterEntry = { router, audioLevelObserver, peerCount: 0, loudest: null };
    audioLevelObserver.on('volumes', (volumes) => {
      const top = volumes[0];
      const peerId = (top.producer.appData as { peerId?: string }).peerId;
      entry.loudest = peerId ? { peerId, volume: top.volume } : null;
      this.recomputeActiveSpeaker();
    });
    audioLevelObserver.on('silence', () => {
      entry.loudest = null;
      this.recomputeActiveSpeaker();
    });
    this.routers.set(router.id, entry);
    logger.info('router added to room', JSON.stringify({ roomId: this.id, routers: this.routers.size }));
    return router.id;
  }

  /**
   * Picks the least-loaded router under the per-router cap, sharding to a new
   * worker when all current routers are full (until maxRouters is reached).
   * @returns {Promise<string>} Router id for a newly joining peer.
   */
  async assignRouterForNewPeer(): Promise<string> {
    let best: { id: string; count: number } | null = null;
    for (const [id, entry] of this.routers) {
      if (entry.peerCount < this.opts.maxPeersPerRouter && (!best || entry.peerCount < best.count)) {
        best = { id, count: entry.peerCount };
      }
    }
    let routerId = best?.id;
    if (!routerId) {
      routerId = this.routers.size < this.opts.maxRouters
        ? await this.createRouterEntry()
        : this.leastLoadedRouterId();
    }
    this.routers.get(routerId)!.peerCount += 1;
    return routerId;
  }

  /**
   * @returns {string} Id of the globally least-loaded router (fallback when capped).
   */
  private leastLoadedRouterId(): string {
    let best: { id: string; count: number } | null = null;
    for (const [id, entry] of this.routers) {
      if (!best || entry.peerCount < best.count) best = { id, count: entry.peerCount };
    }
    return best!.id;
  }

  /**
   * @param {string} routerId Router id.
   * @returns {mediasoup.types.Router} The router.
   */
  getRouter(routerId: string): mediasoup.types.Router {
    const entry = this.routers.get(routerId);
    if (!entry) throw new Error('router not found');
    return entry.router;
  }

  /**
   * Records a producer's home router and registers audio producers with that
   * router's AudioLevelObserver for active-speaker detection.
   * @param {string} producerId Producer id.
   * @param {string} routerId Home router id.
   * @param {mediasoup.types.MediaKind} kind Producer kind.
   * @returns {void}
   */
  registerProducer(producerId: string, routerId: string, kind: mediasoup.types.MediaKind): void {
    this.producerHomeRouter.set(producerId, routerId);
    if (kind === 'audio') {
      void this.routers.get(routerId)?.audioLevelObserver.addProducer({ producerId })
        .catch((err) => logger.warn('addProducer failed', JSON.stringify({ error: String(err) })));
    }
  }

  /**
   * Ensures a producer is available on the target router, piping it across
   * workers once (idempotent) so peers on that router can consume it.
   * @param {string} producerId Producer id.
   * @param {string} targetRouterId Router that needs the producer.
   * @returns {Promise<void>} Resolves once piped (or already present).
   */
  async ensureProducerPipedTo(producerId: string, targetRouterId: string): Promise<void> {
    const homeRouterId = this.producerHomeRouter.get(producerId);
    if (!homeRouterId || homeRouterId === targetRouterId) return;
    const key = `${producerId}=>${targetRouterId}`;
    if (this.pipedKeys.has(key)) return;
    const home = this.routers.get(homeRouterId)?.router;
    const target = this.routers.get(targetRouterId)?.router;
    if (!home || !target) return;
    await home.pipeToRouter({ producerId, router: target });
    this.pipedKeys.add(key);
  }

  /**
   * Recomputes the room-wide active speaker from each router's loudest entry
   * and broadcasts a change.
   * @returns {void}
   */
  private recomputeActiveSpeaker(): void {
    let winner: { peerId: string; volume: number } | null = null;
    for (const entry of this.routers.values()) {
      if (entry.loudest && (!winner || entry.loudest.volume > winner.volume)) winner = entry.loudest;
    }
    const next = winner ? winner.peerId : null;
    if (next !== this.activeSpeakerId) {
      this.activeSpeakerId = next;
      this.emit('broadcast', 'activeSpeaker', { peerId: next });
    }
  }

  /**
   * Adds a peer to the room.
   * @param {Peer} peer Peer to add.
   * @returns {void}
   */
  addPeer(peer: Peer): void {
    this.peers.set(peer.id, peer);
  }

  /**
   * @param {string} peerId Peer id.
   * @returns {Peer|undefined} The peer, if present.
   */
  getPeer(peerId: string): Peer | undefined {
    return this.peers.get(peerId);
  }

  /**
   * @param {string} excludePeerId Peer id to exclude.
   * @returns {Peer[]} Other peers.
   */
  otherPeers(excludePeerId: string): Peer[] {
    return [...this.peers.values()].filter((peer) => peer.id !== excludePeerId);
  }

  /**
   * Lists every producer in the room except the given peer's.
   * @param {string} excludePeerId Peer id to exclude.
   * @returns {ProducerInfo[]} Producer metadata for consumption.
   */
  existingProducers(excludePeerId: string): ProducerInfo[] {
    const list: ProducerInfo[] = [];
    for (const peer of this.otherPeers(excludePeerId)) {
      for (const producer of peer.producers.values()) {
        list.push({
          producerId: producer.id,
          peerId: peer.id,
          displayName: peer.displayName,
          kind: producer.kind,
          source: (producer.appData.source as ProducerInfo['source']) ?? 'webcam',
        });
      }
    }
    return list;
  }

  /**
   * Closes a peer's transports, frees its router slot, and forgets its
   * producers' pipe state.
   * @param {string} peerId Peer id to remove.
   * @returns {Peer|undefined} The removed peer, if it existed.
   */
  removePeer(peerId: string): Peer | undefined {
    const peer = this.peers.get(peerId);
    if (!peer) return undefined;
    for (const producerId of peer.producers.keys()) {
      this.producerHomeRouter.delete(producerId);
      for (const key of [...this.pipedKeys]) {
        if (key.startsWith(`${producerId}=>`)) this.pipedKeys.delete(key);
      }
    }
    for (const transport of peer.transports.values()) transport.close();
    const entry = this.routers.get(peer.routerId);
    if (entry) entry.peerCount = Math.max(0, entry.peerCount - 1);
    this.peers.delete(peerId);
    return peer;
  }

  /**
   * @returns {boolean} True when no peers remain.
   */
  isEmpty(): boolean {
    return this.peers.size === 0;
  }

  /**
   * Closes every router (and observers) owned by the room.
   * @returns {void}
   */
  close(): void {
    for (const entry of this.routers.values()) entry.router.close();
  }
}
