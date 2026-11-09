// Run with: npm run backup   (or double-click backup.bat)
import fs from 'node:fs';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { backupDatabase } from './backup.js';

const cfg = loadConfig();
if (!fs.existsSync(cfg.dbPath)) {
  console.error(`No database found at ${cfg.dbPath}. Nothing to back up yet.`);
  process.exit(1);
}
const db = openDb(cfg.dbPath);
const file = backupDatabase(db);
db.close();
console.log(`Backup saved: ${file}`);
