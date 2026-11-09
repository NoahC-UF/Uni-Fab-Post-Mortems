import {
  addAction, addNote, getPostMortem, listPostMortems, setOwner, setReviewDate, setRootCauses, setStatus, snapshotChanges, STEPS,
} from '../postmortems.js';
import { retakeSnapshot } from '../postmortems.js';
import { UserError, notFound } from '../errors.js';

const asList = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const idOf = (s) => {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1) throw notFound('That post-mortem');
  return n;
};

export function activeUsers(db) {
  return db.prepare('SELECT id, display_name AS name, role FROM users WHERE active = 1 ORDER BY display_name').all().map((r) => ({ ...r }));
}
export function activeCauses(db) {
  return db.prepare('SELECT id, name FROM root_causes WHERE active = 1 ORDER BY sort_order, name').all().map((r) => ({ ...r }));
}

export default async function postMortemRoutes(app) {
  const { db, now } = app.ctx;
  const back = (id, msg) => `/postmortems/${id}${msg ? `?ok=${encodeURIComponent(msg)}` : ''}`;

  app.get('/postmortems', async (req, reply) => {
    const status = ['open', 'done', 'all'].includes(req.query.status) ? req.query.status : 'open';
    const owner = /^\d+$/.test(req.query.owner ?? '') ? req.query.owner : '';
    const rows = listPostMortems(db, { status: status === 'all' ? '' : status, owner });
    return reply.page('pm_list.njk', { rows, status, owner, users: activeUsers(db) });
  });

  app.get('/postmortems/:id', async (req, reply) => {
    const id = idOf(req.params.id);
    const pm = getPostMortem(db, id);
    if (!pm) throw notFound('That post-mortem');
    const { changes } = snapshotChanges(db, pm);
    const stepIndex = STEPS.indexOf(pm.status);
    return reply.page('pm_detail.njk', {
      pm,
      snap: pm.snapshot,
      changes,
      steps: STEPS,
      stepIndex,
      users: activeUsers(db),
      causes: activeCauses(db),
      today: now().toISOString().slice(0, 10),
    });
  });

  app.post('/postmortems/:id/status', async (req, reply) => {
    const id = idOf(req.params.id);
    setStatus(db, id, String(req.body?.status ?? ''), { reason: req.body?.reason ?? '', now: now() });
    return reply.redirect(back(id, 'Status updated.'));
  });

  app.post('/postmortems/:id/causes', async (req, reply) => {
    const id = idOf(req.params.id);
    const ids = setRootCauses(db, id, asList(req.body?.cause));
    return reply.redirect(back(id, ids.length ? 'Root causes saved.' : 'Root causes cleared.'));
  });

  app.post('/postmortems/:id/notes', async (req, reply) => {
    const id = idOf(req.params.id);
    addNote(db, id, req.user.id, req.body?.body);
    return reply.redirect(back(id, 'Note added.'));
  });

  app.post('/postmortems/:id/details', async (req, reply) => {
    const id = idOf(req.params.id);
    setOwner(db, id, req.body?.owner);
    setReviewDate(db, id, req.body?.reviewDate);
    return reply.redirect(back(id, 'Owner and review date saved.'));
  });

  app.post('/postmortems/:id/actions', async (req, reply) => {
    const id = idOf(req.params.id);
    addAction(db, id, req.user.id, { description: req.body?.description, ownerUserId: req.body?.owner, dueDate: req.body?.due });
    return reply.redirect(back(id, 'Action item added.'));
  });

  app.post('/postmortems/:id/resnapshot', async (req, reply) => {
    const id = idOf(req.params.id);
    retakeSnapshot(db, id, req.user.id, now());
    return reply.redirect(back(id, 'Snapshot retaken from the current Epicor data.'));
  });
}
