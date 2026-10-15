-- Additive migration for indexed ranking membership lookups.
-- Safe to run more than once: both the table and rows are idempotent.
CREATE TABLE IF NOT EXISTS ranking_entry_members (
  board TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  PRIMARY KEY(board, entry_id, uid)
);
CREATE INDEX IF NOT EXISTS ranking_entry_members_uid_idx ON ranking_entry_members(uid, board, entry_id);

INSERT OR IGNORE INTO ranking_entry_members(board, entry_id, uid)
SELECT r.board, r.entry_id, CAST(j.value AS TEXT)
FROM ranking_entries AS r, json_each(json_extract(r.payload, '$.uids')) AS j
WHERE json_type(r.payload, '$.uids') = 'array';
