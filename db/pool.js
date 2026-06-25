/**
 * Operation: Archipelago — PostgreSQL connection pool
 *
 * Exposes a shared `pg` Pool. Callers use:
 *   db.query(text, params)   — one-off queries (auto-checkout/return)
 *   db.connect()             — a dedicated client for BEGIN/COMMIT transactions
 *
 * Connection details come from DATABASE_URL (never hardcoded).
 */

import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
    throw new Error('FATAL: DATABASE_URL is not configured in environment.');
}

export const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.PG_POOL_MAX || 20),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Enable TLS in production (managed Postgres typically requires it)
    ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

db.on('error', (err) => {
    // An idle client emitted an error — log and let the pool recover.
    // eslint-disable-next-line no-console
    console.error('Unexpected PostgreSQL pool error', err);
});

export default db;
