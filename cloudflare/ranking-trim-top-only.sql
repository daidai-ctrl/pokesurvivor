-- Keep only the top 50 in daily, weekly, monthly, and per-Pokemon boards.
-- Historical boards (s_all/g_all) are deliberately excluded.
-- Run after ranking-optimization-schema.sql has backfilled membership rows.

WITH ranked AS (
  SELECT board, entry_id,
         ROW_NUMBER() OVER (PARTITION BY board ORDER BY t DESC, entry_id ASC) AS rn
  FROM ranking_entries
  WHERE board LIKE 's_d%' OR board LIKE 'g_d%'
     OR board LIKE 's_w%' OR board LIKE 'g_w%'
     OR board LIKE 's_m%' OR board LIKE 'g_m%'
     OR board LIKE 's_all_p%' OR board LIKE 'g_all_p%'
)
DELETE FROM ranking_entry_members
WHERE EXISTS (
  SELECT 1 FROM ranked
  WHERE ranked.rn > 50
    AND ranked.board = ranking_entry_members.board
    AND ranked.entry_id = ranking_entry_members.entry_id
);

WITH ranked AS (
  SELECT board, entry_id,
         ROW_NUMBER() OVER (PARTITION BY board ORDER BY t DESC, entry_id ASC) AS rn
  FROM ranking_entries
  WHERE board LIKE 's_d%' OR board LIKE 'g_d%'
     OR board LIKE 's_w%' OR board LIKE 'g_w%'
     OR board LIKE 's_m%' OR board LIKE 'g_m%'
     OR board LIKE 's_all_p%' OR board LIKE 'g_all_p%'
)
DELETE FROM ranking_entries
WHERE EXISTS (
  SELECT 1 FROM ranked
  WHERE ranked.rn > 50
    AND ranked.board = ranking_entries.board
    AND ranked.entry_id = ranking_entries.entry_id
);
