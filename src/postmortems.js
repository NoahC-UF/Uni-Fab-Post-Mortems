// Post-mortem records: status workflow, root causes, notes, action items, snapshots.
//
// Status flow:  (Flagged) -> Under Review -> Root Cause Found -> Actions Assigned -> Closed
//               or Dismissed (with a reason, e.g. "data entry error") from any point.
// "Flagged" is not stored: a flagged job simply has no post-mortem record yet.

import { tx } from './db.js';
import { UserError, notFound } from './errors.js';
import { evaluateStoredJob } from './metrics.js';
import { getSettings } from './settings.js';
import { diffSnapshot } from './engine/job.js';
import { loadEconomics } from './economics.js';

export const STATUSES = ['under_review', 'root_cause_found', 'actions_assigned', 'closed', 'dismissed'];
export const STEPS = ['under_review', 'root_cause_found', 'actions_assigned', 'closed'];
export const ACTION_STATUSES = ['open', 'in_progress', 'done'];

const iso = (d) => d.toISOString();
const validDate = (s) => (s === '' || s === null || s === undefined ? null : /^\d{4}-\d{2}-\d{2}$/.test(String(s)) ? String(s) : undefined);

/** Freeze a copy of the job's current numbers and open a post-mortem on it. */
export function createPostMortem(db, { jobNum, userId, status = 'under_review', dismissReason = null, now = new Date() }) {
  if (!['under_review', 'dismissed'].includes(status)) throw new UserError('A post-mortem starts as Under Review or Dismissed.');
  if (db.prepare('SELECT 1 FROM post_mortems WHERE job_num = ?').get(jobNum)) throw new UserError('This job already has a post-mortem.');
  if (status === 'dismissed' && !String(dismissReason ?? '').trim()) throw new UserError('Please give a reason for dismissing this job.');
  const live = evaluateStoredJob(db, jobNum);
  if (!live) throw notFound('That job');
  const s = getSettings(db);
  const snapshot = {
    ...live,
    economics: loadEconomics(db, jobNum, live), // price and margins are frozen with the rest, so the report matches what the team saw
    meta: {
      takenAt: iso(now),
      settings: { greenMax: s.greenMax, yellowMax: s.yellowMax, minHours: s.minHours, minDollars: s.minDollars },
    },
  };
  const info = db
    .prepare(
      `INSERT INTO post_mortems (job_num, status, owner_user_id, dismiss_reason, snapshot_json, snapshot_fingerprint, snapshot_taken_at, created_by, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(jobNum, status, userId, status === 'dismissed' ? String(dismissReason).trim() : null, JSON.stringify(snapshot), live.fingerprint, iso(now), userId, status === 'dismissed' ? iso(now) : null);
  return Number(info.lastInsertRowid);
}

/** Replace the frozen numbers with today's (e.g. after Epicor data was corrected). Leaves a note so the history is clear. */
export function retakeSnapshot(db, id, userId, now = new Date()) {
  const pm = require_(db, id);
  const live = evaluateStoredJob(db, pm.job_num);
  if (!live) throw notFound('That job');
  const s = getSettings(db);
  const snapshot = { ...live, economics: loadEconomics(db, pm.job_num, live), meta: { takenAt: iso(now), settings: { greenMax: s.greenMax, yellowMax: s.yellowMax, minHours: s.minHours, minDollars: s.minDollars } } };
  tx(db, () => {
    db.prepare('UPDATE post_mortems SET snapshot_json = ?, snapshot_fingerprint = ?, snapshot_taken_at = ?, updated_at = datetime(\'now\') WHERE id = ?').run(
      JSON.stringify(snapshot), live.fingerprint, iso(now), id,
    );
    db.prepare('INSERT INTO pm_notes (post_mortem_id, author_id, body) VALUES (?, ?, ?)').run(
      id, userId, `Snapshot retaken from current data (previous snapshot was from ${String(pm.snapshot_taken_at).slice(0, 16).replace('T', ' ')}).`,
    );
  });
}

export function getPostMortem(db, id) {
  const pm = db
    .prepare(
      `SELECT pm.*, u.display_name AS owner_name, c.display_name AS created_by_name
       FROM post_mortems pm LEFT JOIN users u ON u.id = pm.owner_user_id LEFT JOIN users c ON c.id = pm.created_by
       WHERE pm.id = ?`,
    )
    .get(id);
  if (!pm) return null;
  const out = { ...pm, snapshot: JSON.parse(pm.snapshot_json) };
  delete out.snapshot_json;
  out.rootCauseIds = db.prepare('SELECT root_cause_id FROM post_mortem_root_causes WHERE post_mortem_id = ?').all(id).map((r) => r.root_cause_id);
  out.notes = db
    .prepare('SELECT n.*, u.display_name AS author FROM pm_notes n LEFT JOIN users u ON u.id = n.author_id WHERE n.post_mortem_id = ? ORDER BY n.created_at DESC, n.id DESC')
    .all(id)
    .map((r) => ({ ...r }));
  out.actions = db
    .prepare('SELECT a.*, u.display_name AS owner_name FROM action_items a LEFT JOIN users u ON u.id = a.owner_user_id WHERE a.post_mortem_id = ? ORDER BY a.status = \'done\', a.due_date IS NULL, a.due_date, a.id')
    .all(id)
    .map((r) => ({ ...r }));
  return out;
}

export function getPostMortemByJob(db, jobNum) {
  const row = db.prepare('SELECT id FROM post_mortems WHERE job_num = ?').get(jobNum);
  return row ? getPostMortem(db, row.id) : null;
}

function require_(db, id) {
  const pm = db.prepare('SELECT * FROM post_mortems WHERE id = ?').get(id);
  if (!pm) throw notFound('That post-mortem');
  return pm;
}

const touch = (db, id) => db.prepare("UPDATE post_mortems SET updated_at = datetime('now') WHERE id = ?").run(id);

export function setStatus(db, id, status, { reason = '', now = new Date() } = {}) {
  const pm = require_(db, id);
  if (!STATUSES.includes(status)) throw new UserError('Unknown status.');
  const causes = db.prepare('SELECT COUNT(*) n FROM post_mortem_root_causes WHERE post_mortem_id = ?').get(id).n;
  const actions = db.prepare('SELECT COUNT(*) n FROM action_items WHERE post_mortem_id = ?').get(id).n;
  const openActions = db.prepare("SELECT COUNT(*) n FROM action_items WHERE post_mortem_id = ? AND status <> 'done'").get(id).n;

  if (status === 'root_cause_found' && !causes) throw new UserError('Pick at least one root cause first.');
  if (status === 'actions_assigned' && (!causes || !actions)) throw new UserError('Pick a root cause and add at least one action item first.');
  if (status === 'closed') {
    if (!causes) throw new UserError('Pick at least one root cause before closing.');
    if (openActions) throw new UserError(`Finish or remove the ${openActions} open action item(s) before closing.`);
  }
  if (status === 'dismissed' && !String(reason).trim() && !pm.dismiss_reason) throw new UserError('Please give a reason for dismissing this job.');

  const closing = status === 'closed' || status === 'dismissed';
  db.prepare('UPDATE post_mortems SET status = ?, dismiss_reason = ?, closed_at = ?, updated_at = datetime(\'now\') WHERE id = ?').run(
    status,
    status === 'dismissed' ? String(reason).trim() || pm.dismiss_reason : null,
    closing ? iso(now) : null,
    id,
  );
}

export function setRootCauses(db, id, causeIds) {
  require_(db, id);
  const valid = new Set(db.prepare('SELECT id FROM root_causes').all().map((r) => r.id));
  const ids = [...new Set(causeIds.map(Number).filter((n) => valid.has(n)))];
  tx(db, () => {
    db.prepare('DELETE FROM post_mortem_root_causes WHERE post_mortem_id = ?').run(id);
    const ins = db.prepare('INSERT INTO post_mortem_root_causes (post_mortem_id, root_cause_id) VALUES (?, ?)');
    for (const c of ids) ins.run(id, c);
    touch(db, id);
  });
  return ids;
}

export function addNote(db, id, userId, body) {
  require_(db, id);
  const text = String(body ?? '').trim();
  if (!text) throw new UserError('The note is empty.');
  if (text.length > 5000) throw new UserError('That note is too long (5000 characters max).');
  db.prepare('INSERT INTO pm_notes (post_mortem_id, author_id, body) VALUES (?, ?, ?)').run(id, userId, text);
  touch(db, id);
}

export function setOwner(db, id, ownerUserId) {
  require_(db, id);
  const owner = ownerUserId ? Number(ownerUserId) : null;
  if (owner && !db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(owner)) throw new UserError('That user does not exist.');
  db.prepare('UPDATE post_mortems SET owner_user_id = ? WHERE id = ?').run(owner, id);
  touch(db, id);
}

export function setReviewDate(db, id, date) {
  require_(db, id);
  const d = validDate(date);
  if (d === undefined) throw new UserError('That date is not valid.');
  db.prepare('UPDATE post_mortems SET review_date = ? WHERE id = ?').run(d, id);
  touch(db, id);
}

// ------------------------------------------------------------------- actions
export function addAction(db, id, userId, { description, ownerUserId, dueDate }) {
  require_(db, id);
  const text = String(description ?? '').trim();
  if (!text) throw new UserError('Describe the action.');
  if (text.length > 1000) throw new UserError('That description is too long (1000 characters max).');
  const due = validDate(dueDate);
  if (due === undefined) throw new UserError('That due date is not valid.');
  const owner = ownerUserId ? Number(ownerUserId) : null;
  if (owner && !db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(owner)) throw new UserError('That owner does not exist.');
  const info = db
    .prepare('INSERT INTO action_items (post_mortem_id, description, owner_user_id, due_date, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(id, text, owner, due, userId);
  touch(db, id);
  return Number(info.lastInsertRowid);
}

export function setActionStatus(db, actionId, status, now = new Date()) {
  const a = db.prepare('SELECT * FROM action_items WHERE id = ?').get(actionId);
  if (!a) throw notFound('That action item');
  if (!ACTION_STATUSES.includes(status)) throw new UserError('Unknown action status.');
  db.prepare('UPDATE action_items SET status = ?, completed_at = ? WHERE id = ?').run(status, status === 'done' ? iso(now) : null, actionId);
  touch(db, a.post_mortem_id);
  return a.post_mortem_id;
}

export function deleteAction(db, actionId) {
  const a = db.prepare('SELECT * FROM action_items WHERE id = ?').get(actionId);
  if (!a) throw notFound('That action item');
  db.prepare('DELETE FROM action_items WHERE id = ?').run(actionId);
  touch(db, a.post_mortem_id);
  return a.post_mortem_id;
}

// ------------------------------------------------------------------ listings
/** SQL for "this customer's jobs" (j = jobs). '_internal' = Internal / Stock jobs, which have no customer. */
export const INTERNAL_CUSTOMER = '_internal';
export function customerCondition(custKey) {
  return custKey === INTERNAL_CUSTOMER ? "(j.order_num IS NULL OR COALESCE(j.cust_id, '') = '')" : 'j.cust_id = @cust';
}

export function listPostMortems(db, { status = '', owner = '', cust = '' } = {}) {
  const where = [];
  const p = {};
  if (cust) {
    where.push(customerCondition(cust)); // only this customer's post-mortems
    if (cust !== INTERNAL_CUSTOMER) p.cust = cust;
  }
  if (status === 'open') where.push("pm.status IN ('under_review','root_cause_found','actions_assigned')");
  else if (status === 'done') where.push("pm.status IN ('closed','dismissed')");
  else if (STATUSES.includes(status)) {
    where.push('pm.status = @status');
    p.status = status;
  }
  if (owner) {
    where.push('pm.owner_user_id = @owner');
    p.owner = Number(owner);
  }
  return db
    .prepare(
      `SELECT pm.id, pm.job_num, pm.status, pm.review_date, pm.snapshot_taken_at, pm.updated_at, pm.closed_at, pm.dismiss_reason,
              u.display_name AS owner_name, j.part_num, j.cust_name,
              m.flag, m.impact_dollars, m.fingerprint AS live_fingerprint, pm.snapshot_fingerprint,
              (SELECT COUNT(*) FROM action_items a WHERE a.post_mortem_id = pm.id AND a.status <> 'done') AS open_actions,
              (SELECT GROUP_CONCAT(rc.name, '; ') FROM post_mortem_root_causes x JOIN root_causes rc ON rc.id = x.root_cause_id WHERE x.post_mortem_id = pm.id) AS causes
       FROM post_mortems pm
       LEFT JOIN users u ON u.id = pm.owner_user_id
       LEFT JOIN jobs j ON j.job_num = pm.job_num
       LEFT JOIN job_metrics m ON m.job_num = pm.job_num
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY (pm.status IN ('closed','dismissed')), pm.updated_at DESC`,
    )
    .all(p)
    .map((r) => ({ ...r, changed: !!r.live_fingerprint && r.live_fingerprint !== r.snapshot_fingerprint }));
}

export function listActions(db, { status = 'open', owner = '', today = iso(new Date()).slice(0, 10) } = {}) {
  const where = [];
  const p = {};
  if (status === 'open') where.push("a.status <> 'done'");
  else if (status === 'done') where.push("a.status = 'done'");
  else if (status === 'overdue') where.push("a.status <> 'done' AND a.due_date IS NOT NULL AND a.due_date < @today");
  if (status === 'overdue') p.today = today;
  if (owner === 'none') where.push('a.owner_user_id IS NULL');
  else if (owner) {
    where.push('a.owner_user_id = @owner');
    p.owner = Number(owner);
  }
  return db
    .prepare(
      `SELECT a.*, u.display_name AS owner_name, pm.job_num, pm.status AS pm_status, j.part_num, j.cust_name
       FROM action_items a
       JOIN post_mortems pm ON pm.id = a.post_mortem_id
       LEFT JOIN users u ON u.id = a.owner_user_id
       LEFT JOIN jobs j ON j.job_num = pm.job_num
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY a.status = 'done', a.due_date IS NULL, a.due_date, a.id`,
    )
    .all(p)
    .map((r) => ({ ...r, overdue: r.status !== 'done' && !!r.due_date && r.due_date < today }));
}

/** What changed in Epicor since the snapshot was taken (empty = nothing). */
export function snapshotChanges(db, pm) {
  const live = evaluateStoredJob(db, pm.job_num);
  return { live, changes: live ? diffSnapshot(pm.snapshot, live) : [] };
}
