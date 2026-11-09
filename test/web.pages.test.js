import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeSession } from './helpers.js';

let S;
before(async () => {
  S = await makeSession();
});

const ok = (res, label) => assert.equal(res.statusCode, 200, `${label}: ${res.statusCode} ${res.body.slice(0, 300)}`);
const flaggedJobNum = () => S.db.prepare("SELECT j.job_num FROM jobs j JOIN job_metrics m ON m.job_num = j.job_num WHERE j.closed = 1 AND m.flag = 'red' AND j.order_num IS NOT NULL ORDER BY m.impact_dollars DESC LIMIT 1").get().job_num;

describe('pages render', () => {
  test('dashboard shows KPI tiles and a top-10 table', async () => {
    const r = await S.admin.get('/?from=2000-01-01&to=2999-01-01');
    ok(r, 'dashboard');
    for (const t of ['Jobs reviewed', 'Within tolerance', 'Total $ over', 'Total $ under', 'Open post-mortems', 'Top 10 biggest $ misses']) assert.ok(r.body.includes(t), t);
    assert.match(r.body, /id="byOpData"/);
  });

  test('dashboard defaults to the last 30 days', async () => {
    const r = await S.admin.get('/');
    ok(r, 'dashboard default');
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    assert.ok(r.body.includes(`value="${from}"`) && r.body.includes(`value="${to}"`));
  });

  test('flagged jobs list has data, sorted by $ impact, with all filters present', async () => {
    const r = await S.admin.get('/jobs?from=2000-01-01&to=2999-01-01');
    ok(r, 'jobs');
    const m = /<script type="application\/json" id="jobRows">(.*?)<\/script>/s.exec(r.body);
    const rows = JSON.parse(m[1]);
    assert.ok(rows.length > 5);
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].impact >= rows[i].impact, 'biggest $ impact first');
    assert.ok(rows.every((x) => x.flag === 'red' || x.flag === 'yellow'), 'default shows flagged only');
    for (const f of ['name="from"', 'name="status"', 'name="flag"', 'name="direction"', 'name="cust"', 'name="op"', 'name="rg"', 'name="part"', 'name="minImpact"']) assert.ok(r.body.includes(f), f);
  });

  test('filters work: status, flag colour, over/under, op code, customer, min impact', async () => {
    const rows = async (qs) => JSON.parse(/id="jobRows">(.*?)<\/script>/s.exec((await S.admin.get(`/jobs?from=2000-01-01&to=2999-01-01&${qs}`)).body)?.[1] ?? '[]');
    const closed = await rows('status=closed');
    assert.ok(closed.length && closed.every((r) => r.state === 'Closed'));
    const open = await rows('status=open&flag=all');
    assert.ok(open.length && open.every((r) => r.state === 'In progress'));
    const red = await rows('flag=red');
    assert.ok(red.length && red.every((r) => r.flag === 'red'));
    const all = await rows('flag=all');
    assert.ok(all.length > (await rows('flag=flagged')).length);
    const weld = await rows('op=WELD');
    assert.ok(weld.length && weld.length < (await rows('')).length);
    const over = await rows('direction=over');
    const under = await rows('direction=under');
    assert.ok(over.length && under.length);
    const big = await rows('minImpact=3000');
    assert.ok(big.every((r) => r.impact >= 3000));
    const cust = S.db.prepare("SELECT cust_id FROM jobs WHERE cust_id IS NOT NULL LIMIT 1").get().cust_id;
    assert.ok((await rows(`flag=all&cust=${cust}`)).length > 0);
  });

  test('jobs without a sales order are left out by default', async () => {
    const r = await S.admin.get('/jobs?from=2000-01-01&to=2999-01-01&flag=all');
    const rows = JSON.parse(/id="jobRows">(.*?)<\/script>/s.exec(r.body)[1]);
    const noOrder = S.db.prepare('SELECT job_num FROM jobs WHERE order_num IS NULL').all().map((x) => x.job_num);
    assert.ok(noOrder.length >= 3);
    for (const j of noOrder) assert.ok(!rows.some((x) => x.job === j), `${j} should be excluded`);
  });

  test('Excel export returns a real workbook with the flagged jobs', async () => {
    const r = await S.admin.get('/jobs/export.xlsx?from=2000-01-01&to=2999-01-01');
    ok(r, 'export');
    assert.match(r.headers['content-type'], /spreadsheetml/);
    assert.match(r.headers['content-disposition'], /flagged-jobs-\d{4}-\d{2}-\d{2}\.xlsx/);
    const buf = r.rawPayload;
    assert.equal(buf.slice(0, 2).toString(), 'PK', 'xlsx is a zip');
    const { default: ExcelJS } = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.getWorksheet('Flagged jobs');
    assert.ok(ws.rowCount > 5);
    assert.equal(ws.getRow(1).getCell(2).value, 'Job');
    const impacts = [];
    ws.eachRow((row, i) => i > 1 && impacts.push(row.getCell(10).value));
    for (let i = 1; i < impacts.length; i++) assert.ok(impacts[i - 1] >= impacts[i]);
    assert.ok(wb.getWorksheet('Flagged lines').rowCount > 5);
  });

  test('job detail shows operations, materials, chart, labour drill-down', async () => {
    const jn = flaggedJobNum();
    const r = await S.admin.get(`/jobs/${jn}`);
    ok(r, 'job detail');
    for (const t of ['Operations', 'Materials', 'Estimated vs actual hours by operation', 'Setup est', 'Hrs/pc', 'Usage $', 'Cost basis $', 'Start post-mortem']) assert.ok(r.body.includes(t), t);
    assert.match(r.body, /id="chartData"/);
  });

  test('in-progress job shows the watchlist; multi-level job groups by assembly', async () => {
    const r = await S.admin.get('/jobs/104043');
    ok(r, 'open job');
    assert.match(r.body, /Watchlist \(\d+\)/);
    assert.match(r.body, /Trending over/);
    const multi = S.db.prepare('SELECT job_num FROM job_operations GROUP BY job_num HAVING COUNT(DISTINCT assembly_seq) > 1 LIMIT 1').get().job_num;
    assert.match((await S.admin.get(`/jobs/${multi}`)).body, /Assembly 1/);
  });

  test('unknown or malformed job numbers give a friendly 404', async () => {
    assert.equal((await S.admin.get('/jobs/NOPE999')).statusCode, 404);
    assert.equal((await S.admin.get('/jobs/..%2F..%2Fetc')).statusCode, 404);
  });

  test('backflush markers, unplanned work and returns appear where expected', async () => {
    const bf = S.db.prepare('SELECT job_num FROM job_materials WHERE backflush = 1 LIMIT 1').get().job_num;
    assert.match((await S.admin.get(`/jobs/${bf}`)).body, /backflush/);
    assert.match((await S.admin.get('/jobs/104022')).body, /Unplanned/);
    assert.match((await S.admin.get('/jobs/104016')).body, /returned/);
  });
});

describe('employee-level data is Admin only', () => {
  test('reviewers do not see names or numbers in the labour drill-down; admins do', async () => {
    const jn = flaggedJobNum();
    const name = S.db.prepare('SELECT employee_name FROM labor_details WHERE job_num = ? AND employee_name <> \'\' LIMIT 1').get(jn).employee_name;
    const adminPage = await S.admin.get(`/jobs/${jn}`);
    const revPage = await S.reviewer.get(`/jobs/${jn}`);
    assert.ok(adminPage.body.includes(name), 'admin sees operator');
    assert.ok(!revPage.body.includes(name), 'reviewer does not');
    assert.ok(revPage.body.includes('Admin only'));
    assert.ok(!revPage.body.includes('LaborRate') && !adminPage.body.includes('laborRate'), 'pay rates never shown');
  });

  test('printable report never includes employee names', async () => {
    const jn = flaggedJobNum();
    const name = S.db.prepare('SELECT employee_name FROM labor_details WHERE job_num = ? AND employee_name <> \'\' LIMIT 1').get(jn).employee_name;
    const r = await S.admin.get(`/jobs/${jn}/report`);
    ok(r, 'report');
    assert.ok(!r.body.includes(name));
  });

  test('settings and users are Admin only', async () => {
    for (const url of ['/settings']) {
      assert.equal((await S.reviewer.get(url)).statusCode, 403, url);
      assert.equal((await S.admin.get(url)).statusCode, 200, url);
    }
    assert.equal((await S.reviewer.post('/settings/thresholds', { greenPct: 5, yellowPct: 10, minHours: 1, minDollars: 1, syncWindowMonths: 12 })).statusCode, 403);
    assert.equal((await S.reviewer.post('/settings/users', { username: 'sneaky', displayName: 'x', password: 'password123', role: 'admin' })).statusCode, 403);
    assert.equal(S.db.prepare("SELECT COUNT(*) n FROM users WHERE username = 'sneaky'").get().n, 0);
    assert.equal((await S.reviewer.post('/settings/test-connection')).statusCode, 403);
  });

  test('the nav hides Settings from reviewers', async () => {
    assert.ok(!(await S.reviewer.get('/')).body.includes('href="/settings"'));
    assert.ok((await S.admin.get('/')).body.includes('href="/settings"'));
  });
});

describe('post-mortem workflow', () => {
  let jn;
  let pmId;
  before(() => {
    jn = flaggedJobNum();
  });

  test('start a post-mortem: freezes a snapshot and shows it as Under Review', async () => {
    const r = await S.reviewer.post(`/jobs/${jn}/postmortem`);
    assert.equal(r.statusCode, 302);
    pmId = Number(/\/postmortems\/(\d+)/.exec(r.headers.location)[1]);
    const row = S.db.prepare('SELECT * FROM post_mortems WHERE id = ?').get(pmId);
    assert.equal(row.status, 'under_review');
    assert.equal(row.job_num, jn);
    const snap = JSON.parse(row.snapshot_json);
    assert.equal(snap.job.jobNum, jn);
    assert.ok(snap.ops.length && snap.totals && snap.meta.settings.minDollars === 250);
    const page = await S.reviewer.get(`/postmortems/${pmId}`);
    ok(page, 'pm page');
    assert.match(page.body, /Under Review/);
  });

  test('a second start redirects to the existing post-mortem', async () => {
    const r = await S.admin.post(`/jobs/${jn}/postmortem`);
    assert.equal(r.headers.location, `/postmortems/${pmId}`);
    assert.equal(S.db.prepare('SELECT COUNT(*) n FROM post_mortems WHERE job_num = ?').get(jn).n, 1);
  });

  test('cannot skip ahead without a root cause or actions', async () => {
    const r = await S.reviewer.post(`/postmortems/${pmId}/status`, { status: 'root_cause_found' });
    assert.equal(r.statusCode, 400);
    assert.match(r.body, /at least one root cause/);
  });

  test('pick multiple root causes, add a note with author and time, owner and review date', async () => {
    const ids = S.db.prepare('SELECT id FROM root_causes ORDER BY sort_order LIMIT 2').all().map((x) => x.id);
    const r = await S.reviewer.req('POST', `/postmortems/${pmId}/causes`, { form: { _csrf: S.reviewer.csrf, cause: ids.map(String) } });
    assert.equal(r.statusCode, 302);
    assert.equal(S.db.prepare('SELECT COUNT(*) n FROM post_mortem_root_causes WHERE post_mortem_id = ?').get(pmId).n, 2);
    await S.reviewer.post(`/postmortems/${pmId}/notes`, { body: 'Weld fixture was missing, operators improvised.' });
    const note = S.db.prepare('SELECT n.*, u.display_name FROM pm_notes n JOIN users u ON u.id = n.author_id WHERE post_mortem_id = ?').get(pmId);
    assert.equal(note.display_name, 'Ray Reviewer');
    assert.ok(note.created_at);
    const adminId = S.db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
    await S.reviewer.post(`/postmortems/${pmId}/details`, { owner: String(adminId), reviewDate: '2026-12-01' });
    const pm = S.db.prepare('SELECT * FROM post_mortems WHERE id = ?').get(pmId);
    assert.equal(pm.owner_user_id, adminId);
    assert.equal(pm.review_date, '2026-12-01');
    const page = await S.reviewer.get(`/postmortems/${pmId}`);
    assert.match(page.body, /Weld fixture was missing/);
    assert.match(page.body, /Ray Reviewer/);
  });

  test('move through the workflow: Root Cause Found -> Actions Assigned -> Closed', async () => {
    assert.equal((await S.reviewer.post(`/postmortems/${pmId}/status`, { status: 'root_cause_found' })).statusCode, 302);
    assert.equal(S.db.prepare('SELECT status FROM post_mortems WHERE id = ?').get(pmId).status, 'root_cause_found');
    const noAction = await S.reviewer.post(`/postmortems/${pmId}/status`, { status: 'actions_assigned' });
    assert.equal(noAction.statusCode, 400);
    await S.reviewer.post(`/postmortems/${pmId}/actions`, { description: 'Build a weld fixture for this part', owner: '', due: '2026-12-15' });
    assert.equal((await S.reviewer.post(`/postmortems/${pmId}/status`, { status: 'actions_assigned' })).statusCode, 302);
    const blocked = await S.reviewer.post(`/postmortems/${pmId}/status`, { status: 'closed' });
    assert.equal(blocked.statusCode, 400);
    assert.match(blocked.body, /open action item/);
    const actionId = S.db.prepare('SELECT id FROM action_items WHERE post_mortem_id = ?').get(pmId).id;
    await S.reviewer.post(`/actions/${actionId}/status`, { status: 'done', back: `/postmortems/${pmId}` });
    assert.equal((await S.reviewer.post(`/postmortems/${pmId}/status`, { status: 'closed' })).statusCode, 302);
    const pm = S.db.prepare('SELECT * FROM post_mortems WHERE id = ?').get(pmId);
    assert.equal(pm.status, 'closed');
    assert.ok(pm.closed_at);
  });

  test('closed review can be reopened', async () => {
    await S.reviewer.post(`/postmortems/${pmId}/status`, { status: 'under_review' });
    const pm = S.db.prepare('SELECT * FROM post_mortems WHERE id = ?').get(pmId);
    assert.equal(pm.status, 'under_review');
    assert.equal(pm.closed_at, null);
  });

  test('Open Actions page lists actions across jobs with overdue marking', async () => {
    const r2 = flaggedJobNum2(jn);
    await S.reviewer.post(`/jobs/${r2}/postmortem`);
    const id2 = S.db.prepare('SELECT id FROM post_mortems WHERE job_num = ?').get(r2).id;
    await S.reviewer.post(`/postmortems/${id2}/actions`, { description: 'Overdue thing', owner: '', due: '2020-01-01' });
    const page = await S.reviewer.get('/actions');
    ok(page, 'actions');
    assert.match(page.body, /Overdue thing/);
    assert.match(page.body, /overdue/);
    const overdue = await S.reviewer.get('/actions?status=overdue');
    assert.match(overdue.body, /Overdue thing/);
    assert.ok(!overdue.body.includes('Build a weld fixture'), 'completed action is not overdue/open');
  });

  test('dismissing a job needs a reason and keeps a snapshot', async () => {
    const r3 = flaggedJobNum2(jn, 1);
    const bad = await S.reviewer.post(`/jobs/${r3}/dismiss`, { reason: '' });
    assert.equal(bad.statusCode, 400);
    const good = await S.reviewer.post(`/jobs/${r3}/dismiss`, { reason: 'data entry error' });
    assert.equal(good.statusCode, 302);
    const pm = S.db.prepare('SELECT * FROM post_mortems WHERE job_num = ?').get(r3);
    assert.equal(pm.status, 'dismissed');
    assert.equal(pm.dismiss_reason, 'data entry error');
    assert.ok(JSON.parse(pm.snapshot_json).totals);
  });

  test('post-mortem list and dashboard counts reflect open reviews', async () => {
    const list = await S.reviewer.get('/postmortems');
    ok(list, 'pm list');
    assert.match(list.body, new RegExp(jn));
    const dash = await S.reviewer.get('/?from=2000-01-01&to=2999-01-01');
    const open = S.db.prepare("SELECT COUNT(*) n FROM post_mortems WHERE status IN ('under_review','root_cause_found','actions_assigned')").get().n;
    assert.match(dash.body, new RegExp(`<div class="label">Open post-mortems</div>\\s*<div class="value">${open}</div>`));
  });

  test('snapshot is frozen; a warning appears when live data changes; retaking clears it', async () => {
    const before = JSON.parse(S.db.prepare('SELECT snapshot_json FROM post_mortems WHERE id = ?').get(pmId).snapshot_json);
    assert.ok(!(await S.reviewer.get(`/postmortems/${pmId}`)).body.includes('Epicor data has changed'));
    S.source.simulateChanges([jn], 4);
    const { runSync } = await import('../src/sync/sync.js');
    await runSync({ db: S.db, source: S.source, kind: 'full', logger: { info() {}, warn() {}, error() {} } });
    const page = await S.reviewer.get(`/postmortems/${pmId}`);
    assert.match(page.body, /Epicor data has changed since this snapshot/);
    assert.match(page.body, /Labour actual hours/);
    assert.match((await S.reviewer.get(`/jobs/${jn}`)).body, /Live data has changed since/);
    const after = JSON.parse(S.db.prepare('SELECT snapshot_json FROM post_mortems WHERE id = ?').get(pmId).snapshot_json);
    assert.deepEqual(after, before, 'the stored snapshot did not change');
    assert.match((await S.reviewer.get('/postmortems')).body, /data changed/);

    await S.reviewer.post(`/postmortems/${pmId}/resnapshot`);
    assert.ok(!(await S.reviewer.get(`/postmortems/${pmId}`)).body.includes('Epicor data has changed'));
    assert.ok(S.db.prepare('SELECT COUNT(*) n FROM pm_notes WHERE post_mortem_id = ? AND body LIKE ?').get(pmId, 'Snapshot retaken%').n === 1);
  });

  test('printable report uses the snapshot and includes causes and actions', async () => {
    const r = await S.reviewer.get(`/jobs/${jn}/report`);
    ok(r, 'report');
    for (const t of ['Post-mortem report', 'Root causes', 'Action items', 'Estimated vs actual hours by operation', 'Print / Save as PDF', 'Weld fixture was missing']) assert.ok(r.body.includes(t), t);
  });
});

function flaggedJobNum2(not, skip = 0) {
  const taken = S.db.prepare('SELECT job_num FROM post_mortems').all().map((x) => x.job_num);
  const rows = S.db
    .prepare("SELECT j.job_num FROM jobs j JOIN job_metrics m ON m.job_num = j.job_num WHERE j.closed = 1 AND m.flag IN ('red','yellow') AND j.order_num IS NOT NULL ORDER BY m.impact_dollars DESC")
    .all()
    .map((x) => x.job_num)
    .filter((x) => x !== not && !taken.includes(x));
  return rows[skip];
}

describe('settings', () => {
  test('changing thresholds re-checks every job', async () => {
    const before = S.db.prepare("SELECT COUNT(*) n FROM job_metrics WHERE flag <> 'green'").get().n;
    const r = await S.admin.post('/settings/thresholds', { greenPct: 2, yellowPct: 5, minHours: 0.5, minDollars: 25, syncWindowMonths: 12, normalizeMaterialByQty: 'on', excludeNonOrderJobs: 'on' });
    assert.equal(r.statusCode, 302);
    const tight = S.db.prepare("SELECT COUNT(*) n FROM job_metrics WHERE flag <> 'green'").get().n;
    assert.ok(tight > before, `${tight} > ${before}`);
    await S.admin.post('/settings/thresholds', { greenPct: 10, yellowPct: 25, minHours: 2, minDollars: 250, syncWindowMonths: 12, normalizeMaterialByQty: 'on', excludeNonOrderJobs: 'on' });
    assert.equal(S.db.prepare("SELECT COUNT(*) n FROM job_metrics WHERE flag <> 'green'").get().n, before);
  });

  test('rejects nonsense thresholds', async () => {
    const r = await S.admin.post('/settings/thresholds', { greenPct: 30, yellowPct: 10, minHours: 2, minDollars: 250, syncWindowMonths: 12 });
    assert.equal(r.statusCode, 400);
    assert.match(r.body, /lower than the yellow/);
  });

  test('per op code override can be added and removed', async () => {
    await S.admin.post('/settings/overrides', { scope: 'op_code', value: 'WELD', greenPct: 5, yellowPct: 10 });
    const row = S.db.prepare("SELECT * FROM threshold_overrides WHERE scope_value = 'WELD'").get();
    assert.equal(row.green_max, 0.05);
    await S.admin.post(`/settings/overrides/${row.id}/delete`);
    assert.equal(S.db.prepare('SELECT COUNT(*) n FROM threshold_overrides').get().n, 0);
  });

  test('rate overrides change dollar impact', async () => {
    const before = S.db.prepare('SELECT impact_dollars FROM job_metrics ORDER BY impact_dollars DESC LIMIT 1').get().impact_dollars;
    await S.admin.post('/settings/rates', { setLab__WELD1: '200', prodLab__WELD1: '200', setBur__WELD1: '0', prodBur__WELD1: '0' });
    const after = S.db.prepare('SELECT impact_dollars FROM job_metrics ORDER BY impact_dollars DESC LIMIT 1').get().impact_dollars;
    assert.notEqual(after, before);
    await S.admin.post('/settings/rates', { setLab__WELD1: '', prodLab__WELD1: '', setBur__WELD1: '', prodBur__WELD1: '' });
    assert.equal(S.db.prepare('SELECT COUNT(*) n FROM rate_overrides').get().n, 0);
    assert.equal(S.db.prepare('SELECT impact_dollars FROM job_metrics ORDER BY impact_dollars DESC LIMIT 1').get().impact_dollars, before);
  });

  test('root causes can be added, renamed and hidden', async () => {
    await S.admin.post('/settings/causes', { name: 'Supplier late' });
    const c = S.db.prepare("SELECT * FROM root_causes WHERE name = 'Supplier late'").get();
    assert.equal(c.active, 1);
    await S.admin.post(`/settings/causes/${c.id}`, { name: 'Supplier delivered late' });
    assert.equal(S.db.prepare('SELECT active, name FROM root_causes WHERE id = ?').get(c.id).active, 0, 'unchecked = hidden');
    assert.equal(S.db.prepare('SELECT name FROM root_causes WHERE id = ?').get(c.id).name, 'Supplier delivered late');
    assert.equal((await S.admin.post('/settings/causes', { name: 'supplier delivered late' })).statusCode, 400, 'no duplicates');
  });

  test('users: add, change role, reset password, and the last Admin is protected', async () => {
    await S.admin.post('/settings/users', { username: 'newbie', displayName: 'New Person', password: 'newbie-pass-1', role: 'reviewer' });
    const u = S.db.prepare("SELECT * FROM users WHERE username = 'newbie'").get();
    assert.equal(u.role, 'reviewer');
    await S.admin.post(`/settings/users/${u.id}/password`, { password: 'another-pass-22' });
    const { Client } = await import('./helpers.js');
    const c = new Client(S.app);
    await c.login('newbie', 'another-pass-22');
    assert.equal((await c.get('/settings')).statusCode, 403);
    const adminId = S.db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
    const demote = await S.admin.post(`/settings/users/${adminId}`, { role: 'reviewer', active: 'on', displayName: 'Ada' });
    assert.equal(demote.statusCode, 400);
    assert.match(demote.body, /at least one active Admin/);
    const self = await S.admin.post(`/settings/users/${adminId}`, { role: 'admin', displayName: 'Ada' });
    assert.equal(self.statusCode, 400);
  });

  test('test connection in demo mode says no connection is attempted and shows no credentials', async () => {
    const r = await S.admin.post('/settings/test-connection');
    assert.equal(r.statusCode, 302);
    assert.match(decodeURIComponent(r.headers.location), /Mock data mode is ON/);
  });

  test('settings page never contains credential values', async () => {
    const page = await S.admin.get('/settings');
    ok(page, 'settings');
    assert.ok(!/EPICOR_API_KEY=|EPICOR_PASSWORD=/.test(page.body));
  });

  test('Sync now runs in the background and is logged; a reviewer can press it too', async () => {
    const before = S.db.prepare('SELECT COUNT(*) n FROM sync_log').get().n;
    const r = await S.reviewer.post('/sync', { back: '/' });
    assert.equal(r.statusCode, 302);
    await S.app.ctx.sync.promise;
    assert.equal(S.db.prepare('SELECT COUNT(*) n FROM sync_log').get().n, before + 1);
    assert.equal(S.db.prepare('SELECT status FROM sync_log ORDER BY id DESC LIMIT 1').get().status, 'ok');
  });

  test('full re-sync is Admin only', async () => {
    assert.equal((await S.reviewer.post('/settings/sync-full', {})).statusCode, 403);
    const r = await S.admin.post('/settings/sync-full', {});
    assert.equal(r.statusCode, 302);
    await S.app.ctx.sync.promise;
    assert.equal(S.db.prepare('SELECT kind FROM sync_log ORDER BY id DESC LIMIT 1').get().kind, 'full');
  });
});
