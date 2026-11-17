// Automatic sync: once a day at a set time (PC clock), plus a full re-sync on Sundays.
//
// How it decides (checked every minute, see startScheduler):
//   "Is there a successful sync since the most recent scheduled time?"  If yes, nothing to do.
//   If no, a sync is due. That also covers a PC that was off or asleep at the scheduled time:
//   the sync runs shortly after the app starts.
// A failed attempt is retried every 30 minutes, at most 3 times per scheduled slot, so a
// stuck Epicor connection never turns into a hammering loop. The Settings sync log shows each try.

import { isSyncRunning } from './sync.js';
import { getSettings } from '../settings.js';

export const AUTO_SYNC_USER = 'automatic schedule'; // not a valid username, so no real user can be mistaken for it
export const MAX_ATTEMPTS_PER_SLOT = 3;
export const RETRY_AFTER_MS = 30 * 60 * 1000;

export const isValidTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s ?? ''));

/** The most recent scheduled moment at or before `now` (PC local time). */
export function lastSlot(now, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (d > now) d.setDate(d.getDate() - 1);
  return d;
}

/** The next scheduled moment after `now`. */
export function nextSlot(now, hhmm) {
  const d = lastSlot(now, hhmm);
  d.setDate(d.getDate() + 1);
  return d;
}

/** Sundays (PC local time) are a full re-sync when that option is on. */
export const kindForSlot = (slot, weeklyFull) => (weeklyFull && slot.getDay() === 0 ? 'full' : 'incremental');

/**
 * @returns {null | {kind: 'incremental'|'full', slot: Date}}  null = nothing to do right now
 */
export function decideAutoSync(db, now, settings = getSettings(db)) {
  if (!settings.autoSyncEnabled || !isValidTime(settings.autoSyncTime)) return null;
  const slot = lastSlot(now, settings.autoSyncTime);
  const kind = kindForSlot(slot, settings.autoSyncWeeklyFull);
  const since = slot.toISOString();

  // A full slot is only satisfied by a successful full sync; an incremental one by any successful sync.
  const done = db
    .prepare(`SELECT 1 FROM sync_log WHERE status = 'ok' AND started_at >= ? ${kind === 'full' ? "AND kind = 'full'" : ''} LIMIT 1`)
    .get(since);
  if (done) return null;
  if (isSyncRunning(db)) return null;

  const tries = db.prepare('SELECT COUNT(*) n, MAX(started_at) last FROM sync_log WHERE started_by = ? AND started_at >= ?').get(AUTO_SYNC_USER, since);
  if (tries.n >= MAX_ATTEMPTS_PER_SLOT) return null;
  if (tries.last && now.getTime() - new Date(tries.last).getTime() < RETRY_AFTER_MS) return null;
  return { kind, slot };
}

/**
 * Starts the once-a-minute check. Nothing is scheduled in demo mode (the demo data never changes).
 * @param {{db, cfg, startSync: (kind: string, who: string) => Promise, log?: object, now?: () => Date, intervalMs?: number}} o
 */
export function startScheduler({ db, cfg, startSync, log = console, now = () => new Date(), intervalMs = 60_000 }) {
  let lastWarning = '';
  const tick = () => {
    if (cfg.useMock) return null;
    let due;
    try {
      due = decideAutoSync(db, now());
    } catch (err) {
      log.error?.(`Automatic sync check failed: ${err.message}`);
      return null;
    }
    if (!due) return null;
    try {
      const started = startSync(due.kind, AUTO_SYNC_USER);
      log.info?.(`Automatic ${due.kind} sync started`);
      lastWarning = '';
      return started;
    } catch (err) {
      // e.g. Epicor settings missing, or a manual sync started a moment ago. Say it once, not every minute.
      if (err.message !== lastWarning) log.warn?.(`Automatic sync skipped: ${err.message}`);
      lastWarning = err.message;
      return null;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}
