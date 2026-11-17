import { dashboardData, parseFilters } from '../queries.js';
import { getSettings } from '../settings.js';
import { getPref, setPref, deletePref } from '../prefs.js';
import { GRID_COLUMNS, clientRows } from '../gridRows.js';
import { normaliseColumnPref, parseColumnPrefBody } from '../columnPrefs.js';

const COLUMNS_PREF = 'dashboard.columns';

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
    const dir = ['over', 'under'].includes(req.query.dir) ? req.query.dir : ''; // '' = both (the default)
    const d = dashboardData(db, f, now(), dir);
    const presets = presetRanges(now()).map((p) => ({ ...p, on: p.from === f.from && p.to === f.to, href: `/?from=${p.from}&to=${p.to}${dir ? `&dir=${dir}` : ''}` }));
    const hasData = db.prepare('SELECT COUNT(*) n FROM jobs').get().n > 0;
    const settings = getSettings(db);
    return reply.page('dashboard.njk', {
      f, d, dir, presets, hasData, settings,
      topRows: clientRows(d.top),
      targetMarginPct: settings.targetMarginPct,
      savedColumns: normaliseColumnPref(getPref(db, req.user.id, COLUMNS_PREF), GRID_COLUMNS), // null = the standard columns
    });
  });

  // "Save as my default" for the Top 10's columns. Per person, so it follows them to any computer.
  app.post('/dashboard/columns', async (req, reply) => {
    setPref(db, req.user.id, COLUMNS_PREF, parseColumnPrefBody(req.body, GRID_COLUMNS));
    return reply.send({ ok: true });
  });

  app.post('/dashboard/columns/reset', async (req, reply) => {
    deletePref(db, req.user.id, COLUMNS_PREF);
    return reply.send({ ok: true });
  });
}
