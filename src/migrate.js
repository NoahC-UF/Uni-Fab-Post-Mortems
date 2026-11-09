// Run with: npm run migrate   (start.bat does this automatically)
import { loadConfig } from './config.js';
import { openDb, migrate } from './db.js';

const cfg = loadConfig();
const db = openDb(cfg.dbPath);
const applied = migrate(db);
console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Database is up to date.');
db.close();
