-- Arena MVP v2 additive migration.
-- Apply once to an existing D1 database before enabling online Arena v2.
-- The main data-schema.sql already contains these columns for fresh databases.

ALTER TABLE arena_matches ADD COLUMN mode_version TEXT NOT NULL DEFAULT 'arena-mvp-online-v2';
ALTER TABLE arena_matches ADD COLUMN balance_version TEXT NOT NULL DEFAULT 'sim-100k-v3';
ALTER TABLE arena_matches ADD COLUMN map_version TEXT NOT NULL DEFAULT 'normal-48-v1';
ALTER TABLE arena_matches ADD COLUMN rules_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE arena_matches ADD COLUMN ended_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE arena_matches ADD COLUMN duration_sec INTEGER NOT NULL DEFAULT 0;
ALTER TABLE arena_matches ADD COLUMN peak_active_players INTEGER NOT NULL DEFAULT 0;
ALTER TABLE arena_matches ADD COLUMN server_state_updates INTEGER NOT NULL DEFAULT 0;
ALTER TABLE arena_matches ADD COLUMN server_actions INTEGER NOT NULL DEFAULT 0;
ALTER TABLE arena_matches ADD COLUMN anomaly_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE arena_match_players ADD COLUMN state_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE arena_match_players ADD COLUMN last_state_at INTEGER;
ALTER TABLE arena_match_players ADD COLUMN last_x REAL NOT NULL DEFAULT 0;
ALTER TABLE arena_match_players ADD COLUMN last_y REAL NOT NULL DEFAULT 0;
ALTER TABLE arena_match_players ADD COLUMN hp REAL NOT NULL DEFAULT 0;
ALTER TABLE arena_match_players ADD COLUMN max_hp REAL NOT NULL DEFAULT 0;
ALTER TABLE arena_match_players ADD COLUMN level INTEGER NOT NULL DEFAULT 1;
ALTER TABLE arena_match_players ADD COLUMN damage_taken REAL NOT NULL DEFAULT 0;
ALTER TABLE arena_match_players ADD COLUMN pve_kills INTEGER NOT NULL DEFAULT 0;
ALTER TABLE arena_match_players ADD COLUMN skill_casts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE arena_match_players ADD COLUMN state_updates INTEGER NOT NULL DEFAULT 0;
ALTER TABLE arena_match_players ADD COLUMN action_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE arena_match_players ADD COLUMN anomaly_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE arena_match_players ADD COLUMN disconnects INTEGER NOT NULL DEFAULT 0;
ALTER TABLE arena_match_players ADD COLUMN reconnects INTEGER NOT NULL DEFAULT 0;
ALTER TABLE arena_match_players ADD COLUMN outcome_rank INTEGER;
ALTER TABLE arena_match_players ADD COLUMN outcome_reason TEXT NOT NULL DEFAULT '';

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
