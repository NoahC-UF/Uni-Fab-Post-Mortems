// Read-only Epicor REST v2 client.
//
//   GET {BASE}/api/v2/odata/{COMPANY}/BaqSvc/{BAQ_ID}/Data
//   headers: X-API-Key + Basic auth (the integration user)
//
// SAFETY: this class only ever issues HTTP GET. There is deliberately no method
// for POST/PATCH/PUT/DELETE, and request() hard-codes GET. Credentials are never
// logged: every message goes through maskSecrets().

import { maskSecrets } from '../mask.js';

export class EpicorError extends Error {
  constructor(message, { status = null, retryable = false } = {}) {
    super(message);
    this.name = 'EpicorError';
    this.status = status;
    this.retryable = retryable;
  }
}

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

export class EpicorClient {
  /**
   * @param {{baseUrl,company,apiKey,username,password}} creds
   * @param {{fetchImpl?,sleep?,timeoutMs?,retries?,backoffMs?,pageSize?,logger?,secrets?}} opts
   */
  constructor(creds, opts = {}) {
    this.creds = creds;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.sleep = opts.sleep ?? sleepReal;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.retries = opts.retries ?? 3;
    this.backoffMs = opts.backoffMs ?? 1000;
    this.pageSize = opts.pageSize ?? 1000;
    this.logger = opts.logger ?? { info() {}, warn() {}, error() {} };
    this.secrets = opts.secrets ?? [creds.apiKey, creds.password, creds.username].filter(Boolean);
  }

  mask(text) {
    return maskSecrets(text, this.secrets);
  }

  baqUrl(baqId, query = {}) {
    const { baseUrl, company } = this.creds;
    const u = new URL(`${baseUrl}/api/v2/odata/${encodeURIComponent(company)}/BaqSvc/${encodeURIComponent(baqId)}/Data`);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    }
    return u;
  }

  headers() {
    const { apiKey, username, password } = this.creds;
    return {
      Accept: 'application/json',
      'X-API-Key': apiKey,
      Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
    };
  }

  /** One GET with timeout, retry and backoff. Returns parsed JSON. */
  async request(url) {
    let attempt = 0;
    for (;;) {
      try {
        return await this.#once(url);
      } catch (err) {
        const e = err instanceof EpicorError ? err : this.#wrap(err);
        if (!e.retryable || attempt >= this.retries) throw e;
        const wait = this.backoffMs * 2 ** attempt + Math.floor(Math.random() * 250);
        this.logger.warn(`Epicor request failed (${e.message}); retry ${attempt + 1}/${this.retries} in ${wait} ms`);
        await this.sleep(wait);
        attempt++;
      }
    }
  }

  async #once(url) {
    let res;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET', // read-only: never anything else
        headers: this.headers(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw this.#wrap(err);
    }
    if (res.ok) {
      try {
        return await res.json();
      } catch {
        throw new EpicorError('Epicor returned a response that is not valid JSON.', { status: res.status });
      }
    }
    let detail = '';
    try {
      detail = this.mask((await res.text()).slice(0, 300).replace(/\s+/g, ' '));
    } catch {
      /* ignore */
    }
    const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
    throw new EpicorError(`${friendlyStatus(res.status)}${detail ? ` Details: ${detail}` : ''}`, { status: res.status, retryable });
  }

  #wrap(err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return new EpicorError(`Epicor did not answer within ${Math.round(this.timeoutMs / 1000)} seconds.`, { retryable: true });
    }
    const cause = err?.cause?.code ? ` (${err.cause.code})` : '';
    return new EpicorError(`Could not reach Epicor${cause}. Check EPICOR_BASE_URL and the network.`, { retryable: true });
  }

  /**
   * Fetch every row of a BAQ, paging with $top/$skip.
   * @param {string} baqId
   * @param {{params?:object, filter?:string, select?:string, orderBy?:string, pageSize?:number, maxRows?:number}} opts
   */
  async fetchAll(baqId, opts = {}) {
    const { params = {}, filter, select, orderBy, maxRows = Infinity } = opts;
    const pageSize = opts.pageSize ?? this.pageSize;
    const rows = [];
    let skip = 0;
    for (;;) {
      const top = Math.min(pageSize, maxRows - rows.length);
      if (top <= 0) break;
      const url = this.baqUrl(baqId, { ...params, $filter: filter, $select: select, $orderby: orderBy, $top: top, $skip: skip || undefined });
      const body = await this.request(url);
      const page = Array.isArray(body?.value) ? body.value : [];
      rows.push(...page);
      if (page.length < top) break;
      skip += page.length;
    }
    return rows;
  }

  /** Pass/fail only. Never returns or logs credential values. */
  async testConnection(baqId) {
    try {
      const rows = await this.fetchAll(baqId, { params: { FromDate: '2999-01-01' }, maxRows: 1, pageSize: 1 });
      return { ok: true, message: `Connected. ${baqId} answered (${rows.length} row sample).` };
    } catch (err) {
      return { ok: false, message: this.mask(err.message), status: err.status ?? null };
    }
  }
}

function friendlyStatus(status) {
  switch (status) {
    case 400:
      return 'Epicor rejected the request (400). A BAQ parameter name or value may be wrong.';
    case 401:
      return 'Epicor refused the sign-in (401). Check EPICOR_USERNAME, EPICOR_PASSWORD and EPICOR_API_KEY.';
    case 403:
      return 'Epicor says this user is not allowed to run that BAQ (403). Check BAQ sharing and security (docs/BAQ_SETUP.md 3.2).';
    case 404:
      return 'Epicor could not find that BAQ (404). Check the BAQ ID, that it is Shared, and EPICOR_COMPANY.';
    case 408:
      return 'Epicor timed out (408).';
    case 429:
      return 'Epicor asked us to slow down (429).';
    default:
      return status >= 500 ? `Epicor had a server error (${status}).` : `Epicor returned an error (${status}).`;
  }
}
