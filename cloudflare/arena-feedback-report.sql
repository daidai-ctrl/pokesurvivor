-- Read-only D1 queries for the Arena MVP feedback review.
-- Run these in the Cloudflare D1 console after the schema has been applied.

SELECT arena_version, liked, COUNT(*) AS responses
FROM arena_feedback
GROUP BY arena_version, liked
ORDER BY arena_version, responses DESC;

SELECT disliked_point, COUNT(*) AS responses
FROM arena_feedback
WHERE disliked_point <> ''
GROUP BY disliked_point
ORDER BY responses DESC;

SELECT liked_points, COUNT(*) AS responses
FROM arena_feedback
WHERE liked_points <> ''
GROUP BY liked_points
ORDER BY responses DESC;

SELECT outcome, COUNT(*) AS responses, ROUND(AVG(duration_sec), 1) AS avg_duration_sec,
       ROUND(AVG(level), 1) AS avg_level
FROM arena_feedback
GROUP BY outcome;

SELECT created_at, run_count, liked, liked_points, disliked_point, suggestion,
       outcome, duration_sec, level, role_dex
FROM arena_feedback
ORDER BY created_at DESC
LIMIT 200;
