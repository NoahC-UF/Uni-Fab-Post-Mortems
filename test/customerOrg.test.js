import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { nameKey, tidyManagers, parseCsv, parseCustomerFile, applyCustomers, loadCustomerOrg, orgFor, orgSummary, exportWorkbook, exportCsv } from '../src/customerOrg.js';
import { customersPage, parseAccuracyFilters, rankGroups, exportCsv as accuracyCsv, TOP_CUSTOMERS, loadLines, opsAndMaterials, INTERNAL_LABEL, vsTargetOf } from '../src/accuracy.js';
import { makeSession } from './helpers.js';

const NOW = new Date('2026-06-15T12:00:00Z');
const F = (over = {}) => ({ ...parseAccuracyFilters({ from: '2000-01-01', to: '2999-01-01', internal: '1', minJobs: '1' }, NOW, {}), ...over });

/** A workbook shaped like the real one: Name / Level / Account Management in A:C, and a pivot table (with its own "Level" heading) beside it. */
async function sampleWorkbook(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Customer Organization');
  ws.addRow(['Name', 'Level', 'Account Management', null, 'COUNTA of Account Manager', 'Level']);
  rows.forEach((r, i) => ws.addRow(i === 0 ? [...r, null, 'Account Manager', 'A', 'B'] : r));
  wb.addWorksheet('Sales Team').addRow(['Name']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('reading the customer organization file', () => {
  test('names are matched ignoring capitals, extra spaces and curly quotes', () => {
    assert.equal(nameKey('  Uni-Fab Ltd.  (Internal Jobs) '), 'uni-fab ltd. (internal jobs)');
    assert.equal(nameKey("Jose’s Bar and Grill"), "jose's bar and grill");
    assert.equal(nameKey('AVL MANUFACTURING'), nameKey('avl manufacturing'));
  });

  test('managers: split on commas, tidied, XXXXX and blanks mean nobody assigned', () => {
    assert.equal(tidyManagers('Mike Kraynack ,  Nick Iossifidis'), 'Mike Kraynack, Nick Iossifidis');
    assert.equal(tidyManagers('XXXXX'), '');
    assert.equal(tidyManagers(''), '');
    assert.equal(tidyManagers(null), '');
    assert.equal(tidyManagers('Noah; noah ;Tessa'), 'Noah, Tessa', 'repeated names once');
  });

  test('an .xlsx with a pivot table beside the list: only Name, Level and Account Management are read', async () => {
    const buf = await sampleWorkbook([
      ['AVL Manufacturing', 'a', 'Mike Kraynack, Nick Iossifidis'],
      ['Sylvan', 'D', 'Nick Iossifidis'],
      ['GN Corporations Inc.', 'C', 'XXXXX'],
      ['Uni-Fab Ltd.  (Internal Jobs)', 'D', ''],
      ['sylvan', 'B', 'Andy Fehr'],
      [null, null, null],
    ]);
    const { entries, duplicates } = await parseCustomerFile(buf, 'Customer Organization.xlsx');
    assert.equal(duplicates, 1, 'Sylvan twice');
    assert.deepEqual(entries.map((e) => [e.name, e.tier, e.managers]), [
      ['AVL Manufacturing', 'A', 'Mike Kraynack, Nick Iossifidis'],
      ['sylvan', 'B', 'Andy Fehr'], // the last row for a name wins
      ['GN Corporations Inc.', 'C', ''],
      ['Uni-Fab Ltd. (Internal Jobs)', 'D', ''],
    ]);
  });

  test('a CSV works, including quoted names with commas', async () => {
    assert.deepEqual(parseCsv('Name,Level\r\n"Smith, Jones & Co",A\r\n'), [['Name', 'Level'], ['Smith, Jones & Co', 'A']]);
    const { entries } = await parseCustomerFile(Buffer.from('﻿Name,Level,Account Management\r\n"Smith, Jones & Co",b,"Ann Lee, Bo Ng"\r\nPlain Co,NEW,\r\n'), 'x.csv');
    assert.deepEqual(entries, [
      { name: 'Smith, Jones & Co', tier: 'B', managers: 'Ann Lee, Bo Ng' },
      { name: 'Plain Co', tier: 'NEW', managers: '' },
    ]);
  });

  test('a file without the right headings, or not a spreadsheet, gets a clear message', async () => {
    await assert.rejects(parseCustomerFile(Buffer.from('a,b\n1,2\n'), 'x.csv'), /"Name" and "Level"/);
    await assert.rejects(parseCustomerFile(Buffer.from('not a spreadsheet'), 'x.xlsx'), /could not be read/);
    await assert.rejects(parseCustomerFile(Buffer.from('Name,Level\n'), 'x.csv'), /no customers/);
  });
});

describe('the customer list, the Customers page and Settings', () => {
  let S;
  const send = (client, url, body, extra = {}) =>
    S.app.inject({ method: 'POST', url, headers: { cookie: client.cookie, 'x-csrf-token': client.csrf, 'content-type': 'application/octet-stream', ...extra }, payload: body });

  before(async () => {
    S = await makeSession();
  });

  test('replace removes customers that are not in the file; update leaves them alone; counts are right', () => {
    const t = '2026-01-01T00:00:00Z';
    const first = applyCustomers(S.db, [{ name: 'One Co', tier: 'A', managers: 'Ann' }, { name: 'Two Co', tier: 'B', managers: '' }], 'replace', t);
    assert.deepEqual(first, { added: 2, changed: 0, unchanged: 0, removed: 0 });
    const upd = applyCustomers(S.db, [{ name: 'ONE co', tier: 'C', managers: 'Ann' }, { name: 'Three Co', tier: 'D', managers: '' }], 'update', t);
    assert.deepEqual(upd, { added: 1, changed: 1, unchanged: 0, removed: 0 });
    assert.equal(loadCustomerOrg(S.db).size, 3);
    const rep = applyCustomers(S.db, [{ name: 'Three Co', tier: 'D', managers: '' }], 'replace', t);
    assert.deepEqual(rep, { added: 0, changed: 0, unchanged: 1, removed: 2 });
    assert.deepEqual([...loadCustomerOrg(S.db).keys()], ['three co']);
    assert.deepEqual(orgFor(loadCustomerOrg(S.db), { label: 'THREE   Co' }), { listed: true, tier: 'D', managers: '' });
    assert.deepEqual(orgFor(loadCustomerOrg(S.db), { label: 'Nobody' }), { listed: false, tier: '', managers: '' });
  });

  test('Admin can import a workbook; the Customers page then shows each customer\'s tier and account managers', async () => {
    const names = S.db.prepare("SELECT DISTINCT cust_name FROM jobs WHERE cust_name <> '' ORDER BY cust_name").all().map((r) => r.cust_name);
    assert.ok(names.length >= 3);
    const buf = await sampleWorkbook([
      [names[0].toUpperCase(), 'A', 'Mike Kraynack, Nick Iossifidis'],
      [names[1], 'NEW', 'XXXXX'],
      ['A customer with no jobs', 'C', 'Jacob Schmitt'],
    ]);
    const res = await send(S.admin, '/settings/customer-org/import?mode=replace&filename=list.xlsx', buf);
    assert.equal(res.statusCode, 200, res.body);
    assert.match(res.json().message, /3 customers read, 3 added/);

    const d = customersPage(S.db, F());
    const a = d.all.find((g) => g.label === names[0]);
    const b = d.all.find((g) => g.label === names[1]);
    const c = d.all.find((g) => g.label === names[2]);
    assert.deepEqual([a.tier, a.managers, a.listed], ['A', 'Mike Kraynack, Nick Iossifidis', true]);
    assert.deepEqual([b.tier, b.managers, b.listed], ['NEW', '', true]);
    assert.equal(c.listed, false);

    const page = (await S.admin.get('/accuracy/customers?from=2000-01-01&to=2999-01-01&minJobs=1&lists=v')).body;
    assert.ok(page.includes('Mike Kraynack, Nick Iossifidis') && page.includes('Unassigned') && page.includes('<th>Tier</th>') && page.includes('>Manager</th>'));
    assert.ok(accuracyCsv(S.db, F(), 'customers').split('\r\n')[0].startsWith('Customer,Tier,Account Manager,Jobs'));
    const detail = (await S.admin.get(`/accuracy/customers/${encodeURIComponent(a.key)}?from=2000-01-01&to=2999-01-01`)).body;
    assert.ok(detail.includes('Account Manager:') && detail.includes('Mike Kraynack, Nick Iossifidis'));
  });

  test('Settings shows the section, the counts, and who is not on the list', async () => {
    const body = (await S.admin.get('/settings')).body;
    for (const t of ['Customer Tiers and Account Managers', 'id="customer-org"', 'Export Excel', 'Export CSV', 'Customers on the List', 'Customers With Jobs Matched', 'not on the list', '/static/customer-org.js']) assert.ok(body.includes(t), t);
    const s = orgSummary(S.db);
    assert.equal(s.count, 3);
    assert.ok(s.notListedCount > 0 && s.matched === s.jobCustomers - s.notListedCount);
  });

  test('the import is Admin only, needs a real file, and says what is wrong', async () => {
    const buf = await sampleWorkbook([['X Co', 'A', 'Ann']]);
    assert.equal((await send(S.reviewer, '/settings/customer-org/import?filename=a.xlsx', buf)).statusCode, 403);
    assert.ok([302, 401, 403].includes((await send(S.anon, '/settings/customer-org/import?filename=a.xlsx', buf)).statusCode));
    assert.equal((await send(S.admin, '/settings/customer-org/import?filename=a.xlsx', buf, { 'x-csrf-token': 'wrong' })).statusCode, 403, 'needs the page token');
    const wrong = await send(S.admin, '/settings/customer-org/import?filename=a.txt', buf);
    assert.equal(wrong.statusCode, 400);
    assert.match(wrong.json().error, /Excel \(\.xlsx\) or CSV/);
    const junk = await send(S.admin, '/settings/customer-org/import?filename=a.xlsx', Buffer.from('junk'));
    assert.equal(junk.statusCode, 400);
    assert.equal(loadCustomerOrg(S.db).size, 3, 'a bad file changes nothing');
  });

  test('update mode keeps the rest of the list', async () => {
    const buf = await sampleWorkbook([['Brand New Co', 'B', 'Ann Lee']]);
    const res = await send(S.admin, '/settings/customer-org/import?mode=update&filename=more.xlsx', buf);
    assert.equal(res.statusCode, 200);
    assert.equal(loadCustomerOrg(S.db).size, 4);
  });

  test('export gives the same layout back (Excel and CSV), and imports to the same list', async () => {
    const buf = await exportWorkbook(S.db);
    const { entries } = await parseCustomerFile(buf, 'export.xlsx');
    const org = loadCustomerOrg(S.db);
    assert.equal(entries.length, org.size);
    for (const e of entries) assert.deepEqual({ tier: e.tier, managers: e.managers }, { tier: org.get(nameKey(e.name)).tier, managers: org.get(nameKey(e.name)).managers });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    assert.deepEqual(wb.worksheets.map((w) => w.name), ['Customer Organization', 'Not Yet Listed']);
    assert.ok(wb.getWorksheet('Not Yet Listed').rowCount > 1, 'customers with jobs that are not on the list are there to fill in');
    const csv = exportCsv(S.db);
    assert.ok(csv.startsWith('Name,Level,Account Management\r\n'));
    assert.equal((await parseCustomerFile(Buffer.from(csv), 'x.csv')).entries.length, org.size);

    const web = await S.admin.get('/settings/customer-org/export.xlsx');
    assert.equal(web.statusCode, 200);
    assert.match(web.headers['content-disposition'], /customer-organization-.*\.xlsx/);
    assert.equal((await S.admin.get('/settings/customer-org/export.csv')).statusCode, 200);
    assert.equal((await S.reviewer.get('/settings/customer-org/export.csv')).statusCode, 403);
  });

  test('the customer lists are the Top 25 unless the Show filter says otherwise', () => {
    assert.equal(TOP_CUSTOMERS, 25);
    const groups = Array.from({ length: 120 }, (_, i) => ({ key: `C${i}`, label: `C${i}`, kind: 'customer', jobs: 5, netDollars: 100 + i, avgPct: 0.1, pctOff: 0.5, attention: 10 + i, varHrs: 0 }));
    const f = F({ minJobs: 1, sort: 'impact' });
    assert.equal(rankGroups(groups, f, TOP_CUSTOMERS).over.length, 25);
    assert.equal(rankGroups(groups, f).over.length, 10, 'operations and materials stay at 10');
    assert.ok(!(S.admin && false));
  });
});

describe('Tier and Account Manager filters, and the quick date buttons', () => {
  let S;
  let names;
  const q = 'from=2000-01-01&to=2999-01-01&minJobs=1';
  const keysOf = (f) => customersPage(S.db, F({ minJobs: 1, ...f })).all.map((g) => g.label).sort();
  before(async () => {
    S = await makeSession();
    names = S.db.prepare("SELECT DISTINCT cust_name FROM jobs WHERE cust_name <> '' ORDER BY cust_name").all().map((r) => r.cust_name);
    assert.ok(names.length >= 4);
    applyCustomers(S.db, [
      { name: names[0], tier: 'A', managers: 'Ann Lee, Bo Ng' },
      { name: names[1], tier: 'A', managers: 'Bo Ng' },
      { name: names[2], tier: 'B', managers: '' },
    ], 'replace', '2026-01-01T00:00:00Z');
  });

  test('the Customers page can be limited to a tier, an account manager, nobody assigned, or customers not on the list', () => {
    const all = keysOf({});
    assert.ok(all.length > 3);
    assert.deepEqual(keysOf({ tier: 'A' }), [names[0], names[1]].sort());
    assert.deepEqual(keysOf({ tier: 'B' }), [names[2]]);
    assert.deepEqual(keysOf({ mgr: 'Bo Ng' }), [names[0], names[1]].sort());
    assert.deepEqual(keysOf({ mgr: 'ann lee' }), [names[0]], 'a name in a list of several, capitals ignored');
    assert.deepEqual(keysOf({ mgr: '_unassigned' }), [names[2]]);
    assert.deepEqual(keysOf({ tier: 'A', mgr: 'Ann Lee' }), [names[0]], 'both filters together');
    assert.deepEqual(keysOf({ tier: 'B', mgr: 'Ann Lee' }), []);
    const notListed = keysOf({ tier: '_none' });
    assert.equal(notListed.length, all.filter((n) => ![names[0], names[1], names[2]].includes(n) && n !== INTERNAL_LABEL).length);
    assert.ok(!keysOf({ tier: 'A' }).includes(INTERNAL_LABEL), 'Internal / Stock has no customer, so it drops out');
    assert.deepEqual(keysOf({ tier: 'Z' }), []);
  });

  test('the same filter limits Operations & Materials, the lines and the drill-down', () => {
    const all = loadLines(S.db, F({ minJobs: 1 }));
    const a = loadLines(S.db, F({ minJobs: 1, tier: 'A' }));
    assert.ok(a.length > 0 && a.length < all.length);
    const aNames = new Set([names[0], names[1]]);
    assert.ok(a.every((l) => aNames.has(l.cust_name)));
    assert.deepEqual(loadLines(S.db, F({ minJobs: 1, tier: 'Z' })), []);
    const d = opsAndMaterials(S.db, F({ minJobs: 1, tier: 'A' }));
    assert.equal(d.ops.all.reduce((t, g) => t + g.lines, 0) > 0, true);
  });

  test('a new import is seen at once (the filter is not served from an old cache)', () => {
    assert.deepEqual(keysOf({ tier: 'B' }), [names[2]]);
    applyCustomers(S.db, [{ name: names[3], tier: 'B', managers: 'Cy Doe' }], 'update', '2026-02-01T00:00:00Z');
    assert.deepEqual(keysOf({ tier: 'B' }), [names[2], names[3]].sort());
  });

  test('the filters are in the page and the address; both pages have the six date buttons, keeping the other filters', async () => {
    for (const path of ['/accuracy/customers', '/accuracy/ops']) {
      const body = (await S.admin.get(`${path}?${q}&tier=A&mgr=Bo%20Ng`)).body;
      assert.match(body, /<input type="checkbox" name="tier" value="A" x-model="sel" checked>/, path);
      assert.doesNotMatch(body, /name="tier" value="B" x-model="sel" checked>/, path);
      assert.match(body, /<option value="Bo Ng" selected>Bo Ng<\/option>/, path);
      assert.ok(body.includes('Showing only') && body.includes('Show all customers'), path);
      const buttons = [...body.matchAll(/<a class="btn btn-sm[^"]*" href="([^"]+)">(Last 30 days|Last 90 days|This month|Last month|Year to date|Last 12 months)<\/a>/g)];
      assert.deepEqual(buttons.map((m) => m[2]), ['Last 30 days', 'Last 90 days', 'This month', 'Last month', 'Year to date', 'Last 12 months'], path);
      for (const m of buttons) {
        const href = m[1].replace(/&amp;/g, '&');
        assert.ok(href.startsWith(`${path}?`) && href.includes('tier=A') && href.includes('mgr=Bo+Ng') && href.includes('minJobs=1'), `${m[2]} keeps the filters: ${href}`);
      }
    }
    const none = (await S.admin.get(`/accuracy/customers?${q}`)).body;
    assert.ok(!none.includes('Showing only'));
    const dflt = (await S.admin.get('/accuracy/customers')).body;
    assert.match(dflt, /<a class="btn btn-sm btn-primary" href="[^"]+">Last 12 months<\/a>/, 'the default range is the highlighted button');
  });

  test('a date button changes the dates and nothing else', async () => {
    const body = (await S.admin.get(`/accuracy/customers?${q}&tier=A&basis=hours&sort=frequency&lists=v`)).body;
    const href = /href="([^"]+)">This month<\/a>/.exec(body)[1].replace(/&amp;/g, '&');
    const u = new URLSearchParams(href.split('?')[1]);
    assert.notEqual(u.get('from'), '2000-01-01');
    assert.equal(u.get('basis'), 'hours');
    assert.equal(u.get('sort'), 'frequency');
    assert.equal(u.get('lists'), 'v');
    assert.equal(u.get('tier'), 'A');
    const page = await S.admin.get(href);
    assert.equal(page.statusCode, 200);
  });

  test('one customer\'s page has the date buttons but not the tier / account manager filters; the CSV follows the filter', async () => {
    const detail = (await S.admin.get(`/accuracy/customers/${encodeURIComponent(customersPage(S.db, F({ minJobs: 1 })).all.find((g) => g.label === names[0]).key)}?${q}&tier=B`)).body;
    assert.ok(detail.includes('Last 90 days'));
    assert.ok(!detail.includes('<select name="tier">'), 'no tier filter on a single customer');
    assert.ok(detail.includes('Mike') === false);
    const csv = accuracyCsv(S.db, F({ minJobs: 1, tier: 'A' }), 'customers').trimEnd().split('\r\n');
    assert.equal(csv.length - 1, 2);
    const web = (await S.admin.get(`/accuracy/export.csv?${q}&view=customers&tier=A`)).body.trimEnd().split('\r\n');
    assert.equal(web.length - 1, 2);
  });
});

describe('the date controls are the same on the Dashboard, Ops & Materials and Customers', () => {
  test('quick ranges, a | divider, then From / To / Apply; the dates are not repeated in the filter card', async () => {
    const S = await makeSession();
    const shape = (body) => {
      const bar = /(<a class="btn btn-sm[^"]*" href="[^"]+">Last 30 days<\/a>[\s\S]*?Apply<\/button>)/.exec(body)?.[1] ?? '';
      const labels = [...bar.matchAll(/>(Last 30 days|Last 90 days|This month|Last month|Year to date|Last 12 months)<\/a>/g)].map((m) => m[1]);
      return {
        labels,
        divider: /Last 12 months<\/a>\s*<span class="muted">\|<\/span>\s*(<form[^>]*>[\s\S]*?)?<?[^>]*class="date-range"/.test(bar) || /Last 12 months<\/a>\s*<span class="muted">\|<\/span>/.test(bar),
        from: (bar.match(/name="from"/g) ?? []).length,
        to: (bar.match(/name="to"/g) ?? []).length,
        apply: (bar.match(/>Apply<\/button>/g) ?? []).length,
      };
    };
    const pages = { dashboard: '/', ops: '/accuracy/ops', customers: '/accuracy/customers' };
    const shapes = {};
    for (const [name, url] of Object.entries(pages)) {
      const body = (await S.admin.get(url)).body;
      shapes[name] = shape(body);
      assert.deepEqual(shapes[name].labels, ['Last 30 days', 'Last 90 days', 'This month', 'Last month', 'Year to date', 'Last 12 months'], name);
      assert.ok(shapes[name].divider, `${name}: a | between the quick ranges and the dates`);
      assert.deepEqual([shapes[name].from, shapes[name].to, shapes[name].apply], [1, 1, 1], `${name}: one From, one To, one Apply`);
      assert.equal((body.match(/name="from"/g) ?? []).length, 1, `${name}: the dates appear once on the page`);
    }
    assert.deepEqual(shapes.ops, shapes.customers);
    assert.deepEqual(shapes.dashboard, shapes.customers, 'identical on all three pages');
  });

  test('Apply on Ops & Materials and Customers sends the dates together with every filter below it (one form)', async () => {
    const S = await makeSession();
    const body = (await S.admin.get('/accuracy/customers')).body;
    const form = /<form method="get" action="\/accuracy\/customers" class="no-print acc-form">([\s\S]*?)<\/form>/.exec(body)[1];
    for (const n of ['from', 'to', 'tier', 'mgr', 'status', 'basis', 'minJobs', 'sort', 'trend', 'lists']) assert.ok(form.includes(`name="${n}"`), `${n} is in the same form as the dates`);
  });
});

describe('the Customers page is kept compact', () => {
  test('no explanatory paragraph under the title or under the tiles', async () => {
    const S = await makeSession();
    const body = (await S.admin.get('/accuracy/customers')).body;
    assert.ok(!body.includes('acc-note'), 'the long note under the tiles is gone');
    assert.ok(!body.includes("Which customers' jobs, taken as a whole"), 'the paragraph under the title is gone');
    assert.ok(body.includes('<h1 class="acc-title">Post-Mortem Review: Customers</h1>') && body.includes('Customers CSV') && body.includes('class="tiles"'));
  });
});

describe('sorting the customer lists by margin, in either direction', () => {
  let S;
  const F2 = (over = {}) => ({ ...parseAccuracyFilters({ from: '2000-01-01', to: '2999-01-01', internal: '1', minJobs: '1' }, new Date('2026-06-15T12:00:00Z'), {}), ...over });
  before(async () => { S = await makeSession(); });

  const lists = (f) => { const d = customersPage(S.db, F2(f)); return [d.over, d.under]; };
  const nonIncreasing = (rows, key) => {
    const ks = rows.map((g) => g[key]);
    const firstNull = ks.findIndex((k) => k === null);
    assert.ok(firstNull === -1 || ks.slice(firstNull).every((k) => k === null), 'customers with no margin are last');
    const have = ks.filter((k) => k !== null);
    for (let i = 1; i < have.length; i++) assert.ok(have[i - 1] >= have[i], `${key} high to low: ${have}`);
    return have;
  };
  const nonDecreasing = (rows, key) => {
    const ks = rows.map((g) => g[key]);
    const firstNull = ks.findIndex((k) => k === null);
    assert.ok(firstNull === -1 || ks.slice(firstNull).every((k) => k === null), 'customers with no margin are still last when sorting low to high');
    const have = ks.filter((k) => k !== null);
    for (let i = 1; i < have.length; i++) assert.ok(have[i - 1] <= have[i], `${key} low to high: ${have}`);
    return have;
  };

  test('Margin $ and Margin %: high to low by default, low to high on request, customers without a margin last', () => {
    for (const [sort, key] of [['margin', 'margin'], ['marginpct', 'marginPct']]) {
      for (const list of lists({ sort })) nonIncreasing(list, key);
      for (const list of lists({ sort, order: 'asc' })) nonDecreasing(list, key);
    }
    const desc = lists({ sort: 'margin' })[0].map((g) => g.label);
    const asc = lists({ sort: 'margin', order: 'asc' })[0].map((g) => g.label);
    assert.ok(desc.length > 2);
    assert.notDeepEqual(desc, asc);
  });

  test('the order option reverses the other sorts too, and the default is unchanged', () => {
    for (const [sort, key] of [['attention', 'attention'], ['frequency', 'pctOff']]) {
      const [overD] = lists({ sort, order: 'desc' });
      const [overA] = lists({ sort, order: 'asc' });
      const kd = overD.map((g) => g[key]);
      const ka = overA.map((g) => g[key]);
      assert.ok(kd.length > 2, sort);
      for (let i = 1; i < kd.length; i++) assert.ok(kd[i - 1] >= kd[i], `${sort} high to low`);
      for (let i = 1; i < ka.length; i++) assert.ok(ka[i - 1] <= ka[i], `${sort} low to high`);
      assert.deepEqual(lists({ sort })[0].map((g) => g.label), overD.map((g) => g.label), 'no order given = high to low, as before');
    }
  });

  test('the page offers Margin $ / Margin % and a Sort Order; Ops & Materials only the sorts that apply to it', async () => {
    const cust = (await S.admin.get('/accuracy/customers')).body;
    assert.match(cust, /<select name="sort">[\s\S]*<option value="margin" >Margin \$<\/option>[\s\S]*<option value="marginpct" >Margin %<\/option>/);
    assert.match(cust, /<select name="order">\s*<option value="desc" selected>High to Low<\/option>\s*<option value="asc" >Low to High<\/option>/);
    const sel = (await S.admin.get('/accuracy/customers?sort=marginpct&order=asc')).body;
    assert.match(sel, /<option value="marginpct" selected>Margin %<\/option>/);
    assert.match(sel, /<option value="asc" selected>Low to High<\/option>/);

    const ops = (await S.admin.get('/accuracy/ops?sort=margin&order=asc')).body;
    assert.ok(!/<option value="margin"/.test(ops), 'no margin sorts on operations and materials');
    assert.match(ops, /<option value="attention" selected>/, 'a margin sort carried over from Customers falls back to the default');
    assert.match(ops, /<option value="asc" selected>Low to High<\/option>/, 'but the order is kept');
  });

  test('the choice travels in the links (the quick date buttons, the list picker, a customer row)', async () => {
    const body = (await S.admin.get('/accuracy/customers?sort=margin&order=asc&minJobs=1')).body;
    const hrefs = [...body.matchAll(/href="([^"]*\?[^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&')).filter((h) => h.startsWith('/accuracy/customers'));
    assert.ok(hrefs.length > 6);
    for (const h of hrefs.slice(0, 8)) assert.ok(h.includes('sort=margin') && h.includes('order=asc'), h);
    const detail = (await S.admin.get(hrefs.find((h) => /^\/accuracy\/customers\/[^?]+\?/.test(h)))).body;
    assert.match(detail, /<option value="attention" selected>/, 'one customer\'s operation and material lists use the default sort');
    assert.ok(detail.includes('sort=margin&amp;order=asc') || detail.includes('sort=margin&order=asc'), 'the way back to the customers list keeps the margin sort');
  });
});

describe('Margin vs Target $: the number that weighs margin $ and margin % together', () => {
  let S;
  const F3 = (over = {}) => ({ ...parseAccuracyFilters({ from: '2000-01-01', to: '2999-01-01', internal: '1', minJobs: '1' }, new Date('2026-06-15T12:00:00Z'), {}), ...over });
  before(async () => { S = await makeSession(); });

  test('it is Margin $ less target % x Sale Price $, and n/a when nothing is priced', () => {
    const d = customersPage(S.db, F3());
    assert.ok(d.targetMargin > 0);
    let priced = 0;
    for (const g of d.all) {
      if (g.margin === null) { assert.equal(g.vsTarget, null, g.label); continue; }
      priced++;
      assert.ok(Math.abs(g.vsTarget - (g.margin - d.targetMargin * g.price)) < 0.011, g.label);
      // the same thing from the percentages: how many points above / below the target, times the price
      assert.ok(Math.abs(g.vsTarget - (g.marginPct - d.targetMargin) * g.price) < 1 + 0.0001 * g.price, `${g.label}: (margin % - target %) x price (the percentage is stored to 4 decimals)`);
    }
    assert.ok(priced > 0);
  });

  test('it ranks a big customer at a slightly low % above a tiny one at a terrible %, which Margin % alone cannot', () => {
    const t = 0.3;
    const big = { margin: 2_681_751, price: 9_421_167 }; // 28.5%: 145k short
    const tiny = { margin: -2_430, price: 4_889 }; // -49.7%: 3.9k short
    assert.ok(vsTargetOf(big, t) < vsTargetOf(tiny, t), 'the big customer is further below target in dollars');
    assert.ok(big.margin / big.price > tiny.margin / tiny.price, 'although its % is far better');
    assert.ok(big.margin > tiny.margin, 'and its margin $ is far better too');
    assert.equal(vsTargetOf({ margin: null, price: 0 }, t), null);
    assert.equal(vsTargetOf({ margin: 400, price: 1000 }, t), 100, 'above target is positive');
  });

  test('sorting by it, Low to High, lists the customers furthest below target first; no-margin customers last', () => {
    for (const order of ['asc', 'desc']) {
      const d = customersPage(S.db, F3({ sort: 'vstarget', order }));
      for (const list of [d.over, d.under]) {
        const ks = list.map((g) => g.vsTarget);
        const have = ks.filter((k) => k !== null);
        assert.deepEqual(ks.slice(have.length), ks.slice(have.length).map(() => null), 'no-margin customers are last');
        for (let i = 1; i < have.length; i++) assert.ok(order === 'asc' ? have[i - 1] <= have[i] : have[i - 1] >= have[i], `${order}: ${have}`);
      }
    }
  });

  test('the column, its tooltip and the sort choice are on the page; Ops & Materials does not offer it', async () => {
    const body = (await S.admin.get('/accuracy/customers?minJobs=1')).body;
    assert.ok(body.includes('Margin vs Target $'));
    assert.match(body, /<option value="vstarget" >Margin vs Target \$<\/option>/);
    assert.ok(body.includes('dollars short of target') || body.includes('Red = dollars short of target'));
    const ops = (await S.admin.get('/accuracy/ops?sort=vstarget')).body;
    assert.ok(!/<option value="vstarget"/.test(ops));
    assert.match(ops, /<option value="attention" selected>/);
    assert.ok(accuracyCsv(S.db, F3(), 'customers').split('\r\n')[0].includes('Margin vs Target $'));
  });
});
