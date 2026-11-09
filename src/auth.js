// Users, password hashing and login sessions (all stored in SQLite).

import bcrypt from 'bcryptjs';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'uf_session';
export const SESSION_HOURS = 12;
export const ROLES = ['admin', 'reviewer'];

export const hashPassword = (pw) => bcrypt.hashSync(pw, 10);
export const verifyPassword = (pw, hash) => bcrypt.compareSync(pw, hash);

export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > 200) return 'Password is too long.';
  return null;
}

export function validateUsername(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._-]{3,40}$/.test(name)) {
    return 'Username must be 3 to 40 characters: letters, numbers, dot, dash or underscore.';
  }
  return null;
}

export function countUsers(db) {
  return db.prepare('SELECT COUNT(*) n FROM users').get().n;
}

export function createUser(db, { username, displayName, password, role }) {
  const err = validateUsername(username) || validatePassword(password);
  if (err) throw new Error(err);
  if (!ROLES.includes(role)) throw new Error('Unknown role.');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new Error('That username is already taken.');
  const info = db
    .prepare('INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(username, (displayName || username).trim(), hashPassword(password), role);
  return Number(info.lastInsertRowid);
}

export function findUserByLogin(db, username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(String(username ?? ''));
}

export function createSession(db, userId, now = new Date()) {
  const id = randomBytes(32).toString('hex');
  const csrf = randomBytes(24).toString('hex');
  const expires = new Date(now.getTime() + SESSION_HOURS * 3600_000).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, csrf, expires_at) VALUES (?, ?, ?, ?)').run(id, userId, csrf, expires);
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(userId);
  return { id, csrf, expires };
}

export function getSession(db, id, now = new Date()) {
  if (!id) return null;
  const row = db
    .prepare(
      `SELECT s.id, s.csrf, s.expires_at, u.id AS user_id, u.username, u.display_name, u.role, u.active
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    )
    .get(id);
  if (!row || !row.active || new Date(row.expires_at) <= now) return null;
  return {
    session: { id: row.id, csrf: row.csrf },
    user: { id: row.user_id, username: row.username, displayName: row.display_name, role: row.role, isAdmin: row.role === 'admin' },
  };
}

export function deleteSession(db, id) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

export function purgeExpiredSessions(db, now = new Date()) {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now.toISOString());
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Tiny in-memory brake on password guessing: 6 misses locks that user+address for 5 minutes. */
export class LoginThrottle {
  constructor(max = 6, windowMs = 5 * 60_000) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }
  key(username, ip) {
    return `${String(username).toLowerCase()}|${ip}`;
  }
  isLocked(username, ip, now = Date.now()) {
    const h = this.hits.get(this.key(username, ip));
    return !!h && h.count >= this.max && now - h.last < this.windowMs;
  }
  fail(username, ip, now = Date.now()) {
    const k = this.key(username, ip);
    const h = this.hits.get(k);
    if (!h || now - h.last >= this.windowMs) this.hits.set(k, { count: 1, last: now });
    else this.hits.set(k, { count: h.count + 1, last: now });
  }
  clear(username, ip) {
    this.hits.delete(this.key(username, ip));
  }
}
