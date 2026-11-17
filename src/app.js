// Builds the web application (used by server.js and by the tests).

import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import fastifyView from '@fastify/view';
import nunjucks from 'nunjucks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import * as fmt from './format.js';
import { SESSION_COOKIE, countUsers, getSession, safeEqual, LoginThrottle, purgeExpiredSessions } from './auth.js';
import { resolveAppSecret, getAppearance, getSettings } from './settings.js';
import { normaliseBands, bandStyle } from './marginBands.js';
import { tableStyleCss } from './tableStyles.js';
import { COLUMN_HELP } from './columnHelp.js';
import { columnHelpOn, pageWidthOf, PAGE_WIDTHS } from './prefs.js';
import { lastSync } from './sync/sync.js';
import { UserError, forbidden } from './errors.js';
import { makeLogger } from './mask.js';
import { secretValues } from './config.js';

import authRoutes from './routes/auth.js';
import dashboardRoutes from './routes/dashboard.js';
import jobRoutes from './routes/jobs.js';
import postMortemRoutes from './routes/postmortems.js';
import actionRoutes from './routes/actions.js';
import settingsRoutes from './routes/settings.js';
import reportRoutes from './routes/report.js';
import studyRoutes from './routes/study.js';
import accuracyRoutes from './routes/accuracy.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const nm = (...p) => path.join(root, 'node_modules', ...p);

const isAsset = (p) => p.startsWith('/static/') || p.startsWith('/vendor/') || p === '/healthz' || p === '/favicon.ico';

export async function buildApp({ cfg, db, logger = null, now = () => new Date() }) {
  const log = logger ?? makeLogger(secretValues(cfg));
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });

  const secret = resolveAppSecret(db, cfg.secretKey);
  await app.register(fastifyCookie, { secret });
  await app.register(fastifyFormbody);
  await app.register(fastifyStatic, { root: path.join(root, 'public'), prefix: '/static/' });
  const vendor = [
    ['/vendor/htmx/', nm('htmx.org', 'dist')],
    ['/vendor/alpine/', nm('alpinejs', 'dist')],
    ['/vendor/chart/', nm('chart.js', 'dist')],
    ['/vendor/tabulator/', nm('tabulator-tables', 'dist')],
  ];
  for (const [prefix, dir] of vendor) {
    await app.register(fastifyStatic, { root: dir, prefix, decorateReply: false, maxAge: '1d' });
  }

  await app.register(fastifyView, {
    engine: { nunjucks },
    templates: path.join(root, 'src', 'views'),
    options: {
      noCache: process.env.NODE_ENV !== 'production',
      onConfigure(env) {
        for (const name of ['money', 'smoney', 'smoney0', 'spts', 'money0', 'hrs', 'shrs', 'spct', 'pct', 'qty', 'dateOnly', 'dateTime', 'clockTime']) {
          env.addFilter(name, fmt[name]);
        }
        // JSON that is safe to place inside a <script> tag (no way to close the tag early)
        env.addFilter('json', (v) =>
          JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'),
        );
        // {{ margin | bandStyle(marginBands, target) }}: the colour style for a margin fraction, judged against its own target (both fractions), by the Settings > Margin % Colours bands ('' = none)
        env.addFilter('bandStyle', (margin, bands, target) => bandStyle(bands, margin, target));
        env.addGlobal('STATUS_LABELS', fmt.STATUS_LABELS);
        env.addGlobal('DQ_LABELS', fmt.DQ_LABELS);
      },
    },
  });

  const ctx = { cfg, db, log, now, throttle: new LoginThrottle(), secret };
  app.decorate('ctx', ctx);

  // ------------------------------------------------------------- rendering helper
  app.decorateReply('page', function page(template, data = {}) {
    const req = this.request;
    const settings = getSettings(db);
    const base = {
      user: req.user ?? null,
      csrf: req.session?.csrf ?? '',
      path: req.url.split('?')[0],
      mock: cfg.useMock,
      ok: typeof req.query?.ok === 'string' ? req.query.ok.slice(0, 300) : '',
      err: typeof req.query?.err === 'string' ? req.query.err.slice(0, 300) : '',
      lastSync: req.user ? lastSync(db) : null,
      appearance: getAppearance(db),
      tableCss: tableStyleCss(settings.tableStyles),
      marginBands: normaliseBands(settings.marginBandsVsTarget),
      columnHelp: req.user ? columnHelpOn(db, req.user.id) : false,
      columnHelpData: COLUMN_HELP,
      pageWidth: req.user ? pageWidthOf(db, req.user.id) : 'full',
      pageWidths: PAGE_WIDTHS,
    };
    return this.type('text/html; charset=utf-8').view(template, { ...base, ...data });
  });

  // ------------------------------------------------------------------ security
  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    if (!isAsset(req.url.split('?')[0])) reply.header('Cache-Control', 'no-store');
  });

  app.addHook('onRequest', async (req, reply) => {
    const p = req.url.split('?')[0];
    if (isAsset(p)) return;
    req.started = Date.now();

    if (countUsers(db) === 0) {
      if (p !== '/setup') return reply.redirect('/setup');
      return;
    }
    let found = null;
    const raw = req.cookies?.[SESSION_COOKIE];
    if (raw) {
      const u = req.unsignCookie(raw);
      if (u.valid) found = getSession(db, u.value, now());
    }
    if (found) {
      req.user = found.user;
      req.session = found.session;
    }
    if (p === '/login' || p === '/setup') return;
    if (!req.user) {
      if (req.headers['hx-request']) return reply.header('HX-Redirect', '/login').status(401).send('');
      const next = req.method === 'GET' ? `?next=${encodeURIComponent(req.url)}` : '';
      return reply.redirect(`/login${next}`);
    }
  });

  // CSRF: every state-changing request from a signed-in user must carry the session's token.
  app.addHook('preHandler', async (req) => {
    if (!req.user || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    const token = req.body?._csrf ?? req.headers['x-csrf-token'];
    if (!safeEqual(token, req.session.csrf)) throw new UserError('Your page expired. Please go back, reload it and try again.', 403);
  });

  app.addHook('onResponse', async (req, reply) => {
    const p = req.url.split('?')[0];
    if (isAsset(p)) return;
    log.info(`${req.method} ${p} ${reply.statusCode} ${Date.now() - (req.started ?? Date.now())}ms${req.user ? ` (${req.user.username})` : ''}`);
  });

  app.decorate('requireAdmin', async (req) => {
    if (!req.user?.isAdmin) throw forbidden('Only an Admin can do that.');
  });

  // ------------------------------------------------------------------- errors
  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : err instanceof UserError ? err.status : 500;
    const safe = err instanceof UserError || (status >= 400 && status < 500 && err.statusCode);
    const ref = randomBytes(3).toString('hex');
    if (status >= 500) log.error(`[${ref}] ${req.method} ${req.url}: ${err.stack ?? err.message}`);
    if (req.headers['hx-request'] && status < 500) {
      return reply.status(200).header('HX-Retarget', '#flash').header('HX-Reswap', 'innerHTML').send(`<div class="flash flash-err">${escapeHtml(err.message)}</div>`);
    }
    const view = {
      status,
      title: status === 404 ? 'Not Found' : status === 403 ? 'Not Allowed' : status >= 500 ? 'Something Went Wrong' : 'Problem',
      message: safe ? err.message : `Something went wrong on our side. Reference ${ref}. See the console window for details.`,
    };
    return reply.status(status).page('error.njk', view);
  });
  app.setNotFoundHandler((req, reply) => reply.status(404).page('error.njk', { status: 404, title: 'Not Found', message: 'That page was not found.' }));

  app.get('/healthz', async () => ({ ok: true }));

  // -------------------------------------------------------------------- routes
  await app.register(authRoutes);
  await app.register(dashboardRoutes);
  await app.register(jobRoutes);
  await app.register(postMortemRoutes);
  await app.register(actionRoutes);
  await app.register(settingsRoutes);
  await app.register(reportRoutes);
  await app.register(studyRoutes);
  await app.register(accuracyRoutes);

  const sweep = setInterval(() => purgeExpiredSessions(db, now()), 3600_000);
  sweep.unref();
  app.addHook('onClose', async () => clearInterval(sweep));

  return app;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
