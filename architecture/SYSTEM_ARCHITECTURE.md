# Operation: Archipelago — End-to-End System Architecture

## 1. Full-Stack Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              PI BROWSER (iOS / Android WebView)                      │
│                                                                                       │
│  ┌─────────────────────────────────────────────────────────────────────────────┐    │
│  │                        PLAYCANVAS / WEBGL CLIENT ENGINE                      │    │
│  │                                                                               │    │
│  │   ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  ┌──────────────┐  │    │
│  │   │  Touch HUD   │  │  Game Loop   │  │  Asset Loader │  │  UI / React  │  │    │
│  │   │  Controller  │  │  (60 FPS)    │  │  (WASM/GLB)   │  │  Overlay     │  │    │
│  │   └──────┬───────┘  └──────┬───────┘  └───────┬───────┘  └──────┬───────┘  │    │
│  │          │                 │                   │                  │           │    │
│  │          └─────────────────┴───────────────────┴──────────────────┘           │    │
│  │                                      │                                         │    │
│  │                         ┌────────────▼────────────┐                           │    │
│  │                         │     CLIENT STATE MGR     │                           │    │
│  │                         │  (Zustand / Redux-like)  │                           │    │
│  │                         └────────────┬────────────┘                           │    │
│  │                                      │                                         │    │
│  │          ┌───────────────────────────┼───────────────────────────┐            │    │
│  │          │                           │                           │            │    │
│  │   ┌──────▼──────┐          ┌─────────▼─────────┐    ┌──────────▼─────────┐  │    │
│  │   │  Pi JS SDK  │          │  WebSocket Client  │    │   WebRTC Client    │  │    │
│  │   │ (Auth/Pay)  │          │  (Game + Nakama)   │    │  (Voice Channel)   │  │    │
│  │   └──────┬──────┘          └─────────┬─────────┘    └──────────┬─────────┘  │    │
│  └──────────┼──────────────────────────-┼────────────────────────-┼────────────┘    │
└─────────────┼────────────────────────── ┼ ──────────────────────  ┼ ─────────────────┘
              │                           │                          │
              │ HTTPS (TLS 1.3)           │ WSS / UDP                │ WebRTC DTLS
              ▼                           ▼                          ▼
┌─────────────────────┐    ┌─────────────────────────┐   ┌──────────────────────┐
│   PI NETWORK API    │    │  AWS / GCP EDGE LAYER    │   │  TURN / STUN SERVER  │
│                     │    │  (CloudFront / Cloud CDN)│   │  (coturn cluster)    │
│  ┌───────────────┐  │    │                          │   └──────────────────────┘
│  │ Pi Auth Server│  │    │  ┌────────────────────┐  │
│  │ (SSO / JWT)   │  │    │  │  API Gateway        │  │
│  └───────┬───────┘  │    │  │  (AWS API GW /      │  │
│          │          │    │  │   Kong / Nginx)      │  │
│  ┌───────▼───────┐  │    │  └────────┬───────────┘  │
│  │ Pi Blockchain │  │    │           │               │
│  │ (Transaction  │  │    │  ┌────────▼───────────┐  │
│  │  Ledger)      │  │    │  │  GAME API SERVER    │  │
│  └───────────────┘  │    │  │  (Node.js / Go)     │  │
└─────────────────────┘    │  │                     │  │
              ▲            │  │  - /auth             │  │
              │ Pi Tx Verify│  │  - /payments        │  │
              │            │  │  - /store            │  │
              │            │  │  - /bounties         │  │
              │            │  └────────┬────────────┘  │
              │            │           │                │
              │            │  ┌────────▼────────────┐  │
              │            │  │  PHOTON FUSION       │  │
              │            │  │  RELAY SERVERS       │  │
              │            │  │  (Authoritative)     │  │
              │            │  │                      │  │
              │            │  │  - Hit Registration  │  │
              │            │  │  - Lag Compensation  │  │
              │            │  │  - Anti-Cheat        │  │
              │            │  │  - Snapshot Interp.  │  │
              │            │  └────────┬────────────┘  │
              │            │           │                │
              │            │  ┌────────▼────────────┐  │
              │            │  │  NAKAMA SERVER       │  │
              │            │  │  (Heroic Labs)       │  │
              │            │  │                      │  │
              │            │  │  - Matchmaking       │  │
              │            │  │  - Leaderboards      │  │
              │            │  │  - Friend System     │  │
              │            │  │  - Inventory         │  │
              │            │  │  - Notifications     │  │
              │            │  │  - Storage Engine    │  │
              │            │  └────────┬────────────┘  │
              │            │           │                │
              │            │  ┌────────▼────────────┐  │
              └────────────┼──│  PostgreSQL (Primary)│  │
                           │  │  + Redis (Cache/Pub) │  │
                           │  └─────────────────────┘  │
                           └──────────────────────────-─┘
```

---

## 2. Service Layer Breakdown

### 2.1 Client Engine Layer (PlayCanvas WebGL)
| Component | Technology | Responsibility |
|---|---|---|
| Render Pipeline | PlayCanvas + WebGL2 / WebGPU | Scene rendering, PBR materials, dynamic shadows |
| Physics | Ammo.js (WASM) | Rigid bodies, bullet collision, vehicle dynamics |
| Animation | PlayCanvas Anim | Skeletal mesh, blend trees, IK for weapon sway |
| Audio | Web Audio API | 3D positional audio, footstep detection |
| Touch HUD | Custom Canvas2D overlay | Joystick, fire, ADS, jump, crouch buttons |
| Networking Client | Photon Fusion SDK (JS) | Tick-synced state, RPCs, ownership transfer |
| Pi SDK | Pi JavaScript SDK v2 | Authentication, payment initiation |

### 2.2 Authoritative Game Server (Photon Fusion)
| Feature | Implementation |
|---|---|
| Tick Rate | 64-128 Hz server tick, 30-60 Hz client update |
| Hit Registration | Server-side rewind buffer (150ms window) |
| Lag Compensation | Snapshot interpolation + client-side prediction |
| Anti-Cheat | Speed/position delta validation per tick |
| Session Types | Battle Royale rooms (100 players), 5v5 rooms (10 players) |

### 2.3 Nakama Backend Services
| Feature | Nakama Module |
|---|---|
| Matchmaking | `tournaments.matchmaker` with ELO + region routing |
| Inventory | `runtime storage engine` — per-user collections |
| Leaderboards | `leaderboards.list` — global, regional, seasonal |
| Friend System | `friends.list/add/remove` + Pi username lookup |
| Notifications | `notifications.send` for bounty alerts |
| Wallets | `wallets.update` — atomic token credit/debit |

### 2.4 Pi Network Integration Flow
```
Client                    Game API Server              Pi Network
  │                             │                           │
  │──── Pi.authenticate() ─────▶│                           │
  │                             │──── verify Pi JWT ───────▶│
  │◀─── player_session_token ───│◀─── user identity ────────│
  │                             │                           │
  │──── initiatePurchase() ────▶│                           │
  │                             │──── create Pi payment ───▶│
  │◀─── paymentId + deeplink ───│                           │
  │                             │                           │
  │──────── (user approves) ─────────────────────────────────▶│
  │                             │◀─── payment_complete cb ──│
  │                             │     (txid, amount, uid)    │
  │                             │                           │
  │                             │── validate on-chain ─────▶│
  │                             │◀── confirmed block hash ──│
  │                             │                           │
  │                             │── credit wallet (DB) ─────│
  │                             │── update inventory ───────│
  │◀─── purchase_success ───────│                           │
```

### 2.5 CDN & Asset Pipeline
```
Source Assets (Blender FBX/GLB)
        │
        ▼
  Asset Build Pipeline
  (Node.js + gltf-pipeline)
        │
   ┌────┴────┐
   │         │
   ▼         ▼
  LOD 0    LOD 1/2     ← Automatic LOD generation
  (2K tex)  (512px)
   │         │
   └────┬────┘
        ▼
  S3 / GCS Bucket  ──▶  CloudFront CDN
        │                   │
        │              Edge caches
        │              by region (NA/EU/ASIA)
        ▼
  Client Asset Loader
  (Progressive streaming
   during spawn screen)
```

---

## 3. Infrastructure & Deployment

```yaml
# Logical deployment topology

regions:
  - us-east-1:       # Primary — NA players
      game_servers: Photon Fusion (managed cloud)
      api_servers:  ECS Fargate  x3 (auto-scale)
      nakama:       EKS cluster  x2 (HA pair)
      database:     RDS PostgreSQL Multi-AZ
      cache:        ElastiCache Redis cluster

  - eu-west-1:       # EU players
      game_servers: Photon Fusion relay
      api_servers:  ECS Fargate x2
      nakama:       Read-replica + Nakama satellite

  - ap-southeast-1:  # APAC
      game_servers: Photon Fusion relay
      api_servers:  ECS Fargate x2
      nakama:       Read-replica + Nakama satellite

global:
  cdn: CloudFront (assets + static)
  dns: Route 53 (latency-based routing)
  secrets: AWS Secrets Manager
  monitoring: Datadog + Grafana + Sentry
  ci_cd: GitHub Actions → ECR → ECS rolling deploy
```

---

## 4. Security Architecture

| Threat Vector | Mitigation |
|---|---|
| Client-side cheat (speed hack) | Server authoritative position + delta validation |
| Payment replay attack | Pi txid stored in DB; duplicate txids rejected |
| Token manipulation | All wallet ops go through signed server RPCs only |
| WebSocket injection | Input sanitization + protobuf message schemas |
| DDoS | AWS Shield Standard + rate limiting at API Gateway |
| Unauthorized item grants | Admin-only item-grant endpoint behind IAM role |
| JWT forgery | HS256 signature with shared secret (JWT_SECRET); accepted algorithm pinned server-side |
