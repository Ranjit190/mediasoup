# Group Video Call Platform

A Google-Meet-style group video-call app built on an **SFU** architecture:

- **Frontend** — Next.js + TypeScript (`apps/web`) using `mediasoup-client`.
- **Backend** — Node.js + TypeScript (`apps/server`): mediasoup SFU + Socket.IO
  signaling, with optional Redis (cross-pod fan-out) and Kafka (call events).
- **Infra** — plain Kubernetes manifests (`deploy/k8s/video-call.yaml`) and an
  eksctl config (`deploy/eksctl`) for AWS EKS.

See `VIDEO_CALL_ARCHITECTURE_PLAN.md` for the full architecture and roadmap.

```
.
├── apps/
│   ├── server/        # mediasoup SFU + Socket.IO signaling (Node + TS)
│   └── web/           # Next.js client (TS + mediasoup-client)
├── deploy/
│   ├── k8s/video-call.yaml # plain Kubernetes manifests
│   └── eksctl/cluster.yaml # EKS cluster + node groups
└── docker-compose.yml      # local Redis + Kafka (optional)
```

## Run locally

Requires Node.js 20+. mediasoup compiles a native worker on install, so on Linux
you need `python3` and a build toolchain (`build-essential`).

```bash
# 1. Backend
cd apps/server
cp .env.example .env          # defaults are fine for local (Redis/Kafka off)
npm install
npm run dev                   # http://localhost:4000

# 2. Frontend (new terminal)
cd apps/web
cp .env.local.example .env.local
npm install
npm run dev                   # http://localhost:3000
```

Open `http://localhost:3000`, pick a name + room, and join. Open a second tab
(or another machine on the LAN) with the same room id to see multi-party video.

> Browsers require **HTTPS** for camera/mic on non-localhost origins. `localhost`
> is exempt, so local testing works over plain HTTP.

### Optional: Redis + Kafka + MongoDB locally (Docker)

The media server itself runs natively (WebRTC UDP), but the backing services run
fine in Docker:

```bash
docker compose up -d   # redis:6379, kafka:9092 (apache/kafka), mongo:27017
docker compose ps      # confirm all three are Up
```

Then enable them in `apps/server/.env` and restart the server:

```bash
ENABLE_REDIS=true      # Socket.IO adapter (cross-pod fan-out)
ENABLE_KAFKA=true      # publishes call events to the 'call-events' topic
ENABLE_MONGO=true      # persists call events + per-room meeting summaries
```

What gets stored in Mongo (db `videocall`): an `events` collection (one doc per
join/leave/produce) and a `meetings` collection (one upserted summary per room).
Inspect with `docker exec -it vi-mongo-1 mongosh videocall`.

Stop everything with `docker compose down` (add `-v` to also wipe Mongo data).

> **Port 27017 already in use?** You likely have a local MongoDB running. Either
> stop it, or remap the container (e.g. `"27018:27017"` in `docker-compose.yml`
> and set `MONGO_URI=mongodb://127.0.0.1:27018`).

## How the call works (signaling flow)

1. Client connects (WebSocket) and emits `join` → server creates/returns the
   room's mediasoup **Router RTP capabilities** + existing producers.
2. Client loads a `Device`, then creates **send** and **recv** WebRtcTransports
   (`createWebRtcTransport` → `connectTransport`).
3. Client **produces** mic + camera (camera uses 3 **simulcast** layers).
4. For every other participant's producer the client **consumes** it and renders
   the track. New joiners/producers arrive via `newPeer` / `newProducer` events.

## Deploy to Kubernetes

Plain manifests live in `deploy/k8s/video-call.yaml` (namespace, Redis, Kafka,
MongoDB, the combined signaling/SFU server, and the web app):

```bash
# 1. Build the images and make them available to the cluster
docker build -t video-call/server:0.1.0 apps/server
docker build -t video-call/web:0.1.0 apps/web   # portable: backend URL set at runtime
# local clusters: kind load docker-image ... / minikube image load ...

# 2. Set the backend URL the browser uses: edit SERVER_URL in the ConfigMap, then
kubectl apply -f deploy/k8s/video-call.yaml
kubectl -n video-call get pods
```

Web app at `http://<NODE_IP>:30300`; signaling + media at `<NODE_IP>:4000`. The
hard part — WebRTC media (UDP) on Kubernetes — is handled by running the server on
`hostNetwork` and announcing the node IP to mediasoup. Full notes (including AWS
EKS specifics) in `deploy/k8s/README.md`; `deploy/eksctl/cluster.yaml` provisions
an EKS cluster if you need one.

## Big-room scaling (implemented)

This is what makes 100–500-participant rooms viable:

- **Multi-router sharding (PipeTransport).** A room starts on one router; once its
  routers fill (`MAX_PEERS_PER_ROUTER`), it spins a new router on the next worker
  (one router per worker, since `pipeToRouter` requires distinct workers) and
  spreads peers across them. When a peer consumes a producer that lives on another
  router, the server pipes it across **on demand** (`Room.ensureProducerPipedTo`),
  so every peer can see every other peer regardless of router. This uses all cores
  of an SFU node for a single large room.
- **Active-speaker detection.** Each router runs an `AudioLevelObserver`; the room
  aggregates them into a single room-wide dominant speaker and broadcasts
  `activeSpeaker` to all clients.
- **Last-N video.** The client keeps only the **N most-relevant** video consumers
  resumed (pinned tiles → active speaker → recency; screen shares always on) and
  **pauses the rest** server-side, so a 200-person room only decodes ~9 videos.
  The active speaker / pinned tiles also request the **top simulcast layer**
  (`setPreferredLayers`) while thumbnails use the lowest — saving bandwidth.

### Verified

The sharding primitive is covered by a runtime check (produce on router A → not
consumable on router B → pipe → consumable), and both apps type-check and build.

## Scaling notes (next tiers)

- **Signaling** is stateless and HPA-scaled; the Redis Socket.IO adapter lets any
  pod serve any client.
- **Cross-node rooms.** Within-process sharding uses one node's cores. To span a
  single room across multiple SFU **pods**, extend `ensureProducerPipedTo` to use
  networked `PipeTransport` (create pipe transports on each node, exchange their
  IP/port via Redis, and connect) — the `Room` abstraction is already multi-router
  so this slots in at the piping layer.
