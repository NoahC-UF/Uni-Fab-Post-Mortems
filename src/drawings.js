// The "Open Drawings" button on the job page: where a job's PDF drawings live, and the link that opens that folder.
//
// Drawings are kept on a shared drive, one folder per job number, with the PDFs in a subfolder:
//   G:\<job number>\003 - PDF PRINTS
// The drive and the subfolder name are Settings (so a changed drive letter is a Settings edit, not a code change).
//
// A web page cannot open a local folder, so the button is a link with its own scheme, `unifab-folder:`. Each PC runs the
// setup file once (see /tools/folder-button) which tells Windows to hand that link to tools/folder-button/open-folder.ps1.
// That script re-checks everything in the link (it can only ever open a folder, never run anything), so the same rules
// are kept here and in the script: change one, change the other.

import fs from 'node:fs';
import { DEFAULT_SETTINGS } from './settings.js';

export const SCHEME = 'unifab-folder';
// A job number as the Epicor job pages use it (the same rule as the /jobs/:jobNum route), and not just dots
const JOB_RE = /^[A-Za-z0-9._-]{1,30}$/;
const DRIVE_RE = /^[A-Za-z]:\\?$/; // G: or G:\
const UNC_RE = /^\\\\[^\\/:*?"<>|]+\\[^\\/:*?"<>|]+\\?$/; // \\server\share
const FOLDER_RE = /^[^\\/:*?"<>|]{1,80}$/; // one folder name: no slashes, no wildcard or reserved characters

export function validJob(job) {
  return JOB_RE.test(job) && !/^\.+$/.test(job);
}

/** The drive (or network share) the job folders are in, as "G:\" (always ending in a backslash), or null if it is not one. */
export function cleanRoot(root) {
  const r = String(root ?? '').trim();
  if (!DRIVE_RE.test(r) && !UNC_RE.test(r)) return null;
  return r.endsWith('\\') ? r : `${r}\\`;
}

/** The subfolder inside a job's folder ('' = the job folder itself), or null if it is not one folder name. */
export function cleanFolder(folder) {
  const f = String(folder ?? '').trim();
  if (f === '') return '';
  if (!FOLDER_RE.test(f) || /^\.+$/.test(f) || /[. ]$/.test(f)) return null;
  return f;
}

/** Where a job's drawings are, and the link for the button. Null if the job number or the settings are not usable. */
export function drawingsFor(settings, jobNum) {
  const root = cleanRoot(settings.drawingsRoot ?? DEFAULT_SETTINGS.drawingsRoot);
  const sub = cleanFolder(settings.drawingsFolder ?? DEFAULT_SETTINGS.drawingsFolder);
  if (!root || sub === null || !validJob(jobNum)) return null;
  const path = `${root}${jobNum}${sub ? `\\${sub}` : ''}`;
  const q = new URLSearchParams({ job: jobNum, root, sub }).toString().replace(/\+/g, '%20');
  return { path, href: `${SCHEME}:open?${q}` };
}

// ---------------------------------------------------------------------------------------------- the PC setup file

const HANDLER = new URL('../tools/folder-button/open-folder.ps1', import.meta.url);

/**
 * The one-file Windows setup for a PC: a batch file with the handler script (open-folder.ps1) packed after its commands.
 * Run it once: it saves the script under the person's own profile and registers the `unifab-folder:` link for that Windows user
 * only (no administrator needed). With remove = true it is the undo: it deletes both again.
 */
export function buildSetupBat({ remove = false } = {}) {
  const script = fs.readFileSync(HANDLER, 'utf8').replace(/\r?\n/g, '\r\n');
  const head = [
    '@echo off',
    'setlocal',
    'rem Uni-Fab Post-Mortem: makes the "Open Drawings" button open a job\'s drawings folder in File Explorer.',
    'rem It changes this Windows user only (a link type under HKEY_CURRENT_USER and one script in %LOCALAPPDATA%). No administrator needed.',
    remove ? 'rem This is the undo: it removes both.' : 'rem To undo it later, download "remove" from the same page and run it.',
    `set "MODE=${remove ? 'remove' : 'install'}"`,
    'set "SELF=%~f0"',
    'set "DIR=%LOCALAPPDATA%\\UniFabPostMortem"',
    `set "KEY=HKCU\\Software\\Classes\\${SCHEME}"`,
    'if "%MODE%"=="remove" goto remove',
    '',
    'mkdir "%DIR%" 2>nul',
    // the script is everything after the marker line at the end of this file (the marker is built here so this line does not contain it)
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "$t=[IO.File]::ReadAllText($env:SELF); $m=\'#\'+\'#SCRIPT\'+\'-BEGIN\'; $i=$t.IndexOf($m); [IO.File]::WriteAllText($env:DIR+\'\\open-folder.ps1\', $t.Substring($i+$m.Length).TrimStart(), [Text.Encoding]::ASCII)"',
    'if not exist "%DIR%\\open-folder.ps1" goto failed',
    `reg add "%KEY%" /ve /d "URL:Uni-Fab Post-Mortem folder" /f >nul`,
    'reg add "%KEY%" /v "URL Protocol" /d "" /f >nul',
    'reg add "%KEY%\\shell\\open\\command" /ve /d "\\"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\\" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \\"%DIR%\\open-folder.ps1\\" \\"%%1\\"" /f >nul',
    'if errorlevel 1 goto failed',
    'echo.',
    'echo Done. The Open Drawings button on a job page now opens that job\'s drawings folder.',
    'echo The first time, your browser may ask to open "Uni-Fab Post-Mortem folder": tick "Always allow" and say yes.',
    'goto end',
    '',
    ':remove',
    'reg delete "%KEY%" /f >nul 2>nul',
    'rmdir /s /q "%DIR%" 2>nul',
    'echo.',
    'echo Removed. The Open Drawings button no longer opens folders on this PC (Copy Path still works).',
    'goto end',
    '',
    ':failed',
    'echo.',
    'echo Something went wrong, so nothing is set up. Ask whoever looks after this app for help.',
    '',
    ':end',
    'echo.',
    'pause',
    'exit /b',
    '',
  ].join('\r\n');
  return remove ? head : `${head}##SCRIPT-BEGIN\r\n${script}`;
}
