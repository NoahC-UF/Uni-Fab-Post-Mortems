// Quote Accuracy: the Operations & Materials page, the Customers page, one customer in full, and CSV exports.
// All the arithmetic is in src/accuracy.js; these routes read the filters, ask it for the numbers and show them.

import {
  BASES, SORTS, ORDERS, LIST_VIEWS, TOP_CHOICES, REPEAT_JOBS, REPEAT_JOBS_CUSTOMER, INTERNAL_KEY, INTERNAL_LABEL,
  opsAndMaterials, drillDown, customersPage, customerDetail, exportCsv, parseAccuracyFilters, filterLink,
} from '../accuracy.js';
import { getSettings, getEngineConfig } from '../settings.js';
import { notFound } from '../errors.js';
import { orgFilterOptions } from '../customerOrg.js';
import { presetRanges } from './dashboard.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export default async function accuracyRoutes(app) {
  const { db, now } = app.ctx;
  // Margin sorts only mean something for customers: on operations / materials (and inside one customer) the default sort is used instead.
  const MARGIN_SORTS = ['margin', 'marginpct', 'vstarget'];
  const filters = (req, margins = false) => {
    const f = parseAccuracyFilters(req.query, now(), getSettings(db), { customers: margins });
    return !margins && MARGIN_SORTS.includes(f.sort) ? { ...f, sort: 'netvar' } : f;
  };
  // listLinks: the page's address for each choice of the "Show" list picker, keeping every other filter (and the open drill-down)
  const listLinks = (f, extra = {}) => Object.fromEntries(LIST_VIEWS.map((l) => [l.id, filterLink(f, { ...extra, lists: l.id })]));
  // the quick date buttons (the same ranges as the Dashboard); each keeps every other filter
  const presetsFor = (f, path) => presetRanges(now()).map((p) => ({ label: p.label, on: p.from === f.from && p.to === f.to, href: `${path}?${filterLink(f, { from: p.from, to: p.to })}` }));
  const shared = (f, extra, path) => ({
    sorts: SORTS.filter((s) => !s.customers), orders: ORDERS, bases: BASES, listViews: LIST_VIEWS, listLinks: listLinks(f, extra), base: filterLink(f), baseNoLists: filterLink({ ...f, lists: null }), baseNoOrg: filterLink({ ...f, tier: '', mgr: '' }), greenMax: getEngineConfig(db).greenMax, internalKey: INTERNAL_KEY,
    presets: presetsFor(f, path), org: orgFilterOptions(db),
  });

  app.get('/accuracy', async (req, reply) => reply.redirect('/accuracy/ops'));

  // ---------------------------------------------------------------- page 1: operations and materials
  app.get('/accuracy/ops', async (req, reply) => {
    const f = filters(req);
    const d = opsAndMaterials(db, f);

    // one level down: ?drill=op:WELD (or mtl:PART), then &dpart=PART for one part's jobs
    let dd = null;
    let drillKey = '';
    const m = /^(op|mtl):(.{1,200})$/.exec(typeof req.query.drill === 'string' ? req.query.drill : '');
    if (m) {
      const part = typeof req.query.dpart === 'string' ? req.query.dpart.slice(0, 80) : '';
      dd = drillDown(db, f, { type: m[1], key: m[2], part });
      drillKey = dd ? `${m[1]}:${m[2]}` : '';
    }

    let custLabel = '';
    if (f.cust) {
      const row = f.cust === INTERNAL_KEY ? null : db.prepare('SELECT cust_name FROM jobs WHERE cust_id = ? LIMIT 1').get(f.cust);
      custLabel = f.cust === INTERNAL_KEY ? INTERNAL_LABEL : row?.cust_name || f.cust;
    }
    return reply.page('accuracy_ops.njk', {
      ...shared(f, { drill: drillKey, dpart: dd?.part ?? '' }, '/accuracy/ops'), d, dd, drillKey, custLabel, repeatMin: REPEAT_JOBS,
      baseNoCust: filterLink({ ...f, cust: '' }),
      hidden: f.cust ? `<input type="hidden" name="cust" value="${esc(f.cust)}">` : '',
    });
  });

  // ---------------------------------------------------------------- page 2: customers
  app.get('/accuracy/customers', async (req, reply) => {
    const f = { ...filters(req, true), cust: '' };
    return reply.page('accuracy_customers.njk', { ...shared(f, undefined, '/accuracy/customers'), sorts: SORTS, tops: TOP_CHOICES, d: customersPage(db, f) });
  });

  app.get('/accuracy/customers/:cust', async (req, reply) => {
    // one customer in full: the tier / account manager filters do not apply (they pick customers; this is one), but they are kept in the links back
    const asked = filters(req, true);
    // one customer's lists open side by side (Both - Horizontal Window) unless the address says otherwise
    const kept = { ...asked, cust: '', lists: req.query.lists === undefined ? 'h' : asked.lists };
    const f = { ...kept, tier: '', mgr: '', sort: MARGIN_SORTS.includes(kept.sort) ? 'netvar' : kept.sort, order: MARGIN_SORTS.includes(kept.sort) ? 'desc' : kept.order };
    const key = String(req.params.cust).slice(0, 60);
    const c = customerDetail(db, f, key);
    if (!c) throw notFound('That customer has no jobs for these filters.');
    return reply.page('accuracy_customer.njk', { ...shared(kept, undefined, `/accuracy/customers/${encodeURIComponent(key)}`), org: null, c, repeatMin: REPEAT_JOBS_CUSTOMER });
  });

  // ---------------------------------------------------------------- CSV of the current view, filters applied
  app.get('/accuracy/export.csv', async (req, reply) => {
    const f = filters(req);
    const view = ['ops', 'materials', 'customers'].includes(req.query.view) ? req.query.view : 'ops';
    const csv = exportCsv(db, f, view);
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="quote-accuracy-${view}-${f.from}-to-${f.to}.csv"`)
      .send('﻿' + csv); // the BOM makes Excel read it as UTF-8
  });
}
