/**
 * Operation: Archipelago — Pi Network Authentication Route
 *
 * Flow:
 *  1. Client calls Pi.authenticate() → gets { user: { uid, username }, accessToken }
 *  2. Client POSTs /auth/pi with { accessToken, piUid, piUsername }
 *  3. Server verifies accessToken against Pi Platform GET /me
 *  4. Server validates returned uid matches piUid (prevents token-swap attacks)
 *  5. Server upserts player row in DB (idempotent on pi_uid)
 *  6. Server issues a signed HS256 JWT: { sub: player.id, piUid }
 *  7. Client stores JWT, uses it as Bearer on every subsequent API call
 *
 *  GET /auth/me — returns the current player's profile (requires JWT)
 */

import express     from 'express';
import axios       from 'axios';
import jwt         from 'jsonwebtoken';
import { db }      from '../../db/pool.js';
import { logger }  from '../../utils/logger.js';

const router = express.Router();

const PI_API_BASE    = 'https://api.minepi.com/v2';
const JWT_SECRET     = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

if (!JWT_SECRET) {
    throw new Error('FATAL: JWT_SECRET is not configured in environment.');
}

// ---------------------------------------------------------------------------
// POST /auth/pi
// Body: { accessToken: string, piUid: string, piUsername: string }
// ---------------------------------------------------------------------------
router.post('/pi', async (req, res) => {
    const { accessToken, piUid, piUsername } = req.body;

    if (!accessToken || !piUid || !piUsername) {
        return res.status(400).json({
            error: 'accessToken, piUid, and piUsername are required',
        });
    }

    // ---- Verify accessToken with Pi Platform --------------------------------
    let piProfile;
    try {
        const { data } = await axios.get(`${PI_API_BASE}/me`, {
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: 10_000,
        });
        piProfile = data;
    } catch (err) {
        logger.warn({ err: err.message, piUid }, 'Pi Platform /me verification failed');
        return res.status(401).json({ error: 'Pi access token verification failed' });
    }

    // ---- Validate uid match (prevents using another user's token) -----------
    if (piProfile.uid !== piUid) {
        logger.error({ expected: piUid, actual: piProfile.uid }, 'Pi uid mismatch — auth rejected');
        return res.status(401).json({ error: 'Pi UID mismatch' });
    }

    // ---- Validate username (soft check — Pi may update display names) -------
    // We trust Pi's uid as the canonical identity; username is a display hint.
    const canonicalUsername = piProfile.username || piUsername;

    // ---- Upsert player in DB (safe on concurrent logins) --------------------
    let player;
    try {
        const result = await db.query(
            `INSERT INTO players (pi_uid, pi_username, last_login_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (pi_uid) DO UPDATE
               SET pi_username   = EXCLUDED.pi_username,
                   last_login_at = NOW()
             RETURNING id, pi_uid, pi_username, global_level, season_rank,
                       total_kills, total_deaths, total_wins, display_name`,
            [piUid, canonicalUsername]
        );
        player = result.rows[0];
    } catch (dbErr) {
        logger.error({ dbErr, piUid }, 'DB upsert failed during Pi auth');
        return res.status(500).json({ error: 'Authentication error — please retry' });
    }

    // Ensure wallet row exists (created separately in case of race condition)
    await db.query(
        `INSERT INTO wallets (player_id) VALUES ($1) ON CONFLICT (player_id) DO NOTHING`,
        [player.id]
    ).catch(e => logger.warn({ e }, 'Wallet insert skipped — already exists'));

    // ---- Issue session JWT ---------------------------------------------------
    const token = jwt.sign(
        {
            sub:         player.id,
            piUid:       player.pi_uid,
            piUsername:  player.pi_username,
        },
        JWT_SECRET,
        {
            algorithm: 'HS256',
            expiresIn: JWT_EXPIRES_IN,
        }
    );

    logger.info({ playerId: player.id, piUsername: player.pi_username }, 'Pi auth success');

    return res.status(200).json({
        token,
        player: {
            id:          player.id,
            piUsername:  player.pi_username,
            displayName: player.display_name || player.pi_username,
            level:       player.global_level,
            rank:        player.season_rank,
            kills:       player.total_kills,
            deaths:      player.total_deaths,
            wins:        player.total_wins,
        },
    });
});

// ---------------------------------------------------------------------------
// GET /auth/me
// Returns the current player's profile. Requires Bearer JWT.
// Used by the client on startup to restore a cached session.
// ---------------------------------------------------------------------------
router.get('/me', async (req, res) => {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');

    if (scheme !== 'Bearer' || !token) {
        return res.status(401).json({ error: 'Missing or malformed Authorization header' });
    }

    let payload;
    try {
        payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    } catch {
        return res.status(401).json({ error: 'Invalid or expired session token' });
    }

    try {
        const result = await db.query(
            `SELECT p.id, p.pi_username, p.display_name, p.global_level, p.season_rank,
                    p.total_kills, p.total_deaths, p.total_wins,
                    w.balance
             FROM players p
             LEFT JOIN wallets w ON w.player_id = p.id
             WHERE p.id = $1 AND p.is_banned = FALSE`,
            [payload.sub]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Player not found' });
        }

        const p = result.rows[0];
        return res.status(200).json({
            id:           p.id,
            piUsername:   p.pi_username,
            displayName:  p.display_name || p.pi_username,
            level:        p.global_level,
            rank:         p.season_rank,
            kills:        p.total_kills,
            deaths:       p.total_deaths,
            wins:         p.total_wins,
            tokenBalance: p.balance ? Number(p.balance) / 1_000_000 : 0,
        });
    } catch (dbErr) {
        logger.error({ dbErr }, '/auth/me DB query failed');
        return res.status(500).json({ error: 'Server error' });
    }
});

// ---------------------------------------------------------------------------
// POST /auth/refresh
// Extends an expiring JWT if it is still valid (not expired).
// The client should call this proactively before the token expires.
// ---------------------------------------------------------------------------
router.post('/refresh', (req, res) => {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
        return res.status(401).json({ error: 'Missing token' });
    }
    let payload;
    try {
        payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    } catch {
        return res.status(401).json({ error: 'Token invalid or expired' });
    }
    const newToken = jwt.sign(
        { sub: payload.sub, piUid: payload.piUid, piUsername: payload.piUsername },
        JWT_SECRET,
        { algorithm: 'HS256', expiresIn: JWT_EXPIRES_IN }
    );
    return res.status(200).json({ token: newToken });
});

export default router;
