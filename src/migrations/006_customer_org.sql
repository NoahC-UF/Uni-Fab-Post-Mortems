-- Each customer's tier level and account manager(s), imported from the "Customer Organization" spreadsheet
-- (Settings > Customer Tiers and Account Managers). Customers are matched to Epicor by name, ignoring capitals,
-- extra spaces and curly quotes, so name_key is that cleaned-up name.
CREATE TABLE customer_org (
  name_key    TEXT PRIMARY KEY,
  name        TEXT NOT NULL,      -- as written in the spreadsheet
  tier        TEXT NOT NULL DEFAULT '',   -- A, B, C, D, NEW ... (whatever the sheet says, upper case)
  managers    TEXT NOT NULL DEFAULT '',   -- "Mike Kraynack, Nick Iossifidis"; empty = nobody assigned
  updated_at  TEXT NOT NULL
);
