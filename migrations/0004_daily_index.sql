-- The daily comparison reads every ranked run finished on one ET day.

CREATE INDEX run_results_day ON run_results (day, ranked);
