import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { parseAccuracyFilters, customerDetail, customersPage, customerCards } from '../src/accuracy.js';
import { createPostMortem, setRootCauses, setStatus, listPostMortems } from '../src/postmortems.js';
import { makeSession } from './helpers.js';

const F = (over = {}) => ({ ...parseAccuracyFilters({ from: '2000-01-01', to: '2999-01-01', internal: '1', minJobs: '1' }, new Date('2026-06-15T12:00:00Z'), {}, { customers: true }), ...over });
const q = 'from=2000-01-01&to=2999-01-01&minJobs=1';

/** The cards at the top of a customer's page: label -> { cls, value, sub, title }. */
const tiles = (b) => {
  const out = {};
  for (const m of b.matchAll(/<div class="tile ([^"]*)"(?: title="([^"]*)")?><div class="label">([^<]*)<\/div><div class="value">(.*?)<\/div><div class="sub">(.*?)<\/div><\/div>/gs)) out[m[3]] = { cls: m[1].trim(), title: m[2] ?? '', value: m[4], sub: m[5] };
  return out;
};

describe('the cards on a customer\'s page', () => {
  let S;
  let key;
  let name;
  let jobs;
  let ids; // post-mortem ids: [open older, open newer, closed, dismissed]
  const causeIds = [];
  before(async () => {
    S = await makeSession();
    // a customer with enough closed, priced jobs to hold four post-mortems
    const row = S.db.prepare("SELECT j.cust_id, MAX(j.cust_name) AS n, COUNT(*) AS c FROM jobs j JOIN job_metrics m ON m.job_num = j.job_num WHERE j.closed = 1 AND m.price > 0 AND COALESCE(j.cust_id,'') <> '' GROUP BY j.cust_id HAVING c >= 4 ORDER BY c DESC LIMIT 1").get();
    assert.ok(row, 'demo data has a customer with 4+ priced jobs');
    key = row.cust_id;
    name = row.n;
    jobs = S.db.prepare('SELECT job_num FROM jobs WHERE cust_id = ? AND closed = 1 ORDER BY job_num LIMIT 4').all(key).map((r) => r.job_num);
    const admin = S.db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
    S.db.prepare("INSERT INTO root_causes (name, sort_order) VALUES ('Fixture <b>cause</b> A', 90), ('Fixture cause B', 91)").run();
    for (const n of ['Fixture <b>cause</b> A', 'Fixture cause B']) causeIds.push(S.db.prepare('SELECT id FROM root_causes WHERE name = ?').get(n).id);
    ids = jobs.map((j, i) => createPostMortem(S.db, i === 3 ? { jobNum: j, userId: admin, status: 'dismissed', dismissReason: 'duplicate', now: new Date('2026-05-04T10:00:00Z') } : { jobNum: j, userId: admin, now: new Date(`2026-05-0${i + 1}T10:00:00Z`) }));
    setRootCauses(S.db, ids[0], [causeIds[0], causeIds[1]]);
    setRootCauses(S.db, ids[1], [causeIds[0]]);
    setRootCauses(S.db, ids[2], [causeIds[0]]);
    setStatus(S.db, ids[2], 'closed', { now: new Date('2026-05-10T10:00:00Z') });
    // make "newer" really newer, whatever the clock said when the rows were made
    S.db.prepare("UPDATE post_mortems SET updated_at = '2026-05-20 09:00:00' WHERE id = ?").run(ids[1]);
    S.db.prepare("UPDATE post_mortems SET updated_at = '2026-05-02 09:00:00' WHERE id = ?").run(ids[0]);
  });

  const page = async (extra = '') => (await S.admin.get(`/accuracy/customers/${encodeURIComponent(key)}?${q}${extra}`)).body;

  test('Margin, Margin vs Target $, Labour vs Material, Flagged Jobs, Post-Mortems In Progress, Completed Post-Mortems, Top Root Causes', async () => {
    const t = tiles(await page());
    assert.deepEqual(Object.keys(t), ['Margin', 'Margin vs Target $', 'Labour vs Material', 'Flagged Jobs', 'Post-Mortems In Progress', 'Completed Post-Mortems', 'Top Root Causes']);
  });

  test('the Margin card is one line: the margin on what it sold for; the rest is in the tooltip', async () => {
    const d = customerDetail(S.db, F({ tier: '', mgr: '' }), key);
    const t = tiles(await page()).Margin;
    assert.ok(!t.sub.includes('<br>'), 'one line');
    assert.match(t.sub, /^[+-]\$[\d,]+ on \$[\d,]+ sold$/);
    assert.ok(!/priced job|unpriced|vs the/.test(t.sub));
    assert.ok(t.title.includes('priced job'), 'priced jobs are in the tooltip');
    assert.equal(t.value, `${Math.round(d.summary.marginPct * 1000) / 10}%`);
  });

  test('Margin vs Target $ shows the dollars against this customer\'s own target', async () => {
    const d = customerDetail(S.db, F({ tier: '', mgr: '' }), key);
    const t = tiles(await page())['Margin vs Target $'];
    assert.equal(t.value.replace(/[+$,]/g, ''), String(Math.round(d.summary.vsTarget)));
    assert.match(t.sub, /pts (under|over) the [\d.]+% (tier \w+ )?target/);
    assert.match(t.cls, d.summary.vsTarget < 0 ? /t-red/ : /t-green/);
  });

  test('Flagged Jobs: how many of how many, split red and yellow, with a link to the list', async () => {
    const d = customerDetail(S.db, F({ tier: '', mgr: '' }), key);
    const k = d.cards.flagged;
    assert.equal(k.jobs, d.jobCount);
    assert.equal(k.flagged, k.red + k.yellow);
    const t = tiles(await page())['Flagged Jobs'];
    assert.equal(t.value, String(k.flagged));
    assert.ok(t.sub.includes(`of ${k.jobs} jobs &middot; ${k.red} red &middot; ${k.yellow} yellow`));
    assert.ok(t.sub.includes(`href="/jobs?cust=${encodeURIComponent(key)}&amp;from=2000-01-01&amp;to=2999-01-01"`));
  });

  test('In Progress: the count, the most recently updated one to open, and See all', async () => {
    const t = tiles(await page())['Post-Mortems In Progress'];
    assert.equal(t.value, '2');
    assert.ok(t.sub.includes(`<a href="/postmortems/${ids[1]}">${jobs[1]}</a> &middot; Under Review`), 'the newer of the two open ones');
    assert.ok(!t.sub.includes(`/postmortems/${ids[0]}"`));
    assert.ok(t.sub.includes(`href="/postmortems?status=open&amp;cust=${encodeURIComponent(key)}">See all 2`));
  });

  test('Completed: closed and dismissed count; the latest one to open; See all', async () => {
    const t = tiles(await page())['Completed Post-Mortems'];
    assert.equal(t.value, '2');
    assert.ok(t.sub.includes(`<a href="/postmortems/${ids[3]}">${jobs[3]}</a> &middot; Dismissed`) || t.sub.includes(`<a href="/postmortems/${ids[2]}">${jobs[2]}</a> &middot; Closed`));
    assert.ok(t.sub.includes(`href="/postmortems?status=done&amp;cust=${encodeURIComponent(key)}">See all 2`));
  });

  test('Top Root Causes: the most picked first, then the next; names are escaped', async () => {
    const body = await page();
    const t = tiles(body)['Top Root Causes'];
    // cause A is picked on 3 post-mortems (0, 1, 2), cause B on 1
    assert.ok(t.value.includes('Fixture &lt;b&gt;cause&lt;/b&gt; A'), 'the name is escaped, never markup');
    assert.ok(!body.includes('Fixture <b>cause</b> A'));
    assert.ok(t.sub.startsWith('3 post-mortems'));
    assert.ok(t.sub.includes('then Fixture cause B (1)'));
  });

  test('the post-mortem cards do not depend on the dates (an open review is open whatever the dates say); Flagged Jobs does', () => {
    const noJobsInRange = customerCards(S.db, key, []);
    assert.equal(noJobsInRange.open.count, 2);
    assert.equal(noJobsInRange.done.count, 2);
    assert.equal(noJobsInRange.causes[0].n, 3);
    assert.deepEqual(noJobsInRange.flagged, { jobs: 0, flagged: 0, red: 0, yellow: 0 });
  });

  test('a customer with no post-mortems says so', async () => {
    const other = S.db.prepare("SELECT j.cust_id FROM jobs j WHERE COALESCE(j.cust_id,'') <> '' AND j.cust_id <> ? AND j.closed = 1 AND NOT EXISTS (SELECT 1 FROM post_mortems pm JOIN jobs j2 ON j2.job_num = pm.job_num WHERE j2.cust_id = j.cust_id) LIMIT 1").get(key);
    assert.ok(other, 'another customer without post-mortems');
    const body = (await S.admin.get(`/accuracy/customers/${encodeURIComponent(other.cust_id)}?${q}`)).body;
    const t = tiles(body);
    assert.equal(t['Post-Mortems In Progress'].value, '0');
    assert.ok(t['Post-Mortems In Progress'].sub.includes('none open'));
    assert.equal(t['Completed Post-Mortems'].value, '0');
    assert.equal(t['Top Root Causes'].value, 'None yet');
  });

  test('every card has two lines of small print at most, so they can share one height', async () => {
    const t = tiles(await page());
    for (const [label, v] of Object.entries(t)) assert.ok(v.sub.split('<br>').length <= 2, `${label}: ${v.sub}`);
    assert.match(await page(), /class="tiles tiles-7"/);
  });

  test('See all opens the post-mortem list for this customer only', async () => {
    const all = listPostMortems(S.db, {});
    const mine = listPostMortems(S.db, { cust: key });
    assert.ok(mine.length === 4 && all.length >= 4);
    assert.ok(mine.every((r) => r.cust_name === name));
    assert.equal(listPostMortems(S.db, { cust: key, status: 'open' }).length, 2);
    assert.equal(listPostMortems(S.db, { cust: key, status: 'done' }).length, 2);
    assert.equal(listPostMortems(S.db, { cust: 'no-such-customer' }).length, 0);

    const body = (await S.admin.get(`/postmortems?status=all&cust=${encodeURIComponent(key)}`)).body;
    assert.ok(body.includes(`Post-Mortems: ${name}`) && body.includes('Show all customers'));
    for (const j of jobs) assert.ok(body.includes(`<b>${j}</b>`), j);
    assert.ok(body.includes(`<input type="hidden" name="cust" value="${key}">`), 'changing the Show or Owner box keeps the customer');
    const everyone = (await S.admin.get('/postmortems?status=all')).body;
    assert.ok(!everyone.includes('Show all customers'));
  });

  test('the customers table and cards on the Customers page are not affected', async () => {
    const body = (await S.admin.get(`/accuracy/customers?${q}`)).body;
    assert.ok(body.includes('class="tiles tiles-6"'));
    assert.ok(customersPage(S.db, F()).all.length > 0);
  });
});
