import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { cleanRoot, cleanFolder, validJob, drawingsFor } from '../src/drawings.js';
import { getSettings, DEFAULT_SETTINGS } from '../src/settings.js';
import { makeSession } from './helpers.js';

// the page writes a backslash as &#92; inside an attribute (the browser reads it back as a backslash)
const copyOf = (html) => /data-copy="([^"]*)"/.exec(html)?.[1].replace(/&#92;/g, '\\');

describe("where a job's drawings are", () => {
  test('the defaults are the shared drive and the PDF PRINTS folder', () => {
    assert.equal(DEFAULT_SETTINGS.drawingsRoot, 'G:\\');
    assert.equal(DEFAULT_SETTINGS.drawingsFolder, '003 - PDF PRINTS');
    assert.equal(drawingsFor(DEFAULT_SETTINGS, '092115-1-1').path, 'G:\\092115-1-1\\003 - PDF PRINTS');
  });

  test('the drive may be G:, G:\\ or a network share; anything else is refused', () => {
    assert.equal(cleanRoot('G:'), 'G:\\');
    assert.equal(cleanRoot(' g:\\ '), 'g:\\');
    assert.equal(cleanRoot('\\\\files\\jobs'), '\\\\files\\jobs\\');
    for (const bad of ['', 'G:\\Jobs', 'G', '/mnt/g', 'C:\\Windows\\..', '\\\\files', 'http://x', 'G:\\;calc', null]) assert.equal(cleanRoot(bad), null, String(bad));
  });

  test('the folder is one plain name, or empty for the job folder itself; anything that could climb out is refused', () => {
    assert.equal(cleanFolder('003 - PDF PRINTS'), '003 - PDF PRINTS');
    assert.equal(cleanFolder('  '), '');
    assert.equal(cleanFolder(undefined), '');
    for (const bad of ['..', '.', '..\\..', 'a\\b', 'a/b', 'C:', 'a*', 'a?', 'x|y', 'x.', 'a'.repeat(81)]) assert.equal(cleanFolder(bad), null, bad);
  });

  test('a job number is letters, digits and . _ - and not just dots', () => {
    for (const ok of ['092115-1-1', 'BMAU0013', 'a.b_c-1']) assert.ok(validJob(ok), ok);
    for (const bad of ['', '..', '.', 'a b', 'a\\b', 'a/b', 'x'.repeat(31), '092115;calc']) assert.ok(!validJob(bad), bad);
    assert.equal(drawingsFor(DEFAULT_SETTINGS, '..'), null);
    assert.equal(drawingsFor({ drawingsRoot: 'nope', drawingsFolder: '' }, '1'), null);
    assert.equal(drawingsFor({ drawingsRoot: 'H:\\', drawingsFolder: '' }, '1').path, 'H:\\1');
  });
});

describe('the Copy Drawing Path button on the job page', () => {
  let S;
  let job;
  before(async () => {
    S = await makeSession();
    job = S.db.prepare('SELECT j.job_num FROM jobs j JOIN job_metrics m ON m.job_num = j.job_num ORDER BY j.job_num LIMIT 1').get().job_num;
  });

  test('it sits between Start post-mortem and Dismiss and copies the drawings folder\'s address', async () => {
    const body = (await S.admin.get(`/jobs/${job}`)).body;
    const start = body.indexOf('>Start post-mortem<');
    const copy = body.indexOf('id="copyDrawingsPath"');
    const dismiss = body.indexOf('>Dismiss...<');
    assert.ok(start > 0 && start < copy && copy < dismiss, 'Start post-mortem, Copy Drawing Path, Dismiss...');
    assert.ok(body.includes('>Copy Drawing Path<'));
    assert.equal(copyOf(body), `G:\\${job}\\003 - PDF PRINTS`);
    assert.ok(body.includes('/static/copy-text.js'));
  });

  test('there is no Open Drawings button, no Set up link and no PC setup page any more', async () => {
    const body = (await S.admin.get(`/jobs/${job}`)).body;
    for (const gone of ['Open Drawings', 'openDrawings', 'unifab-folder', '/tools/folder-button', '>Set up<']) assert.ok(!body.includes(gone), gone);
    assert.equal((await S.admin.get('/tools/folder-button')).statusCode, 404);
    assert.equal((await S.admin.get('/tools/folder-button/setup.bat')).statusCode, 404);
  });

  test('a job with a post-mortem already started still has the button', async () => {
    const id = S.db.prepare('SELECT j.job_num FROM jobs j JOIN job_metrics m ON m.job_num = j.job_num WHERE j.job_num <> ? ORDER BY j.job_num LIMIT 1').get(job).job_num;
    const made = await S.admin.post(`/jobs/${id}/postmortem`);
    assert.equal(made.statusCode, 302);
    const body = (await S.admin.get(`/jobs/${id}`)).body;
    assert.ok(body.includes('>Open post-mortem<') && body.includes('id="copyDrawingsPath"') && body.indexOf('>Open post-mortem<') < body.indexOf('id="copyDrawingsPath"'));
  });

  test('Settings changes the drive and folder; the button follows; bad values are refused and change nothing', async () => {
    const page = (await S.admin.get('/settings')).body;
    assert.ok(page.includes('id="drawings"') && page.includes('href="#drawings"') && page.includes('G:\\') && page.includes('003 - PDF PRINTS'));
    assert.ok(page.includes('Copy Drawing Path') && !page.includes('Open Drawings') && !page.includes('/tools/folder-button'));
    const ok = await S.admin.post('/settings/drawings', { drawingsRoot: 'H:', drawingsFolder: 'PDFs' });
    assert.equal(ok.statusCode, 302);
    assert.deepEqual([getSettings(S.db).drawingsRoot, getSettings(S.db).drawingsFolder], ['H:\\', 'PDFs']);
    assert.equal(copyOf((await S.admin.get(`/jobs/${job}`)).body), `H:\\${job}\\PDFs`);

    for (const form of [{ drawingsRoot: 'H:\\jobs', drawingsFolder: 'x' }, { drawingsRoot: 'H:\\', drawingsFolder: '..\\..' }, { drawingsRoot: '', drawingsFolder: '' }]) {
      assert.equal((await S.admin.post('/settings/drawings', form)).statusCode, 400, JSON.stringify(form));
    }
    assert.deepEqual([getSettings(S.db).drawingsRoot, getSettings(S.db).drawingsFolder], ['H:\\', 'PDFs'], 'nothing changed');
    assert.equal((await S.reviewer.post('/settings/drawings', { drawingsRoot: 'K:\\', drawingsFolder: '' })).statusCode, 403, 'admin only');
    await S.admin.post('/settings/drawings', { drawingsRoot: 'G:\\', drawingsFolder: '' });
    assert.equal(copyOf((await S.admin.get(`/jobs/${job}`)).body), `G:\\${job}`, 'an empty folder uses the job folder itself');
  });
});

describe('Copy Path script', () => {
  const load = () => {
    const sandbox = { module: { exports: {} }, window: {}, Promise, setTimeout };
    vm.runInNewContext(fs.readFileSync(new URL('../public/copy-text.js', import.meta.url), 'utf8'), sandbox);
    return sandbox.module.exports.copyText;
  };
  const fakeDoc = (ok = true) => {
    const log = { value: null, copied: 0, removed: 0 };
    return {
      log,
      createElement: () => ({ style: {}, setAttribute() {}, select() {}, set value(v) { log.value = v; }, get value() { return log.value; } }),
      body: { appendChild() {}, removeChild() { log.removed++; } },
      execCommand: (c) => { log.copied++; return c === 'copy' && ok; },
    };
  };

  test('uses the clipboard when the page is secure', async () => {
    let wrote = null;
    const ok = await load()('G:\\1\\x', fakeDoc(), { clipboard: { writeText: (t) => { wrote = t; return Promise.resolve(); } } });
    assert.equal(ok, true);
    assert.equal(wrote, 'G:\\1\\x');
  });

  test('copies the old way when there is no clipboard (the app is often opened over plain http on the office network)', async () => {
    const d = fakeDoc();
    assert.equal(await load()('G:\\1\\x', d, {}), true);
    assert.equal(d.log.value, 'G:\\1\\x');
    assert.equal(d.log.copied, 1);
    assert.equal(d.log.removed, 1, 'the hidden box is cleaned up');
  });

  test('says so when copying is refused, and falls back when the clipboard rejects', async () => {
    assert.equal(await load()('x', fakeDoc(false), {}), false);
    const d = fakeDoc();
    assert.equal(await load()('x', d, { clipboard: { writeText: () => Promise.reject(new Error('no')) } }), true);
    assert.equal(d.log.copied, 1);
  });
});
