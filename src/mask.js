// Scrubs secret values out of any text before it is logged or shown to a user.

export function maskSecrets(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) {
    if (!s || s.length < 3) continue;
    out = out.split(s).join('***');
  }
  // Belt and braces: never let an Authorization / API key header value through.
  out = out.replace(/(authorization["']?\s*[:=]\s*["']?)(basic|bearer)\s+[A-Za-z0-9+/=._-]+/gi, '$1$2 ***');
  out = out.replace(/(x-api-key["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1***');
  return out;
}

export function makeLogger(secrets = [], sink = console) {
  const wrap = (level) => (...args) =>
    sink[level](...args.map((a) => (typeof a === 'string' ? maskSecrets(a, secrets) : maskSecrets(safeString(a), secrets))));
  return { info: wrap('log'), warn: wrap('warn'), error: wrap('error') };
}

function safeString(a) {
  if (a instanceof Error) return a.message;
  try {
    return typeof a === 'object' ? JSON.stringify(a) : String(a);
  } catch {
    return String(a);
  }
}
