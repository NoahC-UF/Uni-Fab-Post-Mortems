-- Sale price of each job, from the sales order lines it was made for (one row per job / order release).
CREATE TABLE job_revenue (
  job_num        TEXT    NOT NULL,
  order_num      INTEGER NOT NULL,
  order_line     INTEGER NOT NULL DEFAULT 0,
  order_rel_num  INTEGER NOT NULL DEFAULT 0,
  alloc_qty      REAL,     -- quantity of the order line this job makes
  order_qty      REAL,     -- the whole order line
  ext_price      REAL,     -- line price, company (base) currency
  doc_ext_price  REAL,     -- line price, order currency
  currency_code  TEXT,
  PRIMARY KEY (job_num, order_num, order_line, order_rel_num)
);
CREATE INDEX idx_job_revenue_job ON job_revenue (job_num);
