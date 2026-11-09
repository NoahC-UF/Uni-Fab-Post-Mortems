import { dashboardData, parseFilters } from '../queries.js';
import { getSettings } from '../settings.js';

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

export function presetRanges(now) {
  const today = iso(now);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const firstThis = new Date(Date.UTC(y, m, 1));
  const firstLast = new Date(Date.UTC(y, m - 1, 1));
  const lastLast = new Date(Date.UTC(y, m, 0));
  return [
    { label: 'Last 30 days', from: iso(addDays(now, -30)), to: today },
    { label: 'Last 90 days', from: iso(addDays(now, -90)), to: today },
    { label: 'This month', from: iso(firstThis), to: today },
    { label: 'Last month', from: iso(firstLast), to: iso(lastLast) },
    { label: 'Year to date', from: `${y}-01-01`, to: today },
    { label: 'Last 12 months', from: iso(addDays(now, -365)), to: today },
  ];
}

export default async function dashboardRoutes(app) {
  const { db, now } = app.ctx;

  app.get('/', async (req, reply) => {
    const f = parseFilters(req.query, now(), 30);
    const d = dashboardData(db, f, now());
    const presets = presetRanges(now()).map((p) => ({ ...p, on: p.from === f.from && p.to === f.to }));
    const hasData = db.prepare('SELECT COUNT(*) n FROM jobs').get().n > 0;
    return reply.page('dashboard.njk', { f, d, presets, hasData, settings: getSettings(db) });
  });
}
