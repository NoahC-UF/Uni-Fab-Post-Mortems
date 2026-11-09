import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, migrate } from '../src/db.js';
import { backupDatabase } from '../src/backup.js';

test('backup writes a complete, openable copy and prunes old ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufpm-backup-'));
  const dbFile = path.join(dir, 'live.db');
  const db = openDb(dbFile);
  migrate(db);
  db.prepare("INSERT INTO settings (key, value) VALUES ('hello', '\"world\"')").run();

  const out = path.join(dir, 'backups');
  const file = backupDatabase(db, out, new Date('2026-11-09T14:30:00Z'));
  assert.ok(fs.existsSync(file));
  assert.match(path.basename(file), /^postmortem-20261109-1430\.db$/);

  const copy = new DatabaseSync(file);
  assert.equal(copy.prepare("SELECT value FROM settings WHERE key = 'hello'").get().value, '"world"');
  copy.close();

  for (let i = 0; i < 35; i++) backupDatabase(db, out, new Date(Date.UTC(2026, 0, 1 + i, 8, 0)));
  assert.equal(fs.readdirSync(out).length, 30, 'keeps the newest 30');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
