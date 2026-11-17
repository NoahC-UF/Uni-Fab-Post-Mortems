import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMarginBands, normaliseBands, bandFor, bandStyle, bandLegend, pointsFromTarget, textOn, MAX_BANDS, NO_BANDS } from '../src/marginBands.js';
import { getSettings } from '../src/settings.js';
import { applyCustomers } from '../src/customerOrg.js';
import { customersPage, parseAccuracyFilters } from '../src/accuracy.js';
import { makeSession } from './helpers.js';

// thresholds are points from the customer's own target: under 10 = red, under 5 = orange, under 0 (below target) = yellow, at or above target = green
const CFG = { bands: [{ below: -10, color: '#c62828' }, { below: -5, color: '#ef6c00' }, { below: 0, color: '#f9a825' }], top: '#2e7d32' };
const F = (over = {}) => ({ ...parseAccuracyFilters({ from: '2000-01-01', to: '2999-01-01', internal: '1', minJobs: '1' }, new Date('2026-06-15T12:00:00Z'), {}), ...over });
const FORM = { greenPct: 10, yellowPct: 25, minHours: 2, minDollars: 250, syncWindowMonths: 12, normalizeMaterialByQty: 'on', excludeNonOrderJobs: 'on', targetMarginPct: 20 };

describe('how far a margin is from its target', () => {
  test('in percentage points, as shown on screen', () => {
    assert.equal(pointsFromTarget(0.25, 0.45), -20);
    assert.equal(pointsFromTarget(0.25, 0.2), 5);
    assert.equal(pointsFromTarget(0.45, 0.45), 0);
    assert.equal(pointsFromTarget(0.15, 0.2), -5, 'no floating point noise: 15% against 20% is exactly 5 under');
    assert.equal(pointsFromTarget(0.1496, 0.2), -5, '14.96% shows as 15.0%');
    assert.equal(pointsFromTarget(-0.252, 0.45), -70.2);
    assert.equal(pointsFromTarget(null, 0.2), null);
    assert.equal(pointsFromTarget(0.2, null), null);
    assert.equal(pointsFromTarget(0.2, undefined), null);
    assert.equal(pointsFromTarget(NaN, 0.2), null);
  });
});

describe('which colour a margin gets', () => {
  test('the same margin gets a different colour for a Tier A and a Tier D customer', () => {
    assert.equal(bandFor(CFG, 0.25, 0.45), '#c62828', '25% against a 45% target is 20 points under: red');
    assert.equal(bandFor(CFG, 0.25, 0.2), '#2e7d32', '25% against a 20% target is 5 over: green');
    assert.equal(bandStyle(CFG, 0.25, 0.45), 'background:#c62828;color:#ffffff');
    assert.equal(bandStyle(CFG, 0.25, 0.2), 'background:#2e7d32;color:#ffffff');
  });

  test('the colour of the lowest threshold the difference is below; at or above them all gets the "at or better" colour', () => {
    const t = 0.3;
    assert.equal(bandFor(CFG, 0.1, t), '#c62828', '20 under');
    assert.equal(bandFor(CFG, 0.22, t), '#ef6c00', '8 under');
    assert.equal(bandFor(CFG, 0.27, t), '#f9a825', '3 under');
    assert.equal(bandFor(CFG, 0.3, t), '#2e7d32', 'on target');
    assert.equal(bandFor(CFG, 0.5, t), '#2e7d32', 'well over');
  });

  test('a difference exactly on a threshold is not below it', () => {
    assert.equal(bandFor(CFG, 0.2, 0.3), '#ef6c00', 'exactly 10 under is not below -10');
    assert.equal(bandFor(CFG, 0.25, 0.3), '#f9a825', 'exactly 5 under is not below -5');
    assert.equal(bandFor(CFG, 0.3, 0.3), '#2e7d32', 'exactly on target is not below 0');
  });

  test('a threshold above zero colours margins that beat the target by less than that', () => {
    const cfg = { bands: [{ below: 0, color: '#c62828' }, { below: 5, color: '#f9a825' }], top: '#2e7d32' };
    assert.equal(bandFor(cfg, 0.32, 0.3), '#f9a825', '2 over target, under the 5 mark');
    assert.equal(bandFor(cfg, 0.36, 0.3), '#2e7d32');
  });

  test('no colour: no bands, no "at or better" colour, or no margin or target', () => {
    assert.equal(bandFor(NO_BANDS, 0.2, 0.3), null);
    assert.equal(bandFor(undefined, 0.2, 0.3), null);
    assert.equal(bandFor({ bands: CFG.bands, top: null }, 0.5, 0.3), null);
    assert.equal(bandFor(CFG, null, 0.3), null);
    assert.equal(bandFor(CFG, 0.2, null), null, 'no target to compare with');
    assert.equal(bandStyle(NO_BANDS, 0.2, 0.3), '');
  });

  test('the text colour is the one that can be read on the background', () => {
    assert.equal(bandStyle(CFG, 0.27, 0.3), 'background:#f9a825;color:#111111');
    assert.equal(textOn('#ffffff'), '#111111');
    assert.equal(textOn('#000000'), '#ffffff');
  });

  test('a legend lists the bands in order', () => {
    assert.deepEqual(bandLegend(CFG).map((l) => l.label), ['Below 10 points under target', 'Below 5 points under target', 'Below target', 'target or better']);
    assert.deepEqual(bandLegend(NO_BANDS), []);
  });
});

describe('the Settings form', () => {
  test('rows are sorted lowest first; blank rows are ignored; the "at or better" colour is only kept when ticked', () => {
    const got = parseMarginBands({ bandBelow: ['0', '', '-10', '-5'], bandColor: ['#F9A825', '#000000', '#c62828', '#ef6c00'], bandTopOn: 'on', bandTopColor: '#2E7D32' });
    assert.deepEqual(got, CFG, 'capitals in a colour are tidied');
    assert.deepEqual(parseMarginBands({ bandBelow: '-3', bandColor: '#c62828' }), { bands: [{ below: -3, color: '#c62828' }], top: null }, 'one row arrives as a single value');
    assert.deepEqual(parseMarginBands({ bandBelow: ['-3'], bandColor: ['#c62828'], bandTopColor: '#2e7d32' }), { bands: [{ below: -3, color: '#c62828' }], top: null }, 'unticked: no "at or better" colour');
    assert.deepEqual(parseMarginBands({}), NO_BANDS, 'nothing = the standard colouring');
  });

  test('bad input is refused with a plain message', () => {
    assert.throws(() => parseMarginBands({ bandBelow: ['abc'], bandColor: ['#c62828'] }), /not a number of percentage points/);
    assert.throws(() => parseMarginBands({ bandBelow: ['500'], bandColor: ['#c62828'] }), /not a number of percentage points/);
    assert.throws(() => parseMarginBands({ bandBelow: ['-101'], bandColor: ['#c62828'] }), /not a number of percentage points/);
    assert.throws(() => parseMarginBands({ bandBelow: ['-5'], bandColor: ['red'] }), /Choose a colour/);
    assert.throws(() => parseMarginBands({ bandBelow: ['-5'], bandColor: ['red;background:url(x)'] }), /Choose a colour/, 'a colour must be a plain #rrggbb value');
    assert.throws(() => parseMarginBands({ bandBelow: ['-5', '-5'], bandColor: ['#c62828', '#ef6c00'] }), /used once/);
    assert.throws(() => parseMarginBands({ bandBelow: ['-5'], bandColor: ['#c62828'], bandTopOn: 'on', bandTopColor: 'nope' }), /at or above the highest threshold/);
    const many = Array.from({ length: MAX_BANDS + 1 }, (_, i) => String(-i));
    assert.throws(() => parseMarginBands({ bandBelow: many, bandColor: many.map(() => '#c62828') }), /at most/);
  });

  test('whatever is stored is cleaned before it is used', () => {
    assert.deepEqual(normaliseBands(undefined), NO_BANDS);
    assert.deepEqual(normaliseBands({ bands: [{ below: 20, color: '#AABBCC' }, { below: 'x', color: '#000000' }, { below: 5, color: 'javascript:1' }, { below: '', color: '#000000' }, { below: -10, color: '#112233' }], top: 'bad' }),
      { bands: [{ below: -10, color: '#112233' }, { below: 20, color: '#aabbcc' }], top: null });
  });
});

describe('Margin % Colours in the app', () => {
  let S;
  const PAGE = '/accuracy/customers?minJobs=1&from=2000-01-01&to=2999-01-01&lists=v';
  before(async () => { S = await makeSession(); });

  test('Settings has the section, explains it is against each customer\'s own target, and saving keeps the thresholds', async () => {
    const page = (await S.admin.get('/settings')).body;
    assert.ok(page.includes('id="margin-colours"') && page.includes('Margin % Colours') && page.includes('href="#margin-colours"'));
    assert.ok(page.includes('its own target') && page.includes('/static/margin-bands.js'));
    const r = await S.admin.post('/settings/margin-bands', { bandBelow: ['-10', '-5', '0'], bandColor: ['#c62828', '#ef6c00', '#f9a825'], bandTopOn: 'on', bandTopColor: '#2e7d32' });
    assert.equal(r.statusCode, 302);
    assert.deepEqual(getSettings(S.db).marginBandsVsTarget, CFG);
    const again = (await S.admin.get('/settings')).body;
    assert.match(again, /marginBandsForm\(\{"bands":\[\{"below":-10,"color":"#c62828"\}/, 'the saved rows are put back in the form');
  });

  test('only an admin can change them; a refused form changes nothing', async () => {
    assert.equal((await S.reviewer.post('/settings/margin-bands', { bandBelow: ['-5'], bandColor: ['#000000'] })).statusCode, 403);
    const bad = await S.admin.post('/settings/margin-bands', { bandBelow: ['-5'], bandColor: ['blue'] });
    assert.equal(bad.statusCode, 400);
    assert.deepEqual(getSettings(S.db).marginBandsVsTarget, CFG);
  });

  test('each customer is coloured by how far it is from its own tier\'s target', async () => {
    const names = S.db.prepare("SELECT DISTINCT j.cust_name AS n FROM jobs j JOIN job_metrics m ON m.job_num = j.job_num WHERE j.closed = 1 AND m.price > 0 AND j.cust_name <> '' ORDER BY j.cust_name").all().map((r) => r.n).filter((n) => /^[A-Za-z0-9 ]+$/.test(n));
    assert.ok(names.length >= 3);
    applyCustomers(S.db, [{ name: names[0], tier: 'A', managers: '' }, { name: names[1], tier: 'D', managers: '' }], 'replace', '2026-01-01T00:00:00Z');
    assert.equal((await S.admin.post('/settings/thresholds', { ...FORM, targetMargin_A: 60, targetMargin_D: 10 })).statusCode, 302);
    const d = customersPage(S.db, F());
    const body = (await S.admin.get(PAGE)).body;
    for (const [name, target] of [[names[0], 0.6], [names[1], 0.1]]) {
      const g = d.all.find((x) => x.label === name);
      assert.equal(g.target, target);
      const at = body.indexOf(`<b>${name}</b></a>`);
      assert.ok(at > 0, `${name} is on the page`);
      const row = body.slice(at, body.indexOf('</tr>', at));
      const expected = bandStyle(CFG, g.marginPct, g.target);
      assert.ok(expected, `${name} has a colour`);
      assert.ok(row.includes(`<span class="band" style="${expected}"`), `${name}: ${g.marginPct} against ${target} is coloured ${expected}`);
      const diff = pointsFromTarget(g.marginPct, g.target);
      assert.ok(row.includes(`${Math.abs(diff)} points ${diff < 0 ? 'under' : 'over'} target`), `${name}: the hover says how far from target`);
    }
  });

  test('the job tables are given the same bands', async () => {
    const dash = (await S.admin.get('/?from=2000-01-01&to=2999-01-01')).body;
    assert.ok(dash.includes('"marginBands":{"bands":[{"below":-10,"color":"#c62828"}'), 'the Dashboard table gets the bands');
    const jobs = (await S.admin.get('/jobs?from=2000-01-01&to=2999-01-01')).body;
    assert.ok(jobs.includes('"marginBands":{"bands":[{"below":-10,"color":"#c62828"}'), 'Flagged Jobs gets the bands');
  });

  test('the browser-built tables use the same rules as the server', () => {
    const src = readFileSync(new URL('../public/job-columns.js', import.meta.url), 'utf8');
    assert.ok(src.includes('Math.round(Number(v) * 1000) / 10 - Math.round(Number(t) * 1000) / 10') && src.includes('diff < b.below') && src.includes('lum > 0.4'), 'same rounding, same "below" rule, same text-colour choice');
  });

  test('clearing the list brings back the standard colouring', async () => {
    const r = await S.admin.post('/settings/margin-bands', {});
    assert.equal(r.statusCode, 302);
    assert.deepEqual(getSettings(S.db).marginBandsVsTarget, NO_BANDS);
    const body = (await S.admin.get(PAGE)).body;
    assert.ok(!body.includes('<span class="band"'), 'no coloured pills');
    assert.match(body, /class="(?:neg-good|neg-bad|)"[^>]*title="Planned margin was/);
  });
});
