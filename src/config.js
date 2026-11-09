// Reads settings from environment variables (loaded from .env by Node's --env-file).
// Credentials live ONLY here. Nothing in this file ever prints them.

function clean(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function toBool(v, dflt) {
  const s = clean(v).toLowerCase();
  if (s === '') return dflt;
  return s === 'true' || s === '1' || s === 'yes';
}

export function loadConfig(env = process.env) {
  return {
    useMock: toBool(env.USE_MOCK_DATA, true),
    port: Number(env.PORT) || 8080,
    host: clean(env.HOST) || '127.0.0.1',
    secretKey: clean(env.APP_SECRET_KEY),
    dbPath: clean(env.DB_PATH) || 'data/postmortem.db',
    importDir: clean(env.IMPORT_DIR) || 'import',
    epicor: {
      baseUrl: clean(env.EPICOR_BASE_URL).replace(/\/+$/, ''),
      company: clean(env.EPICOR_COMPANY),
      apiKey: clean(env.EPICOR_API_KEY),
      username: clean(env.EPICOR_USERNAME),
      password: clean(env.EPICOR_PASSWORD),
    },
  };
}

/** Names (never values) of required Epicor settings that are still empty. */
export function missingEpicorSettings(cfg) {
  const names = {
    baseUrl: 'EPICOR_BASE_URL',
    company: 'EPICOR_COMPANY',
    apiKey: 'EPICOR_API_KEY',
    username: 'EPICOR_USERNAME',
    password: 'EPICOR_PASSWORD',
  };
  return Object.entries(names)
    .filter(([k]) => !cfg.epicor[k])
    .map(([, envName]) => envName);
}

/** Secret values, used only to scrub them out of log lines and error messages. */
export function secretValues(cfg) {
  const e = cfg.epicor;
  const vals = [e.apiKey, e.password, e.username, cfg.secretKey];
  if (e.username && e.password) {
    vals.push(Buffer.from(`${e.username}:${e.password}`).toString('base64'));
  }
  return vals.filter((v) => v && v.length >= 3);
}
