import { SESSION_COOKIE, SESSION_HOURS, countUsers, createSession, createUser, deleteSession, findUserByLogin, hashPassword, validatePassword, verifyPassword } from '../auth.js';
import { UserError } from '../errors.js';

// Used so a wrong username takes as long to reject as a wrong password (no user guessing by timing).
const DUMMY_HASH = hashPassword('not-a-real-password');

const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/');

export default async function authRoutes(app) {
  const { db, now, throttle } = app.ctx;

  function startSession(reply, userId) {
    const s = createSession(db, userId, now());
    reply.setCookie(SESSION_COOKIE, s.id, {
      signed: true,
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_HOURS * 3600,
    });
  }

  // ------------------------------------------------------------------ first run
  app.get('/setup', async (req, reply) => {
    if (countUsers(db) > 0) return reply.redirect('/');
    return reply.page('setup.njk', { form: {} });
  });

  app.post('/setup', async (req, reply) => {
    if (countUsers(db) > 0) throw new UserError('Setup is already done.', 403);
    const { displayName, username, password, confirm } = req.body ?? {};
    const form = { displayName, username };
    if (password !== confirm) return reply.status(400).page('setup.njk', { form, error: 'The two passwords do not match.' });
    try {
      const id = createUser(db, { username, displayName, password, role: 'admin' });
      startSession(reply, id);
      return reply.redirect('/?ok=' + encodeURIComponent('Admin account created. Welcome!'));
    } catch (err) {
      return reply.status(400).page('setup.njk', { form, error: err.message });
    }
  });

  // ---------------------------------------------------------------------- login
  app.get('/login', async (req, reply) => {
    if (req.user) return reply.redirect('/');
    return reply.page('login.njk', { next: safeNext(req.query.next), form: {} });
  });

  app.post('/login', async (req, reply) => {
    const { username = '', password = '', next } = req.body ?? {};
    const ip = req.ip;
    const fail = (msg) => reply.status(401).page('login.njk', { next: safeNext(next), form: { username }, error: msg });
    if (throttle.isLocked(username, ip)) return fail('Too many attempts. Please wait a few minutes and try again.');
    const user = findUserByLogin(db, username);
    const ok = verifyPassword(String(password), user?.password_hash ?? DUMMY_HASH) && !!user && !!user.active;
    if (!ok) {
      throttle.fail(username, ip);
      return fail('That username and password do not match.');
    }
    throttle.clear(username, ip);
    startSession(reply, user.id);
    return reply.redirect(safeNext(next));
  });

  app.post('/logout', async (req, reply) => {
    if (req.session) deleteSession(db, req.session.id);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.redirect('/login');
  });

  // -------------------------------------------------------- change own password
  app.get('/account', async (req, reply) => reply.page('account.njk', {}));

  app.post('/account/password', async (req, reply) => {
    const { current = '', password = '', confirm = '' } = req.body ?? {};
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(String(current), row.password_hash)) return reply.status(400).page('account.njk', { error: 'Your current password is not right.' });
    if (password !== confirm) return reply.status(400).page('account.njk', { error: 'The two new passwords do not match.' });
    const problem = validatePassword(password);
    if (problem) return reply.status(400).page('account.njk', { error: problem });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), req.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(req.user.id, req.session.id);
    return reply.redirect('/account?ok=' + encodeURIComponent('Password changed.'));
  });
}
