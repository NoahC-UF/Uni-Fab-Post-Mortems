import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeSession, Client } from './helpers.js';
import { countUsers } from '../src/auth.js';

describe('first-run setup', () => {
  test('with no users, every page sends you to /setup and the first user becomes Admin', async () => {
    const { app, db } = await makeApp({ sync: false });
    const c = new Client(app);
    const r = await c.get('/');
    assert.equal(r.statusCode, 302);
    assert.equal(r.headers.location, '/setup');
    const page = await c.get('/setup');
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Create Admin account/);

    const bad = await c.req('POST', '/setup', { form: { displayName: 'Boss', username: 'boss', password: 'longenough1', confirm: 'different' } });
    assert.equal(bad.statusCode, 400);
    assert.equal(countUsers(db), 0);

    const ok = await c.req('POST', '/setup', { form: { displayName: 'Boss', username: 'boss', password: 'longenough1', confirm: 'longenough1' } });
    assert.equal(ok.statusCode, 302);
    assert.equal(db.prepare('SELECT role FROM users').get().role, 'admin');
    assert.ok(c.cookie.startsWith('uf_session='), 'signed in after setup');

    const again = await new Client(app).req('POST', '/setup', { form: { displayName: 'x', username: 'hacker', password: 'longenough1', confirm: 'longenough1' } });
    assert.ok([302, 403].includes(again.statusCode));
    assert.equal(countUsers(db), 1, 'setup cannot be used to add users later');
  });
});

describe('login and sessions', () => {
  test('anonymous users are sent to the login page', async () => {
    const { anon } = await makeSession({ sync: false });
    const r = await anon.get('/jobs');
    assert.equal(r.statusCode, 302);
    assert.match(r.headers.location, /^\/login\?next=%2Fjobs/);
  });

  test('wrong password is rejected with a generic message', async () => {
    const { anon } = await makeSession({ sync: false });
    const r = await anon.req('POST', '/login', { form: { username: 'admin', password: 'nope-nope' } });
    assert.equal(r.statusCode, 401);
    assert.match(r.body, /do not match/);
    const unknown = await anon.req('POST', '/login', { form: { username: 'ghost', password: 'nope-nope' } });
    assert.equal(unknown.statusCode, 401);
    assert.match(unknown.body, /do not match/, 'same message for unknown user');
  });

  test('too many wrong attempts locks the account for a few minutes', async () => {
    const { anon } = await makeSession({ sync: false });
    for (let i = 0; i < 6; i++) await anon.req('POST', '/login', { form: { username: 'admin', password: 'wrong-wrong' } });
    const r = await anon.req('POST', '/login', { form: { username: 'admin', password: 'admin-pass-1' } });
    assert.equal(r.statusCode, 401);
    assert.match(r.body, /Too many attempts/);
  });

  test('login redirects only to local paths (no open redirect)', async () => {
    const { anon } = await makeSession({ sync: false });
    const r = await anon.req('POST', '/login', { form: { username: 'admin', password: 'admin-pass-1', next: 'https://evil.example.com/' } });
    assert.equal(r.statusCode, 302);
    assert.equal(r.headers.location, '/');
    const r2 = await new Client(anon.app).req('POST', '/login', { form: { username: 'admin', password: 'admin-pass-1', next: '//evil.example.com' } });
    assert.equal(r2.headers.location, '/');
  });

  test('the session cookie is HttpOnly and signed', async () => {
    const { anon } = await makeSession({ sync: false });
    const r = await anon.req('POST', '/login', { form: { username: 'admin', password: 'admin-pass-1' } });
    const cookie = [].concat(r.headers['set-cookie'])[0];
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    const value = decodeURIComponent(cookie.split(';')[0].split('=').slice(1).join('='));
    assert.match(value, /\./, 'has a signature');
  });

  test('a tampered cookie is not accepted', async () => {
    const { admin } = await makeSession({ sync: false });
    const tampered = new Client(admin.app);
    tampered.cookie = admin.cookie.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
    const r = await tampered.get('/account');
    assert.equal(r.statusCode, 302);
  });

  test('sign out ends the session', async () => {
    const { admin } = await makeSession({ sync: false });
    assert.equal((await admin.get('/account')).statusCode, 200);
    const saved = admin.cookie;
    await admin.post('/logout');
    const stale = new Client(admin.app);
    stale.cookie = saved;
    assert.equal((await stale.get('/account')).statusCode, 302, 'old cookie no longer works');
  });

  test('deactivated users are locked out immediately', async () => {
    const { admin, db } = await makeSession({ sync: false });
    db.prepare("UPDATE users SET active = 0 WHERE username = 'admin'").run();
    assert.equal((await admin.get('/account')).statusCode, 302);
  });

  test('passwords are stored hashed', async () => {
    const { db } = await makeSession({ sync: false });
    const h = db.prepare("SELECT password_hash FROM users WHERE username = 'admin'").get().password_hash;
    assert.ok(h.startsWith('$2'), 'bcrypt hash');
    assert.ok(!h.includes('admin-pass-1'));
  });
});

describe('CSRF protection', () => {
  test('a POST without the token is refused', async () => {
    const { admin } = await makeSession({ sync: false });
    const r = await admin.req('POST', '/account/password', { form: { current: 'admin-pass-1', password: 'brand-new-pass', confirm: 'brand-new-pass' } });
    assert.equal(r.statusCode, 403);
  });
  test('a POST with the right token works', async () => {
    const { admin } = await makeSession({ sync: false });
    const r = await admin.post('/account/password', { current: 'admin-pass-1', password: 'brand-new-pass', confirm: 'brand-new-pass' });
    assert.equal(r.statusCode, 302);
  });
});

describe('account page', () => {
  test('changing the password needs the current password', async () => {
    const { admin } = await makeSession({ sync: false });
    const r = await admin.post('/account/password', { current: 'wrong', password: 'brand-new-pass', confirm: 'brand-new-pass' });
    assert.equal(r.statusCode, 400);
    assert.match(r.body, /current password is not right/);
  });
  test('security headers are present', async () => {
    const { admin } = await makeSession({ sync: false });
    const r = await admin.get('/account');
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
  });
});
