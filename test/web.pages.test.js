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
    for (const t of ['Jobs reviewed', 'Within tolerance', 'Total $ over', 'Total $ under', 'Open post-mortems', 'Top 10 Biggest $ Misses']) assert.ok(r.body.includes(t), t);
    assert.match(r.body, /id="byOpData"/);
  });

  test('dashboard defaults to the last 90 days', async () => {
    const r = await S.admin.get('/');
    ok(r, 'dashboard default');
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
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
    for (const t of ['Operations', 'Materials', 'Estimated vs Actual Hours by Operation', 'Setup est', 'Hrs/pc', 'Usage $', 'Cost basis $', 'Start post-mortem']) assert.ok(r.body.includes(t), t);
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
    for (const t of ['Post-Mortem Report', 'Root Causes', 'Action Items', 'Estimated vs Actual Hours by Operation', 'Print / Save as PDF', 'Weld fixture was missing']) assert.ok(r.body.includes(t), t);
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

  test('appearance: dark Uni-Fab Default out of the box; Admin can switch theme and mode for everyone', async () => {
    const first = await S.admin.get('/');
    assert.match(first.body, /<html[^>]*data-theme="unifab"[^>]*data-mode="dark"/);
    assert.match(first.body, /\/static\/logo-white\.png/, 'logo in the top bar');

    assert.equal((await S.reviewer.post('/settings/appearance', { uiTheme: 'original', uiMode: 'light' })).statusCode, 403);
    assert.equal((await S.admin.post('/settings/appearance', { uiTheme: 'neon', uiMode: 'light' })).statusCode, 400);
    assert.equal((await S.admin.post('/settings/appearance', { uiTheme: 'original', uiMode: 'sepia' })).statusCode, 400);

    assert.equal((await S.admin.post('/settings/appearance', { uiTheme: 'original', uiMode: 'light' })).statusCode, 302);
    const changed = await S.reviewer.get('/');
    assert.match(changed.body, /<html[^>]*data-theme="original"[^>]*data-mode="light"/, 'everyone gets the new default');
    const page = await S.admin.get('/settings');
    assert.match(page.body, /Uni-Fab Default/);
    assert.match(page.body, /value="original" checked/);

    await S.admin.post('/settings/appearance', { uiTheme: 'unifab', uiMode: 'system' });
    assert.match((await S.admin.get('/')).body, /data-default-mode="system"/);
    await S.admin.post('/settings/appearance', { uiTheme: 'unifab', uiMode: 'dark' });
  });

  test('dashboard Top 10 can show both (default), only over-runs, or only under-runs', async () => {
    const { dashboardData, parseFilters } = await import('../src/queries.js');
    const now = new Date();
    const f = parseFilters({ from: '2000-01-01', to: '2100-01-01' }, now, 30);
    const both = dashboardData(S.db, f, now);
    const over = dashboardData(S.db, f, now, 'over');
    const under = dashboardData(S.db, f, now, 'under');
    assert.ok(both.top.length > 0 && over.top.length > 0 && under.top.length > 0, 'demo data has both kinds');
    assert.ok(both.top.every((r) => r.shown_dollars === r.impact_dollars), 'both: ranked by total impact');
    assert.ok(over.top.every((r) => r.over_dollars > 0 && r.shown_dollars === r.over_dollars));
    assert.ok(under.top.every((r) => r.under_dollars > 0 && r.shown_dollars === r.under_dollars));
    for (const list of [over.top, under.top]) assert.deepEqual(list.map((r) => r.shown_dollars), list.map((r) => r.shown_dollars).sort((a, b) => b - a), 'biggest first');
    assert.ok(over.top.every((r) => !r.topMiss || r.topMiss.direction === 'over'), 'biggest miss is an over-run');
    assert.ok(under.top.every((r) => !r.topMiss || r.topMiss.direction === 'under'), 'biggest miss is an under-run');
    assert.equal(over.reviewed, both.reviewed, 'tiles are not affected by the Top 10 filter');

    const url = '/?from=2000-01-01&to=2100-01-01';
    assert.match((await S.reviewer.get(url)).body, /Top 10 Biggest \$ Misses/);
    assert.match((await S.reviewer.get(`${url}&dir=over`)).body, /Top 10 Biggest \$ Over-Runs/);
    assert.match((await S.reviewer.get(`${url}&dir=under`)).body, /Top 10 Biggest \$ Under-Runs/);
    assert.match((await S.reviewer.get(`${url}&dir=bogus`)).body, /Top 10 Biggest \$ Misses/, 'unknown value = both');
  });

  test('Flagged Jobs: each person can save which columns they see; it is theirs alone and can be reset', async () => {
    const colPrefs = (body) => JSON.parse(/id="colPrefs">([^<]*)</.exec(body)[1]);
    const jobsUrl = '/jobs?from=2000-01-01&to=2100-01-01';
    assert.equal(colPrefs((await S.admin.get(jobsUrl)).body), null, 'standard columns until they save');

    const post = (client, url, body) =>
      S.app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', 'x-csrf-token': client.csrf, cookie: client.cookie }, payload: JSON.stringify(body) });
    assert.equal((await post(S.admin, '/jobs/columns', { columns: ['job', 'customer', 'impact'] })).statusCode, 200);
    assert.deepEqual(colPrefs((await S.admin.get(jobsUrl)).body).visible, ['job', 'customer', 'impact']);
    assert.equal(colPrefs((await S.reviewer.get(jobsUrl)).body), null, "someone else's choice is not affected");

    assert.equal((await post(S.admin, '/jobs/columns', { columns: [] })).statusCode, 400, 'at least one column');
    assert.equal((await post(S.admin, '/jobs/columns', { columns: ['job', 'passwordHash'] })).statusCode, 400, 'only real columns');
    assert.deepEqual(colPrefs((await S.admin.get(jobsUrl)).body).visible, ['job', 'customer', 'impact'], 'a bad save changes nothing');
    assert.equal((await S.app.inject({ method: 'POST', url: '/jobs/columns', headers: { 'content-type': 'application/json', cookie: S.admin.cookie }, payload: '{"columns":["job"]}' })).statusCode, 403, 'needs the page token');

    assert.equal((await post(S.admin, '/jobs/columns/reset', {})).statusCode, 200);
    assert.equal(colPrefs((await S.admin.get(jobsUrl)).body), null);
  });

  test('printable report includes price and margins; they are frozen with the post-mortem snapshot', async () => {
    const job = S.db
      .prepare(
        `SELECT j.job_num FROM jobs j WHERE j.closed = 1 AND j.order_num IS NOT NULL AND EXISTS (SELECT 1 FROM job_revenue r WHERE r.job_num = j.job_num)
         AND NOT EXISTS (SELECT 1 FROM post_mortems p WHERE p.job_num = j.job_num) LIMIT 1`,
      )
      .get().job_num;
    // before a post-mortem exists the report uses live numbers and already shows the margins
    const live = (await S.reviewer.get(`/jobs/${job}/report`)).body;
    for (const t of ['Price and Margin (CAD)', 'Sale price (CAD)', 'Margin, planned', 'Planned (Job Set-Up)', 'Actual (Final)', 'Total cost', 'Margin (%)']) assert.ok(live.includes(t), t);

    await S.reviewer.post(`/jobs/${job}/postmortem`);
    const price = (html) => /Sale price \(CAD\)<\/span><b>([^<]+)</.exec(html)[1];
    const frozen = price((await S.reviewer.get(`/jobs/${job}/report`)).body);

    S.db.prepare('UPDATE job_revenue SET ext_price = ext_price * 2 WHERE job_num = ?').run(job); // the price changes in Epicor afterwards
    const after = (await S.reviewer.get(`/jobs/${job}/report`)).body;
    assert.equal(price(after), frozen, 'the report keeps the price from the snapshot');
    assert.ok(!after.includes('started before price and margin were tracked'));

    // a post-mortem from before this feature has no frozen figures: today's are shown, and it says so
    const row = S.db.prepare('SELECT id, snapshot_json FROM post_mortems WHERE job_num = ?').get(job);
    const snap = JSON.parse(row.snapshot_json);
    delete snap.economics;
    S.db.prepare('UPDATE post_mortems SET snapshot_json = ? WHERE id = ?').run(JSON.stringify(snap), row.id);
    const legacy = (await S.reviewer.get(`/jobs/${job}/report`)).body;
    assert.ok(legacy.includes('started before price and margin were tracked'));
    assert.notEqual(price(legacy), frozen, "and they are today's figures");

    // a job with no sales order: price n/a, no margin lines, and it says why
    const bare = S.db.prepare('SELECT job_num FROM jobs WHERE order_num IS NULL AND closed = 1 LIMIT 1').get()?.job_num ?? S.db.prepare('SELECT job_num FROM jobs WHERE order_num IS NULL LIMIT 1').get().job_num;
    const none = (await S.reviewer.get(`/jobs/${bare}/report`)).body;
    assert.ok(none.includes('Sale price (CAD)') && none.includes('n/a'));
    assert.ok(!none.includes('Margin, planned') && !none.includes('Margin (%)'));
    assert.ok(none.includes('No sale price is available'));
  });

  test('Flagged Jobs: margin columns, the likely-cause filter, and the Excel export', async () => {
    const url = '/jobs?from=2000-01-01&to=2100-01-01&flag=all';
    const rowsOf = (html) => {
      const m = /id="jobRows">([^<]*)</.exec(html); // no rows = the page shows "No jobs match" instead of the grid
      return m ? JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')) : [];
    };
    const all = rowsOf((await S.reviewer.get(url)).body);
    assert.ok(all.some((r) => r.price > 0 && r.actualMarginPct !== null), 'priced jobs carry their margins');
    // (jobs with no sales order are left out of this list by the default setting, so none show here)

    for (const [cause, label] of [['price-vs-plan', 'Price / Set-Up'], ['overrun', 'Overrun'], ['ok', 'On Target'], ['no-price', 'No Price']]) {
      const rows = rowsOf((await S.reviewer.get(`${url}&cause=${cause}`)).body);
      assert.ok(rows.every((r) => r.cause === cause && r.causeLabel === label), cause);
    }
    const below = rowsOf((await S.reviewer.get(`${url}&cause=below`)).body);
    assert.ok(below.length > 0 && below.every((r) => ['price-vs-plan', 'overrun'].includes(r.cause)));
    assert.equal(rowsOf((await S.reviewer.get(`${url}&cause=bogus`)).body).length, all.length, 'unknown value = no filter');

    const page = (await S.reviewer.get(url)).body;
    assert.ok(page.includes('Likely Cause (Margin)') && page.includes('id="gridMeta"'));
    const js = (await S.reviewer.get('/static/job-columns.js')).body;
    for (const t of ['Sale Price', 'Planned Margin', 'Actual Margin', 'Likely Cause']) assert.ok(js.includes(t), t);
    assert.equal((await S.reviewer.post('/jobs/columns', {})).statusCode, 400, 'sanity: form posts are not column saves');

    const ExcelJS = (await import('exceljs')).default;
    const res = await S.reviewer.get(`/jobs/export.xlsx?from=2000-01-01&to=2100-01-01&flag=all`);
    assert.equal(res.statusCode, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload);
    const ws = wb.getWorksheet('Flagged jobs');
    const headers = ws.getRow(1).values.filter(Boolean);
    for (const h of ['Sale price (CAD)', 'Planned cost', 'Actual cost', 'Planned margin $', 'Actual margin $', 'Planned margin %', 'Actual margin %', 'Likely cause']) assert.ok(headers.includes(h), h);
    const col = (name) => ws.getRow(1).values.findIndex((v) => v === name);
    const priced = [...Array(ws.rowCount - 1).keys()].map((i) => ws.getRow(i + 2)).find((r) => typeof r.getCell(col('Sale price (CAD)')).value === 'number');
    assert.ok(priced, 'a priced job has a number in the price column');
    assert.ok(['Price / Set-Up', 'Overrun', 'On Target'].includes(priced.getCell(col('Likely cause')).value));
  });

  test('job page shows the Price and Margin card; the target margin is a setting', async () => {
    const withOrder = S.db.prepare('SELECT job_num FROM jobs WHERE closed = 1 AND order_num IS NOT NULL LIMIT 1').get().job_num;
    const page = (await S.reviewer.get(`/jobs/${withOrder}`)).body;
    for (const t of ['Price and Margin (CAD)', 'Sale price', 'Planned (Job Set-Up)', 'Actual (Final)', 'Total cost', 'Margin (%)', 'Target margin 20.0%', 'How the price was built']) assert.ok(page.includes(t), t);
    const noOrder = S.db.prepare('SELECT job_num FROM jobs WHERE order_num IS NULL LIMIT 1').get().job_num;
    const bare = (await S.reviewer.get(`/jobs/${noOrder}`)).body;
    assert.ok(bare.includes('No sale price is available'), 'a job with no order says so');
    assert.ok(!bare.includes('Margin (%)'), 'and shows no margin rows');
    const open = S.db.prepare('SELECT job_num FROM jobs WHERE closed = 0 AND order_num IS NOT NULL LIMIT 1').get().job_num;
    assert.ok((await S.reviewer.get(`/jobs/${open}`)).body.includes('Actual (So Far)'));

    const form = { greenPct: 10, yellowPct: 25, minHours: 2, minDollars: 250, syncWindowMonths: 12, normalizeMaterialByQty: 'on', excludeNonOrderJobs: 'on' };
    assert.equal((await S.admin.post('/settings/thresholds', { ...form, targetMarginPct: '150' })).statusCode, 400);
    assert.equal((await S.admin.post('/settings/thresholds', { ...form, targetMarginPct: '30' })).statusCode, 302);
    assert.ok((await S.reviewer.get(`/jobs/${withOrder}`)).body.includes('Target margin 30.0%'));
    assert.equal((await S.admin.post('/settings/thresholds', { ...form, targetMarginPct: '20' })).statusCode, 302);
  });

  test('Op Code and Resource Group filters: "Flagged" is ticked by default; unticked finds any job that has the operation', async () => {
    const rowsOf = (html) => {
      const m = /id="jobRows">([^<]*)</.exec(html);
      return m ? JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')).map((r) => r.job) : [];
    };
    const base = '/jobs?from=2000-01-01&to=2100-01-01&flag=all';
    // an operation that exists on a job but was NOT flagged there
    const pick = S.db
      .prepare(
        `SELECT o.job_num, o.op_code, o.resource_grp_id FROM job_operations o JOIN jobs j ON j.job_num = o.job_num
         WHERE j.closed = 1 AND j.order_num IS NOT NULL AND o.resource_grp_id <> ''
           AND NOT EXISTS (SELECT 1 FROM flag_lines f WHERE f.job_num = o.job_num AND f.op_code = o.op_code)
           AND NOT EXISTS (SELECT 1 FROM flag_lines f WHERE f.job_num = o.job_num AND f.resource_grp_id = o.resource_grp_id) LIMIT 1`,
      )
      .get();
    assert.ok(pick, 'demo data has an operation that was not flagged');
    const op = encodeURIComponent(pick.op_code);
    const rg = encodeURIComponent(pick.resource_grp_id);

    // default (nothing said) and explicitly ticked (the form sends 0 then 1): flagged only, so this job is not there
    assert.ok(!rowsOf((await S.reviewer.get(base + '&op=' + op)).body).includes(pick.job_num));
    assert.ok(!rowsOf((await S.reviewer.get(base + '&op=' + op + '&opFlagged=0&opFlagged=1')).body).includes(pick.job_num));
    // unticked (the form sends just 0): any job with that operation
    const any = rowsOf((await S.reviewer.get(base + '&op=' + op + '&opFlagged=0')).body);
    assert.ok(any.includes(pick.job_num), 'unticked finds the job where the operation was not flagged');
    const flaggedOnly = rowsOf((await S.reviewer.get(base + '&op=' + op)).body);
    assert.ok(any.length > flaggedOnly.length && flaggedOnly.every((j) => any.includes(j)), 'unticked is a superset of ticked');

    // same for resource group, independently
    assert.ok(!rowsOf((await S.reviewer.get(base + '&rg=' + rg)).body).includes(pick.job_num));
    assert.ok(rowsOf((await S.reviewer.get(base + '&rg=' + rg + '&rgFlagged=0')).body).includes(pick.job_num));
    assert.ok(!rowsOf((await S.reviewer.get(base + '&op=' + op + '&opFlagged=0&rg=' + rg)).body).includes(pick.job_num), 'the two ticks are independent');
    assert.ok(rowsOf((await S.reviewer.get(base + '&op=' + op + '&opFlagged=0&rg=' + rg + '&rgFlagged=0')).body).includes(pick.job_num));

    // the page shows two ticked boxes, and remembers an unticked one
    const page = (await S.reviewer.get(base)).body;
    assert.equal((page.match(/name="(op|rg)Flagged" value="1" checked/g) ?? []).length, 2);
    const off = (await S.reviewer.get(base + '&opFlagged=0')).body;
    assert.equal((off.match(/name="(op|rg)Flagged" value="1" checked/g) ?? []).length, 1);
    // the Excel export and Job Study follow the same filter
    const study = await S.reviewer.get('/study?from=2000-01-01&to=2100-01-01&flag=all&op=' + op + '&opFlagged=0');
    assert.equal(study.statusCode, 200);
    assert.ok(study.body.includes('/jobs/' + pick.job_num));
    assert.match((await S.reviewer.get(base + '&op=' + op + '&opFlagged=0')).body, /opFlagged=false/, 'the export and study links carry the choice');
  });

  test('Flagged Jobs: filter buttons read Reset then Apply, and filter labels are in Title Case', async () => {
    const body = (await S.admin.get('/jobs?from=2000-01-01&to=2100-01-01')).body;
    assert.ok(body.indexOf('>Reset<') < body.indexOf('>Apply Filters<'), 'Reset comes first, Apply to its right');
    for (const t of ['Last 30 days', 'Job Status', 'Over / Under', 'Op Code', 'Resource Group', 'Min $ Impact', 'Post-Mortem']) assert.ok(body.includes(t), t);
    const js = await S.admin.get('/static/job-columns.js');
    assert.match(js.body, /flag-dot/, 'the flag column is a dot');
    assert.match(js.body, /'Biggest Miss'/);
  });

  test('a person can pick their own light / dark mode on the Account page; the logo and stylesheet are served', async () => {
    const acct = await S.reviewer.get('/account');
    assert.match(acct.body, /Appearance/);
    assert.match(acct.body, /Use the shop default/);
    const login = await S.anon.get('/login');
    assert.match(login.body, /\/static\/logo\.png/);
    assert.match(login.body, /\/static\/logo-white\.png/);
    for (const f of ['logo.png', 'logo-white.png', 'app.css']) assert.equal((await S.anon.get(`/static/${f}`)).statusCode, 200, f);
  });

  test('automatic sync settings: Admin only, validated, saved, and shown on the page', async () => {
    const form = { autoSyncEnabled: 'on', autoSyncTime: '03:15', autoSyncWeeklyFull: 'on' };
    assert.equal((await S.reviewer.post('/settings/auto-sync', form)).statusCode, 403);
    assert.equal((await S.admin.post('/settings/auto-sync', { ...form, autoSyncTime: '25:00' })).statusCode, 400);
    assert.equal((await S.admin.post('/settings/auto-sync', form)).statusCode, 302);
    const s = Object.fromEntries(S.db.prepare("SELECT key, value FROM settings WHERE key LIKE 'autoSync%'").all().map((r) => [r.key, JSON.parse(r.value)]));
    assert.deepEqual(s, { autoSyncEnabled: true, autoSyncTime: '03:15', autoSyncWeeklyFull: true });
    const page = await S.admin.get('/settings');
    assert.match(page.body, /Automatic Sync/);
    assert.match(page.body, /value="03:15"/);
    await S.admin.post('/settings/auto-sync', { autoSyncTime: '03:15' }); // boxes unticked = off
    assert.equal(JSON.parse(S.db.prepare("SELECT value FROM settings WHERE key = 'autoSyncEnabled'").get().value), false);
  });

  test('full re-sync is Admin only', async () => {
    assert.equal((await S.reviewer.post('/settings/sync-full', {})).statusCode, 403);
    const r = await S.admin.post('/settings/sync-full', {});
    assert.equal(r.statusCode, 302);
    await S.app.ctx.sync.promise;
    assert.equal(S.db.prepare('SELECT kind FROM sync_log ORDER BY id DESC LIMIT 1').get().kind, 'full');
  });
});
