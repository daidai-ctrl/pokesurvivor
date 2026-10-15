-- Arena rewards v1 additive migration.
-- Apply once to an existing D1 database before enabling the reward endpoints.
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
