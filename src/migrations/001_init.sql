-- Uni-Fab Post-Mortem: initial schema.
-- Dates are stored as ISO text (YYYY-MM-DD). Booleans are 0/1.

-- ---------------------------------------------------------------- app tables
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'reviewer')),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  csrf       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- key/value settings; value is JSON text
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE threshold_overrides (
  id          INTEGER PRIMARY KEY,
  scope       TEXT NOT NULL CHECK (scope IN ('op_code', 'resource_group')),
  scope_value TEXT NOT NULL,
  green_max   REAL NOT NULL,   -- fraction, 0.10 = 10%
  yellow_max  REAL NOT NULL,
  UNIQUE (scope, scope_value)
);

CREATE TABLE rate_overrides (
  resource_grp_id TEXT PRIMARY KEY,
  setup_lab_rate  REAL,
  prod_lab_rate   REAL,
  setup_bur_rate  REAL,
  prod_bur_rate   REAL
);

CREATE TABLE root_causes (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  active     INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

INSERT INTO root_causes (name, sort_order) VALUES
  ('Estimating/quoting error', 10),
  ('Routing/method error', 20),
  ('Drawing or engineering change', 30),
  ('Customer change', 40),
  ('Material issue (shortage, wrong material, quality)', 50),
  ('Rework/scrap', 60),
  ('Machine downtime', 70),
  ('Programming issue', 80),
  ('Training/skill gap', 90),
  ('Setup issue', 100),
  ('Clock-in/data error', 110),
  ('Subcontractor issue', 120),
  ('Other', 130);

CREATE TABLE sync_log (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL,            -- 'incremental' | 'full' | 'import'
  source     TEXT NOT NULL,            -- 'mock' | 'epicor' | 'files'
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  status     TEXT NOT NULL DEFAULT 'running',   -- running | ok | error
  rows_json  TEXT,
  error      TEXT,
  started_by TEXT
);

-- ------------------------------------------- staging tables (copied from Epicor)
CREATE TABLE jobs (
  job_num          TEXT PRIMARY KEY,
  part_num         TEXT,
  revision_num     TEXT,
  part_description TEXT,
  prod_qty         REAL NOT NULL DEFAULT 0,
  qty_completed    REAL NOT NULL DEFAULT 0,
  released         INTEGER NOT NULL DEFAULT 0,
  complete         INTEGER NOT NULL DEFAULT 0,
  closed           INTEGER NOT NULL DEFAULT 0,
  closed_date      TEXT,
  completion_date  TEXT,
  start_date       TEXT,
  req_due_date     TEXT,
  prod_code        TEXT,
  planner_id       TEXT,
  quote_num        INTEGER,
  quote_line       INTEGER,
  order_num        INTEGER,
  order_line       INTEGER,
  cust_id          TEXT,
  cust_name        TEXT,
  scope_date       TEXT,
  synced_at        TEXT NOT NULL
);
CREATE INDEX idx_jobs_closed_date ON jobs (closed_date);
CREATE INDEX idx_jobs_cust ON jobs (cust_id);
CREATE INDEX idx_jobs_part ON jobs (part_num);

CREATE TABLE job_operations (
  job_num          TEXT NOT NULL,
  assembly_seq     INTEGER NOT NULL,
  opr_seq          INTEGER NOT NULL,
  assembly_part    TEXT,
  assembly_desc    TEXT,
  op_code          TEXT,
  op_desc          TEXT,
  est_set_hours    REAL NOT NULL DEFAULT 0,
  est_prod_hours   REAL NOT NULL DEFAULT 0,
  act_setup_hours  REAL NOT NULL DEFAULT 0,
  act_prod_hours   REAL NOT NULL DEFAULT 0,
  run_qty          REAL NOT NULL DEFAULT 0,
  qty_completed    REAL NOT NULL DEFAULT 0,
  op_complete      INTEGER NOT NULL DEFAULT 0,
  prod_standard    REAL,
  std_format       TEXT,
  subcontract      INTEGER NOT NULL DEFAULT 0,
  op_dtl_seq       INTEGER,
  resource_grp_id  TEXT,
  resource_id      TEXT,
  rg_description   TEXT,
  set_lab_rate     REAL,
  prod_lab_rate    REAL,
  set_bur_rate     REAL,
  prod_bur_rate    REAL,
  PRIMARY KEY (job_num, assembly_seq, opr_seq)
);
CREATE INDEX idx_ops_code ON job_operations (op_code);
CREATE INDEX idx_ops_rg ON job_operations (resource_grp_id);

CREATE TABLE labor_details (
  labor_hed_seq   INTEGER NOT NULL,
  labor_dtl_seq   INTEGER NOT NULL,
  job_num         TEXT NOT NULL,
  assembly_seq    INTEGER NOT NULL DEFAULT 0,
  opr_seq         INTEGER NOT NULL DEFAULT 0,
  employee_num    TEXT,
  employee_name   TEXT,
  shift           TEXT,
  dept            TEXT,
  labor_type      TEXT,            -- 'S' setup / 'P' production
  clock_in_date   TEXT,
  clock_in_time   REAL,            -- decimal hours of the day
  clock_out_time  REAL,
  labor_hrs       REAL NOT NULL DEFAULT 0,
  burden_hrs      REAL NOT NULL DEFAULT 0,
  labor_qty       REAL NOT NULL DEFAULT 0,
  scrap_qty       REAL NOT NULL DEFAULT 0,
  scrap_reason    TEXT,
  discrep_qty     REAL NOT NULL DEFAULT 0,
  resource_grp_id TEXT,
  labor_rate      REAL,            -- employee pay rate: Admin only, never used for $ impact
  burden_rate     REAL,
  active_trans    INTEGER NOT NULL DEFAULT 0,
  time_status     TEXT,
  PRIMARY KEY (labor_hed_seq, labor_dtl_seq)
);
CREATE INDEX idx_labor_job ON labor_details (job_num, assembly_seq, opr_seq);

CREATE TABLE job_materials (
  job_num          TEXT NOT NULL,
  assembly_seq     INTEGER NOT NULL,
  mtl_seq          INTEGER NOT NULL,
  part_num         TEXT,
  description      TEXT,
  qty_per          REAL,
  required_qty     REAL NOT NULL DEFAULT 0,
  issued_qty       REAL NOT NULL DEFAULT 0,
  ium              TEXT,
  est_unit_cost    REAL,
  unit_cost        REAL,
  total_cost       REAL,
  issued_complete  INTEGER NOT NULL DEFAULT 0,
  backflush        INTEGER NOT NULL DEFAULT 0,
  related_operation INTEGER,
  buy_it           INTEGER NOT NULL DEFAULT 0,
  class_id         TEXT,
  prod_code        TEXT,
  PRIMARY KEY (job_num, assembly_seq, mtl_seq)
);

CREATE TABLE material_transactions (
  tran_num         INTEGER PRIMARY KEY,
  tran_date        TEXT,
  tran_type        TEXT,
  job_num          TEXT NOT NULL,
  assembly_seq     INTEGER NOT NULL DEFAULT 0,
  mtl_seq          INTEGER NOT NULL DEFAULT 0,
  part_num         TEXT,
  tran_qty         REAL NOT NULL DEFAULT 0,
  um               TEXT,
  mtl_unit_cost    REAL NOT NULL DEFAULT 0,
  lbr_unit_cost    REAL NOT NULL DEFAULT 0,
  bur_unit_cost    REAL NOT NULL DEFAULT 0,
  sub_unit_cost    REAL NOT NULL DEFAULT 0,
  mtl_bur_unit_cost REAL NOT NULL DEFAULT 0,
  ext_cost         REAL
);
CREATE INDEX idx_mtltran_job ON material_transactions (job_num, assembly_seq, mtl_seq);

-- ------------------------------------- computed results (rebuilt after each sync)
CREATE TABLE job_metrics (
  job_num              TEXT PRIMARY KEY,
  job_state            TEXT NOT NULL,          -- 'closed' | 'open'
  flag                 TEXT NOT NULL,          -- worst line flag: green | yellow | red
  flagged_lines        INTEGER NOT NULL DEFAULT 0,
  red_lines            INTEGER NOT NULL DEFAULT 0,
  yellow_lines         INTEGER NOT NULL DEFAULT 0,
  impact_dollars       REAL NOT NULL DEFAULT 0, -- sum of |variance| over flagged lines (ranking key)
  over_dollars         REAL NOT NULL DEFAULT 0,
  under_dollars        REAL NOT NULL DEFAULT 0,
  net_dollars          REAL NOT NULL DEFAULT 0,
  labour_var_dollars   REAL NOT NULL DEFAULT 0,
  material_var_dollars REAL NOT NULL DEFAULT 0,
  fingerprint          TEXT,
  computed_at          TEXT NOT NULL
);
CREATE INDEX idx_metrics_flag ON job_metrics (flag, impact_dollars DESC);

CREATE TABLE flag_lines (
  id              INTEGER PRIMARY KEY,
  job_num         TEXT NOT NULL,
  kind            TEXT NOT NULL,       -- 'op' | 'material'
  assembly_seq    INTEGER NOT NULL,
  seq             INTEGER NOT NULL,    -- opr_seq or mtl_seq
  op_code         TEXT,
  resource_grp_id TEXT,
  part_num        TEXT,
  flag            TEXT NOT NULL,       -- yellow | red
  direction       TEXT NOT NULL,       -- over | under
  unplanned       INTEGER NOT NULL DEFAULT 0,
  var_hours       REAL,
  var_pct         REAL,
  var_dollars     REAL NOT NULL DEFAULT 0
);
CREATE INDEX idx_flaglines_job ON flag_lines (job_num);
CREATE INDEX idx_flaglines_op ON flag_lines (op_code);
CREATE INDEX idx_flaglines_rg ON flag_lines (resource_grp_id);

-- ----------------------------------------------------------------- post-mortems
CREATE TABLE post_mortems (
  id                   INTEGER PRIMARY KEY,
  job_num              TEXT NOT NULL UNIQUE,
  status               TEXT NOT NULL DEFAULT 'under_review'
    CHECK (status IN ('under_review', 'root_cause_found', 'actions_assigned', 'closed', 'dismissed')),
  owner_user_id        INTEGER REFERENCES users (id),
  review_date          TEXT,
  dismiss_reason       TEXT,
  snapshot_json        TEXT NOT NULL,
  snapshot_fingerprint TEXT,
  snapshot_taken_at    TEXT NOT NULL,
  created_by           INTEGER REFERENCES users (id),
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at            TEXT
);

CREATE TABLE post_mortem_root_causes (
  post_mortem_id INTEGER NOT NULL REFERENCES post_mortems (id) ON DELETE CASCADE,
  root_cause_id  INTEGER NOT NULL REFERENCES root_causes (id),
  PRIMARY KEY (post_mortem_id, root_cause_id)
);

CREATE TABLE pm_notes (
  id             INTEGER PRIMARY KEY,
  post_mortem_id INTEGER NOT NULL REFERENCES post_mortems (id) ON DELETE CASCADE,
  author_id      INTEGER REFERENCES users (id),
  body           TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE action_items (
  id             INTEGER PRIMARY KEY,
  post_mortem_id INTEGER NOT NULL REFERENCES post_mortems (id) ON DELETE CASCADE,
  description    TEXT NOT NULL,
  owner_user_id  INTEGER REFERENCES users (id),
  due_date       TEXT,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done')),
  created_by     INTEGER REFERENCES users (id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at   TEXT
);
CREATE INDEX idx_actions_status ON action_items (status, due_date);
