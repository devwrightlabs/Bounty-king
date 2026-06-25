/**
 * Operation: Archipelago — Pi Network Payment Validation Service
 *
 * Secure server-side flow:
 *  1. Client calls POST /payments/initiate  → server creates a Pi payment record
 *  2. Pi SDK calls POST /payments/confirm   → server validates on-chain + credits wallet
 *  3. Client calls GET  /payments/:id/status → polls for final state
 *
 * All endpoints require a valid player session JWT.
 * The Pi API secret key NEVER leaves this server — never sent to client.
 */

import express from 'express';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/pool.js';           // PostgreSQL pool (pg)
import { redis } from '../db/redis.js';        // Redis client
import { verifyPlayerJWT } from '../auth/jwt.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// CONFIG — loaded from AWS Secrets Manager / environment (never hardcoded)
// ---------------------------------------------------------------------------
const PI_API_KEY         = process.env.PI_API_KEY;           // Developer server-side key
const PI_API_BASE        = 'https://api.minepi.com/v2';      // Pi Platform API
const TOKEN_RATE         = Number(process.env.TOKEN_RATE_PER_PI || 1000);  // game tokens per 1 Pi
const IDEMPOTENCY_TTL    = 86400;  // seconds — 24h dedup window in Redis
const PAYMENT_TIMEOUT_MS = 300000; // 5 minutes before marking payment as abandoned

if (!PI_API_KEY) {
    throw new Error('FATAL: PI_API_KEY is not configured in environment.');
}

// ---------------------------------------------------------------------------
// MIDDLEWARE: Authenticate player session on all routes in this router
// ---------------------------------------------------------------------------
router.use(verifyPlayerJWT);

// ---------------------------------------------------------------------------
// HELPER: Call Pi Platform REST API with server-side secret key
// ---------------------------------------------------------------------------
async function piApi(method, path, data = null) {
    const config = {
        method,
        url: `${PI_API_BASE}${path}`,
        headers: {
            Authorization: `Key ${PI_API_KEY}`,
            'Content-Type': 'application/json',
        },
        timeout: 15000,
    };
    if (data) config.data = data;

    const response = await axios(config);
    return response.data;
}

// ---------------------------------------------------------------------------
// HELPER: Calculate game tokens from Pi amount
// ---------------------------------------------------------------------------
function calcTokens(piAmount) {
    // piAmount is a decimal (e.g., 3.14159)
    // Token amounts stored as micro-units internally (multiply by 1_000_000)
    return Math.floor(piAmount * TOKEN_RATE * 1_000_000);
}

// ---------------------------------------------------------------------------
// HELPER: Idempotency guard using Redis SETNX
// Returns true if this is a NEW request; false if a duplicate
// ---------------------------------------------------------------------------
async function acquireIdempotencyLock(key) {
    const result = await redis.set(
        `idempotency:payment:${key}`,
        '1',
        'EX', IDEMPOTENCY_TTL,
        'NX'
    );
    return result === 'OK';  // OK = new, null = duplicate
}

// ---------------------------------------------------------------------------
// POST /payments/initiate
// Body: { packageSku: string }
// Creates the server record and returns the Pi payment metadata for the client SDK
// ---------------------------------------------------------------------------
router.post('/initiate', async (req, res) => {
    const { packageSku } = req.body;
    const playerId = req.player.id;

    if (!packageSku || typeof packageSku !== 'string') {
        return res.status(400).json({ error: 'packageSku is required' });
    }

    // Look up the token package from DB (prevents price manipulation)
    const pkgResult = await db.query(
        `SELECT id, display_name, price_pi, tokens_granted
         FROM token_packages
         WHERE sku = $1 AND is_active = TRUE`,
        [packageSku.trim()]
    );

    if (pkgResult.rowCount === 0) {
        return res.status(404).json({ error: 'Package not found' });
    }

    const pkg = pkgResult.rows[0];
    const internalPaymentId = uuidv4();

    // Insert pending record BEFORE initiating with Pi (prevents orphaned records)
    await db.query(
        `INSERT INTO pi_payments
             (id, player_id, pi_payment_id, amount_pi, tokens_credited, status, raw_payload)
         VALUES ($1, $2, $3, $4, 0, 'pending', $5)`,
        [
            internalPaymentId,
            playerId,
            internalPaymentId,  // placeholder — real pi_payment_id set on confirm
            pkg.price_pi,
            JSON.stringify({ packageSku, initiatedAt: new Date().toISOString() }),
        ]
    );

    // Return metadata for Pi SDK on the client side
    // Client calls Pi.createPayment({ amount, memo, metadata }) using these values
    return res.status(200).json({
        paymentId: internalPaymentId,
        amount: pkg.price_pi,
        memo: `${pkg.display_name} — Operation: Archipelago`,
        metadata: {
            internalPaymentId,
            playerId,
            packageSku,
            tokensGranted: pkg.tokens_granted,
        },
    });
});

// ---------------------------------------------------------------------------
// POST /payments/confirm
// Called by: (a) Pi SDK's onReadyForServerApproval callback relayed via client
//             (b) Pi Platform webhook (recommended for production)
// Body: { piPaymentId: string, internalPaymentId: string }
//
// SECURITY RULE: We call Pi Platform to verify — we do NOT trust any amount
//                or status field sent by the client.
// ---------------------------------------------------------------------------
router.post('/confirm', async (req, res) => {
    const { piPaymentId, internalPaymentId } = req.body;
    const playerId = req.player.id;

    if (!piPaymentId || !internalPaymentId) {
        return res.status(400).json({ error: 'piPaymentId and internalPaymentId are required' });
    }

    // ---- IDEMPOTENCY: prevent double-processing ----
    const isNew = await acquireIdempotencyLock(piPaymentId);
    if (!isNew) {
        logger.warn({ piPaymentId, playerId }, 'Duplicate payment confirm attempt — rejected');
        return res.status(409).json({ error: 'Payment already being processed' });
    }

    // ---- FETCH INTERNAL RECORD ----
    const paymentRow = await db.query(
        `SELECT id, player_id, amount_pi, status
         FROM pi_payments
         WHERE id = $1 AND player_id = $2`,
        [internalPaymentId, playerId]
    );

    if (paymentRow.rowCount === 0) {
        // Release the idempotency lock so a corrected retry isn't blocked for 24h.
        await redis.del(`idempotency:payment:${piPaymentId}`);
        return res.status(404).json({ error: 'Internal payment record not found' });
    }

    const internalRecord = paymentRow.rows[0];

    if (internalRecord.status !== 'pending') {
        logger.warn({ internalPaymentId, status: internalRecord.status }, 'Confirm on non-pending payment');
        return res.status(409).json({ error: `Payment is already ${internalRecord.status}` });
    }

    // ---- VERIFY WITH PI PLATFORM API ----
    let piPayment;
    try {
        piPayment = await piApi('GET', `/payments/${piPaymentId}`);
    } catch (err) {
        logger.error({ err, piPaymentId }, 'Failed to reach Pi Platform API');
        // Likely transient — release the idempotency lock so the payment can be retried.
        await redis.del(`idempotency:payment:${piPaymentId}`);
        return res.status(502).json({ error: 'Could not verify payment with Pi Network' });
    }

    // ---- VALIDATE ALL FIELDS SERVER-SIDE ----
    const validationErrors = [];

    if (piPayment.uid !== req.player.piUid) {
        validationErrors.push('uid mismatch — payment not owned by this player');
    }

    // Compare amounts numerically at the schema precision (NUMERIC(18,7) = 7 dp)
    // to avoid false rejections from differing string formats (e.g. "1" vs "1.0000000").
    const PI_AMOUNT_SCALE = 10_000_000; // 7 decimal places
    const piAmountScaled = Math.round(Number(piPayment.amount) * PI_AMOUNT_SCALE);
    const dbAmountScaled = Math.round(Number(internalRecord.amount_pi) * PI_AMOUNT_SCALE);
    if (!Number.isFinite(piAmountScaled) || piAmountScaled !== dbAmountScaled) {
        validationErrors.push(
            `amount mismatch — Pi says ${piPayment.amount}, DB expects ${internalRecord.amount_pi}`
        );
    }

    if (!piPayment.status.developer_approved) {
        validationErrors.push('Pi payment not in developer_approved state');
    }

    if (piPayment.status.cancelled || piPayment.status.user_cancelled) {
        validationErrors.push('Payment was cancelled');
    }

    if (validationErrors.length > 0) {
        logger.error({ validationErrors, piPaymentId, playerId }, 'Pi payment validation FAILED');
        await db.query(
            `UPDATE pi_payments SET status = 'failed', raw_payload = $1 WHERE id = $2`,
            [JSON.stringify({ errors: validationErrors, piPayment }), internalPaymentId]
        );
        return res.status(400).json({ error: 'Payment validation failed', details: validationErrors });
    }

    // ---- DUPLICATE TxID GUARD ----
    const txId = piPayment.transaction?.txid;
    if (txId) {
        const dupCheck = await db.query(
            'SELECT id FROM pi_payments WHERE pi_txid = $1 AND id != $2',
            [txId, internalPaymentId]
        );
        if (dupCheck.rowCount > 0) {
            logger.error({ txId, piPaymentId }, 'Duplicate txid detected — replay attack rejected');
            await db.query(
                `UPDATE pi_payments SET status = 'duplicate_rejected' WHERE id = $1`,
                [internalPaymentId]
            );
            return res.status(409).json({ error: 'Transaction ID already processed' });
        }
    }

    // ---- COMPUTE TOKEN GRANT ----
    const tokensToCredit = calcTokens(parseFloat(piPayment.amount));

    // ---- ATOMIC DB TRANSACTION: update payment + credit wallet ----
    const client = await db.connect();
    try {
        await client.query('BEGIN');

        // Update payment record
        await client.query(
            `UPDATE pi_payments SET
                pi_payment_id = $1,
                pi_txid       = $2,
                tokens_credited = $3,
                status        = 'confirmed',
                confirmed_at  = NOW(),
                pi_block_hash = $4,
                raw_payload   = $5
             WHERE id = $6`,
            [
                piPaymentId,
                txId || null,
                tokensToCredit,
                piPayment.transaction?.block_hash || null,
                JSON.stringify(piPayment),
                internalPaymentId,
            ]
        );

        // Credit the player's wallet (uses DB function for atomic balance update + ledger entry)
        await client.query(
            `SELECT fn_wallet_credit($1, $2, 'pi_purchase'::transaction_type, $3, $4)`,
            [
                playerId,
                tokensToCredit,
                internalPaymentId,
                `Pi purchase: ${piPayment.amount} Pi → ${tokensToCredit / 1_000_000} tokens`,
            ]
        );

        await client.query('COMMIT');
    } catch (dbErr) {
        await client.query('ROLLBACK');
        logger.error({ dbErr, internalPaymentId }, 'DB transaction failed during payment confirm');
        // Release idempotency lock so payment can be retried
        await redis.del(`idempotency:payment:${piPaymentId}`);
        return res.status(500).json({ error: 'Internal server error during credit' });
    } finally {
        client.release();
    }

    // ---- NOTIFY PI PLATFORM: mark payment as completed ----
    try {
        await piApi('POST', `/payments/${piPaymentId}/complete`, {
            txid: txId,
        });
    } catch (completeErr) {
        // Non-fatal: wallet already credited. Log for manual reconciliation.
        logger.warn({ completeErr, piPaymentId }, 'Failed to notify Pi Platform of completion');
    }

    logger.info({
        playerId,
        piPaymentId,
        tokensToCredit,
        piAmount: piPayment.amount,
    }, 'Pi payment confirmed and wallet credited');

    return res.status(200).json({
        success: true,
        tokensGranted: tokensToCredit / 1_000_000,  // human-readable units for client display
        internalPaymentId,
    });
});

// ---------------------------------------------------------------------------
// POST /payments/cancel
// Body: { internalPaymentId: string, piPaymentId: string }
// Called when user cancels on the Pi SDK side — clean up the pending record
// ---------------------------------------------------------------------------
router.post('/cancel', async (req, res) => {
    const { internalPaymentId, piPaymentId } = req.body;
    const playerId = req.player.id;

    await db.query(
        `UPDATE pi_payments
         SET status      = 'failed',
             raw_payload = COALESCE(raw_payload, '{}'::jsonb) || '{"cancelledByUser": true}'::jsonb
         WHERE id = $1 AND player_id = $2 AND status = 'pending'`,
        [internalPaymentId, playerId]
    );

    if (piPaymentId) {
        await redis.del(`idempotency:payment:${piPaymentId}`);
    }

    return res.status(200).json({ success: true });
});

// ---------------------------------------------------------------------------
// GET /payments/:id/status
// Polling endpoint for client to check final state
// ---------------------------------------------------------------------------
router.get('/:id/status', async (req, res) => {
    const { id } = req.params;
    const playerId = req.player.id;

    const result = await db.query(
        `SELECT status, tokens_credited, confirmed_at
         FROM pi_payments
         WHERE id = $1 AND player_id = $2`,
        [id, playerId]
    );

    if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Payment not found' });
    }

    const row = result.rows[0];
    return res.status(200).json({
        status: row.status,
        tokensGranted: row.tokens_credited ? row.tokens_credited / 1_000_000 : 0,
        confirmedAt: row.confirmed_at,
    });
});

// ---------------------------------------------------------------------------
// POST /payments/store-purchase
// Spend game tokens to buy a catalog item — no Pi involved
// Body: { itemId: string }
// ---------------------------------------------------------------------------
router.post('/store-purchase', async (req, res) => {
    const { itemId } = req.body;
    const playerId = req.player.id;

    if (!itemId) {
        return res.status(400).json({ error: 'itemId is required' });
    }

    // Fetch item price from DB (never trust client-sent price)
    const itemResult = await db.query(
        `SELECT id, display_name, price_tokens, rarity
         FROM catalog_items
         WHERE id = $1 AND is_active = TRUE`,
        [itemId]
    );

    if (itemResult.rowCount === 0) {
        return res.status(404).json({ error: 'Item not found or inactive' });
    }

    const item = itemResult.rows[0];

    // Check if player already owns the item
    const ownsCheck = await db.query(
        'SELECT id FROM player_inventories WHERE player_id = $1 AND item_id = $2',
        [playerId, item.id]
    );

    if (ownsCheck.rowCount > 0) {
        return res.status(409).json({ error: 'You already own this item' });
    }

    const client = await db.connect();
    let txId;
    try {
        await client.query('BEGIN');

        // Debit wallet (throws if insufficient funds)
        const debitResult = await client.query(
            `SELECT fn_wallet_debit($1, $2, 'store_purchase'::transaction_type, $3, $4) AS tx_id`,
            [
                playerId,
                item.price_tokens,
                item.id,
                `Store purchase: ${item.display_name} (${item.rarity})`,
            ]
        );
        txId = debitResult.rows[0].tx_id;

        // Grant item to inventory
        await client.query(
            `INSERT INTO player_inventories (player_id, item_id, acquisition_tx)
             VALUES ($1, $2, (
                 SELECT id FROM wallet_transactions
                 WHERE player_id = $1 AND reference_id = $3
                 ORDER BY created_at DESC LIMIT 1
             ))`,
            [playerId, item.id, item.id]
        );

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.message.includes('Insufficient balance')) {
            return res.status(402).json({ error: 'Insufficient token balance' });
        }
        logger.error({ err, playerId, itemId }, 'Store purchase failed');
        return res.status(500).json({ error: 'Purchase failed — please retry' });
    } finally {
        client.release();
    }

    return res.status(200).json({
        success: true,
        item: { id: item.id, name: item.display_name, rarity: item.rarity },
    });
});

// ---------------------------------------------------------------------------
// POST /bounties/place
// Places a Vendetta bounty — deducts tokens + brokerage fee
// Body: { targetPlayerId: string, tokenAmount: number (human units) }
// ---------------------------------------------------------------------------
router.post('/bounties/place', async (req, res) => {
    const { targetPlayerId, tokenAmount } = req.body;
    const placerId = req.player.id;

    if (!targetPlayerId || !tokenAmount || tokenAmount <= 0) {
        return res.status(400).json({ error: 'targetPlayerId and tokenAmount are required' });
    }

    if (targetPlayerId === placerId) {
        return res.status(400).json({ error: 'Cannot place a bounty on yourself' });
    }

    // Convert to micro-units
    const totalMicro     = Math.floor(tokenAmount * 1_000_000);
    const feeRate        = 0.025; // 2.5%
    const feeMicro       = Math.floor(totalMicro * feeRate);
    const poolMicro      = totalMicro - feeMicro;

    const bountyId = uuidv4();

    const client = await db.connect();
    try {
        await client.query('BEGIN');

        // Debit full amount from placer wallet
        await client.query(
            `SELECT fn_wallet_debit($1, $2, 'bounty_placed'::transaction_type, $3, $4)`,
            [
                placerId,
                totalMicro,
                bountyId,
                `Bounty placed on ${targetPlayerId}`,
            ]
        );

        // Insert bounty contract
        await client.query(
            `INSERT INTO bounty_contracts
                 (id, placer_id, target_id, total_pool, brokerage_fee, fee_rate, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '7 days')`,
            [bountyId, placerId, targetPlayerId, poolMicro, feeMicro, feeRate]
        );

        // Route brokerage fee to dev wallet ledger
        await client.query(
            `INSERT INTO dev_wallet_ledger (source_type, source_id, amount_tokens)
             VALUES ('bounty_brokerage', $1, $2)`,
            [bountyId, feeMicro]
        );

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.message.includes('Insufficient balance')) {
            return res.status(402).json({ error: 'Insufficient token balance' });
        }
        logger.error({ err, placerId, targetPlayerId }, 'Bounty placement failed');
        return res.status(500).json({ error: 'Failed to place bounty' });
    } finally {
        client.release();
    }

    // Notify target player via Nakama notification (non-blocking)
    notifyBountyTarget(targetPlayerId, placerId, poolMicro).catch((e) =>
        logger.warn({ e }, 'Failed to send bounty notification')
    );

    return res.status(200).json({
        success: true,
        bountyId,
        pool: poolMicro / 1_000_000,
        fee: feeMicro / 1_000_000,
    });
});

// ---------------------------------------------------------------------------
// INTERNAL: Push Nakama notification when a bounty is placed
// ---------------------------------------------------------------------------
async function notifyBountyTarget(targetPlayerId, placerId, poolMicro) {
    const nakamaClient = (await import('../nakama/client.js')).default;
    await nakamaClient.notifyUser(targetPlayerId, {
        type: 'BOUNTY_PLACED',
        message: 'You are being hunted.',
        data: {
            placerId,
            pool: poolMicro / 1_000_000,
        },
    });
}

export default router;
