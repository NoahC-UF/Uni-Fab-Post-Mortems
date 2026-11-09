// Settings (Admin only), plus the "Sync now" button that any signed-in user can press.

import { UserError, notFound } from '../errors.js';
import { getSettings, setSettings } from '../settings.js';
import { recomputeJobs } from '../metrics.js';
import { createSource } from '../sync/sources.js';
import { runSync, lastSync, isSyncRunning } from '../sync/sync.js';
import { missingEpicorSettings, secretValues } from '../config.js';
import { EpicorClient } from '../epicor/client.js';
import { BAQ_MAP } from '../epicor/epicor_field_map.js';
import { ROLES, createUser, hashPassword, validatePassword } from '../auth.js';
import { MockSource } from '../mock/mockSource.js';

const msg = (path, text, kind = 'ok') => `${path}?${kind}=${encodeURIComponent(text)}`;
const asBool = (v) => v === 'on' || v === 'true' || v === '1';

function pctToFraction(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1000) throw new UserError(`${label} must be a percentage between 0 and 1000.`);
  return n / 100;
}

function checkLimits(green, yellow) {
  if (green >= yellow) throw new UserError('The green limit must be lower than the yellow limit.');
}

export default async function settingsRoutes(app) {
  const { db, cfg, log, now } = app.ctx;
  const secrets = secretValues(cfg);
  const admin = { preHandler: app.requireAdmin };
  app.ctx.sync = { running: false, promise: null };

  /** Start a sync in the background; the Settings page polls until it is done. */
  function startSync(kind, who, fromDate = null) {
    if (app.ctx.sync.running || isSyncRunning(db)) throw new UserError('A sync is already running. Please wait for it to finish.');
    const source = createSource(cfg, log); // throws a clear message if Epicor is not configured
    app.ctx.sync.running = true;
    app.ctx.sync.promise = runSync({ db, source, kind, fromDate, now: now(), startedBy: who, secrets, logger: log })
      .catch((err) => log.error(`Sync crashed: ${err.message}`))
      .finally(() => {
        app.ctx.sync.running = false;
      });
    return app.ctx.sync.promise;
  }

  // Anyone signed in can pull fresh data (incremental). A full re-sync is an Admin action.
  app.post('/sync', async (req, reply) => {
    startSync('incremental', req.user.username);
    const back = typeof req.body?.back === 'string' && /^\/(settings)?$/.test(req.body.back) ? req.body.back : '/';
    return reply.redirect(msg(back, 'Sync started. It runs in the background; refresh in a moment.'));
  });

  app.post('/settings/sync-full', admin, async (req, reply) => {
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.from ?? '') ? req.body.from : null;
    startSync('full', req.user.username, from);
    return reply.redirect(msg('/settings', 'Full re-sync started.'));
  });

  // -------------------------------------------------------------------- page
  app.get('/settings', admin, async (req, reply) => {
    const s = getSettings(db);
    const overrides = db.prepare('SELECT * FROM threshold_overrides ORDER BY scope, scope_value').all().map((r) => ({ ...r }));
    const ratesDb = new Map(db.prepare('SELECT * FROM rate_overrides').all().map((r) => [r.resource_grp_id, r]));
    const groups = db
      .prepare(
        `SELECT resource_grp_id AS id, MAX(rg_description) AS description, MAX(set_lab_rate) AS setLab, MAX(prod_lab_rate) AS prodLab,
                MAX(set_bur_rate) AS setBur, MAX(prod_bur_rate) AS prodBur
         FROM job_operations WHERE resource_grp_id IS NOT NULL AND resource_grp_id <> '' GROUP BY resource_grp_id ORDER BY resource_grp_id`,
      )
      .all()
      .map((g) => ({ ...g, ov: ratesDb.get(g.id) ?? null }));
    const opCodes = db.prepare("SELECT DISTINCT op_code FROM job_operations WHERE op_code <> '' ORDER BY op_code").all().map((r) => r.op_code);
    const users = db.prepare('SELECT id, username, display_name, role, active, last_login_at FROM users ORDER BY username').all().map((r) => ({ ...r }));
    const causes = db.prepare('SELECT * FROM root_causes ORDER BY sort_order, name').all().map((r) => ({ ...r }));
    const log_ = db.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT 8').all().map((r) => ({ ...r, rows: r.rows_json ? JSON.parse(r.rows_json) : null }));
    return reply.page('settings.njk', {
      s,
      pct: { green: s.greenMax * 100, yellow: s.yellowMax * 100 },
      overrides: overrides.map((o) => ({ ...o, greenPct: o.green_max * 100, yellowPct: o.yellow_max * 100 })),
      groups,
      opCodes,
      users,
      causes,
      syncLog: log_,
      running: app.ctx.sync.running || isSyncRunning(db),
      epicor: { mock: cfg.useMock, missing: missingEpicorSettings(cfg), baqs: Object.values(BAQ_MAP).map((b) => b.id) },
      lastSync: lastSync(db),
    });
  });

  // ------------------------------------------------------------ thresholds etc
  app.post('/settings/thresholds', admin, async (req, reply) => {
    const b = req.body ?? {};
    const green = pctToFraction(b.greenPct, 'Green limit');
    const yellow = pctToFraction(b.yellowPct, 'Yellow limit');
    checkLimits(green, yellow);
    const minHours = Number(b.minHours);
    const minDollars = Number(b.minDollars);
    const window = Math.trunc(Number(b.syncWindowMonths));
    if (!Number.isFinite(minHours) || minHours < 0) throw new UserError('Minimum hours must be 0 or more.');
    if (!Number.isFinite(minDollars) || minDollars < 0) throw new UserError('Minimum dollars must be 0 or more.');
    if (!Number.isInteger(window) || window < 1 || window > 120) throw new UserError('The sync window must be 1 to 120 months.');
    setSettings(db, {
      greenMax: green, yellowMax: yellow, minHours, minDollars, syncWindowMonths: window,
      normalizeMaterialByQty: asBool(b.normalizeMaterialByQty), excludeNonOrderJobs: asBool(b.excludeNonOrderJobs),
    });
    const n = recomputeJobs(db);
    return reply.redirect(msg('/settings', `Settings saved. ${n} jobs were re-checked with the new rules.`));
  });

  app.post('/settings/overrides', admin, async (req, reply) => {
    const b = req.body ?? {};
    const scope = b.scope === 'resource_group' ? 'resource_group' : b.scope === 'op_code' ? 'op_code' : null;
    const value = String(b.value ?? '').trim();
    if (!scope || !value) throw new UserError('Choose op code or resource group, and say which one.');
    const green = pctToFraction(b.greenPct, 'Green limit');
    const yellow = pctToFraction(b.yellowPct, 'Yellow limit');
    checkLimits(green, yellow);
    db.prepare(
      `INSERT INTO threshold_overrides (scope, scope_value, green_max, yellow_max) VALUES (?, ?, ?, ?)
       ON CONFLICT(scope, scope_value) DO UPDATE SET green_max = excluded.green_max, yellow_max = excluded.yellow_max`,
    ).run(scope, value, green, yellow);
    const n = recomputeJobs(db);
    return reply.redirect(msg('/settings#overrides', `Override saved for ${value}. ${n} jobs re-checked.`));
  });

  app.post('/settings/overrides/:id/delete', admin, async (req, reply) => {
    db.prepare('DELETE FROM threshold_overrides WHERE id = ?').run(Number(req.params.id));
    const n = recomputeJobs(db);
    return reply.redirect(msg('/settings#overrides', `Override removed. ${n} jobs re-checked.`));
  });

  app.post('/settings/rates', admin, async (req, reply) => {
    const body = req.body ?? {};
    const ids = new Set();
    for (const k of Object.keys(body)) {
      const m = /^(setLab|prodLab|setBur|prodBur)__(.+)$/.exec(k);
      if (m) ids.add(m[2]);
    }
    const num = (v, label, id) => {
      if (v === undefined || String(v).trim() === '') return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 10000) throw new UserError(`${label} rate for ${id} must be a number of 0 or more.`);
      return n;
    };
    for (const id of ids) {
      const vals = [num(body[`setLab__${id}`], 'Setup labour', id), num(body[`prodLab__${id}`], 'Production labour', id), num(body[`setBur__${id}`], 'Setup burden', id), num(body[`prodBur__${id}`], 'Production burden', id)];
      if (vals.every((v) => v === null)) db.prepare('DELETE FROM rate_overrides WHERE resource_grp_id = ?').run(id);
      else
        db.prepare(
          `INSERT INTO rate_overrides (resource_grp_id, setup_lab_rate, prod_lab_rate, setup_bur_rate, prod_bur_rate) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(resource_grp_id) DO UPDATE SET setup_lab_rate = excluded.setup_lab_rate, prod_lab_rate = excluded.prod_lab_rate,
             setup_bur_rate = excluded.setup_bur_rate, prod_bur_rate = excluded.prod_bur_rate`,
        ).run(id, ...vals);
    }
    const n = recomputeJobs(db);
    return reply.redirect(msg('/settings#rates', `Rate overrides saved. ${n} jobs re-checked.`));
  });

  // -------------------------------------------------------------- root causes
  app.post('/settings/causes', admin, async (req, reply) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name || name.length > 100) throw new UserError('Give the root cause a name (100 characters max).');
    if (db.prepare('SELECT 1 FROM root_causes WHERE name = ?').get(name)) throw new UserError('That root cause already exists.');
    const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) m FROM root_causes').get().m;
    db.prepare('INSERT INTO root_causes (name, sort_order) VALUES (?, ?)').run(name, max + 10);
    return reply.redirect(msg('/settings#causes', 'Root cause added.'));
  });

  app.post('/settings/causes/:id', admin, async (req, reply) => {
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM root_causes WHERE id = ?').get(id);
    if (!row) throw notFound('That root cause');
    const name = String(req.body?.name ?? '').trim();
    if (!name || name.length > 100) throw new UserError('Give the root cause a name (100 characters max).');
    const clash = db.prepare('SELECT id FROM root_causes WHERE name = ? AND id <> ?').get(name, id);
    if (clash) throw new UserError('Another root cause already has that name.');
    db.prepare('UPDATE root_causes SET name = ?, active = ? WHERE id = ?').run(name, asBool(req.body?.active) ? 1 : 0, id);
    return reply.redirect(msg('/settings#causes', 'Root cause saved. (Past reviews keep the cause even if you hide it.)'));
  });

  // -------------------------------------------------------------------- users
  app.post('/settings/users', admin, async (req, reply) => {
    const b = req.body ?? {};
    const role = ROLES.includes(b.role) ? b.role : 'reviewer';
    createUser(db, { username: String(b.username ?? '').trim(), displayName: String(b.displayName ?? '').trim(), password: String(b.password ?? ''), role });
    return reply.redirect(msg('/settings#users', `User ${b.username} added.`));
  });

  const activeAdmins = () => db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND active = 1").get().n;

  app.post('/settings/users/:id', admin, async (req, reply) => {
    const id = Number(req.params.id);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) throw notFound('That user');
    const role = ROLES.includes(req.body?.role) ? req.body.role : u.role;
    const active = asBool(req.body?.active) ? 1 : 0;
    const displayName = String(req.body?.displayName ?? u.display_name).trim() || u.display_name;
    const losesAdmin = u.role === 'admin' && u.active === 1 && (role !== 'admin' || !active);
    if (losesAdmin && activeAdmins() <= 1) throw new UserError('There must always be at least one active Admin.');
    if (id === req.user.id && !active) throw new UserError('You cannot deactivate your own account.');
    db.prepare('UPDATE users SET role = ?, active = ?, display_name = ? WHERE id = ?').run(role, active, displayName, id);
    if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    return reply.redirect(msg('/settings#users', `${u.username} updated.`));
  });

  app.post('/settings/users/:id/password', admin, async (req, reply) => {
    const id = Number(req.params.id);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) throw notFound('That user');
    const pw = String(req.body?.password ?? '');
    const problem = validatePassword(pw);
    if (problem) throw new UserError(problem);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(pw), id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    return reply.redirect(msg('/settings#users', `Password reset for ${u.username}. They have been signed out.`));
  });

  // ------------------------------------------------------- connection test
  // Pass/fail and the error only. Credential values are never displayed or logged.
  app.post('/settings/test-connection', admin, async (req, reply) => {
    if (cfg.useMock) return reply.redirect(msg('/settings', 'Mock data mode is ON (USE_MOCK_DATA=true), so no connection to Epicor is attempted.'));
    const missing = missingEpicorSettings(cfg);
    if (missing.length) return reply.redirect(msg('/settings', `Not configured. These .env settings are empty: ${missing.join(', ')}`, 'err'));
    const client = new EpicorClient(cfg.epicor, { logger: log, secrets, retries: 1, timeoutMs: 30_000 });
    const r = await client.testConnection(BAQ_MAP.jobHeader.id);
    return reply.redirect(r.ok ? msg('/settings', `PASS: ${r.message}`) : msg('/settings', `FAIL: ${r.message}`, 'err'));
  });

  // ------------------------------------------------------ demo-mode helper
  // Pretends Epicor data was corrected, so you can see the "live data has changed" warning.
  app.post('/settings/mock-change', admin, async (req, reply) => {
    if (!cfg.useMock) throw new UserError('This only works with demo data.');
    const source = createSource(cfg, log);
    if (!(source instanceof MockSource)) throw new UserError('This only works with demo data.');
    const jobNums = db.prepare("SELECT job_num FROM post_mortems ORDER BY id LIMIT 3").all().map((r) => r.job_num);
    const changed = source.simulateChanges(jobNums.length ? jobNums : null, 2.5);
    return reply.redirect(msg('/settings', `Demo: pretended Epicor corrected hours on ${changed.length} job(s) (${changed.join(', ')}). Press Sync now, then open their post-mortems to see the warning.`));
  });
}
