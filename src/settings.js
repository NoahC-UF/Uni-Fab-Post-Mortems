// App settings (stored in SQLite, editable on the Settings page) and the engine
// configuration built from them. Credentials are NOT here: those live in .env.

import { randomBytes } from 'node:crypto';
import { DEFAULT_CONFIG } from './engine/thresholds.js';
import { TRAN_TYPES } from './epicor/epicor_field_map.js';

export const DEFAULT_SETTINGS = {
  greenMax: 0.1, // below 10% = green
  yellowMax: 0.25, // 10-25% = yellow, above = red
  minHours: 2,
  minDollars: 250,
  normalizeMaterialByQty: true,
  excludeNonOrderJobs: true,
  syncWindowMonths: 12,
  issueTranTypes: TRAN_TYPES.issue,
  returnTranTypes: TRAN_TYPES.return,
};

export function getSettings(db) {
  const out = { ...DEFAULT_SETTINGS };
  for (const { key, value } of db.prepare('SELECT key, value FROM settings').all()) {
    if (key in DEFAULT_SETTINGS) {
      try {
        out[key] = JSON.parse(value);
      } catch {
        /* keep default */
      }
    }
  }
  return out;
}

export function setSettings(db, patch) {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_SETTINGS)) throw new Error(`Unknown setting: ${key}`);
    stmt.run(key, JSON.stringify(value));
  }
}

/** Engine config = global settings + per op code / resource group threshold overrides + rate overrides. */
export function getEngineConfig(db) {
  const s = getSettings(db);
  const opCodeOverrides = {};
  const resourceGroupOverrides = {};
  for (const r of db.prepare('SELECT scope, scope_value, green_max, yellow_max FROM threshold_overrides').all()) {
    const target = r.scope === 'op_code' ? opCodeOverrides : resourceGroupOverrides;
    target[r.scope_value] = { greenMax: r.green_max, yellowMax: r.yellow_max };
  }
  const rateOverrides = {};
  for (const r of db.prepare('SELECT * FROM rate_overrides').all()) {
    rateOverrides[r.resource_grp_id] = {
      setLab: r.setup_lab_rate,
      prodLab: r.prod_lab_rate,
      setBur: r.setup_bur_rate,
      prodBur: r.prod_bur_rate,
    };
  }
  return {
    ...DEFAULT_CONFIG,
    greenMax: s.greenMax,
    yellowMax: s.yellowMax,
    minHours: s.minHours,
    minDollars: s.minDollars,
    normalizeMaterialByQty: s.normalizeMaterialByQty,
    issueTranTypes: s.issueTranTypes,
    returnTranTypes: s.returnTranTypes,
    opCodeOverrides,
    resourceGroupOverrides,
    rateOverrides,
  };
}

/**
 * Secret used to sign login cookies. Uses APP_SECRET_KEY from .env when set;
 * otherwise creates one once and remembers it in the database, so sessions
 * survive restarts without any setup.
 */
export function resolveAppSecret(db, envSecret) {
  if (envSecret && envSecret.length >= 16) return envSecret;
  const row = db.prepare("SELECT value FROM settings WHERE key = '_app_secret'").get();
  if (row) return JSON.parse(row.value);
  const secret = randomBytes(32).toString('hex');
  db.prepare("INSERT INTO settings (key, value) VALUES ('_app_secret', ?)").run(JSON.stringify(secret));
  return secret;
}
