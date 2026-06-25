-- =============================================================================
--  Operation: Archipelago — Master Database Schema
--  Engine: PostgreSQL 15+
--  In-game token balances stored as integer micro-units (1 token = 1,000,000 units).
--  Pi amounts stored as exact decimals NUMERIC(18,7) (e.g. token_packages.price_pi,
--  pi_payments.amount_pi).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- EXTENSIONS
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "btree_gin";

-- ---------------------------------------------------------------------------
-- ENUMS
-- ---------------------------------------------------------------------------

CREATE TYPE rarity_tier AS ENUM (
    'common', 'rare', 'epic', 'legendary', 'mythic'
);

CREATE TYPE item_category AS ENUM (
    'weapon_blueprint', 'character_skin', 'vehicle_wrap',
    'kill_effect', 'reload_animation', 'holographic_texture',
    'dog_tag_frame', 'parachute_skin', 'emote'
);

CREATE TYPE bounty_status AS ENUM (
    'active', 'claimed', 'expired', 'cancelled'
);

CREATE TYPE match_mode AS ENUM (
    'battle_royale_solo', 'battle_royale_duo', 'battle_royale_quad',
    'tdm', 'frontline', 'free_for_all', 'one_shot_one_kill', 'firing_range'
);

CREATE TYPE match_status AS ENUM (
    'waiting', 'loading', 'active', 'completed', 'abandoned'
);

CREATE TYPE transaction_type AS ENUM (
    'pi_purchase',       -- player bought tokens with Pi
    'store_purchase',    -- player bought item with tokens
    'bounty_placed',     -- player placed a bounty (debit)
    'bounty_claimed',    -- hunter collected bounty (credit)
    'bounty_fee',        -- brokerage fee routed to dev wallet
    'dog_tag_collected', -- tokens earned from dog tag pickup
    'reward_credit',     -- match completion reward
    'admin_grant'        -- developer-issued credit
);

CREATE TYPE vehicle_type AS ENUM (
    'jet_ski', 'hovercraft', 'combat_boat', 'atv', 'armored_truck'
);

-- ---------------------------------------------------------------------------
-- TABLE: players
-- Core identity table — keyed on Pi Network UID
-- ---------------------------------------------------------------------------
CREATE TABLE players (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    pi_uid              VARCHAR(128)  UNIQUE NOT NULL,   -- immutable Pi Network user ID
    pi_username         VARCHAR(64)   UNIQUE NOT NULL,   -- display handle from Pi SDK
    display_name        VARCHAR(32),                     -- optional custom in-game alias
    avatar_url          TEXT,
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    last_login_at       TIMESTAMPTZ,
    is_banned           BOOLEAN       NOT NULL DEFAULT FALSE,
    ban_reason          TEXT,
    ban_expires_at      TIMESTAMPTZ,

    -- progression
    global_level        SMALLINT      NOT NULL DEFAULT 1,
    global_xp           INTEGER       NOT NULL DEFAULT 0,
    season_rank         SMALLINT      NOT NULL DEFAULT 0,   -- 0 = unranked
    season_xp           INTEGER       NOT NULL DEFAULT 0,
    prestige_level      SMALLINT      NOT NULL DEFAULT 0,

    -- stats aggregates (updated via trigger after each match)
    total_kills         INTEGER       NOT NULL DEFAULT 0,
    total_deaths        INTEGER       NOT NULL DEFAULT 0,
    total_matches       INTEGER       NOT NULL DEFAULT 0,
    total_wins          INTEGER       NOT NULL DEFAULT 0,
    best_kill_streak    SMALLINT      NOT NULL DEFAULT 0,

    -- settings blobs (JSON for flexibility)
    hud_layout          JSONB,   -- saved button positions/sizes
    sensitivity_config  JSONB,   -- look/ADS sensitivity curves
    control_scheme      JSONB,   -- 2-thumb / 4-finger claw mapping

    -- region preference
    preferred_region    VARCHAR(16) DEFAULT 'auto',

    CONSTRAINT chk_global_level   CHECK (global_level BETWEEN 1 AND 500),
    CONSTRAINT chk_season_rank    CHECK (season_rank BETWEEN 0 AND 10)
);

CREATE INDEX idx_players_pi_uid       ON players(pi_uid);
CREATE INDEX idx_players_season_rank  ON players(season_rank DESC);
CREATE INDEX idx_players_global_level ON players(global_level DESC);

-- ---------------------------------------------------------------------------
-- TABLE: wallets
-- One wallet per player — single source of truth for token balance
-- ---------------------------------------------------------------------------
CREATE TABLE wallets (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    player_id       UUID        NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    balance         BIGINT      NOT NULL DEFAULT 0,   -- stored in micro-units
    lifetime_earned BIGINT      NOT NULL DEFAULT 0,
    lifetime_spent  BIGINT      NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_balance_non_negative CHECK (balance >= 0),
    CONSTRAINT uq_wallet_player UNIQUE (player_id)
);

CREATE INDEX idx_wallets_player_id ON wallets(player_id);

-- ---------------------------------------------------------------------------
-- TABLE: wallet_transactions
-- Immutable audit ledger — never UPDATE or DELETE rows here
-- ---------------------------------------------------------------------------
CREATE TABLE wallet_transactions (
    id              UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
    player_id       UUID            NOT NULL REFERENCES players(id),
    tx_type         transaction_type NOT NULL,
    amount          BIGINT          NOT NULL,   -- positive = credit, negative = debit
    balance_after   BIGINT          NOT NULL,
    reference_id    UUID,                       -- links to pi_payments.id, bounties.id, etc.
    description     TEXT,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    ip_hash         VARCHAR(64),                -- hashed IP for fraud review

    CONSTRAINT chk_amount_nonzero CHECK (amount != 0)
);

CREATE INDEX idx_wallet_tx_player    ON wallet_transactions(player_id, created_at DESC);
CREATE INDEX idx_wallet_tx_reference ON wallet_transactions(reference_id);

-- ---------------------------------------------------------------------------
-- TABLE: token_packages
-- Purchasable Pi → game-token bundles — server-priced to prevent manipulation
-- (queried by POST /payments/initiate)
-- ---------------------------------------------------------------------------
CREATE TABLE token_packages (
    id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    sku             VARCHAR(64)  UNIQUE NOT NULL,
    display_name    VARCHAR(128) NOT NULL,
    price_pi        NUMERIC(18,7) NOT NULL,   -- Pi cost (exact decimal)
    tokens_granted  BIGINT       NOT NULL,    -- game tokens awarded on confirm
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_package_price_positive  CHECK (price_pi > 0),
    CONSTRAINT chk_package_tokens_positive CHECK (tokens_granted > 0)
);

CREATE INDEX idx_token_packages_active ON token_packages(is_active) WHERE is_active = TRUE;

-- ---------------------------------------------------------------------------
-- TABLE: pi_payments
-- Records every Pi Network blockchain payment — txid is the external anchor
-- ---------------------------------------------------------------------------
CREATE TABLE pi_payments (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    player_id       UUID        NOT NULL REFERENCES players(id),
    pi_payment_id   VARCHAR(128) UNIQUE NOT NULL,   -- Pi SDK paymentId
    pi_txid         VARCHAR(256) UNIQUE,            -- on-chain transaction ID (set after confirm)
    amount_pi       NUMERIC(18,7) NOT NULL,         -- Pi tokens paid (exact decimal)
    tokens_credited BIGINT      NOT NULL DEFAULT 0, -- game tokens credited after validation
    status          VARCHAR(32) NOT NULL DEFAULT 'pending',  -- pending/confirmed/failed/refunded
    pi_block_hash   VARCHAR(256),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    confirmed_at    TIMESTAMPTZ,
    raw_payload     JSONB,                          -- full Pi SDK callback payload for audit

    CONSTRAINT chk_amount_positive CHECK (amount_pi > 0),
    CONSTRAINT chk_status CHECK (
        status IN ('pending','confirmed','failed','refunded','duplicate_rejected')
    )
);

CREATE INDEX idx_pi_payments_player   ON pi_payments(player_id);
CREATE INDEX idx_pi_payments_pi_txid  ON pi_payments(pi_txid);
CREATE INDEX idx_pi_payments_status   ON pi_payments(status);

-- ---------------------------------------------------------------------------
-- TABLE: catalog_items
-- Master item catalog — managed by developers only
-- ---------------------------------------------------------------------------
CREATE TABLE catalog_items (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    sku             VARCHAR(64) UNIQUE NOT NULL,
    display_name    VARCHAR(128) NOT NULL,
    description     TEXT,
    category        item_category NOT NULL,
    rarity          rarity_tier   NOT NULL,
    price_tokens    BIGINT      NOT NULL DEFAULT 0,
    asset_bundle    TEXT        NOT NULL,   -- CDN path to GLB/asset bundle
    thumbnail_url   TEXT,
    preview_video   TEXT,
    is_limited      BOOLEAN     NOT NULL DEFAULT FALSE,
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- rarity-specific metadata
    kill_tracer_color  VARCHAR(16),
    has_custom_reload  BOOLEAN NOT NULL DEFAULT FALSE,
    holographic        BOOLEAN NOT NULL DEFAULT FALSE,

    CONSTRAINT chk_price_non_negative CHECK (price_tokens >= 0)
);

CREATE INDEX idx_catalog_rarity   ON catalog_items(rarity);
CREATE INDEX idx_catalog_category ON catalog_items(category);
CREATE INDEX idx_catalog_active   ON catalog_items(is_active);

-- ---------------------------------------------------------------------------
-- TABLE: player_inventories
-- Junction table: which player owns which item (and how many instances)
-- ---------------------------------------------------------------------------
CREATE TABLE player_inventories (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    player_id       UUID        NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    item_id         UUID        NOT NULL REFERENCES catalog_items(id),
    acquired_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    acquisition_tx  UUID        REFERENCES wallet_transactions(id),
    is_equipped     BOOLEAN     NOT NULL DEFAULT FALSE,
    slot            VARCHAR(32),    -- 'primary', 'secondary', 'character', etc.
    serial_number   BIGSERIAL,      -- globally unique serial (Trophy Room display)

    CONSTRAINT uq_player_item UNIQUE (player_id, item_id)
);

CREATE INDEX idx_inventory_player    ON player_inventories(player_id);
CREATE INDEX idx_inventory_item      ON player_inventories(item_id);
CREATE INDEX idx_inventory_equipped  ON player_inventories(player_id, is_equipped) WHERE is_equipped = TRUE;

-- ---------------------------------------------------------------------------
-- TABLE: dog_tags
-- Physical collectible tags dropped on player death
-- ---------------------------------------------------------------------------
CREATE TABLE dog_tags (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    match_id        UUID        NOT NULL,   -- references matches.id (FK added after matches table; see below)
    victim_id       UUID        NOT NULL REFERENCES players(id),
    killer_id       UUID        REFERENCES players(id),   -- NULL if environmental
    token_value     BIGINT      NOT NULL DEFAULT 0,
    collected       BOOLEAN     NOT NULL DEFAULT FALSE,
    collected_by    UUID        REFERENCES players(id),
    collected_at    TIMESTAMPTZ,
    dropped_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- position on map where tag was dropped
    map_pos_x       REAL,
    map_pos_z       REAL,
    -- scaling factors used at drop time (for audit)
    victim_level    SMALLINT    NOT NULL DEFAULT 1,
    victim_rank     SMALLINT    NOT NULL DEFAULT 0,
    kill_streak     SMALLINT    NOT NULL DEFAULT 0,
    -- cosmetic / display
    is_trophy       BOOLEAN     NOT NULL DEFAULT FALSE,  -- flagged for Trophy Room display

    CONSTRAINT chk_token_value_positive CHECK (token_value >= 0)
);

CREATE INDEX idx_dog_tags_match   ON dog_tags(match_id);
CREATE INDEX idx_dog_tags_victim  ON dog_tags(victim_id);
CREATE INDEX idx_dog_tags_killer  ON dog_tags(killer_id);
CREATE INDEX idx_dog_tags_active  ON dog_tags(match_id, collected) WHERE collected = FALSE;

-- ---------------------------------------------------------------------------
-- TABLE: trophy_room
-- Per-player curated wall of notable dog tags
-- ---------------------------------------------------------------------------
CREATE TABLE trophy_room (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    player_id       UUID        NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    dog_tag_id      UUID        NOT NULL REFERENCES dog_tags(id),
    slot_index      SMALLINT    NOT NULL,       -- wall position 0-19
    added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_trophy_slot UNIQUE (player_id, slot_index),
    CONSTRAINT uq_trophy_tag  UNIQUE (player_id, dog_tag_id),
    CONSTRAINT chk_slot_range CHECK (slot_index BETWEEN 0 AND 19)
);

-- ---------------------------------------------------------------------------
-- TABLE: bounty_contracts
-- Vendetta and open bounty contracts — the core token-sink economy
-- ---------------------------------------------------------------------------
CREATE TABLE bounty_contracts (
    id              UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
    placer_id       UUID            NOT NULL REFERENCES players(id),
    target_id       UUID            NOT NULL REFERENCES players(id),
    match_id        UUID,           -- NULL = cross-match persistent bounty
    total_pool      BIGINT          NOT NULL,           -- tokens in the pool (after fee)
    brokerage_fee   BIGINT          NOT NULL DEFAULT 0, -- fee taken at creation (dev wallet)
    fee_rate        NUMERIC(5,4)    NOT NULL DEFAULT 0.025,  -- 2.5% default
    status          bounty_status   NOT NULL DEFAULT 'active',
    placed_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ,    -- NULL = no expiry until collected
    claimed_by      UUID            REFERENCES players(id),
    claimed_at      TIMESTAMPTZ,
    -- grudge match settings
    grudge_enabled  BOOLEAN         NOT NULL DEFAULT TRUE,
    grudge_lobbies  SMALLINT        NOT NULL DEFAULT 3,    -- how many queued matches to enforce proximity
    -- tracking / hunt gadget state
    hunt_active     BOOLEAN         NOT NULL DEFAULT FALSE,

    CONSTRAINT chk_pool_positive    CHECK (total_pool > 0),
    CONSTRAINT chk_no_self_bounty   CHECK (placer_id != target_id)
);

CREATE INDEX idx_bounty_target  ON bounty_contracts(target_id, status) WHERE status = 'active';
CREATE INDEX idx_bounty_placer  ON bounty_contracts(placer_id);
CREATE INDEX idx_bounty_match   ON bounty_contracts(match_id);
CREATE INDEX idx_bounty_active  ON bounty_contracts(status, expires_at) WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- TABLE: matches
-- Master match record — created by game server at session start
-- ---------------------------------------------------------------------------
CREATE TABLE matches (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    mode            match_mode  NOT NULL,
    status          match_status NOT NULL DEFAULT 'waiting',
    region          VARCHAR(16) NOT NULL,
    server_instance VARCHAR(128),   -- Photon room/session ID
    map_name        VARCHAR(64) NOT NULL DEFAULT 'archipelago_grand_matrix',
    started_at      TIMESTAMPTZ,
    ended_at        TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    winner_id       UUID        REFERENCES players(id),   -- Solo BR winner
    winning_team_id UUID,                                  -- Team modes
    total_players   SMALLINT    NOT NULL DEFAULT 0,
    storm_phase     SMALLINT    NOT NULL DEFAULT 0,       -- BR storm ring phase 0-6
    metadata        JSONB       -- arbitrary server stats (avg latency, etc.)
);

CREATE INDEX idx_matches_status  ON matches(status);
CREATE INDEX idx_matches_mode    ON matches(mode, started_at DESC);

-- Deferred FK: dog_tags.match_id references matches.id (matches is created here,
-- after dog_tags, so the constraint is added now rather than inline).
ALTER TABLE dog_tags
    ADD CONSTRAINT fk_dog_tags_match
    FOREIGN KEY (match_id) REFERENCES matches(id);

-- ---------------------------------------------------------------------------
-- TABLE: match_players
-- Per-player stats within a single match
-- ---------------------------------------------------------------------------
CREATE TABLE match_players (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    match_id        UUID        NOT NULL REFERENCES matches(id),
    player_id       UUID        NOT NULL REFERENCES players(id),
    team_id         UUID,
    placement       SMALLINT,   -- final rank (1 = winner)
    kills           SMALLINT    NOT NULL DEFAULT 0,
    deaths          SMALLINT    NOT NULL DEFAULT 0,
    assists         SMALLINT    NOT NULL DEFAULT 0,
    damage_dealt    INTEGER     NOT NULL DEFAULT 0,
    damage_taken    INTEGER     NOT NULL DEFAULT 0,
    tokens_earned   BIGINT      NOT NULL DEFAULT 0,
    xp_earned       INTEGER     NOT NULL DEFAULT 0,
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    eliminated_at   TIMESTAMPTZ,
    active_bounties SMALLINT    NOT NULL DEFAULT 0,  -- bounties on this player at match start

    CONSTRAINT uq_match_player UNIQUE (match_id, player_id)
);

CREATE INDEX idx_match_players_match  ON match_players(match_id);
CREATE INDEX idx_match_players_player ON match_players(player_id, match_id DESC);

-- ---------------------------------------------------------------------------
-- TABLE: friends
-- Bidirectional friend graph — only one canonical row per pair
-- ---------------------------------------------------------------------------
CREATE TABLE friends (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    player_a_id     UUID        NOT NULL REFERENCES players(id),
    player_b_id     UUID        NOT NULL REFERENCES players(id),
    initiated_by    UUID        NOT NULL REFERENCES players(id),
    accepted        BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    accepted_at     TIMESTAMPTZ,

    CONSTRAINT uq_friendship    UNIQUE (player_a_id, player_b_id),
    CONSTRAINT chk_no_self_friend CHECK (player_a_id != player_b_id),
    CONSTRAINT chk_canonical_order CHECK (player_a_id < player_b_id)
);

CREATE INDEX idx_friends_a ON friends(player_a_id, accepted);
CREATE INDEX idx_friends_b ON friends(player_b_id, accepted);

-- ---------------------------------------------------------------------------
-- TABLE: dev_wallet_ledger
-- Tracks all revenue flows into the developer master wallet
-- (separate from player wallets for accounting)
-- ---------------------------------------------------------------------------
CREATE TABLE dev_wallet_ledger (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_type     VARCHAR(32) NOT NULL,  -- 'pi_purchase_fee', 'bounty_brokerage', 'store_margin'
    source_id       UUID,                  -- FK to originating record
    amount_tokens   BIGINT      NOT NULL,
    amount_pi       NUMERIC(18,7),         -- set when a Pi payout occurs
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_dev_ledger_type ON dev_wallet_ledger(source_type, created_at DESC);

-- ---------------------------------------------------------------------------
-- VIEWS
-- ---------------------------------------------------------------------------

-- Active bounties with enriched player names for API queries
CREATE VIEW v_active_bounties AS
SELECT
    bc.id,
    bc.total_pool,
    bc.brokerage_fee,
    bc.placed_at,
    bc.expires_at,
    bc.grudge_enabled,
    p_placer.pi_username  AS placer_username,
    p_target.pi_username  AS target_username,
    p_target.global_level AS target_level,
    p_target.season_rank  AS target_rank
FROM bounty_contracts bc
JOIN players p_placer ON p_placer.id = bc.placer_id
JOIN players p_target ON p_target.id = bc.target_id
WHERE bc.status = 'active';

-- Leaderboard snapshot (top 100 by season rank)
CREATE VIEW v_leaderboard_season AS
SELECT
    ROW_NUMBER() OVER (ORDER BY season_rank DESC, season_xp DESC) AS position,
    pi_username,
    display_name,
    season_rank,
    season_xp,
    total_kills,
    total_wins
FROM players
WHERE is_banned = FALSE
ORDER BY season_rank DESC, season_xp DESC
LIMIT 100;

-- ---------------------------------------------------------------------------
-- FUNCTIONS & TRIGGERS
-- ---------------------------------------------------------------------------

-- Atomic wallet debit function — returns new balance or raises exception
CREATE OR REPLACE FUNCTION fn_wallet_debit(
    p_player_id     UUID,
    p_amount        BIGINT,
    p_tx_type       transaction_type,
    p_reference_id  UUID DEFAULT NULL,
    p_description   TEXT DEFAULT NULL
) RETURNS BIGINT AS $$
DECLARE
    v_balance   BIGINT;
    v_new_bal   BIGINT;
BEGIN
    -- Exclusive lock on wallet row
    SELECT balance INTO v_balance
    FROM wallets
    WHERE player_id = p_player_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Wallet not found for player %', p_player_id;
    END IF;

    IF v_balance < p_amount THEN
        RAISE EXCEPTION 'Insufficient balance: has %, needs %', v_balance, p_amount;
    END IF;

    v_new_bal := v_balance - p_amount;

    UPDATE wallets
    SET balance        = v_new_bal,
        lifetime_spent = lifetime_spent + p_amount,
        updated_at     = NOW()
    WHERE player_id = p_player_id;

    INSERT INTO wallet_transactions
        (player_id, tx_type, amount, balance_after, reference_id, description)
    VALUES
        (p_player_id, p_tx_type, -p_amount, v_new_bal, p_reference_id, p_description);

    RETURN v_new_bal;
END;
$$ LANGUAGE plpgsql;

-- Atomic wallet credit function
CREATE OR REPLACE FUNCTION fn_wallet_credit(
    p_player_id     UUID,
    p_amount        BIGINT,
    p_tx_type       transaction_type,
    p_reference_id  UUID DEFAULT NULL,
    p_description   TEXT DEFAULT NULL
) RETURNS BIGINT AS $$
DECLARE
    v_new_bal   BIGINT;
BEGIN
    UPDATE wallets
    SET balance        = balance + p_amount,
        lifetime_earned = lifetime_earned + p_amount,
        updated_at     = NOW()
    WHERE player_id = p_player_id
    RETURNING balance INTO v_new_bal;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Wallet not found for player %', p_player_id;
    END IF;

    INSERT INTO wallet_transactions
        (player_id, tx_type, amount, balance_after, reference_id, description)
    VALUES
        (p_player_id, p_tx_type, p_amount, v_new_bal, p_reference_id, p_description);

    RETURN v_new_bal;
END;
$$ LANGUAGE plpgsql;

-- Trigger: keep player aggregate stats current after match_players insert/update
CREATE OR REPLACE FUNCTION fn_update_player_stats() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.eliminated_at IS NOT NULL THEN
        UPDATE players SET
            total_kills  = total_kills  + NEW.kills,
            total_deaths = total_deaths + NEW.deaths,
            total_matches = total_matches + 1,
            global_xp    = global_xp + NEW.xp_earned,
            best_kill_streak = GREATEST(best_kill_streak, NEW.kills)
        WHERE id = NEW.player_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_player_stats
AFTER UPDATE OF eliminated_at ON match_players
FOR EACH ROW EXECUTE FUNCTION fn_update_player_stats();

-- Trigger: calculate dog tag value dynamically on insert
CREATE OR REPLACE FUNCTION fn_calculate_dog_tag_value() RETURNS TRIGGER AS $$
DECLARE
    v_level     SMALLINT;
    v_rank      SMALLINT;
    base_value  BIGINT := 50000;  -- 0.05 tokens base (in micro-units x1000)
BEGIN
    SELECT global_level, season_rank INTO v_level, v_rank
    FROM players WHERE id = NEW.victim_id;

    NEW.victim_level := v_level;
    NEW.victim_rank  := v_rank;

    -- Value formula: base * (1 + level/100) * (1 + rank/10) * (1 + streak/5)
    NEW.token_value := (
        base_value
        * (1.0 + v_level::FLOAT / 100.0)
        * (1.0 + v_rank::FLOAT  / 10.0)
        * (1.0 + NEW.kill_streak::FLOAT / 5.0)
    )::BIGINT;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_dog_tag_value
BEFORE INSERT ON dog_tags
FOR EACH ROW EXECUTE FUNCTION fn_calculate_dog_tag_value();
