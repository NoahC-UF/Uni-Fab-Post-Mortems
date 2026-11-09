import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, tx } from '../src/db.js';
import { loadConfig, missingEpicorSettings, secretValues } from '../src/config.js';
import { maskSecrets } from '../src/mask.js';

test('migrations create the schema and are idempotent', () => {
  const db = openDb(':memory:');
  const first = migrate(db);
  assert.ok(first.includes('001_init.sql'));
  assert.deepEqual(migrate(db), []);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const t of ['users', 'jobs', 'job_operations', 'labor_details', 'job_materials', 'post_mortems', 'action_items']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  const causes = db.prepare('SELECT COUNT(*) AS n FROM root_causes').get().n;
  assert.equal(causes, 13);
});

test('tx rolls back when the callback throws', () => {
  const db = openDb(':memory:');
  migrate(db);
  assert.throws(() =>
    tx(db, () => {
      db.prepare("INSERT INTO settings (key, value) VALUES ('a', '1')").run();
      throw new Error('boom');
    }),
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM settings').get().n, 0);
});

test('config: defaults to mock mode and reports missing settings by NAME only', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.useMock, true);
  assert.equal(cfg.port, 8080);
  assert.deepEqual(missingEpicorSettings(cfg).sort(), [
    'EPICOR_API_KEY',
    'EPICOR_BASE_URL',
    'EPICOR_COMPANY',
    'EPICOR_PASSWORD',
    'EPICOR_USERNAME',
  ]);
});

test('config: trims base url and parses booleans', () => {
  const cfg = loadConfig({ USE_MOCK_DATA: 'false', EPICOR_BASE_URL: 'https://x.example.com/SaaS1/ ' });
  assert.equal(cfg.useMock, false);
  assert.equal(cfg.epicor.baseUrl, 'https://x.example.com/SaaS1');
});

test('mask: secrets and auth headers never survive', () => {
  const cfg = loadConfig({ EPICOR_API_KEY: 'KEY-12345', EPICOR_USERNAME: 'svc_user', EPICOR_PASSWORD: 'p@ssw0rd!' });
  const secrets = secretValues(cfg);
  const text = `failed for svc_user with p@ssw0rd! key KEY-12345 Authorization: Basic ${Buffer.from('svc_user:p@ssw0rd!').toString('base64')}`;
  const masked = maskSecrets(text, secrets);
  for (const s of ['svc_user', 'p@ssw0rd!', 'KEY-12345']) assert.ok(!masked.includes(s), `leaked ${s}`);
  assert.ok(!maskSecrets('x-api-key: abc123def', []).includes('abc123def'));
});
