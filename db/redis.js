/**
 * Operation: Archipelago — Redis client
 *
 * Shared ioredis client used for idempotency locks on payment confirmation.
 * Connection details come from REDIS_URL (never hardcoded).
 *
 * Usage in the payment validator:
 *   redis.set(key, '1', 'EX', ttl, 'NX')  — atomic SET-if-not-exists with TTL
 *   redis.del(key)                        — release a lock
 */

import Redis from 'ioredis';

if (!process.env.REDIS_URL) {
    throw new Error('FATAL: REDIS_URL is not configured in environment.');
}

export const redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
});

redis.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('Redis client error', err);
});

export default redis;
