// Makes a safe copy of the database in the backups folder (works while the app is running).
import fs from 'node:fs';
import path from 'node:path';

const KEEP = 30; // keep the newest 30 backups

export function backupDatabase(db, dir = 'backups', now = new Date()) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
  const file = path.resolve(dir, `postmortem-${stamp}.db`);
  if (fs.existsSync(file)) fs.rmSync(file);
  db.prepare('VACUUM INTO ?').run(file);
  const all = fs.readdirSync(dir).filter((f) => /^postmortem-.*\.db$/.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP))) fs.rmSync(path.join(dir, old));
  return file;
}
