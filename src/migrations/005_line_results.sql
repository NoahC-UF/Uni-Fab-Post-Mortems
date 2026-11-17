-- One row per operation / material line of every job (flagged or not), so the Quote Accuracy pages can roll
-- the job-level results up by operation, material and customer without re-running the variance engine.
-- (flag_lines only keeps the flagged lines; this keeps all of them.) Filled in by recomputeJobs.
CREATE TABLE line_results (
  job_num         TEXT NOT NULL,
  kind            TEXT NOT NULL,       -- 'op' | 'material'
  assembly_seq    INTEGER NOT NULL,
  seq             INTEGER NOT NULL,    -- opr_seq or mtl_seq
  counted         INTEGER NOT NULL,    -- 1 = counts toward variance (completed op / issued material), 0 = open, subcontract or still to be issued
  activity_date   TEXT,                -- closed date, or for an open job its latest labour / material date (the date range filter uses this)
  op_code         TEXT,
  resource_grp_id TEXT,
  part_num        TEXT,                -- material part
  description     TEXT,
  class_id        TEXT,                -- material class
  unplanned       INTEGER NOT NULL DEFAULT 0,   -- nothing estimated, but there are actuals
  flag            TEXT NOT NULL DEFAULT 'green', -- green | yellow | red (the same tiers and minimums as everywhere else)
  -- operations: hours the job SHOULD have taken for the quantity made, and what it took (setup and run kept apart)
  exp_hours       REAL,
  act_hours       REAL,
  exp_setup       REAL,
  act_setup       REAL,
  exp_run         REAL,
  act_run         REAL,
  var_hours       REAL,
  -- materials: expected and issued quantity
  exp_qty         REAL,
  act_qty         REAL,
  -- both: dollars (labour + burden for operations), and the split of a material variance
  est_dollars     REAL NOT NULL DEFAULT 0,
  act_dollars     REAL NOT NULL DEFAULT 0,
  var_dollars     REAL NOT NULL DEFAULT 0,
  usage_var       REAL,                -- material: (actual qty - expected qty) x estimated unit cost
  price_var       REAL,                -- material: actual cost - actual qty x estimated unit cost
  var_pct         REAL,                -- NULL when nothing was estimated
  PRIMARY KEY (job_num, kind, assembly_seq, seq)
);
CREATE INDEX idx_lines_activity ON line_results (activity_date);
CREATE INDEX idx_lines_op ON line_results (kind, op_code);
CREATE INDEX idx_lines_part ON line_results (kind, part_num);
