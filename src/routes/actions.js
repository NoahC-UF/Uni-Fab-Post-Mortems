import { deleteAction, listActions, setActionStatus } from '../postmortems.js';
import { notFound } from '../errors.js';
import { activeUsers } from './postmortems.js';

// Only ever send people back to one of our own pages (no open redirect)
const safeBack = (b, fallback) => (typeof b === 'string' && /^\/(postmortems\/\d+|actions)$/.test(b) ? b : fallback);
const idOf = (s) => {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1) throw notFound('That action item');
  return n;
};

export default async function actionRoutes(app) {
  const { db, now } = app.ctx;

  // Open actions across every job
  app.get('/actions', async (req, reply) => {
    const status = ['open', 'overdue', 'done', 'all'].includes(req.query.status) ? req.query.status : 'open';
    const owner = req.query.owner === 'none' || /^\d+$/.test(req.query.owner ?? '') ? req.query.owner : '';
    const today = now().toISOString().slice(0, 10);
    const rows = listActions(db, { status: status === 'all' ? '' : status, owner, today });
    return reply.page('actions.njk', { rows, status, owner, users: activeUsers(db), today });
  });

  app.post('/actions/:id/status', async (req, reply) => {
    setActionStatus(db, idOf(req.params.id), String(req.body?.status ?? ''), now());
    return reply.redirect(`${safeBack(req.body?.back, '/actions')}?ok=${encodeURIComponent('Action updated.')}`);
  });

  app.post('/actions/:id/delete', async (req, reply) => {
    deleteAction(db, idOf(req.params.id));
    return reply.redirect(`${safeBack(req.body?.back, '/actions')}?ok=${encodeURIComponent('Action removed.')}`);
  });
}
