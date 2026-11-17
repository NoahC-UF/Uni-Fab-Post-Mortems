-- The target margin that applies to each job: the target of its customer's tier (Settings), or the default target.
-- Stored with the other per-job numbers so the Flagged Jobs grid can colour every row against its own target.
ALTER TABLE job_metrics ADD COLUMN target_margin REAL;  -- fraction, e.g. 0.3
