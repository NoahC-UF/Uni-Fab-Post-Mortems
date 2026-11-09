import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from '../src/db.js';
import { MockSource } from '../src/mock/mockSource.js';
import { runSync, chooseFromDate, lastSync } from '../src/sync/sync.js';
import { recomputeJobs, evaluateStoredJob } from '../src/metrics.js';
import { setSettings, getEngineConfig } from '../src/settings.js';

const NOW = new Date('2026-11-09T12:00:00Z');
const quiet = { info() {}, warn() {}, error() {} };

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

describe('mock data through the real pipeline', () => {
  let db;
  let source;
  let result;
  before(async () => {
    db = fresh();
    source = new MockSource({ now: NOW });
    result = await runSync({ db, source, kind: 'full', now: NOW, logger: quiet });
  });

  test('full sync succeeds and is logged', () => {
    assert.equal(result.ok, true, result.error);
    const log = lastSync(db);
    assert.equal(log.status, 'ok');
    assert.equal(log.source, 'mock');
    assert.ok(log.started_at && log.ended_at);
    assert.ok(log.rows.stored.jobs >= 60);
  });

  test('realistic volumes and the op codes you use', () => {
    const jobs = db.prepare('SELECT COUNT(*) n FROM jobs').get().n;
    const codes = db.prepare('SELECT DISTINCT op_code FROM job_operations').all().map((r) => r.op_code);
    for (const c of ['LSRSRT', 'PRGRMCHK', 'FORM', 'WELD', 'ASSY', 'PAINT', 'FQLTY', 'PACK']) assert.ok(codes.includes(c), c);
    assert.ok(jobs >= 60 && jobs <= 80);
    assert.ok(db.prepare('SELECT COUNT(*) n FROM labor_details').get().n > 300);
    assert.ok(db.prepare('SELECT COUNT(*) n FROM material_transactions').get().n > 100);
  });

  test('has both closed and in-progress jobs, and jobs without orders', () => {
    assert.ok(db.prepare('SELECT COUNT(*) n FROM jobs WHERE closed = 1').get().n > 30);
    assert.ok(db.prepare('SELECT COUNT(*) n FROM jobs WHERE closed = 0').get().n > 10);
    assert.ok(db.prepare('SELECT COUNT(*) n FROM jobs WHERE order_num IS NULL').get().n >= 3);
  });

  test('a good spread of flags: some red, some yellow, some clean, over and under', () => {
    const by = Object.fromEntries(db.prepare('SELECT flag, COUNT(*) n FROM job_metrics GROUP BY flag').all().map((r) => [r.flag, r.n]));
    assert.ok(by.red >= 8, `red=${by.red}`);
    assert.ok(by.yellow >= 3, `yellow=${by.yellow}`);
    assert.ok(by.green >= 8, `green=${by.green}`);
    const dirs = db.prepare('SELECT DISTINCT direction FROM flag_lines').all().map((r) => r.direction);
    assert.ok(dirs.includes('over') && dirs.includes('under'));
  });

  test('every metric is a finite number (no NaN reaches the database)', () => {
    const rows = db.prepare('SELECT * FROM job_metrics').all();
    for (const r of rows) for (const k of ['impact_dollars', 'over_dollars', 'under_dollars', 'net_dollars']) assert.ok(Number.isFinite(r[k]), `${r.job_num} ${k}`);
  });

  test('the multi-order job is merged to one row, with a warning', () => {
    assert.ok(result.warnings.some((w) => /merged/.test(w)));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs WHERE job_num = '104026'").get().n, 1);
  });

  test('scenarios show up: unplanned op, trending-over watch, data quality hints', () => {
    const j22 = evaluateStoredJob(db, '104022');
    assert.ok(j22.ops.some((o) => o.unplanned), 'unplanned op');
    const j43 = evaluateStoredJob(db, '104043');
    assert.ok(j43.watch.some((w) => w.status === 'trending-over'), 'trending over');
    const j20 = evaluateStoredJob(db, '104020');
    assert.ok(j20.ops.some((o) => o.dq.includes('labor-mismatch')), 'labour mismatch');
    const j9 = evaluateStoredJob(db, '104009');
    assert.ok(j9.ops.some((o) => o.dq.includes('complete-zero-hours')));
    const j14 = evaluateStoredJob(db, '104014');
    assert.ok(j14.ops.some((o) => o.dq.includes('hours-zero-qty')));
    const j5 = evaluateStoredJob(db, '104005');
    assert.ok(j5.ops.some((o) => o.countReason === 'skipped'), 'closed with open op');
  });

  test('subcontract operations are present but excluded from labour variance', () => {
    const r = evaluateStoredJob(db, db.prepare("SELECT job_num FROM job_operations WHERE subcontract = 1 LIMIT 1").get().job_num);
    const sub = r.ops.find((o) => o.subcontract);
    assert.equal(sub.counts, false);
    assert.equal(sub.flag, null);
  });

  test('labour transactions roughly reconcile with operation hours on clean jobs', () => {
    const r = evaluateStoredJob(db, '104000');
    assert.ok(!r.ops.some((o) => o.dq.includes('labor-mismatch')));
  });
});

describe('incremental sync and scope', () => {
  test('incremental sync only pulls closed jobs since the last sync, but always the open ones', async () => {
    const db = fresh();
    const source = new MockSource({ now: NOW });
    await runSync({ db, source, kind: 'full', now: NOW, logger: quiet });
    const total = db.prepare('SELECT COUNT(*) n FROM jobs').get().n;
    const open = db.prepare('SELECT COUNT(*) n FROM jobs WHERE closed = 0').get().n;
    const later = new Date('2026-11-10T12:00:00Z');
    const r = await runSync({ db, source, kind: 'incremental', now: later, logger: quiet });
    assert.equal(r.ok, true);
    assert.ok(r.stored.jobs < total, `incremental pulled ${r.stored.jobs} of ${total}`);
    assert.ok(r.stored.jobs >= open, 'all open jobs are always re-pulled');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM jobs').get().n, total, 'nothing was lost');
  });

  test('first incremental sync with no history behaves like a full sync window', () => {
    const db = fresh();
    assert.equal(chooseFromDate(db, 'incremental', NOW, 12), '2025-11-09');
    assert.equal(chooseFromDate(db, 'full', NOW, 6), '2026-05-09');
    assert.equal(chooseFromDate(db, 'full', NOW, 12, '2024-01-01'), '2024-01-01');
  });

  test('re-syncing replaces rows instead of duplicating them', async () => {
    const db = fresh();
    const source = new MockSource({ now: NOW });
    await runSync({ db, source, kind: 'full', now: NOW, logger: quiet });
    const ops = db.prepare('SELECT COUNT(*) n FROM job_operations').get().n;
    const labor = db.prepare('SELECT COUNT(*) n FROM labor_details').get().n;
    await runSync({ db, source, kind: 'full', now: NOW, logger: quiet });
    assert.equal(db.prepare('SELECT COUNT(*) n FROM job_operations').get().n, ops);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM labor_details').get().n, labor);
  });

  test('a changed value in Epicor is picked up on the next sync', async () => {
    const db = fresh();
    const source = new MockSource({ now: NOW });
    await runSync({ db, source, kind: 'full', now: NOW, logger: quiet });
    const before = evaluateStoredJob(db, '104000').totals.labour.actHours;
    source.simulateChanges(['104000'], 3);
    await runSync({ db, source, kind: 'full', now: NOW, logger: quiet });
    const after = evaluateStoredJob(db, '104000').totals.labour.actHours;
    assert.equal(Math.round((after - before) * 100) / 100, 3);
  });
});

describe('failures are logged, masked, and leave existing data alone', () => {
  test('a source that throws marks the sync as error and keeps old data', async () => {
    const db = fresh();
    const good = new MockSource({ now: NOW });
    await runSync({ db, source: good, kind: 'full', now: NOW, logger: quiet });
    const jobs = db.prepare('SELECT COUNT(*) n FROM jobs').get().n;
    const bad = { name: 'epicor', fetchBaq: async () => { throw new Error('boom with SECRET-TOKEN inside'); } };
    const r = await runSync({ db, source: bad, kind: 'full', now: NOW, secrets: ['SECRET-TOKEN'], logger: quiet });
    assert.equal(r.ok, false);
    assert.ok(!r.error.includes('SECRET-TOKEN'));
    assert.equal(lastSync(db).status, 'error');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM jobs').get().n, jobs);
  });

  test('a missing required column stops the sync before anything is written', async () => {
    const db = fresh();
    const src = new MockSource({ now: NOW });
    const broken = {
      name: 'epicor',
      fetchBaq: async (key, o) => {
        const rows = await src.fetchBaq(key, o);
        if (key === 'jobOperations') rows.forEach((r) => delete r.JobOper_OpCode);
        return rows;
      },
    };
    const r = await runSync({ db, source: broken, kind: 'full', now: NOW, logger: quiet });
    assert.equal(r.ok, false);
    assert.match(r.error, /JobOper_OpCode/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM jobs').get().n, 0);
  });
});

describe('settings change the flags', () => {
  test('tighter thresholds produce more flagged lines; recompute applies them', async () => {
    const db = fresh();
    await runSync({ db, source: new MockSource({ now: NOW }), kind: 'full', now: NOW, logger: quiet });
    const base = db.prepare('SELECT COUNT(*) n FROM flag_lines').get().n;
    setSettings(db, { greenMax: 0.02, yellowMax: 0.05, minHours: 0.5, minDollars: 50 });
    recomputeJobs(db);
    const tight = db.prepare('SELECT COUNT(*) n FROM flag_lines').get().n;
    assert.ok(tight > base, `${tight} > ${base}`);
  });

  test('per op code override and rate override reach the engine config', () => {
    const db = fresh();
    db.prepare("INSERT INTO threshold_overrides (scope, scope_value, green_max, yellow_max) VALUES ('op_code','WELD',0.05,0.1)").run();
    db.prepare("INSERT INTO rate_overrides (resource_grp_id, setup_lab_rate) VALUES ('WELD1', 99)").run();
    const cfg = getEngineConfig(db);
    assert.deepEqual(cfg.opCodeOverrides.WELD, { greenMax: 0.05, yellowMax: 0.1 });
    assert.equal(cfg.rateOverrides.WELD1.setLab, 99);
    assert.equal(cfg.rateOverrides.WELD1.prodLab, null);
  });
});
