-- PokéSurvivor data plane. Firebase Authentication remains the identity
-- provider; this database stores the game data after the migration.
CREATE TABLE IF NOT EXISTS saves (
  uid TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  game_updated INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  uid TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One short Arena MVP questionnaire per completed fifth match/version.
-- Free text is intentionally bounded by the API and kept separate from saves.
CREATE TABLE IF NOT EXISTS arena_feedback (
  feedback_id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  arena_version TEXT NOT NULL,
  run_count INTEGER NOT NULL,
  liked TEXT NOT NULL,
  liked_points TEXT NOT NULL DEFAULT '',
  disliked_point TEXT NOT NULL DEFAULT '',
  suggestion TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT '',
  duration_sec INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 0,
  role_dex INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS arena_feedback_uid_idx ON arena_feedback(uid, created_at DESC);
CREATE INDEX IF NOT EXISTS arena_feedback_created_idx ON arena_feedback(created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS arena_feedback_uid_version_idx ON arena_feedback(uid, arena_version);

-- Online Arena state is kept separate from the normal co-op room tables.
-- A queue row represents a paid seat; it is promoted to a match by the
-- ArenaMatchmaker Durable Object in groups of eight.
CREATE TABLE IF NOT EXISTS arena_queue (
  uid TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  name TEXT NOT NULL,
  dex INTEGER NOT NULL,
  shiny INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  match_id TEXT,
  queued_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS arena_queue_status_idx ON arena_queue(status, queued_at);

CREATE TABLE IF NOT EXISTS arena_matches (
  match_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  mode_version TEXT NOT NULL DEFAULT 'arena-mvp-online-v2',
  balance_version TEXT NOT NULL DEFAULT 'sim-100k-v3',
  map_version TEXT NOT NULL DEFAULT 'normal-48-v1',
  rules_json TEXT NOT NULL DEFAULT '{}',
  entry_coins INTEGER NOT NULL DEFAULT 100,
  prize_coins INTEGER NOT NULL DEFAULT 700,
  expected_players INTEGER NOT NULL DEFAULT 8,
  seed INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  ended_reason TEXT NOT NULL DEFAULT '',
  duration_sec INTEGER NOT NULL DEFAULT 0,
  peak_active_players INTEGER NOT NULL DEFAULT 0,
  server_state_updates INTEGER NOT NULL DEFAULT 0,
  server_actions INTEGER NOT NULL DEFAULT 0,
  anomaly_count INTEGER NOT NULL DEFAULT 0,
  winner_uid TEXT,
  settlement_hash TEXT
);
CREATE INDEX IF NOT EXISTS arena_matches_status_idx ON arena_matches(status, created_at);

CREATE TABLE IF NOT EXISTS arena_match_players (
  match_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  seat INTEGER NOT NULL,
  name TEXT NOT NULL,
  dex INTEGER NOT NULL,
  shiny INTEGER NOT NULL DEFAULT 0,
  entry_coins INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'reserved',
  joined_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  reconnect_until INTEGER NOT NULL,
  death_at INTEGER,
  kills INTEGER NOT NULL DEFAULT 0,
  damage REAL NOT NULL DEFAULT 0,
  state_seq INTEGER NOT NULL DEFAULT 0,
  last_state_at INTEGER,
  last_x REAL NOT NULL DEFAULT 0,
  last_y REAL NOT NULL DEFAULT 0,
  hp REAL NOT NULL DEFAULT 0,
  max_hp REAL NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 1,
  damage_taken REAL NOT NULL DEFAULT 0,
  pve_kills INTEGER NOT NULL DEFAULT 0,
  skill_casts INTEGER NOT NULL DEFAULT 0,
  state_updates INTEGER NOT NULL DEFAULT 0,
  action_count INTEGER NOT NULL DEFAULT 0,
  anomaly_count INTEGER NOT NULL DEFAULT 0,
  disconnects INTEGER NOT NULL DEFAULT 0,
  reconnects INTEGER NOT NULL DEFAULT 0,
  outcome_rank INTEGER,
  outcome_reason TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(match_id, uid),
  UNIQUE(match_id, seat)
);
CREATE INDEX IF NOT EXISTS arena_match_players_uid_idx ON arena_match_players(uid, status);
CREATE INDEX IF NOT EXISTS arena_match_players_match_idx ON arena_match_players(match_id, status);

-- Reports are idempotent and form the audit trail used by server settlement.
-- The client can report only its own row; it cannot mark another player dead.
CREATE TABLE IF NOT EXISTS arena_match_events (
  event_id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  event_type TEXT NOT NULL,
  elapsed_sec INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 1,
  kills INTEGER NOT NULL DEFAULT 0,
  damage REAL NOT NULL DEFAULT 0,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS arena_match_events_match_idx ON arena_match_events(match_id, created_at);

-- Bounded-rate samples for balance and bug analysis. The room writes at most
-- one sample per player every few seconds, not every render frame.
CREATE TABLE IF NOT EXISTS arena_match_telemetry (
  telemetry_id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  sample_seq INTEGER NOT NULL,
  elapsed_sec INTEGER NOT NULL DEFAULT 0,
  x REAL NOT NULL DEFAULT 0,
  y REAL NOT NULL DEFAULT 0,
  hp REAL NOT NULL DEFAULT 0,
  max_hp REAL NOT NULL DEFAULT 0,
  damage_taken REAL NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 1,
  kills INTEGER NOT NULL DEFAULT 0,
  damage REAL NOT NULL DEFAULT 0,
  pve_kills INTEGER NOT NULL DEFAULT 0,
  skill_casts INTEGER NOT NULL DEFAULT 0,
  flags_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE(match_id, uid, sample_seq)
);
CREATE INDEX IF NOT EXISTS arena_match_telemetry_match_idx ON arena_match_telemetry(match_id, created_at);
CREATE INDEX IF NOT EXISTS arena_match_telemetry_uid_idx ON arena_match_telemetry(uid, created_at DESC);

-- Server-side validation findings are kept separately from player reports so
-- moderation and balance analysis can distinguish a real game event from a
-- suspicious client claim.
CREATE TABLE IF NOT EXISTS arena_match_incidents (
  incident_id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warn',
  elapsed_sec INTEGER NOT NULL DEFAULT 0,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS arena_match_incidents_match_idx ON arena_match_incidents(match_id, created_at);
CREATE INDEX IF NOT EXISTS arena_match_incidents_uid_idx ON arena_match_incidents(uid, created_at DESC);

-- Negative rows are entry charges, positive rows are prizes/refunds. The
-- idempotency key prevents retries, reconnects or duplicate clicks from
-- charging/paying twice.
CREATE TABLE IF NOT EXISTS arena_wallet_ledger (
  ledger_id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  match_id TEXT,
  kind TEXT NOT NULL,
  amount INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS arena_wallet_ledger_uid_idx ON arena_wallet_ledger(uid, created_at DESC);

-- Same transaction-guard pattern as the Waffo grant ledger. A failed CAS
-- aborts the whole D1 batch, so the wallet and its ledger never diverge.
CREATE TABLE IF NOT EXISTS arena_wallet_guards (
  id TEXT PRIMARY KEY,
  ok INTEGER NOT NULL CHECK(ok = 1)
);

CREATE TABLE IF NOT EXISTS collections (
  uid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  owned_count INTEGER NOT NULL DEFAULT 0,
  shiny_count INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS collections_score_idx ON collections(score DESC, owned_count DESC, shiny_count DESC);

-- Moderation flags are deliberately separate from saves and payment ledgers.
-- A leaderboard quarantine must never delete or rewrite a player's progress.
CREATE TABLE IF NOT EXISTS account_flags (
  uid TEXT PRIMARY KEY,
  flag TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS account_flags_flag_idx ON account_flags(flag);

-- Separate table because an account may be hidden from a leaderboard and also
-- need ticket quarantine; the two controls must not overwrite each other.
CREATE TABLE IF NOT EXISTS ticket_quarantines (
  uid TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ranking_entries (
  board TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  t INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(board, entry_id)
);
CREATE INDEX IF NOT EXISTS ranking_board_time_idx ON ranking_entries(board, t DESC);

-- Keep ranking membership queryable by UID. The ranking payload still keeps
-- its display data, but account deletion and ranking removal must not scan
-- every JSON payload in ranking_entries.
CREATE TABLE IF NOT EXISTS ranking_entry_members (
  board TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  PRIMARY KEY(board, entry_id, uid)
);
CREATE INDEX IF NOT EXISTS ranking_entry_members_uid_idx ON ranking_entry_members(uid, board, entry_id);

CREATE TABLE IF NOT EXISTS profiles (
  uid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  lower TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS profiles_lower_idx ON profiles(lower);

CREATE TABLE IF NOT EXISTS names (
  lower TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS friendships (
  id TEXT PRIMARY KEY,
  users_json TEXT NOT NULL,
  from_uid TEXT NOT NULL,
  to_uid TEXT NOT NULL,
  status TEXT NOT NULL,
  names_json TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS friendships_user_a_idx ON friendships(from_uid);
CREATE INDEX IF NOT EXISTS friendships_user_b_idx ON friendships(to_uid);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  to_uid TEXT NOT NULL,
  from_uid TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS invites_to_idx ON invites(to_uid);

CREATE TABLE IF NOT EXISTS presence (
  uid TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One-time campaign rewards. The unique key prevents duplicate claims even
-- when the browser retries after a slow network response.
CREATE TABLE IF NOT EXISTS share_rewards (
  uid TEXT NOT NULL,
  campaign TEXT NOT NULL,
  tickets_t1 INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing',
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  PRIMARY KEY (uid, campaign)
);
CREATE INDEX IF NOT EXISTS share_rewards_uid_idx ON share_rewards(uid, campaign);

-- One-time reward for completing the first valid online Arena match. This is
-- separate from share_rewards so the historical general-share campaign keeps
-- its own claim history and ticket amount.
CREATE TABLE IF NOT EXISTS arena_reward_claims (
  uid TEXT NOT NULL,
  campaign TEXT NOT NULL,
  match_id TEXT NOT NULL,
  tickets_t1 INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'processing',
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  payload TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (uid, campaign)
);
CREATE INDEX IF NOT EXISTS arena_reward_claims_match_idx ON arena_reward_claims(match_id, created_at DESC);

-- Waffo payment ledger. The order id and event id make fulfillment
-- idempotent: retries from Waffo can never grant the same purchase twice.
-- Rows are append/audit records; existing saves are never deleted or replaced.
CREATE TABLE IF NOT EXISTS waffo_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  order_id TEXT,
  status TEXT NOT NULL,
  uid TEXT,
  tickets_t1 INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS waffo_events_order_idx ON waffo_events(order_id);

CREATE TABLE IF NOT EXISTS waffo_orders (
  order_id TEXT PRIMARY KEY,
  event_id TEXT,
  uid TEXT,
  product_id TEXT,
  tickets_t1 INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  buyer_email TEXT,
  merchant_external_id TEXT,
  grant_nonce TEXT,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  granted_at INTEGER
);
CREATE INDEX IF NOT EXISTS waffo_orders_uid_idx ON waffo_orders(uid, status);
CREATE INDEX IF NOT EXISTS waffo_orders_external_idx ON waffo_orders(merchant_external_id);

-- A failed CAS must abort the whole D1 batch, including its ledger insert.
-- The CHECK constraint is deliberately used as a transaction guard.
CREATE TABLE IF NOT EXISTS waffo_grant_guards (
  id TEXT PRIMARY KEY,
  ok INTEGER NOT NULL CHECK(ok = 1)
);
