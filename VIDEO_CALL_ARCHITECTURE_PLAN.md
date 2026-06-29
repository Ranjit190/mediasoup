# Group Video Call Platform — Architecture & Software Plan
*(Google-Meet-style, 100–500 participants per call, Node.js + Kubernetes)*

## 1. Decision summary

| Concern | Decision |
|---|---|
| Media topology | **SFU** (Selective Forwarding Unit) — mandatory for 100+ |
| SFU library | **mediasoup** (Node.js, C++ core) |
| Signaling | Node.js + WebSocket (Socket.IO or `ws`) |
| Shared state / fan-out | **Redis** (presence, room→SFU map, pub/sub, socket adapter) |
| Event streaming | **Kafka** (analytics, recording triggers, chat persistence, audit) — *never in the media path* |
| NAT traversal | **coturn** (STUN + TURN) |
| Metadata DB | PostgreSQL |
| Orchestration | Kubernetes (plain manifests) + HPA |
| Observability | Prometheus + Grafana + Loki |

> **Alternative if time-to-market matters more than control:** LiveKit (Go, K8s-native, Node SDK) or Jitsi Meet (full product, Java SFU). mediasoup is chosen here because you want to own the scaling.

## 2. The 100–500 reality (drives the whole design)

- 500 people sending HD video simultaneously is impractical (bandwidth + fan-out explosion).
- **Show only ~9–25 videos at a time** ("last-N") + **active-speaker detection**; everyone else audio-only until they speak.
- **Simulcast**: each sender publishes 3 spatial layers (e.g. 180p/360p/720p); SFU forwards the right layer per receiver based on their bandwidth and on-screen size.
- A big room is **sharded across multiple SFU instances** connected by **PipeTransport** (SFU-to-SFU). No single SFU process should carry 500 peers.
- **Audio-only tier** for large town-hall style calls.

## 3. System components

```
                         ┌────────────────────────┐
   Browser (React)  ◄────┤   HTTP/WS Ingress       │  (auth, signaling)
   mediasoup-client      │  (nginx / Traefik)      │
        │                └──────────┬─────────────┘
        │                           │
        │              ┌────────────▼─────────────┐
        │              │  Signaling Service (Node) │  stateless, HPA-scaled
        │              │  Socket.IO + Redis adapter│
        │              └─────┬───────────────┬────┘
        │   media (UDP/SRTP) │  Redis pub/sub │ Kafka events
        │   bypasses ingress │                │
        ▼                    ▼                ▼
┌──────────────────┐   ┌──────────┐    ┌──────────────┐
│  SFU media nodes │   │  Redis   │    │    Kafka     │
│  Node + mediasoup│   │ presence │    │ analytics /  │
│  (public UDP)    │   │ room map │    │ recording /  │
│  PipeTransport   │   └──────────┘    │ chat / audit │
│  between nodes   │                   └──────┬───────┘
└────────┬─────────┘                          │
         │                            ┌────────▼────────┐
   ┌─────▼──────┐                     │ Consumers:      │
   │  coturn    │  TURN relay         │ recording svc,  │
   │  (public)  │  for blocked NATs   │ analytics, etc. │
   └────────────┘                     └─────────────────┘

   PostgreSQL: users, rooms, meetings, permissions
   Auth/API service (JWT): login, room create, schedule
```

### Service responsibilities
1. **Web client** — React + TypeScript + `mediasoup-client`. Captures media, renders grid, handles UI (mute, screen-share, layout, active speaker).
2. **Auth/API service (Node)** — JWT auth, room CRUD, scheduling, permissions. Backed by Postgres.
3. **Signaling service (Node)** — WebSocket. Orchestrates the mediasoup handshake (below). Stateless; scaled via HPA; uses Redis adapter so any pod can serve any socket.
4. **SFU media nodes (Node + mediasoup)** — the CPU-bound core. One mediasoup **Worker per CPU core**; **Routers** hold the room's RTP; **Transports/Producers/Consumers** per peer.
5. **Redis** — presence, `room → SFU node` mapping, pub/sub for cross-pod signaling, Socket.IO adapter.
6. **Kafka** — durable event log: `call.started`, `participant.joined/left`, `recording.requested`, chat messages, audit/analytics. Decouples slow/optional work from the live path.
7. **coturn** — STUN for discovery, TURN for relay when direct UDP fails (~10–20% of clients on strict NAT/firewalls). Bandwidth-heavy — size it.
8. **PostgreSQL** — durable metadata.
9. **Recording service (optional)** — mediasoup `PlainTransport` → ffmpeg, or headless-browser capture.

## 4. mediasoup signaling flow (per participant)

1. Client opens WS, authenticates (JWT), joins room.
2. Signaling picks/creates the room's **Router** on an SFU node; returns **Router RTP capabilities**.
3. Client loads a `Device` with those capabilities.
4. Client requests a **send transport** → server creates `WebRtcTransport`, returns ICE/DTLS params.
5. Client `connect()`s (DTLS) and **produces** audio + video → server creates **Producers**.
6. For each existing/other Producer, server creates a **Consumer**; client creates a **recv transport** and **consumes**.
7. New producers are announced via Redis pub/sub so all signaling pods notify their sockets.

## 5. Scaling strategy

**Vertical (per node):** mediasoup runs 1 Worker/core; route peers across workers/routers on the node.

**Horizontal (the real scaling):**
- `room → SFU node` map in Redis. New rooms placed on least-loaded node (track CPU, peer count, bitrate).
- **Big-room sharding:** split one room's participants across N SFU nodes; connect their Routers with **PipeTransport** so a producer on node A is consumable on node B. Each peer only connects to its local SFU.
- **Simulcast layer selection** per consumer by available bandwidth + on-screen tile size.
- **Last-N + active speaker:** only forward video for the top speakers / on-screen tiles; pause the rest (`consumer.pause()`).
- **Congestion control:** use mediasoup transport bitrate APIs + client-side bandwidth estimation.

## 6. Kubernetes deployment notes (read this — #1 gotcha)

**Media (RTP/SRTP over UDP) CANNOT go through an HTTP ingress or normal L7 load balancer.** SFU pods need **publicly reachable IP + UDP port range**, and mediasoup must `announcedIp` that public IP.

- **Signaling/API:** `Deployment` + **HPA**, stateless, Redis-backed, session affinity (sticky) on the WS ingress.
- **SFU:** one pod **per node** using `hostNetwork: true` (or a fixed NodePort UDP range), each announcing the node's public IP. Scale by adding nodes, not just pods. Use node anti-affinity.
- **coturn:** `Deployment`/`DaemonSet` with public IP, UDP + TCP/TLS fallback.
- **Redis / Kafka / Postgres:** prefer **managed** (ElastiCache/MSK/RDS or CloudSQL) for prod; for self-host use operators (Bitnami Redis, Strimzi Kafka, CloudNativePG).
- **Ingress (nginx/Traefik):** HTTP + WebSocket only. Media bypasses it.
- Deploy with **plain Kubernetes manifests** (`kubectl apply`); GitOps with ArgoCD optional.

## 7. Tech stack

- **Frontend:** React, TypeScript, `mediasoup-client`, `socket.io-client`.
- **Backend:** Node.js + TypeScript, `mediasoup`, `socket.io`, `ioredis`, `@socket.io/redis-adapter`, `kafkajs`.
- **DB/ORM:** PostgreSQL + Prisma (or Sequelize).
- **Infra:** Docker, Kubernetes (plain manifests), HPA, coturn.
- **Observability:** Prometheus + Grafana (mediasoup exposes stats), Loki/ELK logs, Sentry.
- **CI/CD:** GitHub Actions (+ ArgoCD optional).
- **Load testing:** KITE, or a fleet of headless-Chrome bot clients (puppeteer) to simulate hundreds of peers.

## 8. Data model (sketch)

- `users(id, email, name, password_hash, created_at)`
- `rooms(id, name, owner_id, type[meeting|webinar], max_participants, created_at)`
- `meetings(id, room_id, started_at, ended_at, recording_url)`
- `participants(id, meeting_id, user_id, joined_at, left_at, role[host|speaker|viewer])`
- `chat_messages(id, meeting_id, user_id, body, created_at)` (also streamed via Kafka)

## 9. Phased roadmap

| Phase | Goal | Key deliverables |
|---|---|---|
| **0. Spike** | Prove mediasoup | Local 1:1 call, mediasoup handshake working |
| **1. MVP** | Single SFU, ~30–50/room | Auth, room create/join, web grid UI, mute/leave |
| **2. Core features** | Real meeting feel | Screen share, chat, simulcast, active speaker, last-N |
| **3. Scale-out** | Multi-SFU | Redis state, room→SFU placement, PipeTransport sharding, coturn |
| **4. Kubernetes** | Cloud-ready | Dockerize, K8s manifests, HPA, monitoring, basic load test |
| **5. Big rooms** | 100–500 | Audio-only tier, broadcast mode, recording, Kafka analytics |
| **6. Hardening** | Production | Security, E2E load tests (bot fleet), cost tuning, SLOs |

## 10. Top risks & costs

- **Bandwidth/egress cost** is the dominant operating cost at 500-person scale — model it early (TURN relay traffic especially).
- **K8s + UDP media networking** is the hardest infra piece — solve it in Phase 4 with a spike, not at the end.
- **TURN sizing** — under-provisioning coturn breaks calls for users behind strict firewalls.
- **Active-speaker + last-N correctness** — get this right or the client melts trying to decode 100 videos.
- **Sticky sessions / Redis adapter** — required or signaling breaks across pods.

## 11. Immediate next steps

1. Phase 0 spike: stand up a single Node + mediasoup process, get a 2-person call working locally.
2. Decide hosting (AWS/GCP/bare metal) — affects public-IP/UDP and managed-service choices.
3. Lock the feature scope for MVP (Phase 1) and build the room/signaling skeleton.
