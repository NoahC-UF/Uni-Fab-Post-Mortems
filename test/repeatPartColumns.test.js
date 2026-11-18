import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { parseAccuracyFilters, customersPage, customerDetail } from '../src/accuracy.js';
import { makeSession } from './helpers.js';

const NOW = new Date('2026-06-15T12:00:00Z');
const F = (over = {}) => ({ ...parseAccuracyFilters({ from: '2000-01-01', to: '2999-01-01', internal: '1', minJobs: '1' }, NOW, {}), tier: '', mgr: '', ...over });
const q = 'from=2000-01-01&to=2999-01-01&minJobs=1';

describe("a customer's Repeat Part Numbers: Total Qty, Labour Var $, Material Var $ and a link to the part's jobs", () => {
  let S;
  let key;
  let jobs;
  before(async () => {
    S = await makeSession();
    key = customersPage(S.db, F()).all.sort((a, b) => b.jobs - a.jobs)[0].key;
    // the demo data has no repeat parts, so make one: RP-COLS on four jobs, off by a lot on each
    jobs = S.db.prepare("SELECT DISTINCT j.job_num FROM jobs j JOIN line_results l ON l.job_num = j.job_num WHERE j.cust_id = ? AND j.closed = 1 AND l.counted = 1 AND l.est_dollars > 0 ORDER BY j.job_num").all(key).map((r) => r.job_num).slice(0, 4);
    assert.equal(jobs.length, 4, 'the customer has four jobs with estimated lines');
    jobs.forEach((job, i) => {
      S.db.prepare('UPDATE jobs SET part_num = ?, qty_completed = ? WHERE job_num = ?').run('RP-COLS', 10 * (i + 1), job);
      const line = S.db.prepare("SELECT rowid AS id FROM line_results WHERE job_num = ? AND counted = 1 AND est_dollars > 0 ORDER BY rowid LIMIT 1").get(job).id;
      S.db.prepare('UPDATE line_results SET act_dollars = act_dollars + 50000, var_dollars = var_dollars + 50000 WHERE rowid = ?').run(line);
      S.db.prepare("UPDATE job_metrics SET actual_cost = actual_cost + 50000, computed_at = '9999-12-31T23:59:59.999Z' WHERE job_num = ?").run(job);
    });
  });
  const detail = () => customerDetail(S.db, F(), key);

  test('the part carries the pieces made and the labour and material variance, added up over its jobs', () => {
    const p = detail().repeatParts.find((x) => x.part === 'RP-COLS');
    assert.ok(p, 'RP-COLS is a repeat part');
    assert.equal(p.jobs, 4);
    assert.equal(p.qty, 10 + 20 + 30 + 40);
    const mine = detail().jobs.filter((j) => jobs.includes(j.job));
    assert.equal(mine.length, 4);
    const sum = (k) => Math.round(mine.reduce((t, j) => t + j[k], 0) * 100) / 100;
    assert.equal(p.labour, sum('labour'));
    assert.equal(p.material, sum('material'));
  });

  test('the table shows the columns in order, with a narrower description column', async () => {
    const body = (await S.admin.get(`/accuracy/customers/${encodeURIComponent(key)}?${q}`)).body;
    const at = body.indexOf('id="sec-repeat"');
    const head = body.slice(at, body.indexOf('</thead>', at));
    const names = [...head.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    assert.deepEqual(names, ['Part', 'Jobs', 'Jobs Off', 'Total Qty', 'Labour Var $', 'Material Var $', 'Net Var $', 'Avg Var %']);
    assert.ok(head.includes('acc-descol-repeat'));
    const fs = await import('node:fs');
    const css = fs.readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');
    const w = /th\.acc-descol-repeat \{ width: (\d+)%; \}/.exec(css);
    assert.ok(w && Number(w[1]) < 62, 'less than the 62% the other wide description tables get');
  });

  test("the part number links to the Flagged Jobs page for that part, this customer and these dates, showing all its jobs", async () => {
    const body = (await S.admin.get(`/accuracy/customers/${encodeURIComponent(key)}?${q}`)).body;
    const m = /<a href="(\/jobs\?[^"]*part=RP-COLS)"/.exec(body);
    assert.ok(m, 'the part number is a link');
    const href = m[1].replace(/&amp;/g, '&');
    assert.ok(href.includes(`cust=${encodeURIComponent(key)}`) && href.includes('from=2000-01-01') && href.includes('to=2999-01-01') && href.includes('flag=all'));
    const page = (await S.admin.get(href)).body;
    // the job list's rows are sent to the grid as data, the job number in quotes
    for (const job of jobs) assert.ok(page.includes(`"${job}"`), `${job} is listed`);
    const other = S.db.prepare("SELECT job_num FROM jobs WHERE cust_id = ? AND part_num != 'RP-COLS' LIMIT 1").get(key).job_num;
    assert.ok(!page.includes(`"${other}"`), 'and a job of another part is not');
  });
});
