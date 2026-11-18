import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { cleanRoot, cleanFolder, validJob, drawingsFor, buildSetupBat, SCHEME } from '../src/drawings.js';
import { getSettings, DEFAULT_SETTINGS } from '../src/settings.js';
import { makeSession } from './helpers.js';

// the page writes a backslash as &#92; inside an attribute (the browser reads it back as a backslash)
const copyOf = (html) => /data-copy="([^"]*)"/.exec(html)?.[1].replace(/&#92;/g, '\\');
const win = process.platform === 'win32';
const PS1 = fileURLToPathSafe(new URL('../tools/folder-button/open-folder.ps1', import.meta.url));
function fileURLToPathSafe(u) {
  return decodeURIComponent(u.pathname.replace(/^\//, '')).replace(/\//g, path.sep);
}

describe('where a job\'s drawings are', () => {
  test('the defaults are the shared drive and the PDF PRINTS folder', () => {
    assert.equal(DEFAULT_SETTINGS.drawingsRoot, 'G:\\');
    assert.equal(DEFAULT_SETTINGS.drawingsFolder, '003 - PDF PRINTS');
    const d = drawingsFor(DEFAULT_SETTINGS, '092115-1-1');
    assert.equal(d.path, 'G:\\092115-1-1\\003 - PDF PRINTS');
    assert.equal(d.href, `${SCHEME}:open?job=092115-1-1&root=G%3A%5C&sub=003%20-%20PDF%20PRINTS`);
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

describe('the Open Drawings button on the job page', () => {
  let S;
  let job;
  before(async () => {
    S = await makeSession();
    job = S.db.prepare('SELECT j.job_num FROM jobs j JOIN job_metrics m ON m.job_num = j.job_num ORDER BY j.job_num LIMIT 1').get().job_num;
  });

  test('it sits between Start post-mortem and Dismiss, with a Copy Path beside it', async () => {
    const body = (await S.admin.get(`/jobs/${job}`)).body;
    const start = body.indexOf('>Start post-mortem<');
    const open = body.indexOf('id="openDrawings"');
    const copy = body.indexOf('id="copyDrawingsPath"');
    const dismiss = body.indexOf('>Dismiss...<');
    assert.ok(start > 0 && start < open && open < copy && copy < dismiss, 'Start post-mortem, Open Drawings, Copy Path, Dismiss...');
    const href = /id="openDrawings" href="([^"]*)"/.exec(body)[1].replace(/&amp;/g, '&');
    assert.equal(href, drawingsFor(DEFAULT_SETTINGS, job).href);
    assert.equal(copyOf(body), `G:\\${job}\\003 - PDF PRINTS`, 'Copy Path copies the folder\'s address');
    assert.ok(body.includes('/static/copy-text.js') && body.includes('href="/tools/folder-button"'));
  });

  test('a job with a post-mortem already started still has the button', async () => {
    const id = S.db.prepare('SELECT j.job_num FROM jobs j JOIN job_metrics m ON m.job_num = j.job_num WHERE j.job_num <> ? ORDER BY j.job_num LIMIT 1').get(job).job_num;
    const made = await S.admin.post(`/jobs/${id}/postmortem`);
    assert.equal(made.statusCode, 302);
    const body = (await S.admin.get(`/jobs/${id}`)).body;
    assert.ok(body.includes('>Open post-mortem<') && body.includes('id="openDrawings"') && body.indexOf('>Open post-mortem<') < body.indexOf('id="openDrawings"'));
  });

  test('Settings changes the drive and folder; the button follows; bad values are refused and change nothing', async () => {
    const page = (await S.admin.get('/settings')).body;
    assert.ok(page.includes('id="drawings"') && page.includes('href="#drawings"') && page.includes('G:\\') && page.includes('003 - PDF PRINTS'));
    const ok = await S.admin.post('/settings/drawings', { drawingsRoot: 'H:', drawingsFolder: 'PDFs' });
    assert.equal(ok.statusCode, 302);
    assert.deepEqual([getSettings(S.db).drawingsRoot, getSettings(S.db).drawingsFolder], ['H:\\', 'PDFs']);
    const body = (await S.admin.get(`/jobs/${job}`)).body;
    assert.equal(copyOf(body), `H:\\${job}\\PDFs`);

    for (const form of [{ drawingsRoot: 'H:\\jobs', drawingsFolder: 'x' }, { drawingsRoot: 'H:\\', drawingsFolder: '..\\..' }, { drawingsRoot: '', drawingsFolder: '' }]) {
      assert.equal((await S.admin.post('/settings/drawings', form)).statusCode, 400, JSON.stringify(form));
    }
    assert.deepEqual([getSettings(S.db).drawingsRoot, getSettings(S.db).drawingsFolder], ['H:\\', 'PDFs'], 'nothing changed');
    assert.equal((await S.reviewer.post('/settings/drawings', { drawingsRoot: 'K:\\', drawingsFolder: '' })).statusCode, 403, 'admin only');
    await S.admin.post('/settings/drawings', { drawingsRoot: 'G:\\', drawingsFolder: '' });
    assert.equal(copyOf((await S.admin.get(`/jobs/${job}`)).body), `G:\\${job}`, 'an empty folder opens the job folder itself');
  });
});

describe('the PC setup page and files', () => {
  let S;
  before(async () => { S = await makeSession(); });

  test('the page needs a sign-in and explains the setup and the undo', async () => {
    assert.equal((await S.anon.get('/tools/folder-button')).statusCode, 302);
    assert.equal((await S.anon.get('/tools/folder-button/setup.bat')).statusCode, 302);
    const body = (await S.reviewer.get('/tools/folder-button')).body;
    for (const t of ['Set Up Open Drawings', '/tools/folder-button/setup.bat', '/tools/folder-button/remove.bat', 'No administrator is needed', 'Copy Path']) assert.ok(body.includes(t), t);
  });

  test('the setup file is a batch file that carries the handler script after its commands', async () => {
    const r = await S.reviewer.get('/tools/folder-button/setup.bat');
    assert.equal(r.statusCode, 200);
    assert.match(r.headers['content-disposition'], /attachment; filename="uni-fab-drawings-setup\.bat"/);
    const bat = r.body;
    assert.ok(!/[^\r]\n/.test(bat), 'Windows line endings throughout');
    assert.ok(bat.includes('reg add "%KEY%\\shell\\open\\command"') && bat.includes('\\"%%1\\"') && bat.includes('-File \\"%DIR%\\open-folder.ps1\\"'));
    assert.ok(bat.includes('HKCU\\Software\\Classes\\unifab-folder') && !/HKLM/.test(bat), 'this Windows user only');
    const marker = '##SCRIPT-BEGIN\r\n';
    assert.equal(bat.split(marker).length, 2, 'the marker line is there once');
    assert.equal(bat.split(marker)[1], fs.readFileSync(PS1, 'utf8').replace(/\r?\n/g, '\r\n'), 'followed by the script, whole');
    assert.ok(bat.indexOf('exit /b') < bat.indexOf(marker), 'the batch file ends before the script starts');
    assert.ok(/^[\x00-\x7f]*$/.test(bat), 'plain ASCII, so the unpacked script reads the same everywhere');
  });

  test('the remove file undoes both and carries no script', async () => {
    const bat = (await S.reviewer.get('/tools/folder-button/remove.bat')).body;
    assert.ok(bat.includes('set "MODE=remove"') && bat.includes('reg delete "%KEY%" /f') && bat.includes('rmdir /s /q "%DIR%"'));
    assert.ok(!bat.includes('##SCRIPT-BEGIN'));
  });

  test('the unpack step of the setup file writes the script out exactly (run for real on Windows)', { skip: !win }, () => {
    const bat = buildSetupBat();
    const line = bat.split('\r\n').find((l) => l.startsWith('powershell -NoProfile'));
    const code = /-Command "(.*)"$/.exec(line)[1];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufbat-'));
    const self = path.join(dir, 'setup.bat');
    fs.writeFileSync(self, bat);
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', code], { env: { ...process.env, SELF: self, DIR: out } });
    assert.equal(fs.readFileSync(path.join(out, 'open-folder.ps1'), 'utf8'), fs.readFileSync(PS1, 'utf8').replace(/\r?\n/g, '\r\n').trimStart());
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('the handler script (dry runs on Windows: it prints what it would open)', { skip: !win }, () => {
  const run = (url) => {
    try {
      return execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1, url, '-DryRun'], { encoding: 'utf8' }).trim().split(/\r?\n/);
    } catch (e) {
      return String(e.stdout).trim().split(/\r?\n/);
    }
  };
  const link = (job, root, sub) => `unifab-folder:open?job=${encodeURIComponent(job)}&root=${encodeURIComponent(root)}&sub=${encodeURIComponent(sub)}`;

  test('opens the drawings folder when it is there, else the job folder, else the drive', () => {
    assert.deepEqual(run(link('Windows', 'C:\\', 'System32')), ['OPEN: C:\\Windows\\System32']);
    assert.match(run(link('Windows', 'C:\\', 'No Such Folder')).join('|'), /^OPEN: C:\\Windows\|NOTE: There is no 'No Such Folder' folder for job Windows/);
    assert.match(run(link('NoSuchJob99', 'C:\\', 'x')).join('|'), /^OPEN: C:\\\|NOTE: There is no folder for job NoSuchJob99/);
    assert.deepEqual(run(link('Windows', 'C:\\', '')), ['OPEN: C:\\Windows']);
  });

  test('refuses anything that is not a plain job number, drive and folder, and opens nothing', () => {
    for (const url of [link('..', 'C:\\', 'x'), link('a\\b', 'C:\\', ''), link('Windows', 'C:\\Windows', 'x'), link('Windows', 'C:\\', '..\\..'), link('Windows', 'C:\\', 'a/b'), 'http://example.com/x', 'unifab-folder:other?job=Windows', link('Windows', 'C:\\', 'x') + '" -x "']) {
      const out = run(url).join('|');
      assert.ok(/^REFUSED:/.test(out) || /^OPEN: C:\\(Windows)?\|NOTE/.test(out), `${url} -> ${out}`);
      assert.ok(!/OPEN: C:\\Windows\\/.test(out), url);
    }
    assert.match(run(link('..', 'C:\\', 'x'))[0], /^REFUSED: The job number/);
    assert.match(run(link('Windows', 'C:\\Windows', 'x'))[0], /^REFUSED: The drive/);
    assert.match(run(link('Windows', 'C:\\', '..\\..'))[0], /^REFUSED: The folder name/);
    assert.match(run('http://example.com/x')[0], /^REFUSED: That is not a folder link/);
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
