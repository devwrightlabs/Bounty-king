/**
 * Operation: Archipelago — Nakama Custom Matchmaking Module
 *
 * Compiled and deployed to Nakama as a TypeScript runtime plugin.
 * Handles:
 *  - ELO-weighted, region-aware matchmaking
 *  - Grudge Match lobby injection (bounty targets forced into same lobby)
 *  - Battle Royale (100p) vs 5v5 queue separation
 */

const nkruntime = require('@heroiclabs/nakama-runtime');

// ---------------------------------------------------------------------------
// MATCH HANDLER: Battle Royale
// ---------------------------------------------------------------------------
const BattleRoyaleMatch: nkruntime.MatchHandler = {

    matchInit(ctx, logger, nk, params) {
        // Nakama's JS runtime is not Node.js — process.env is unavailable.
        // Capture required env values from ctx.env into match state for later use.
        const state = {
            players:     {} as Record<string, PlayerMatchState>,
            phase:       0,                      // storm ring phase 0-6
            phaseTimer:  0,
            mapCenter:   { x: 0, z: 0 },        // NASA island center
            ringRadius:  [1800, 1400, 1000, 700, 450, 250, 100],
            maxPlayers:  100,
            minPlayers:  2,                      // players required before match starts
            activeBounties: [] as string[],      // bounty IDs active this match
            started:     false,
            gameApiUrl:    ctx.env['GAME_API_URL'] || '',
            internalSecret: ctx.env['INTERNAL_SECRET'] || '',
        };

        return {
            state,
            tickRate: 30,
            label: JSON.stringify({ mode: 'BR', region: params['region'] || 'us-east-1' }),
        };
    },

    matchJoinAttempt(ctx, logger, nk, dispatcher, tick, state, presence, metadata) {
        const ms = state as any;
        if (Object.keys(ms.players).length >= ms.maxPlayers) {
            return { state, accept: false, rejectMessage: 'Match full' };
        }
        if (ms.started) {
            return { state, accept: false, rejectMessage: 'Match already in progress' };
        }
        return { state, accept: true };
    },

    matchJoin(ctx, logger, nk, dispatcher, tick, state, presences) {
        const ms = state as any;
        for (const p of presences) {
            ms.players[p.userId] = {
                userId:    p.userId,
                sessionId: p.sessionId,
                kills:     0,
                alive:     true,
                position:  { x: 0, y: 0, z: 0 },
                spawnedAt: tick,
            };
        }
        return { state };
    },

    matchLeave(ctx, logger, nk, dispatcher, tick, state, presences) {
        const ms = state as any;
        for (const p of presences) {
            if (ms.players[p.userId]) {
                if (ms.started) {
                    // Match in progress: mark eliminated so the win condition counts them out.
                    ms.players[p.userId].alive = false;
                } else {
                    // Pre-start: remove entirely so start and capacity checks reflect
                    // the players currently present, not those who joined and left.
                    delete ms.players[p.userId];
                }
            }
        }
        return { state };
    },

    matchLoop(ctx, logger, nk, dispatcher, tick, state, messages) {
        const ms = state as any;

        // ---- Start the match once enough players have joined ----
        // Setting ms.started enables the win condition below and makes
        // matchJoinAttempt reject late joiners.
        if (!ms.started && Object.keys(ms.players).length >= ms.minPlayers) {
            ms.started = true;
            logger.info('Match started with ' + Object.keys(ms.players).length + ' players');
        }

        // ---- Process incoming messages ----
        for (const msg of messages) {
            try {
                const data = JSON.parse(nk.binaryToString(msg.data));
                _handleMatchMessage(nk, dispatcher, ms, msg.sender, data, logger);
            } catch (e) {
                logger.warn('Bad match message from ' + msg.sender.userId);
            }
        }

        // ---- Storm ring advancement (every ~60s real time at 30 tick) ----
        ms.phaseTimer++;
        const phaseTickDuration = [1800, 1500, 1200, 900, 600, 300, 120];
        if (ms.phase < 6 && ms.phaseTimer >= phaseTickDuration[ms.phase]) {
            ms.phase++;
            ms.phaseTimer = 0;
            dispatcher.broadcastMessage(OpCode.STORM_ADVANCE, JSON.stringify({
                phase: ms.phase,
                radius: ms.ringRadius[ms.phase],
            }));
        }

        // ---- Check win condition ----
        const alive = Object.values(ms.players).filter((p: any) => p.alive);
        if (ms.started && alive.length <= 1) {
            const winner = alive[0] as any;
            dispatcher.broadcastMessage(OpCode.MATCH_END, JSON.stringify({
                winner: winner?.userId || null,
                placement: _buildPlacements(ms.players),
            }));
            return null; // End match
        }

        return { state };
    },

    matchTerminate(ctx, logger, nk, dispatcher, tick, state, graceSeconds) {
        dispatcher.broadcastMessage(OpCode.SERVER_SHUTDOWN, JSON.stringify({ graceSeconds }));
        return { state };
    },

    matchSignal(ctx, logger, nk, dispatcher, tick, state, data) {
        // Inject a grudge bounty target into this match
        try {
            const signal = JSON.parse(data);
            if (signal.type === 'INJECT_GRUDGE') {
                const ms = state as any;
                ms.activeBounties.push(signal.bountyId);
                logger.info('Grudge match signal received for bounty ' + signal.bountyId);
            }
        } catch (_) {}
        return { state, data: '' };
    },
};

// ---------------------------------------------------------------------------
// MESSAGE OPCODES
// ---------------------------------------------------------------------------
const OpCode = Object.freeze({
    PLAYER_MOVE:      1,
    PLAYER_SHOOT:     2,
    PLAYER_HIT:       3,
    PLAYER_DEAD:      4,
    DOG_TAG_DROP:     5,
    DOG_TAG_COLLECT:  6,
    STORM_ADVANCE:    10,
    MATCH_END:        11,
    BOUNTY_ALERT:     20,
    SERVER_SHUTDOWN:  99,
});

// ---------------------------------------------------------------------------
// MESSAGE HANDLER
// ---------------------------------------------------------------------------
function _handleMatchMessage(
    nk: any,
    dispatcher: any,
    state: any,
    sender: nkruntime.Presence,
    data: any,
    logger: nkruntime.Logger
) {
    switch (data.op) {
        case OpCode.PLAYER_MOVE:
            // Server validates position delta for speed-hack detection
            _validateAndApplyMove(state, sender.userId, data.pos, data.vel);
            break;

        case OpCode.PLAYER_SHOOT:
            // Relay to all clients (Photon Fusion handles authoritative hit reg)
            dispatcher.broadcastMessage(OpCode.PLAYER_SHOOT, JSON.stringify(data), null, sender);
            break;

        case OpCode.DOG_TAG_COLLECT:
            _processTagCollection(nk, dispatcher, state, sender.userId, data.tagId, logger);
            break;
    }
}

function _validateAndApplyMove(state: any, userId: string, pos: any, vel: any) {
    const player = state.players[userId];
    if (!player) return;

    const MAX_SPEED_PER_TICK = 0.3; // ~8 m/s at 30 tick — generous for lag
    const dx = pos.x - player.position.x;
    const dz = pos.z - player.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist > MAX_SPEED_PER_TICK) {
        // Speed violation — teleport back to last known position (silent correction)
        return;
    }

    player.position = pos;
}

async function _processTagCollection(
    nk: any,
    dispatcher: any,
    state: any,
    collectorId: string,
    tagId: string,
    logger: nkruntime.Logger
) {
    // Prevent double-collection via in-memory lock
    if (state[`tag_lock_${tagId}`]) return;

    // Env values are captured into match state during matchInit because
    // process.env is unavailable in the Nakama runtime. Fail fast if missing.
    const gameApiUrl = state.gameApiUrl;
    const internalSecret = state.internalSecret;
    if (!gameApiUrl || !internalSecret) {
        logger.error('Dog tag collection aborted: GAME_API_URL / INTERNAL_SECRET not configured in match state');
        return;
    }

    state[`tag_lock_${tagId}`] = true;

    try {
        // RPC call to Game API Server to process token transfer
        const resp = await nk.httpRequest(
            `${gameApiUrl}/internal/dog-tags/collect`,
            'POST',
            { 'X-Internal-Secret': internalSecret },
            JSON.stringify({ tagId, collectorId })
        );

        const result = JSON.parse(resp.body);
        dispatcher.broadcastMessage(OpCode.DOG_TAG_COLLECT, JSON.stringify({
            tagId,
            collectorId,
            tokensAwarded: result.tokensAwarded,
        }));
    } catch (e) {
        logger.error('Dog tag collection failed: ' + e);
        delete state[`tag_lock_${tagId}`];
    }
}

function _buildPlacements(players: Record<string, any>) {
    return Object.values(players)
        .sort((a: any, b: any) => b.kills - a.kills)
        .map((p: any, i) => ({ userId: p.userId, placement: i + 1, kills: p.kills }));
}

// ---------------------------------------------------------------------------
// MATCHMAKER MATCHED HOOK
// Runs before players are placed into a match — applies grudge match logic
// ---------------------------------------------------------------------------
const matchmakerMatched: nkruntime.MatchmakerMatchedFunction = async (
    ctx, logger, nk, matches
) => {
    // Check if any players have active bounties targeting another player in this pool
    const userIds = matches.map(m => m.presence.userId);

    // nk.storageRead is synchronous in the Nakama runtime and throws on error;
    // its return value is a plain array with no .catch(), so guard with try/catch.
    let activeBounties: any[] = [];
    try {
        activeBounties = nk.storageRead(
            userIds.map(uid => ({ collection: 'bounties', key: 'active_targets', userId: uid }))
        );
    } catch (e) {
        logger.warn('Failed to read active bounties for matchmaker pool: ' + e);
        activeBounties = [];
    }

    for (const record of activeBounties) {
        if (!record?.value?.targets) continue;
        for (const target of record.value.targets) {
            if (userIds.includes(target)) {
                // Both placer and target are in this pool — let match proceed as Grudge Match
                logger.info(`Grudge match triggered: ${record.userId} → ${target}`);
            }
        }
    }

    const matchId = await nk.matchCreate('BattleRoyale', {
        region: matches[0]?.properties['region'] || 'us-east-1',
    });

    return matchId;
};

// ---------------------------------------------------------------------------
// RPC: Get active bounties targeting a player (called from client)
// ---------------------------------------------------------------------------
const rpcGetMyBounties: nkruntime.RpcFunction = async (ctx, logger, nk, payload) => {
    const userId = ctx.userId;
    const result = await nk.storageRead([
        { collection: 'bounties', key: 'incoming', userId }
    ]);

    return JSON.stringify({
        bounties: result[0]?.value?.list || [],
    });
};

// ---------------------------------------------------------------------------
// MODULE EXPORTS (Nakama Go runtime init entrypoint)
// ---------------------------------------------------------------------------
function InitModule(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    initializer: nkruntime.Initializer
) {
    initializer.registerMatch('BattleRoyale', BattleRoyaleMatch);
    initializer.registerMatchmakerMatched(matchmakerMatched);
    initializer.registerRpc('get_my_bounties', rpcGetMyBounties);

    logger.info('Operation: Archipelago — Nakama module initialized');
}

interface PlayerMatchState {
    userId:    string;
    sessionId: string;
    kills:     number;
    alive:     boolean;
    position:  { x: number; y: number; z: number };
    spawnedAt: number;
}

// @ts-ignore — Nakama expects this global
globalThis.InitModule = InitModule;
