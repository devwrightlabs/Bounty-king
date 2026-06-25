/**
 * Operation: Archipelago — Player session JWT verification middleware
 *
 * Validates the bearer session token on every protected route and attaches the decoded
 * player identity to `req.player`. The signing secret comes from JWT_SECRET
 * (never hardcoded).
 *
 * Expected token claims:
 *   sub    — internal player id (UUID)
 *   piUid  — Pi Network user id (used to bind payments to the paying account)
 */

import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
    throw new Error('FATAL: JWT_SECRET is not configured in environment.');
}

export function verifyPlayerJWT(req, res, next) {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');

    if (scheme !== 'Bearer' || !token) {
        return res.status(401).json({ error: 'Missing or malformed Authorization header' });
    }

    let payload;
    try {
        payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired session token' });
    }

    if (!payload.sub || !payload.piUid) {
        return res.status(401).json({ error: 'Session token missing required claims' });
    }

    req.player = {
        id:    payload.sub,
        piUid: payload.piUid,
    };

    return next();
}

export default verifyPlayerJWT;
