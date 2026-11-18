import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { parseAccuracyFilters, customersPage } from '../src/accuracy.js';
import { makeSession } from './helpers.js';

const F = (over = {}) => ({ ...parseAccuracyFilters({ from: '2000-01-01', to: '2999-01-01', internal: '1', minJobs: '1' }, new Date('2026-06-15T12:00:00Z'), {}, { customers: true }), ...over });
const q = 'from=2000-01-01&to=2999-01-01&minJobs=1';
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

describe('the six cards on the Customers page: the figures', () => {
  let S;
  let d;
  before(async () => { S = await makeSession(); d = customersPage(S.db, F()); });

  test('customers priced, under target, and at a loss are counted from the customer rows', () => {
    const sold = d.all.filter((g) => g.margin !== null && g.price > 0);
    const s = d.shop;
    assert.equal(s.pricedCustomers, sold.length);
    assert.ok(s.pricedCustomers > 0);
    assert.equal(s.underTarget, sold.filter((g) => g.vsTarget < 0).length);
    const losing = sold.filter((g) => g.margin < 0);
    assert.equal(s.lossCustomers, losing.length);
    assert.equal(s.lossDollars, r2(losing.reduce((t, g) => t + g.margin, 0)));
    assert.ok(s.lossDollars <= 0, 'what was lost is a negative number');
    assert.ok(s.underTarget <= s.pricedCustomers && s.lossCustomers <= s.pricedCustomers);
  });

  test('Margin vs Target $ for the shop is the customers\' added up', () => {
    const sold = d.all.filter((g) => g.margin !== null && g.price > 0);
    assert.equal(d.shop.vsTarget, r2(sold.reduce((t, g) => t + g.vsTarget, 0)));
  });

  test('labour + material + other = net variance, for the shop as for each customer', () => {
    const s = d.shop;
    assert.ok(Math.abs(s.labourDollars + s.materialDollars + s.otherDollars - s.netDollars) < 0.011);
    assert.equal(s.labourDollars, r2(d.all.reduce((t, g) => t + g.labourDollars, 0)));
  });

  test('a filter changes the cards: only the ticked tier\'s customers are counted', () => {
    const none = customersPage(S.db, F({ tier: 'Z' }));
    assert.equal(none.shop.pricedCustomers, 0);
    assert.equal(none.shop.lossCustomers, 0);
  });
});

describe('the six cards on the Customers page: what is on screen', () => {
  let S;
  let body;
  const tiles = (b) => {
    const out = {};
    for (const m of b.matchAll(/<div class="tile ([^"]*)">(?:<div class="tile-short"[^>]*>.*?<\/div>)?<div class="label">([^<]*)<\/div><div class="value">([^<]*)<\/div><div class="sub">(.*?)<\/div><\/div>/gs)) out[m[2]] = { cls: m[1].trim(), value: m[3], sub: m[4] };
    return out;
  };
  before(async () => { S = await makeSession(); body = (await S.admin.get(`/accuracy/customers?${q}`)).body; });

  test('Sold, Margin, Margin vs Target $, Customers at a Loss, Net Variance and Customer-Level Accuracy, in that order', () => {
    const t = tiles(body);
    assert.deepEqual(Object.keys(t), ['Sold', 'Margin', 'Margin vs Target $', 'Customers at a Loss', 'Net Variance', 'Customer-Level Accuracy']);
    assert.ok(!body.includes('Customers With Jobs') && !('Needs Attention' in tiles(body)), 'the two old cards are gone');
    assert.ok(body.includes('class="tiles tiles-6"'));
  });

  test('the figures shown are the ones worked out', () => {
    const d = customersPage(S.db, F({ internal: false }));
    const t = tiles(body);
    const money = (n) => `$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
    assert.equal(t.Sold.value, money(d.shop.price));
    assert.ok(t.Sold.sub.includes(`${d.customers} customers`) && t.Sold.sub.includes(`${d.jobCount} jobs`));
    assert.equal(t.Margin.value, `${Math.round(d.shop.marginPct * 1000) / 10}%`);
    assert.ok(t.Margin.sub.includes('% target'));
    assert.match(t['Margin vs Target $'].value, /^[+-]?\$[\d,]+$/);
    assert.equal(t['Margin vs Target $'].value.replace('−', '-').replace(/[+$,]/g, ''), (d.shop.vsTarget < 0 ? '-' : '') + Math.abs(Math.round(d.shop.vsTarget)));
    assert.ok(t['Margin vs Target $'].sub.includes(`${d.shop.underTarget} of ${d.shop.pricedCustomers} customers under target`));
    assert.ok(t['Customers at a Loss'].sub.includes(`${d.shop.lossCustomers} of ${d.shop.pricedCustomers} customers lost money`));
    assert.ok(t['Net Variance'].sub.includes('labour ') && t['Net Variance'].sub.includes('material ') && t['Net Variance'].sub.includes('other ') && t['Net Variance'].sub.includes('gross '));
  });

  test('colours: red = a shortfall, a loss or an overrun; green = on or over target; yellow = below target', () => {
    const d = customersPage(S.db, F({ internal: false }));
    const t = tiles(body);
    const s = d.shop;
    assert.equal(/\bt-(red|green|yellow|blue)\b/.exec(t.Margin.cls)[1], s.marginPct < 0 ? 'red' : s.marginPct >= s.targetMargin ? 'green' : 'yellow');
    assert.equal(/\bt-(red|green)\b/.exec(t['Margin vs Target $'].cls)[1], s.vsTarget < 0 ? 'red' : 'green');
    assert.equal(/\bt-(red|green)\b/.exec(t['Customers at a Loss'].cls)[1], s.lossCustomers ? 'red' : 'green');
    assert.equal(/\bt-(red|blue)\b/.exec(t['Net Variance'].cls)[1], s.netDollars > 0 ? 'red' : 'blue');
    assert.equal(/\bt-(green|yellow)\b/.exec(t['Customer-Level Accuracy'].cls)[1], s.accuracy >= 0.8 ? 'green' : 'yellow');
    assert.match(t.Sold.cls, /t-blue/, 'Sold is just information');
  });

  test('with nothing priced the cards say so instead of showing zeros', async () => {
    const empty = (await S.admin.get(`/accuracy/customers?${q}&tier=Z`)).body;
    const t = tiles(empty);
    assert.equal(t.Sold.value, 'n/a');
    assert.equal(t['Margin vs Target $'].value, 'n/a');
    assert.equal(t['Customers at a Loss'].value, 'n/a');
  });
});

describe('every card is two lines', () => {
  let S;
  before(async () => { S = await makeSession(); });

  test('each card has exactly two lines of small print, and the Net Variance split is in short amounts', async () => {
    const body = (await S.admin.get(`/accuracy/customers?${q}`)).body;
    const subs = [...body.matchAll(/<div class="tile [^"]*">(?:<div class="tile-short"[^>]*>.*?<\/div>)?<div class="label">([^<]*)<\/div><div class="value">[^<]*<\/div><div class="sub">(.*?)<\/div><\/div>/gs)];
    assert.equal(subs.length, 6);
    for (const m of subs) assert.equal(m[2].split('<br>').length, 2, `${m[1]}: two lines`);
    const net = subs.find((m) => m[1] === 'Net Variance')[2].split('<br>')[1];
    assert.match(net, /^labour [+-]?\$[\d.]+[kM]? &middot; material [+-]?\$[\d.]+[kM]? &middot; other [+-]?\$[\d.]+[kM]?$/, net);
    assert.ok(net.replace(/&middot;/g, '·').length <= 44, `short enough for the card: ${net.replace(/&middot;/g, '·').length} characters`);
  });

  test('the card CSS keeps each line on one line (a long one ends in ...)', async () => {
    const css = (await S.admin.get('/static/app.css')).body;
    assert.match(css, /\.tiles\.tiles-6 \.tile \.sub \{[^}]*white-space: nowrap[^}]*text-overflow: ellipsis/);
  });
});
