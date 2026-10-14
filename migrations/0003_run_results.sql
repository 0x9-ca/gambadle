-- One row per finished run, for each player's personal stats.
--
-- A player is a session (the signed cookie), the same identity the ranked-run
-- rule uses. Rows are written once, when a run reaches `finished`, and kept:
-- the stats are all-time. `rounds` is a JSON array of {game, net, doubles},
-- one entry per round with any Double or Nothing chain folded in.

CREATE TABLE run_results (
	session_id  TEXT    NOT NULL,
	day         TEXT    NOT NULL,
	ranked      INTEGER NOT NULL,
	chips       INTEGER NOT NULL,
	bust        INTEGER NOT NULL,
	rounds      TEXT    NOT NULL,
	finished_at INTEGER NOT NULL
);

CREATE INDEX run_results_session ON run_results (session_id, finished_at);
