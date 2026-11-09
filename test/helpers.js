// Shared helpers for web tests: an app on an in-memory database + a tiny cookie-aware client.
import { openDb, migrate } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { MockSource } from '../src/mock/mockSource.js';
import { runSync } from '../src/sync/sync.js';
import { createUser } from '../src/auth.js';

export const quiet = { info() {}, warn() {}, error() {} };

export async function makeApp({ sync = true, env = {} } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  const cfg = loadConfig({ USE_MOCK_DATA: 'true', ...env });
  const source = new MockSource();
  if (sync) await runSync({ db, source, kind: 'full', logger: quiet });
  const app = await buildApp({ cfg, db, logger: quiet });
  return { app, db, cfg, source };
}

export class Client {
  constructor(app) {
    this.app = app;
    this.cookie = '';
    this.csrf = '';
  }

  async req(method, url, { form, headers = {} } = {}) {
    const h = { ...headers };
    if (this.cookie) h.cookie = this.cookie;
    let payload;
    if (form) {
      h['content-type'] = 'application/x-www-form-urlencoded';
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(form)) for (const x of [].concat(v)) params.append(k, String(x)); // arrays = repeated fields
      payload = params.toString();
    }
    const res = await this.app.inject({ method, url, headers: h, payload });
    const set = [].concat(res.headers['set-cookie'] ?? []);
    for (const c of set) {
      const [pair] = c.split(';');
      const [name, ...rest] = pair.split('=');
      if (name === 'uf_session') this.cookie = rest.join('=') ? `${name}=${rest.join('=')}` : '';
    }
    return res;
  }

  get(url, o) {
    return this.req('GET', url, o);
  }

  async post(url, form = {}, o = {}) {
    if (!this.csrf && this.cookie) await this.refreshCsrf();
    return this.req('POST', url, { ...o, form: { _csrf: this.csrf, ...form } });
  }

  async refreshCsrf() {
    const res = await this.req('GET', '/account');
    const m = /name="_csrf" value="([a-f0-9]+)"/.exec(res.body);
    this.csrf = m ? m[1] : '';
    return this.csrf;
  }

  async login(username, password) {
    const res = await this.req('POST', '/login', { form: { username, password } });
    if (res.statusCode !== 302) throw new Error(`login failed: ${res.statusCode}`);
    await this.refreshCsrf();
    return res;
  }
}

/** App + admin + reviewer users, returns signed-in clients. */
export async function makeSession(opts = {}) {
  const ctx = await makeApp(opts);
  createUser(ctx.db, { username: 'admin', displayName: 'Ada Admin', password: 'admin-pass-1', role: 'admin' });
  createUser(ctx.db, { username: 'rev', displayName: 'Ray Reviewer', password: 'review-pass-1', role: 'reviewer' });
  const admin = new Client(ctx.app);
  await admin.login('admin', 'admin-pass-1');
  const reviewer = new Client(ctx.app);
  await reviewer.login('rev', 'review-pass-1');
  return { ...ctx, admin, reviewer, anon: new Client(ctx.app) };
}
