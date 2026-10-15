-- Read-only Arena MVP analysis queries for D1.
-- Run these against a copy/analytics environment first. None of the queries
-- below changes game state, wallet balances, or player saves.

-- 1) Match health: duration, throughput, anomalies and settlement reason.
SELECT
  match_id,
  mode_version,
  balance_version,
  map_version,
  status,
  expected_players,
  duration_sec,
  peak_active_players,
  server_state_updates,
  server_actions,
  anomaly_count,
  ended_reason,
  created_at,
  ended_at
FROM arena_matches
ORDER BY created_at DESC
LIMIT 200;

-- 2) Role balance: win rate, top-3 rate, survival and combat distribution.
WITH totals AS (
  SELECT COUNT(*) AS n FROM arena_match_players WHERE outcome_rank IS NOT NULL
), role_rows AS (
  SELECT
    dex,
    COUNT(*) AS appearances,
    SUM(CASE WHEN outcome_rank = 1 THEN 1 ELSE 0 END) AS wins,
    SUM(CASE WHEN outcome_rank <= 3 THEN 1 ELSE 0 END) AS top3,
    AVG(outcome_rank) AS avg_rank,
    AVG(level) AS avg_level,
    AVG(kills) AS avg_kills,
    AVG(damage) AS avg_damage,
    AVG(damage_taken) AS avg_damage_taken,
    AVG(pve_kills) AS avg_pve_kills,
    AVG(skill_casts) AS avg_skill_casts,
    AVG(anomaly_count) AS avg_anomalies
  FROM arena_match_players
  WHERE outcome_rank IS NOT NULL
  GROUP BY dex
)
SELECT role_rows.*, totals.n AS completed_player_rows,
  ROUND(CAST(wins AS REAL) / NULLIF(appearances, 0), 4) AS win_rate,
  ROUND(CAST(top3 AS REAL) / NULLIF(appearances, 0), 4) AS top3_rate
FROM role_rows CROSS JOIN totals
ORDER BY appearances DESC, win_rate DESC;

-- 3) Incident funnel: movement/HP/counter issues and their affected users.
SELECT kind, severity, COUNT(*) AS incidents, COUNT(DISTINCT uid) AS users,
       COUNT(DISTINCT match_id) AS matches
FROM arena_match_incidents
GROUP BY kind, severity
ORDER BY incidents DESC;

-- 4) Disconnect/reconnect reliability and outcomes.
SELECT
  COUNT(*) AS player_rows,
  SUM(CASE WHEN disconnects > 0 THEN 1 ELSE 0 END) AS disconnected_players,
  SUM(CASE WHEN reconnects > 0 THEN 1 ELSE 0 END) AS reconnected_players,
  SUM(CASE WHEN outcome_reason = 'reconnect_expired' THEN 1 ELSE 0 END) AS expired_players,
  AVG(disconnects) AS avg_disconnects,
  AVG(reconnects) AS avg_reconnects
FROM arena_match_players;

-- 5) One match timeline. Replace the parameter with an am_* match id.
SELECT uid, sample_seq, elapsed_sec, x, y, hp, max_hp, damage_taken,
       level, kills, damage, pve_kills, skill_casts, flags_json, created_at
FROM arena_match_telemetry
WHERE match_id = ?
ORDER BY elapsed_sec ASC, uid ASC, sample_seq ASC;

-- 6) Cross-check payout/entry ledger against settled matches.
SELECT m.match_id, m.status, m.winner_uid, m.ended_reason,
       SUM(CASE WHEN l.kind = 'arena_entry' THEN l.amount ELSE 0 END) AS entries,
       SUM(CASE WHEN l.kind = 'arena_prize' THEN l.amount ELSE 0 END) AS prizes,
       SUM(CASE WHEN l.kind = 'arena_refund' THEN l.amount ELSE 0 END) AS refunds
FROM arena_matches m
LEFT JOIN arena_wallet_ledger l ON l.match_id = m.match_id
GROUP BY m.match_id, m.status, m.winner_uid, m.ended_reason
ORDER BY m.created_at DESC
LIMIT 200;

-- 7) Feedback joined to the game outcome for product decisions.
SELECT f.created_at, f.uid, f.arena_version, f.run_count, f.liked,
       f.liked_points, f.disliked_point, f.suggestion, f.outcome,
       f.duration_sec, f.level, f.role_dex
FROM arena_feedback f
ORDER BY f.created_at DESC
LIMIT 500;
