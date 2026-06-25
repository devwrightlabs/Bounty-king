/**
 * Operation: Archipelago — Nakama server-to-server client
 *
 * Used by the Game API to push real-time notifications to players (e.g. when a
 * bounty is placed). Talks to a custom Nakama RPC (`notify_user`) over HTTP using
 * the server-side runtime http key — Pi keys never leave the payment service.
 *
 * Config:
 *   NAKAMA_URL       — base URL of the Nakama server (e.g. http://localhost:7350)
 *   NAKAMA_HTTP_KEY  — runtime http key for server-authoritative RPC calls
 */

import axios from 'axios';

const NAKAMA_URL      = process.env.NAKAMA_URL || 'http://localhost:7350';
const NAKAMA_HTTP_KEY = process.env.NAKAMA_HTTP_KEY;

if (!NAKAMA_HTTP_KEY) {
    throw new Error('FATAL: NAKAMA_HTTP_KEY is not configured in environment.');
}

/**
 * Send an in-app notification to a single user via the `notify_user` RPC.
 * @param {string} userId  Target player's Nakama user id.
 * @param {{ type: string, message: string, data?: object }} notification
 */
async function notifyUser(userId, notification) {
    const url = `${NAKAMA_URL}/v2/rpc/notify_user`;
    const response = await axios.post(
        url,
        JSON.stringify({ userId, ...notification }),
        {
            params: { http_key: NAKAMA_HTTP_KEY },
            headers: { 'Content-Type': 'application/json' },
            timeout: 10_000,
        }
    );
    return response.data;
}

export default { notifyUser };
