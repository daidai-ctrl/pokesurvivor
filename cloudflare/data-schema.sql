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

CREATE TABLE IF NOT EXISTS ranking_entries (
  board TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  t INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(board, entry_id)
);
CREATE INDEX IF NOT EXISTS ranking_board_time_idx ON ranking_entries(board, t DESC);

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
