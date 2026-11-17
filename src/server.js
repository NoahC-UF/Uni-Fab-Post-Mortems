// Starts the web server.   npm start   (or double-click start.bat)

import { loadConfig } from './config.js';
import { openDb, migrate } from './db.js';
import { buildApp } from './app.js';
import { makeLogger } from './mask.js';
import { secretValues } from './config.js';
import { countUsers } from './auth.js';
import { createSource } from './sync/sources.js';
import { runSync } from './sync/sync.js';
import { startScheduler } from './sync/scheduler.js';
import { ensureMetricsCurrent } from './metrics.js';

const cfg = loadConfig();
const log = makeLogger(secretValues(cfg));

const db = openDb(cfg.dbPath);
const applied = migrate(db);
if (applied.length) log.info(`Database updated: ${applied.join(', ')}`);
const rechecked = ensureMetricsCurrent(db);
if (rechecked) log.info(`Re-checked ${rechecked} jobs after the update (adds price and margin figures).`);

const app = await buildApp({ cfg, db, logger: log });

try {
  await app.listen({ port: cfg.port, host: cfg.host });
} catch (err) {
  if (err.code === 'EADDRINUSE') {
    log.error(`Port ${cfg.port} is already in use. Is the app already running? Change PORT in .env to use another port.`);
  } else {
    log.error(`Could not start: ${err.message}`);
  }
  process.exit(1);
}

const where = cfg.host === '0.0.0.0' ? `http://<this-pc-name>:${cfg.port}` : `http://localhost:${cfg.port}`;
log.info('------------------------------------------------------------');
log.info(` Uni-Fab Post-Mortem is running at ${where}`);
log.info(` Data source: ${cfg.useMock ? 'MOCK (fake demo data)' : 'Epicor'}`);
log.info(countUsers(db) === 0 ? ' First time: open the address above to create the Admin account.' : ' Leave this window open. Close it to stop the app.');
log.info('------------------------------------------------------------');

// First start with demo data: load it so there is something to look at.
if (cfg.useMock && db.prepare('SELECT COUNT(*) n FROM jobs').get().n === 0) {
  const result = await runSync({ db, source: createSource(cfg, log), kind: 'full', startedBy: 'startup', secrets: secretValues(cfg), logger: log });
  log.info(result.ok ? 'Demo data loaded.' : `Demo data failed to load: ${result.error}`);
}

// Automatic sync (Settings > Automatic sync). Checks once a minute whether a sync is due.
const scheduler = startScheduler({ db, cfg, startSync: app.ctx.startSync, log });

const stop = async () => {
  scheduler.stop();
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
