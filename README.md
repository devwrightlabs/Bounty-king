# Operation: Archipelago — Production Blueprint

> AAA-grade mobile-first FPS for Pi Browser | Web3 Economy | PlayCanvas WebGL

---

## Repository Structure

```
Bounty-king/
├── architecture/
│   └── SYSTEM_ARCHITECTURE.md   # Full-stack data flow, service topology, security
├── database/
│   └── SCHEMA.sql               # PostgreSQL schema: players, wallets, bounties, inventory
├── server/
│   ├── pi_payment_validator.js  # Secure Pi Network payment validation API (Node.js)
│   └── nakama_modules/
│       └── matchmaking.ts       # Nakama custom match handler + grudge match logic
└── client/
    └── CharacterController.js   # PlayCanvas FSM: CoD-style movement + vehicle seats
```

---

## Module Summaries

### 1. `architecture/SYSTEM_ARCHITECTURE.md`
End-to-end data flow from Pi Browser → PlayCanvas client → Photon Fusion game servers →
Nakama backend → PostgreSQL → Pi Network Blockchain API. Includes CDN asset pipeline,
security threat model, and multi-region deployment topology.

### 2. `database/SCHEMA.sql`
Complete PostgreSQL schema covering:
- `players` — Pi UID anchored profiles, progression, sensitivity configs
- `wallets` + `wallet_transactions` — atomic balance ledger with micro-unit precision
- `pi_payments` — immutable blockchain payment audit trail with duplicate txid guard
- `catalog_items` + `player_inventories` — rarity-tiered item store and ownership
- `dog_tags` + `trophy_room` — collectible death economy with dynamic value formula
- `bounty_contracts` — Vendetta/Grudge match economy with brokerage fee routing
- `matches` + `match_players` — match lifecycle and per-player stat aggregation
- Stored functions `fn_wallet_credit` / `fn_wallet_debit` for atomic balance ops
- Triggers for dog-tag value calculation and post-match stat rollup

### 3. `server/pi_payment_validator.js`
Production Node.js Express router implementing the full Pi Network payment lifecycle:
- `POST /payments/initiate` — server creates pending record, returns Pi SDK metadata
- `POST /payments/confirm` — server-side Pi Platform API verification (txid, amount, uid)
- Redis idempotency locks preventing double-processing and replay attacks
- Atomic DB transaction crediting wallet only after on-chain confirmation
- `POST /payments/store-purchase` — spend game tokens on catalog items (server-priced)
- `POST /bounties/place` — Vendetta bounty with automatic 2.5% brokerage fee deduction

### 4. `server/nakama_modules/matchmaking.ts`
Nakama TypeScript runtime plugin:
- `BattleRoyaleMatch` handler — 100-player lobby with 30 Hz server tick
- Server-side speed-hack validation on every position update
- Storm ring phase advancement via tick counter
- Dog tag collection via internal API with in-memory double-collect prevention
- `matchmakerMatched` hook injecting Grudge Match logic (bounty target co-location)
- `rpcGetMyBounties` — client RPC to fetch incoming bounty contracts

### 5. `client/CharacterController.js`
PlayCanvas script component implementing:
- Full FSM: IDLE → WALK → SPRINT → SLIDE → CROUCH → JUMP → FALL → VAULT → ADS → IN_VEHICLE → DEAD
- Slide-cancel mechanic (18ms window, mirrors CoD Mobile)
- Vault raycasting against obstacles
- Vehicle entry/exit with camera reparenting to seat mount
- Mid-transit seat swapping (DRIVER ↔ PASSENGER ↔ GUNNER)
- Per-seat free-look and weapon fire in vehicle
- Procedural weapon sway and recoil offset
- FOV transitions for ADS and sprint
- Camera roll tilt during sprint, land-shake on fall impact
- Drives PlayCanvas Anim state machine booleans/triggers for all states

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| Server-priced items | Client never sends a price — prevents purchase price manipulation |
| txid dedup in DB | Pi payments use unique on-chain txids; second INSERT rejected before any credit |
| Redis idempotency lock | Prevents race condition between two simultaneous confirm requests |
| Micro-unit wallet | Integers avoid floating-point rounding errors on token arithmetic |
| Atomic PG functions | `fn_wallet_debit` / `fn_wallet_credit` hold row locks — safe under concurrent requests |
| Nakama internal RPC | Dog tag token award routed through Game API, not Nakama directly, to keep Pi keys isolated |
| Grudge Match via signal | Nakama `matchSignal` used so existing matches can receive injected grudge targets mid-queue |

---

## Getting Started (Development)

### Prerequisites
- Node.js 20+
- PostgreSQL 15+
- Redis 7+
- Nakama Server 3.x
- PlayCanvas Editor (for client engine)

### Environment Variables
```bash
PI_API_KEY=<your_pi_developer_key>
DATABASE_URL=postgres://user:pass@host:5432/archipelago
REDIS_URL=redis://localhost:6379
NAKAMA_URL=http://localhost:7350
INTERNAL_SECRET=<shared_secret_between_game_api_and_nakama>
TOKEN_RATE_PER_PI=1000
GAME_API_URL=http://localhost:3000
```

### Database Setup
```bash
psql $DATABASE_URL < database/SCHEMA.sql
```

### API Server
```bash
cd server
npm install
node --experimental-vm-modules index.js
```

### Nakama Module
```bash
cd server/nakama_modules
npm install @heroiclabs/nakama-runtime
npx tsc matchmaking.ts --target es2020 --module commonjs
# Deploy compiled JS to Nakama /data/modules/
```
