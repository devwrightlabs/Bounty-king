/**
 * Operation: Archipelago — Structured logger
 *
 * Thin wrapper around pino so every service shares one configuration.
 * Log level is controlled via LOG_LEVEL (defaults to 'info').
 *
 * Usage: logger.info({ key: value }, 'message')
 */

import pino from 'pino';

export const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    base: { service: 'archipelago-game-api' },
    redact: {
        // Never log secrets or raw auth material.
        paths: ['req.headers.authorization', '*.PI_API_KEY', '*.INTERNAL_SECRET'],
        remove: true,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
});

export default logger;
