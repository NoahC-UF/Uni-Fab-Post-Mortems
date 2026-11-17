import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSession } from './helpers.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('Settings page layout', () => {
  let S;
  let page;
  before(async () => {
    S = await makeSession();
    page = (await S.admin.get('/settings')).body;
  });

  test('has a jump menu on the left, and every link in it goes to a section on the page', () => {
    const nav = /<nav class="settings-nav[^>]*id="settingsNav"[\s\S]*?<\/nav>/.exec(page)?.[0];
    assert.ok(nav, 'the menu is there');
    const hrefs = [...nav.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    assert.ok(hrefs.length >= 9, 'one link per section');
    for (const id of hrefs) assert.ok(new RegExp(`id="${id}"`).test(page), `#${id} exists on the page`);
    for (const id of ['sync-card', 'appearance', 'table-appearance', 'thresholds', 'rates', 'causes', 'users']) assert.ok(hrefs.includes(id), `${id} is in the menu`);
    assert.ok(page.indexOf('class="settings-nav') < page.indexOf('id="sync-card"'), 'the menu comes before the sections (it sits to their left)');
    assert.match(page, /\/static\/settings-nav\.js/);
  });

  test('Recent Syncs is a fold that starts closed', async () => {
    // the demo data has a sync log once something has synced
    const withLog = (await S.admin.get('/settings')).body;
    const m = /<details class="fold" id="recent-syncs"([^>]*)>/.exec(withLog);
    assert.ok(m, 'Recent Syncs is a details element');
    assert.ok(!/\bopen\b/.test(m[1]), 'closed to begin with');
    assert.match(withLog, /<summary>Recent Syncs/);
    assert.match(withLog, /<table data-table="settings" class="t" data-help-scope="sync">/, 'the log is inside it');
    assert.ok(withLog.indexOf('id="recent-syncs"') < withLog.indexOf('data-help-scope="sync"'));
  });

  test('without any syncs there is no empty fold, and the menu script hides that link', async () => {
    S.db.prepare('DELETE FROM sync_log').run();
    const empty = (await S.admin.get('/settings')).body;
    assert.ok(!empty.includes('id="recent-syncs"'));
    const js = fs.readFileSync(path.join(root, 'public', 'settings-nav.js'), 'utf8');
    assert.match(js, /a\.hidden = !el/);
  });

  test('buttons, tick boxes and fields in a row are lined up on their middles', () => {
    const css = fs.readFileSync(path.join(root, 'public', 'app.css'), 'utf8');
    assert.match(css, /\.settings-main \.form-inline \{[^}]*align-items: center/);
    assert.match(css, /\.settings-main \.form-inline > label:not\(\.check\) \{[^}]*align-items: center/);
    assert.match(css, /\.settings-main table\.t td \{ vertical-align: middle/);
    assert.match(css, /\.settings-nav \{[^}]*position: sticky/);
  });

  test('the sync panel still refreshes itself while a sync runs, so the fold must survive it', () => {
    const js = fs.readFileSync(path.join(root, 'public', 'settings-nav.js'), 'utf8');
    assert.match(js, /htmx:afterSettle/);
    assert.match(js, /recent-syncs/);
  });
});
