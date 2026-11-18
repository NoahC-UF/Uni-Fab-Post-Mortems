// The Copy Drawing Path button on the job page: where a job's PDF drawings live.
//
// Drawings are kept on a shared drive, one folder per job number, with the PDFs in a subfolder:
//   G:\<job number>\003 - PDF PRINTS
// The drive and the subfolder name are Settings (so a changed drive letter is a Settings edit, not a code change).
// A web page cannot open a local folder, so the button copies the folder's address to paste into File Explorer.

import { DEFAULT_SETTINGS } from './settings.js';

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

/** Where a job's drawings are: { path }. Null if the job number or the settings are not usable. */
export function drawingsFor(settings, jobNum) {
  const root = cleanRoot(settings.drawingsRoot ?? DEFAULT_SETTINGS.drawingsRoot);
  const sub = cleanFolder(settings.drawingsFolder ?? DEFAULT_SETTINGS.drawingsFolder);
  if (!root || sub === null || !validJob(jobNum)) return null;
  return { path: `${root}${jobNum}${sub ? `\\${sub}` : ''}` };
}
