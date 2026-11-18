// Settings (Admin only), plus the "Sync now" button that any signed-in user can press.

import { UserError, notFound } from '../errors.js';
import { getSettings, setSettings, getAppearance, THEMES, MODES } from '../settings.js';
import { recomputeJobs, refreshTargets } from '../metrics.js';
import { TIER_TARGETS, parseTierTargets } from '../targets.js';
import { parseMarginBands, normaliseBands, MAX_BANDS } from '../marginBands.js';
import { createSource } from '../sync/sources.js';
import { runSync, lastSync, isSyncRunning } from '../sync/sync.js';
import { isValidTime, nextSlot, kindForSlot } from '../sync/scheduler.js';
import { missingEpicorSettings, secretValues } from '../config.js';
import { EpicorClient } from '../epicor/client.js';
import { BAQ_MAP } from '../epicor/epicor_field_map.js';
import { ROLES, createUser, hashPassword, validatePassword } from '../auth.js';
import { MockSource } from '../mock/mockSource.js';
import { parseCustomerFile, applyCustomers, orgSummary, exportWorkbook, exportCsv as orgCsv } from '../customerOrg.js';
import { cleanRoot, cleanFolder } from '../drawings.js';
import { TABLES, TABLE_IDS, FONT_SIZE, COL_WIDTH, LINE_SIZE, normaliseTableStyles, parseTableStyleForm } from '../tableStyles.js';

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
  app.ctx.startSync = startSync; // also used by the automatic schedule (server.js)

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

  app.post('/settings/appearance', admin, async (req, reply) => {
    const theme = THEMES.find((t) => t.id === req.body?.uiTheme);
    const mode = MODES.find((m) => m.id === req.body?.uiMode);
    if (!theme || !mode) throw new UserError('Choose a colour theme and a mode.');
    setSettings(db, { uiTheme: theme.id, uiMode: mode.id });
    return reply.redirect(msg('/settings#appearance', `Appearance saved: ${theme.label}, ${mode.label.toLowerCase()} mode.`));
  });

  // Table Appearance: text size, column width and lines for one table at a time. Same for everyone.
  const tableBack = (id, text) => `/settings?table=${encodeURIComponent(id)}&ok=${encodeURIComponent(text)}#table-appearance`;
  const tableLabel = (id) => {
    const t = TABLES.find((x) => x.id === id);
    return t ? `${t.group}: ${t.label}` : id;
  };
  app.post('/settings/table-styles', admin, async (req, reply) => {
    const { id, style } = parseTableStyleForm(req.body);
    const styles = normaliseTableStyles(getSettings(db).tableStyles);
    if (style) styles[id] = style;
    else delete styles[id];
    setSettings(db, { tableStyles: styles });
    return reply.redirect(tableBack(id, style ? `Saved the look of ${tableLabel(id)}.` : `${tableLabel(id)} is back to the standard look.`));
  });

  app.post('/settings/table-styles/reset', admin, async (req, reply) => {
    const id = req.body?.table;
    if (!TABLE_IDS.includes(id)) throw new UserError('Choose a table.');
    const styles = normaliseTableStyles(getSettings(db).tableStyles);
    delete styles[id];
    setSettings(db, { tableStyles: styles });
    return reply.redirect(tableBack(id, `${tableLabel(id)} is back to the standard look.`));
  });

  // Customer Tiers and Account Managers: import a spreadsheet (sent as the raw file by the page's script), or export the list.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 5_000_000 }, (req, body, done) => done(null, body));
  app.post('/settings/customer-org/import', { preHandler: app.requireAdmin, bodyLimit: 5_000_000 }, async (req, reply) => {
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw new UserError('Choose a file first.');
      const filename = String(req.query?.filename ?? '').slice(0, 200);
      if (!/.(xlsx|csv)$/i.test(filename)) throw new UserError('Choose an Excel (.xlsx) or CSV (.csv) file.');
      const mode = req.query?.mode === 'update' ? 'update' : 'replace';
      const { entries, skipped, duplicates } = await parseCustomerFile(req.body, filename);
      const r = applyCustomers(db, entries, mode, now().toISOString());
      const retargeted = refreshTargets(db); // jobs whose customer changed tier now use that tier's target margin
      const bits = [`${entries.length} customers read`, `${r.added} added`, `${r.changed} changed`, `${r.unchanged} unchanged`];
      if (r.removed) bits.push(`${r.removed} removed`);
      let text = `Customer list imported (${mode === 'replace' ? 'replaced the list' : 'updated only'}): ${bits.join(', ')}.`;
      if (retargeted) text += ` ${retargeted} job${retargeted === 1 ? '' : 's'} now use a different target margin.`;
      if (duplicates) text += ` ${duplicates} repeated name${duplicates === 1 ? '' : 's'} in the file (the last one was used).`;
      if (skipped) text += ` ${skipped} row${skipped === 1 ? '' : 's'} with no name were skipped.`;
      return { ok: true, message: text };
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      return reply.code(400).send({ ok: false, error: err.message });
    }
  });
  app.get('/settings/customer-org/export.xlsx', admin, async (req, reply) =>
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="customer-organization-${now().toISOString().slice(0, 10)}.xlsx"`)
      .send(await exportWorkbook(db)));
  app.get('/settings/customer-org/export.csv', admin, async (req, reply) =>
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="customer-organization-${now().toISOString().slice(0, 10)}.csv"`)
      .send('﻿' + orgCsv(db)));

  app.post('/settings/auto-sync', admin, async (req, reply) => {
    const b = req.body ?? {};
    const time = String(b.autoSyncTime ?? '').trim();
    if (!isValidTime(time)) throw new UserError('Enter the time as hours and minutes on a 24-hour clock, for example 02:00.');
    setSettings(db, { autoSyncEnabled: asBool(b.autoSyncEnabled), autoSyncTime: time, autoSyncWeeklyFull: asBool(b.autoSyncWeeklyFull) });
    return reply.redirect(msg('/settings', asBool(b.autoSyncEnabled) ? `Automatic sync saved: every day at ${time}.` : 'Automatic sync is turned off.'));
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
    const pad = (n) => String(n).padStart(2, '0');
    const nextAuto = s.autoSyncEnabled && isValidTime(s.autoSyncTime) ? nextSlot(now(), s.autoSyncTime) : null;
    const auto = {
      enabled: s.autoSyncEnabled,
      time: s.autoSyncTime,
      weeklyFull: s.autoSyncWeeklyFull,
      next: nextAuto
        ? `${nextAuto.getFullYear()}-${pad(nextAuto.getMonth() + 1)}-${pad(nextAuto.getDate())} ${pad(nextAuto.getHours())}:${pad(nextAuto.getMinutes())} (${kindForSlot(nextAuto, s.autoSyncWeeklyFull) === 'full' ? 'full re-sync' : 'incremental'})`
        : null,
    };
    const log_ = db.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT 8').all().map((r) => ({ ...r, rows: r.rows_json ? JSON.parse(r.rows_json) : null }));
    return reply.page('settings.njk', {
      s,
      auto,
      themes: THEMES,
      modes: MODES,
      current: getAppearance(db),
      org: orgSummary(db),
      tierTargets: TIER_TARGETS,
      bandRows: normaliseBands(s.marginBandsVsTarget),
      maxBands: MAX_BANDS,
      tables: TABLES,
      tableStyles: normaliseTableStyles(s.tableStyles),
      selectedTable: TABLE_IDS.includes(req.query?.table) ? req.query.table : TABLES[0].id,
      tableLimits: { fontSize: FONT_SIZE, colWidth: COL_WIDTH, lineSize: LINE_SIZE },
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
    const patch = {};
    if (b.targetMarginPct !== undefined && String(b.targetMarginPct).trim() !== '') {
      const t = Number(b.targetMarginPct);
      if (!Number.isFinite(t) || t < 0 || t >= 100) throw new UserError('The target margin must be a percentage from 0 to 99.');
      patch.targetMarginPct = t;
    }
    patch.targetMarginByTier = parseTierTargets(b); // an empty box = that tier uses the default target
    setSettings(db, {
      ...patch,
      greenMax: green, yellowMax: yellow, minHours, minDollars, syncWindowMonths: window,
      normalizeMaterialByQty: asBool(b.normalizeMaterialByQty), excludeNonOrderJobs: asBool(b.excludeNonOrderJobs),
    });
    const n = recomputeJobs(db);
    return reply.redirect(msg('/settings', `Settings saved. ${n} jobs were re-checked with the new rules.`));
  });

  // Where the PDF drawings are (the job page's Open Drawings button): display only, so nothing is re-checked
  app.post('/settings/drawings', admin, async (req, reply) => {
    const b = req.body ?? {};
    const root = cleanRoot(b.drawingsRoot);
    if (!root) throw new UserError('The drive must look like G:\\ or a network share like \\\\server\\share.');
    const folder = cleanFolder(b.drawingsFolder);
    if (folder === null) throw new UserError('The drawings folder must be one folder name (no slashes), or empty to open the job folder itself.');
    setSettings(db, { drawingsRoot: root, drawingsFolder: folder });
    return reply.redirect(msg('/settings#drawings', `Drawings folder saved: ${root}<job number>${folder ? `\\${folder}` : ''}`));
  });

  // Margin % colours: display only, so nothing is re-checked
  app.post('/settings/margin-bands', admin, async (req, reply) => {
    const bands = parseMarginBands(req.body ?? {});
    setSettings(db, { marginBandsVsTarget: bands });
    const text = bands.bands.length ? `Margin % colours saved (${bands.bands.length} threshold${bands.bands.length === 1 ? '' : 's'}).` : 'Margin % colours cleared: the standard colouring is back.';
    return reply.redirect(msg('/settings#margin-colours', text));
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
