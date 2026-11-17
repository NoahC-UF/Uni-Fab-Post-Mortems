-- Price and margin per job, stored with the other per-job numbers so the Flagged Jobs grid and the
-- Excel export can show, sort and filter them across many jobs. (Filled in by recomputeJobs.)
ALTER TABLE job_metrics ADD COLUMN price REAL;               -- sale price, CAD (NULL = no priced order)
ALTER TABLE job_metrics ADD COLUMN planned_cost REAL;
ALTER TABLE job_metrics ADD COLUMN actual_cost REAL;
ALTER TABLE job_metrics ADD COLUMN planned_margin REAL;      -- $
ALTER TABLE job_metrics ADD COLUMN actual_margin REAL;       -- $
ALTER TABLE job_metrics ADD COLUMN planned_margin_pct REAL;  -- fraction, e.g. 0.304
ALTER TABLE job_metrics ADD COLUMN actual_margin_pct REAL;
ALTER TABLE job_metrics ADD COLUMN cause TEXT;               -- price-vs-plan | overrun | ok | no-price | no-plan
