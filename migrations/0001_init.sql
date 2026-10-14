-- Gambadle schema
--
--   runs         — one row per game session (in progress or just finished)
--   scores       — append-only log of submitted leaderboard entries (kept forever)
--   alltime_best — materialized per-name best, maintained on submit
--
-- `day` is always a 'YYYY-MM-DD' string in the America/New_York timezone.

CREATE TABLE runs (
	-- Session id, from crypto.randomUUID(). Matches the gambadle_sid cookie.
	id         TEXT    PRIMARY KEY,
	day        TEXT    NOT NULL,
	-- Game phase: betting | in_game | resolved | don_offer | finished | submitted
	phase      TEXT    NOT NULL,
	-- Serialized engine state (chips, round, played games, current game state).
	state      TEXT    NOT NULL,
	name       TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

-- The cron prunes runs from days that are already over. Nothing else reads them:
-- the daily reset is implicit, so a run from a previous day is never resumed.
CREATE INDEX idx_runs_day ON runs (day);


CREATE TABLE scores (
	id            INTEGER PRIMARY KEY AUTOINCREMENT,
	name          TEXT    NOT NULL,
	-- Lower-cased name. Used for per-day uniqueness and for the all-time board.
	name_key      TEXT    NOT NULL,
	day           TEXT    NOT NULL,
	chips         INTEGER NOT NULL,
	rounds_played INTEGER NOT NULL,
	-- 1 when the run ended by hitting 0 chips rather than surviving 5 rounds.
	bust          INTEGER NOT NULL DEFAULT 0,
	run_id        TEXT    NOT NULL,
	submitted_at  INTEGER NOT NULL
);

-- Serves the daily board: top N for a given day, ordered by chips.
CREATE INDEX idx_scores_day_chips ON scores (day, chips DESC);
CREATE INDEX idx_scores_run      ON scores (run_id);

-- One entry per name per day — but a busted run does not lock the name. A 0-chip
-- score never ranks, so it should not cost the player their one real attempt.
-- Partial index: SQLite only enforces uniqueness among rows matching the WHERE.
CREATE UNIQUE INDEX idx_scores_day_name
	ON scores (day, name_key)
	WHERE chips > 0;


-- Materialized all-time leaderboard, maintained inside the same transaction as the
-- scores insert. Turns the all-time board into an indexed top-N lookup instead of
-- a full-table GROUP BY that would degrade as scores accumulate forever.
CREATE TABLE alltime_best (
	name_key    TEXT    PRIMARY KEY,
	name        TEXT    NOT NULL,
	best_day    TEXT    NOT NULL,
	best_chips  INTEGER NOT NULL,
	-- Only advances when the previous best is beaten, so it always reflects
	-- when the current record was actually set.
	achieved_at INTEGER NOT NULL
);

CREATE INDEX idx_alltime_best_chips ON alltime_best (best_chips DESC, achieved_at ASC);