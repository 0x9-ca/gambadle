-- How many runs each session has started on an ET day.
--
-- Only a session's first run of the day can reach the leaderboard. The runs table
-- cannot answer that, because starting over deletes the row, so the count lives
-- here. Rows from earlier days are pruned by the cron.

CREATE TABLE run_starts (
	session_id TEXT    NOT NULL,
	day        TEXT    NOT NULL,
	starts     INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (session_id, day)
);
