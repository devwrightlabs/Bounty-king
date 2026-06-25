/**
 * Operation: Archipelago — Game API Server
 * Entry point: node server/index.js
 *
 * Mounts all routers, wires middleware, starts listening.
 * All secrets come from environment — never hardcoded here.
 */

import express from 'express';
import { logger } from '../utils/logger.js';

// ── Routers ──────────────────────────────────────────────────────────────
import authRouter     from './routes/auth.js';
import paymentsRouter from './pi_payment_validator.js';

const app  = express();
const PORT = Number(process.env.PORT || 3000);

// ── Middleware ────────────────────────────────────────────────────────────

// JSON body — 512 KB cap (Pi payment payloads are small)
app.use(express.json({ limit: '512kb' }));

// Basic CORS for Pi Browser WebView (adjust origin allowlist in production)
app.use((req, res, next) => {
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
});

// Request logging (structured, secret-redacted via pino config)
app.use((req, _res, next) => {
    logger.info({ method: req.method, path: req.path }, 'incoming request');
    return next();
});

// ── Health check (no auth required) ──────────────────────────────────────
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: Math.floor(process.uptime()) });
});

// ── Route mounting ────────────────────────────────────────────────────────
app.use('/auth',     authRouter);
app.use('/payments', paymentsRouter);   // includes /payments/store-purchase, /bounties/place

// ── 404 catch-all ────────────────────────────────────────────────────────
app.use((_req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// ── Global error handler ──────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
    // Never expose internal details in production
    logger.error({ err }, 'Unhandled error');
    const status  = err.status || err.statusCode || 500;
    const message = process.env.NODE_ENV === 'production'
        ? 'Internal server error'
        : (err.message || 'Internal server error');
    res.status(status).json({ error: message });
});

// ── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    logger.info({ port: PORT, env: process.env.NODE_ENV || 'development' },
        'Operation: Archipelago API server listening');
});

export default app;
