import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { parseAccuracyFilters, customerDetail, customersPage } from '../src/accuracy.js';
import { makeSession } from './helpers.js';

const F = (over = {}) => ({ ...parseAccuracyFilters({ from: '2000-01-01', to: '2999-01-01', internal: '1', minJobs: '1' }, new Date('2026-06-15T12:00:00Z'), {}, { customers: true }), ...over });
const q = 'from=2000-01-01&to=2999-01-01&minJobs=1';
const sum = (a, k) => a.reduce((t, p) => t + p[k], 0);

describe('the two charts on a customer\'s page: Margin Over Time and Margin vs Target $ Over Time', () => {
  let S;
  let key;
  before(async () => {
    S = await makeSession();
    key = customersPage(S.db, F({ tier: '', mgr: '' })).all.filter((g) => g.pricedJobs > 0).sort((a, b) => b.pricedJobs - a.pricedJobs)[0].key;
  });

  test('one point per month, oldest first, adding up to the Margin card', () => {
    const d = customerDetail(S.db, F({ tier: '', mgr: '' }), key);
    const t = d.marginTrend;
    assert.ok(t.length > 0);
    assert.deepEqual(t.map((p) => p.label), [...t.map((p) => p.label)].sort());
    assert.ok(t.every((p) => /^\d{4}-\d{2}$/.test(p.label) && p.jobs > 0));
    assert.equal(sum(t, 'jobs'), d.summary.pricedJobs);
    assert.ok(Math.abs(sum(t, 'price') - d.summary.price) < 0.05 * t.length);
    assert.ok(Math.abs(sum(t, 'margin') - d.summary.margin) < 0.05 * t.length);
    assert.ok(Math.abs(sum(t, 'vsTarget') - d.summary.vsTarget) < 0.05 * t.length, 'the bars add up to Margin vs Target $');
    for (const p of t) assert.ok(Math.abs(p.marginPct - p.margin / p.price) < 0.0002);
  });

  test('by quarter the points are quarters', () => {
    const d = customerDetail(S.db, F({ tier: '', mgr: '', trend: 'quarter' }), key);
    assert.ok(d.marginTrend.every((p) => /^\d{4}-Q[1-4]$/.test(p.label)));
    assert.equal(sum(d.marginTrend, 'jobs'), d.summary.pricedJobs);
  });

  test('the page has both charts, the target line and no post-mortem card or variance chart', async () => {
    const body = (await S.admin.get(`/accuracy/customers/${encodeURIComponent(key)}?${q}`)).body;
    assert.match(body, /<h2[^>]*>Margin Over Time<\/h2>/);
    assert.match(body, /<h2[^>]*>Margin vs Target \$ Over Time<\/h2>/);
    assert.match(body, /id="marginChart"/);
    assert.match(body, /id="vsTargetChart"/);
    const data = JSON.parse(/<script type="application\/json" id="marginData">(.*?)<\/script>/s.exec(body)[1]);
    assert.ok(data.points.length > 0 && typeof data.target === 'number');
    assert.ok(!body.includes('Post-Mortems for This Customer'));
    assert.ok(!body.includes('Variance % Over Time'));
    assert.ok(!body.includes('id="trendChart"'));
    assert.ok(body.includes('Month</a>') && body.includes('Quarter</a>'));
  });
});
