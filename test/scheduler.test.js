import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from '../src/db.js';
import { setSettings } from '../src/settings.js';
import { lastSlot, nextSlot, decideAutoSync, startScheduler, AUTO_SYNC_USER, isValidTime } from '../src/sync/scheduler.js';

const quiet = { info() {}, warn() {}, error() {} };
// Local-time dates, so the tests do not depend on the PC's time zone. 2026-11-10 is a Tuesday, 2026-11-08 a Sunday.
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}
function addSync(db, when, { kind = 'incremental', status = 'ok', by = 'someone' } = {}) {
  db.prepare("INSERT INTO sync_log (kind, source, started_at, ended_at, status, started_by) VALUES (?, 'epicor', ?, ?, ?, ?)").run(kind, when.toISOString(), when.toISOString(), status, by);
}

describe('schedule maths', () => {
  test('lastSlot is today when the time has passed, yesterday when it has not', () => {
    assert.deepEqual(lastSlot(at(2026, 11, 10, 9, 0), '02:00'), at(2026, 11, 10, 2, 0));
    assert.deepEqual(lastSlot(at(2026, 11, 10, 1, 0), '02:00'), at(2026, 11, 9, 2, 0));
    assert.deepEqual(lastSlot(at(2026, 11, 10, 2, 0), '02:00'), at(2026, 11, 10, 2, 0), 'exactly on the time counts');
  });
  test('nextSlot is the following day after the last one', () => {
    assert.deepEqual(nextSlot(at(2026, 11, 10, 9, 0), '02:00'), at(2026, 11, 11, 2, 0));
    assert.deepEqual(nextSlot(at(2026, 11, 10, 1, 0), '02:00'), at(2026, 11, 10, 2, 0));
  });
  test('time validation', () => {
    for (const ok of ['00:00', '02:00', '23:59']) assert.ok(isValidTime(ok), ok);
    for (const bad of ['24:00', '2:00', '02:60', '', 'noon', null]) assert.ok(!isValidTime(bad), String(bad));
  });
});

describe('when is a sync due', () => {
  test('due when nothing has synced since the scheduled time, including catching up after the PC was off', () => {
    const db = fresh();
    addSync(db, at(2026, 11, 9, 2, 5)); // yesterday's run
    const d = decideAutoSync(db, at(2026, 11, 10, 8, 30)); // PC switched on at 08:30
    assert.equal(d.kind, 'incremental');
  });
  test('not due before the time, or once a successful sync has happened since it', () => {
    const db = fresh();
    addSync(db, at(2026, 11, 9, 2, 5));
    assert.equal(decideAutoSync(db, at(2026, 11, 10, 1, 59)), null);
    addSync(db, at(2026, 11, 10, 2, 1));
    assert.equal(decideAutoSync(db, at(2026, 11, 10, 23, 0)), null);
  });
  test('a manual sync after the scheduled time also satisfies it', () => {
    const db = fresh();
    addSync(db, at(2026, 11, 10, 7, 45), { by: 'noah' });
    assert.equal(decideAutoSync(db, at(2026, 11, 10, 9, 0)), null);
  });
  test('a first-ever start is due straight away', () => {
    assert.ok(decideAutoSync(fresh(), at(2026, 11, 10, 9, 0)));
  });
  test('off means never', () => {
    const db = fresh();
    setSettings(db, { autoSyncEnabled: false });
    assert.equal(decideAutoSync(db, at(2026, 11, 10, 9, 0)), null);
  });
  test('the time setting is honoured', () => {
    const db = fresh();
    setSettings(db, { autoSyncTime: '18:30' });
    addSync(db, at(2026, 11, 9, 18, 31));
    assert.equal(decideAutoSync(db, at(2026, 11, 10, 18, 29)), null);
    assert.ok(decideAutoSync(db, at(2026, 11, 10, 18, 30)));
  });
  test('not due while another sync is running', () => {
    const db = fresh();
    db.prepare("INSERT INTO sync_log (kind, source, started_at, status) VALUES ('incremental', 'epicor', ?, 'running')").run(new Date().toISOString());
    // the "running" check uses the real clock, so ask at the real time
    const now = new Date();
    setSettings(db, { autoSyncTime: '00:00' });
    assert.equal(decideAutoSync(db, now), null);
  });
});

describe('Sundays are a full re-sync', () => {
  test('Sunday slot needs a full sync; an incremental one does not satisfy it', () => {
    const db = fresh();
    addSync(db, at(2026, 11, 7, 2, 5)); // Saturday night, fine
    const sunday = at(2026, 11, 8, 9, 0);
    assert.equal(decideAutoSync(db, sunday).kind, 'full');
    addSync(db, at(2026, 11, 8, 6, 0), { kind: 'incremental', by: 'noah' });
    assert.equal(decideAutoSync(db, sunday).kind, 'full', 'a manual incremental does not replace the weekly full');
    addSync(db, at(2026, 11, 8, 7, 0), { kind: 'full', by: 'noah' });
    assert.equal(decideAutoSync(db, sunday), null);
  });
  test('Monday is incremental again, and the option can be turned off', () => {
    const db = fresh();
    assert.equal(decideAutoSync(db, at(2026, 11, 9, 9, 0)).kind, 'incremental');
    setSettings(db, { autoSyncWeeklyFull: false });
    assert.equal(decideAutoSync(db, at(2026, 11, 8, 9, 0)).kind, 'incremental');
  });
});

describe('failures are retried gently', () => {
  test('retry no sooner than 30 minutes, and at most 3 attempts per scheduled time', () => {
    const db = fresh();
    addSync(db, at(2026, 11, 9, 2, 5));
    addSync(db, at(2026, 11, 10, 2, 0), { status: 'error', by: AUTO_SYNC_USER });
    assert.equal(decideAutoSync(db, at(2026, 11, 10, 2, 20)), null, 'too soon');
    assert.ok(decideAutoSync(db, at(2026, 11, 10, 2, 31)), 'retry after 30 minutes');
    addSync(db, at(2026, 11, 10, 2, 31), { status: 'error', by: AUTO_SYNC_USER });
    addSync(db, at(2026, 11, 10, 3, 2), { status: 'error', by: AUTO_SYNC_USER });
    assert.equal(decideAutoSync(db, at(2026, 11, 10, 9, 0)), null, 'gives up after 3 tries until the next scheduled time');
    assert.ok(decideAutoSync(db, at(2026, 11, 11, 2, 0)), 'next day it tries again');
  });
});

describe('the timer', () => {
  test('starts a sync as the automatic user, only when due, and never in demo mode', () => {
    const db = fresh();
    const calls = [];
    const startSync = (kind, who) => {
      calls.push([kind, who]);
      addSync(db, new Date(), { kind, by: who }); // like a real sync, it leaves a log row behind
    };
    let clock = at(2026, 11, 10, 9, 0);
    const s = startScheduler({ db, cfg: { useMock: false }, startSync, log: quiet, now: () => clock, intervalMs: 3_600_000 });
    s.tick();
    assert.deepEqual(calls, [['incremental', AUTO_SYNC_USER]]);
    s.stop();

    const demo = startScheduler({ db: fresh(), cfg: { useMock: true }, startSync: () => assert.fail('must not sync in demo mode'), log: quiet, intervalMs: 3_600_000 });
    demo.tick();
    demo.stop();
  });
  test('a start-up problem (e.g. Epicor not configured) is reported once, not every minute', () => {
    const warnings = [];
    const s = startScheduler({
      db: fresh(),
      cfg: { useMock: false },
      startSync: () => {
        throw new Error('Epicor is not configured.');
      },
      log: { ...quiet, warn: (m) => warnings.push(m) },
      now: () => at(2026, 11, 10, 9, 0),
      intervalMs: 3_600_000,
    });
    s.tick();
    s.tick();
    s.tick();
    s.stop();
    assert.equal(warnings.length, 1);
  });
});
