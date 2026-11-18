import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { parseAccuracyFilters, customersPage, customerDetail, sortByFilters } from '../src/accuracy.js';
import { makeSession } from './helpers.js';

const NOW = new Date('2026-06-15T12:00:00Z');
const F = (over = {}) => ({ ...parseAccuracyFilters({ from: '2000-01-01', to: '2999-01-01', internal: '1', minJobs: '1' }, NOW, {}), ...over });
const q = 'from=2000-01-01&to=2999-01-01&minJobs=1';

describe('sortByFilters: the page\'s Sort Lists By and Sort Order, on the column the table has', () => {
  const rows = () => [{ n: 'a', v: 5 }, { n: 'b', v: -10 }, { n: 'c', v: null }, { n: 'd', v: 20 }, { n: 'e', v: null }];
  const fallback = (a, b) => a.n.localeCompare(b.n);
  const names = (r) => r.map((x) => x.n).join('');

  test('High to Low: the biggest (most over) first; Low to High: the other way; rows with no value are always last', () => {
    assert.equal(names(sortByFilters(rows(), { sort: 'netvar', order: 'desc' }, { netvar: (r) => r.v }, fallback)), 'dabce');
    assert.equal(names(sortByFilters(rows(), { sort: 'netvar', order: 'asc' }, { netvar: (r) => r.v }, fallback)), 'badce');
  });

  test('a sort the table has no column for keeps the table\'s usual order, whichever way the order is set', () => {
    assert.equal(names(sortByFilters(rows(), { sort: 'attention', order: 'asc' }, { netvar: (r) => r.v }, fallback)), 'abcde');
    assert.equal(names(sortByFilters(rows(), { sort: 'attention', order: 'desc' }, { netvar: (r) => r.v }, fallback)), 'abcde');
  });

  test('ties go to the usual order', () => {
    const r = [{ n: 'z', v: 1 }, { n: 'a', v: 1 }, { n: 'm', v: 2 }];
    assert.equal(names(sortByFilters(r, { sort: 'netvar', order: 'desc' }, { netvar: (x) => x.v }, fallback)), 'maz');
  });
});

describe("one customer's All Jobs and Repeat Part Numbers follow the filters", () => {
  let S;
  let key;
  before(async () => {
    S = await makeSession();
    key = customersPage(S.db, F({ tier: '', mgr: '' })).all.sort((a, b) => b.jobs - a.jobs)[0].key;
  });
  const detail = (over) => customerDetail(S.db, F({ tier: '', mgr: '', ...over }), key);
  const sortedBy = (list, get, dir) => list.slice(1).every((x, i) => (dir === 'desc' ? get(list[i]) >= get(x) : get(list[i]) <= get(x)));

  test('All Jobs by Net Var $: the most over the estimate first (High to Low), the most under first (Low to High)', () => {
    const hi = detail({ sort: 'netvar', order: 'desc' }).jobs;
    const lo = detail({ sort: 'netvar', order: 'asc' }).jobs;
    assert.ok(hi.length > 3);
    assert.ok(sortedBy(hi, (j) => j.varD, 'desc'));
    assert.ok(sortedBy(lo, (j) => j.varD, 'asc'));
    assert.deepEqual([...hi.map((j) => j.job)].sort(), [...lo.map((j) => j.job)].sort(), 'the same jobs either way, only the order changes');
    assert.notDeepEqual(hi.map((j) => j.job), lo.map((j) => j.job));
  });

  test('All Jobs by Avg Variance %, and by Impact on the % basis: Var % order; jobs with no estimate last', () => {
    for (const over of [{ sort: 'avg', order: 'desc' }, { sort: 'impact', basis: 'pct', order: 'desc' }]) {
      const jobs = detail(over).jobs;
      const withPct = jobs.filter((j) => j.pct !== null);
      assert.ok(sortedBy(withPct, (j) => j.pct, 'desc'), JSON.stringify(over));
      assert.ok(jobs.slice(withPct.length).every((j) => j.pct === null), 'no estimate = last');
    }
    assert.ok(sortedBy(detail({ sort: 'avg', order: 'asc' }).jobs.filter((j) => j.pct !== null), (j) => j.pct, 'asc'));
    assert.ok(sortedBy(detail({ sort: 'impact', basis: 'dollars', order: 'desc' }).jobs, (j) => j.varD, 'desc'), 'Impact on the $ basis is Var $');
  });

  test('All Jobs by % of Jobs Off: the jobs that were off first (High to Low) or last (Low to High)', () => {
    const hi = detail({ sort: 'frequency', order: 'desc' }).jobs;
    const lo = detail({ sort: 'frequency', order: 'asc' }).jobs;
    assert.ok(sortedBy(hi, (j) => (j.off ? 1 : 0), 'desc'));
    assert.ok(sortedBy(lo, (j) => (j.off ? 1 : 0), 'asc'));
  });

  test('Needs Attention has no column in All Jobs: the usual order (the biggest miss, either way)', () => {
    const a = detail({ sort: 'attention', order: 'desc' }).jobs;
    const b = detail({ sort: 'attention', order: 'asc' }).jobs;
    assert.ok(sortedBy(a, (j) => Math.abs(j.varD), 'desc'));
    assert.deepEqual(a.map((j) => j.job), b.map((j) => j.job));
  });

  test('the page shows the jobs in that order', async () => {
    const body = (await S.admin.get(`/accuracy/customers/${encodeURIComponent(key)}?${q}&sort=netvar&order=asc`)).body;
    const at = body.indexOf('id="sec-jobs"');
    const shown = [...body.slice(at).matchAll(/<td class="nowrap"><a href="\/jobs\/([^"]+)">/g)].map((m) => m[1]);
    const want = detail({ sort: 'netvar', order: 'asc' }).jobs.map((j) => j.job);
    assert.deepEqual(shown, want);
  });

  test('Repeat Part Numbers: ordered by Net Var $, Avg Var % and the share of jobs off; Needs Attention keeps the usual order', () => {
    // the demo data has no repeat parts, so make two: part RP-BIG (off on two jobs, by a lot) and RP-SMALL (off on two jobs, by a little)
    const jobs = S.db.prepare("SELECT DISTINCT j.job_num FROM jobs j JOIN line_results l ON l.job_num = j.job_num WHERE j.cust_id = ? AND j.closed = 1 AND l.counted = 1 AND l.est_dollars > 0 ORDER BY j.job_num").all(key).map((r) => r.job_num);
    assert.ok(jobs.length >= 4, 'the customer has four jobs with estimated lines');
    const bump = (job, part, extra) => {
      S.db.prepare('UPDATE jobs SET part_num = ? WHERE job_num = ?').run(part, job);
      const line = S.db.prepare("SELECT rowid AS id FROM line_results WHERE job_num = ? AND counted = 1 AND est_dollars > 0 ORDER BY rowid LIMIT 1").get(job).id;
      S.db.prepare('UPDATE line_results SET act_dollars = act_dollars + ?, var_dollars = var_dollars + ? WHERE rowid = ?').run(extra, extra, line);
      // a closed job's own variance comes from its stored costs; and the lines are cached by the jobs' computed stamp, so move that on too
      S.db.prepare("UPDATE job_metrics SET actual_cost = actual_cost + ?, computed_at = '9999-12-31T23:59:59.999Z' WHERE job_num = ?").run(extra, job);
    };
    bump(jobs[0], 'RP-BIG', 60000);
    bump(jobs[1], 'RP-BIG', 60000);
    bump(jobs[2], 'RP-SMALL', 9000);
    bump(jobs[3], 'RP-SMALL', 9000);
    // the stored lines are cached by the jobs' computed stamp: move it so they are read again

    const rp = (over) => detail(over).repeatParts;
    const base = rp({ sort: 'netvar', order: 'desc' });
    const big = base.find((x) => x.part === 'RP-BIG');
    const small = base.find((x) => x.part === 'RP-SMALL');
    assert.ok(big && small, 'both are repeat parts now');
    assert.ok(big.varD > small.varD);

    assert.deepEqual(base.map((x) => x.part).filter((x) => x.startsWith('RP-')), ['RP-BIG', 'RP-SMALL'], 'Net Var $, High to Low: the biggest overrun first');
    assert.deepEqual(rp({ sort: 'netvar', order: 'asc' }).map((x) => x.part).filter((x) => x.startsWith('RP-')), ['RP-SMALL', 'RP-BIG'], 'Low to High: the other way');
    assert.ok(sortedBy(rp({ sort: 'netvar', order: 'asc' }), (x) => x.varD, 'asc'));
    assert.ok(sortedBy(rp({ sort: 'avg', order: 'desc' }).filter((x) => x.avgPct !== null), (x) => x.avgPct, 'desc'), 'Avg Variance %');
    assert.ok(sortedBy(rp({ sort: 'avg', order: 'asc' }).filter((x) => x.avgPct !== null), (x) => x.avgPct, 'asc'));
    assert.ok(sortedBy(rp({ sort: 'impact', basis: 'pct', order: 'desc' }).filter((x) => x.avgPct !== null), (x) => x.avgPct, 'desc'), 'Impact on the % basis is Avg Var %');
    assert.ok(sortedBy(rp({ sort: 'impact', basis: 'dollars', order: 'desc' }), (x) => x.varD, 'desc'), 'Impact on the $ basis is Net Var $');
    assert.ok(sortedBy(rp({ sort: 'frequency', order: 'desc' }), (x) => x.off / x.jobs, 'desc'), '% of Jobs Off: the share of this part\'s jobs that were off');
    assert.ok(sortedBy(rp({ sort: 'frequency', order: 'asc' }), (x) => x.off / x.jobs, 'asc'));
    const usual = rp({ sort: 'attention', order: 'desc' });
    assert.ok(sortedBy(usual, (x) => x.off, 'desc'), 'Needs Attention: no column here, the usual order');
    assert.deepEqual(rp({ sort: 'attention', order: 'asc' }).map((x) => x.part), usual.map((x) => x.part));
  });

  test('the page lists them in that order', async () => {
    const part = (body) => [...body.slice(body.indexOf('id="sec-repeat"')).matchAll(/<td><b><a href="[^"]*"[^>]*>(RP-[A-Z]+)<\/a><\/b>/g)].map((m) => m[1]);
    const hi = (await S.admin.get(`/accuracy/customers/${encodeURIComponent(key)}?${q}&sort=netvar&order=desc`)).body;
    const lo = (await S.admin.get(`/accuracy/customers/${encodeURIComponent(key)}?${q}&sort=netvar&order=asc`)).body;
    assert.deepEqual(part(hi), ['RP-BIG', 'RP-SMALL']);
    assert.deepEqual(part(lo), ['RP-SMALL', 'RP-BIG']);
  });
});

describe('the pinned top block has the same room above and below its row', () => {
  test('the block\'s top padding equals the gap under the date row', async () => {
    const fs = await import('node:fs');
    const css = fs.readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');
    const pad = /\.acc-sticky \{[^}]*padding: (\d+)px 0 1px;/.exec(css);
    const gap = /\.acc-sticky\.is-compact \.acc-datebar \{ margin-bottom: (\d+)px; \}/.exec(css);
    assert.ok(pad && gap, 'both are set');
    assert.equal(pad[1], gap[1], 'so the shrunk heading row is centred between the top bar and the filters');
    const full = /\.acc-sticky \.acc-datebar \{ margin: 0 0 (\d+)px;/.exec(css);
    assert.equal(Number(full[1]), Number(pad[1]) + 3, 'at full size 3px more, for the date buttons that hang 3px below the date line');
  });
});
