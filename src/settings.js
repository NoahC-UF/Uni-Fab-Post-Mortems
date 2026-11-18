// App settings (stored in SQLite, editable on the Settings page) and the engine
// configuration built from them. Credentials are NOT here: those live in .env.

import { randomBytes } from 'node:crypto';
import { DEFAULT_CONFIG } from './engine/thresholds.js';
import { TRAN_TYPES } from './epicor/epicor_field_map.js';

// Look and feel. Everyone gets the shop default set here; each person can override the
// light/dark mode for their own browser on the Account page.
export const THEMES = [
  { id: 'unifab', label: 'Uni-Fab Default', note: 'Soft navy-slate with the Uni-Fab logo blue and striped table rows.', swatches: ['#1a2130', '#2f73bd', '#8ab4f8'] },
  { id: 'original', label: 'Original', note: 'The first navy and orange look.', swatches: ['#14395b', '#1f5f99', '#e07b00'] },
];
export const MODES = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'system', label: "Match the computer's setting" },
];

export const DEFAULT_SETTINGS = {
  uiTheme: 'unifab',
  uiMode: 'dark',
  tableStyles: {}, // per-table text size, column width and lines (Settings > Table Appearance); see tableStyles.js
  greenMax: 0.1, // below 10% = green
  yellowMax: 0.25, // 10-25% = yellow, above = red
  minHours: 2,
  minDollars: 250,
  normalizeMaterialByQty: true,
  excludeNonOrderJobs: true,
  syncWindowMonths: 12,
  targetMarginPct: 20, // the margin a job should earn; the job page compares the planned and actual margin to it. The default: used for any customer without a tier target
  targetMarginByTier: {}, // { A: 30, B: 25, ... } a target for each customer tier (see targets.js); a tier not listed here uses targetMarginPct
  marginBandsVsTarget: { bands: [], top: null }, // colours for the Margin % columns by how far a margin is from its own target, in points (see marginBands.js); none = the standard colouring
  drawingsRoot: 'G:\\', // the drive the job folders are on (the job page's Copy Drawing Path button): G:\<job number>\<drawingsFolder>
  drawingsFolder: '003 - PDF PRINTS', // the folder inside each job's folder that holds the PDF drawings
  baseCurrency: 'CAD', // prices come from Epicor in the company (base) currency
  autoSyncEnabled: true, // sync by itself once a day (not used in demo mode)
  autoSyncTime: '02:00', // PC local time, 24-hour
  autoSyncWeeklyFull: true, // Sundays do a full re-sync instead, to pick up late corrections to older jobs
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

/** The saved theme and mode, falling back to the defaults if the stored value is not a known one. */
export function getAppearance(db) {
  const s = getSettings(db);
  return {
    theme: THEMES.some((t) => t.id === s.uiTheme) ? s.uiTheme : DEFAULT_SETTINGS.uiTheme,
    mode: MODES.some((m) => m.id === s.uiMode) ? s.uiMode : DEFAULT_SETTINGS.uiMode,
  };
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
