import * as mediasoup from 'mediasoup';
import type { Server, Socket } from 'socket.io';
import { getOrCreateRoom, disposeRoom } from '../rooms/roomManager';
import { Room } from '../rooms/Room';
import { Peer } from '../rooms/types';
import { createWebRtcTransport } from '../mediasoup/webrtcTransport';
import { emitCallEvent } from '../kafka/producer';
import { logger } from '../logger';

type Ack = (response: unknown) => void;

const wiredRooms = new WeakSet<Room>();

/**
 * Wraps an async handler so thrown errors are returned via the ack callback
 * instead of crashing the socket.
 * @param {(data: any) => Promise<unknown>} handler The handler logic.
 * @returns {(data: any, ack: Ack) => void} Socket.IO-compatible listener.
 */
function withAck(handler: (data: any) => Promise<unknown>): (data: any, ack: Ack) => void {
  return (data: any, ack: Ack) => {
    Promise.resolve(handler(data))
      .then((result) => ack?.(result ?? {}))
      .catch((err) => {
        logger.error('handler error', JSON.stringify({ error: String(err) }));
        ack?.({ error: err instanceof Error ? err.message : String(err) });
      });
  };
}

/**
 * Resolves the room + peer bound to a socket, throwing if not joined.
 * @param {Socket} socket The socket.
 * @returns {Promise<{room: Room, peer: Peer}>} Bound room and peer.
 */
async function context(socket: Socket): Promise<{ room: Room; peer: Peer }> {
  const roomId = socket.data.roomId as string | undefined;
  const peerId = socket.data.peerId as string | undefined;
  if (!roomId || !peerId) throw new Error('not joined');
  const room = await getOrCreateRoom(roomId);
  const peer = room.getPeer(peerId);
  if (!peer) throw new Error('peer not found');
  return { room, peer };
}

/**
 * Forwards a room's broadcast events (e.g. active speaker) to its Socket.IO
 * room, wiring each Room instance exactly once.
 * @param {Server} io Socket.IO server.
 * @param {Room} room The room.
 * @returns {void}
 */
function wireRoomBroadcast(io: Server, room: Room): void {
  if (wiredRooms.has(room)) return;
  room.on('broadcast', (event: string, payload: unknown) => io.to(room.id).emit(event, payload));
  wiredRooms.add(room);
}

/**
 * Registers all signaling event handlers on the Socket.IO server.
 * @param {Server} io Socket.IO server.
 * @returns {void}
 */
export function registerSocketHandlers(io: Server): void {
  io.on('connection', (socket: Socket) => {
    logger.info('socket connected', JSON.stringify({ socketId: socket.id }));

    socket.on('join', withAck(async (data: { roomId: string; displayName: string }) => {
      const room = await getOrCreateRoom(data.roomId);
      wireRoomBroadcast(io, room);
      const routerId = await room.assignRouterForNewPeer();
      const peer: Peer = {
        id: socket.id,
        socketId: socket.id,
        displayName: data.displayName || 'Guest',
        routerId,
        transports: new Map(),
        producers: new Map(),
        consumers: new Map(),
      };
      room.addPeer(peer);
      socket.data.roomId = data.roomId;
      socket.data.peerId = peer.id;
      await socket.join(data.roomId);
      socket.to(data.roomId).emit('newPeer', { peerId: peer.id, displayName: peer.displayName });
      await emitCallEvent('participant.joined', { roomId: data.roomId, peerId: peer.id });
      return {
        peerId: peer.id,
        rtpCapabilities: room.getRouter(routerId).rtpCapabilities,
        peers: room.otherPeers(peer.id).map((other) => ({ peerId: other.id, displayName: other.displayName })),
        producers: room.existingProducers(peer.id),
      };
    }));

    socket.on('createWebRtcTransport', withAck(async (data: { direction: 'send' | 'recv' }) => {
      const { room, peer } = await context(socket);
      const { transport, params } = await createWebRtcTransport(room.getRouter(peer.routerId));
      peer.transports.set(transport.id, transport);
      return { direction: data.direction, ...params };
    }));

    socket.on('connectTransport', withAck(async (data: { transportId: string; dtlsParameters: mediasoup.types.DtlsParameters }) => {
      const { peer } = await context(socket);
      const transport = peer.transports.get(data.transportId);
      if (!transport) throw new Error('transport not found');
      await transport.connect({ dtlsParameters: data.dtlsParameters });
      return { connected: true };
    }));

    socket.on('produce', withAck(async (data: { transportId: string; kind: mediasoup.types.MediaKind; rtpParameters: mediasoup.types.RtpParameters; source: string }) => {
      const { room, peer } = await context(socket);
      const transport = peer.transports.get(data.transportId);
      if (!transport) throw new Error('transport not found');
      const producer = await transport.produce({
        kind: data.kind,
        rtpParameters: data.rtpParameters,
        appData: { peerId: peer.id, source: data.source },
      });
      peer.producers.set(producer.id, producer);
      room.registerProducer(producer.id, peer.routerId, producer.kind);
      socket.to(room.id).emit('newProducer', {
        producerId: producer.id,
        peerId: peer.id,
        displayName: peer.displayName,
        kind: producer.kind,
        source: data.source,
      });
      await emitCallEvent('producer.created', { roomId: room.id, peerId: peer.id, kind: producer.kind });
      return { id: producer.id };
    }));

    socket.on('consume', withAck(async (data: { transportId: string; producerId: string; rtpCapabilities: mediasoup.types.RtpCapabilities }) => {
      const { room, peer } = await context(socket);
      await room.ensureProducerPipedTo(data.producerId, peer.routerId);
      const router = room.getRouter(peer.routerId);
      if (!router.canConsume({ producerId: data.producerId, rtpCapabilities: data.rtpCapabilities })) {
        throw new Error('cannot consume');
      }
      const transport = peer.transports.get(data.transportId);
      if (!transport) throw new Error('transport not found');
      const consumer = await transport.consume({ producerId: data.producerId, rtpCapabilities: data.rtpCapabilities, paused: true });
      peer.consumers.set(consumer.id, consumer);
      consumer.on('producerclose', () => {
        peer.consumers.delete(consumer.id);
        socket.emit('consumerClosed', { consumerId: consumer.id });
      });
      return { id: consumer.id, producerId: data.producerId, kind: consumer.kind, rtpParameters: consumer.rtpParameters };
    }));

    socket.on('resumeConsumer', withAck(async (data: { consumerId: string }) => {
      const { peer } = await context(socket);
      const consumer = peer.consumers.get(data.consumerId);
      if (!consumer) throw new Error('consumer not found');
      await consumer.resume();
      return { resumed: true };
    }));

    socket.on('pauseConsumer', withAck(async (data: { consumerId: string }) => {
      const { peer } = await context(socket);
      const consumer = peer.consumers.get(data.consumerId);
      if (!consumer) throw new Error('consumer not found');
      await consumer.pause();
      return { paused: true };
    }));

    socket.on('setPreferredLayers', withAck(async (data: { consumerId: string; spatialLayer: number; temporalLayer?: number }) => {
      const { peer } = await context(socket);
      const consumer = peer.consumers.get(data.consumerId);
      if (!consumer) throw new Error('consumer not found');
      await consumer.setPreferredLayers({ spatialLayer: data.spatialLayer, temporalLayer: data.temporalLayer });
      return { ok: true };
    }));

    socket.on('closeProducer', withAck(async (data: { producerId: string }) => {
      const { room, peer } = await context(socket);
      const producer = peer.producers.get(data.producerId);
      if (!producer) throw new Error('producer not found');
      producer.close();
      peer.producers.delete(data.producerId);
      socket.to(room.id).emit('producerClosed', { producerId: data.producerId, peerId: peer.id });
      return { closed: true };
    }));

    socket.on('disconnect', () => {
      const roomId = socket.data.roomId as string | undefined;
      const peerId = socket.data.peerId as string | undefined;
      if (!roomId || !peerId) return;
      void (async () => {
        const room = await getOrCreateRoom(roomId);
        room.removePeer(peerId);
        socket.to(roomId).emit('peerClosed', { peerId });
        await emitCallEvent('participant.left', { roomId, peerId });
        if (room.isEmpty()) disposeRoom(roomId);
        logger.info('socket disconnected', JSON.stringify({ socketId: socket.id, roomId, peerId }));
      })();
    });
  });
}
