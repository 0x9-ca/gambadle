-- Leaderboard ties go to the run that finished first.
--
-- Until now equal stacks were ordered by `submitted_at`, which is when the name
-- was typed, not when the run ended. `finished_at` is the run's finish time
-- (ms since the epoch), stamped by the Worker when the run reaches `finished`.
--
-- Backfill: the session's ranked run_results row for that day carries the real
-- finish time (only the first run of a day is ranked, and only it can be
-- submitted). Scores from before run_results existed, or whose result failed
-- to record, fall back to submitted_at, the closest time known.

ALTER TABLE scores ADD COLUMN finished_at INTEGER;

UPDATE scores SET finished_at = COALESCE(
	(SELECT MIN(r.finished_at) FROM run_results r
	 WHERE r.session_id = scores.run_id AND r.day = scores.day AND r.ranked = 1),
	submitted_at
);

-- Serves today's board in its new order. Replaces idx_scores_day_chips, which
-- only covered (day, chips).
DROP INDEX IF EXISTS idx_scores_day_chips;
CREATE INDEX idx_scores_day_rank ON scores (day, chips DESC, finished_at ASC);

-- The all-time board's `achieved_at` becomes the finish time of the run that
-- set the record, so its ties follow the same rule. The record-setting score
-- is the one with that name, day and stack (unique while chips > 0; a 0-chip
-- best takes the earliest such score).
UPDATE alltime_best SET achieved_at = COALESCE(
	(SELECT MIN(s.finished_at) FROM scores s
	 WHERE s.name_key = alltime_best.name_key AND s.day = alltime_best.best_day AND s.chips = alltime_best.best_chips),
	achieved_at
);
