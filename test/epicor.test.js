import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EpicorClient, EpicorError } from '../src/epicor/client.js';
import { mapRows, checkColumns, coerce, FieldMapError, toRawRow } from '../src/epicor/mapper.js';
import { BAQ_MAP } from '../src/epicor/epicor_field_map.js';

const creds = { baseUrl: 'https://test.epicorsaas.com/SaaS123', company: 'UF', apiKey: 'KEY-SECRET-1', username: 'svc_pm', password: 'Pa$$w0rd-X' };

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
      text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? '')),
    };
  };
  fn.calls = calls;
  return fn;
}
const mkClient = (responses, o = {}) => {
  const f = fakeFetch(responses);
  const client = new EpicorClient(creds, { fetchImpl: f, sleep: async () => {}, backoffMs: 1, ...o });
  return { client, f };
};

describe('Epicor client is read-only and builds the right request', () => {
  test('only ever uses GET, with API key and basic auth headers', async () => {
    const { client, f } = mkClient([{ status: 200, body: { value: [{ a: 1 }] } }]);
    await client.fetchAll('UF_PM_JobHeader', { params: { FromDate: '2025-01-01' } });
    for (const c of f.calls) assert.equal(c.init.method, 'GET');
    const h = f.calls[0].init.headers;
    assert.equal(h['X-API-Key'], 'KEY-SECRET-1');
    assert.equal(h.Authorization, `Basic ${Buffer.from('svc_pm:Pa$$w0rd-X').toString('base64')}`);
  });

  test('URL matches the BAQ v2 pattern and carries parameters and OData options', async () => {
    const { client, f } = mkClient([{ status: 200, body: { value: [] } }]);
    await client.fetchAll('UF_PM_JobHeader', { params: { FromDate: '2025-01-01' }, filter: "JobHead_JobNum eq '1001'", select: 'JobHead_JobNum', orderBy: 'JobHead_JobNum', pageSize: 500 });
    const u = new URL(f.calls[0].url);
    assert.equal(u.pathname, '/SaaS123/api/v2/odata/UF/BaqSvc/UF_PM_JobHeader/Data');
    assert.equal(u.searchParams.get('FromDate'), '2025-01-01');
    assert.equal(u.searchParams.get('$filter'), "JobHead_JobNum eq '1001'");
    assert.equal(u.searchParams.get('$select'), 'JobHead_JobNum');
    assert.equal(u.searchParams.get('$orderby'), 'JobHead_JobNum');
    assert.equal(u.searchParams.get('$top'), '500');
    assert.equal(u.searchParams.get('$skip'), null);
  });

  test('exposes no write methods', () => {
    const { client } = mkClient([]);
    for (const name of ['post', 'put', 'patch', 'delete', 'update', 'create']) assert.equal(typeof client[name], 'undefined');
  });

  test('pages with $top/$skip until a short page', async () => {
    const page = (n) => ({ status: 200, body: { value: Array.from({ length: n }, (_, i) => ({ i })) } });
    const { client, f } = mkClient([page(2), page(2), page(1)]);
    const rows = await client.fetchAll('X', { pageSize: 2 });
    assert.equal(rows.length, 5);
    assert.equal(f.calls.length, 3);
    assert.equal(new URL(f.calls[1].url).searchParams.get('$skip'), '2');
    assert.equal(new URL(f.calls[2].url).searchParams.get('$skip'), '4');
  });

  test('maxRows stops early', async () => {
    const { client, f } = mkClient([{ status: 200, body: { value: [{ a: 1 }] } }]);
    const rows = await client.fetchAll('X', { maxRows: 1, pageSize: 1 });
    assert.equal(rows.length, 1);
    assert.equal(f.calls.length, 1);
  });
});

describe('retries, timeouts and errors', () => {
  test('retries 5xx then succeeds', async () => {
    const { client, f } = mkClient([{ status: 503, body: 'busy' }, { status: 502, body: 'bad' }, { status: 200, body: { value: [{ a: 1 }] } }]);
    const rows = await client.fetchAll('X');
    assert.equal(rows.length, 1);
    assert.equal(f.calls.length, 3);
  });
  test('retries network failures', async () => {
    const { client, f } = mkClient([new TypeError('fetch failed'), { status: 200, body: { value: [] } }]);
    await client.fetchAll('X');
    assert.equal(f.calls.length, 2);
  });
  test('gives up after the retry limit', async () => {
    const { client, f } = mkClient([{ status: 500, body: '' }, { status: 500, body: '' }, { status: 500, body: '' }, { status: 500, body: '' }, { status: 500, body: '' }]);
    await assert.rejects(client.fetchAll('X'), (e) => e instanceof EpicorError && e.status === 500);
    assert.equal(f.calls.length, 4, '1 try + 3 retries');
  });
  test('does NOT retry auth or not-found errors', async () => {
    for (const status of [400, 401, 403, 404]) {
      const { client, f } = mkClient([{ status, body: 'nope' }]);
      await assert.rejects(client.fetchAll('X'));
      assert.equal(f.calls.length, 1, `status ${status}`);
    }
  });
  test('timeout is reported as a retryable timeout', async () => {
    const err = new Error('aborted');
    err.name = 'TimeoutError';
    const { client } = mkClient([err, err, err, err]);
    await assert.rejects(client.fetchAll('X'), /did not answer/);
  });
  test('invalid JSON gives a clear error', async () => {
    const f = async () => ({ ok: true, status: 200, json: async () => { throw new Error('x'); }, text: async () => '' });
    const client = new EpicorClient(creds, { fetchImpl: f, sleep: async () => {} });
    await assert.rejects(client.fetchAll('X'), /not valid JSON/);
  });
});

describe('credentials never leak', () => {
  test('error messages have secrets masked, even if Epicor echoes them back', async () => {
    const { client } = mkClient([{ status: 400, body: 'bad request for svc_pm using Pa$$w0rd-X and KEY-SECRET-1' }]);
    await assert.rejects(client.fetchAll('X'), (e) => {
      for (const s of ['svc_pm', 'Pa$$w0rd-X', 'KEY-SECRET-1']) assert.ok(!e.message.includes(s), `leaked ${s}`);
      return true;
    });
  });
  test('testConnection returns pass/fail and message only', async () => {
    const { client } = mkClient([{ status: 401, body: 'denied svc_pm' }]);
    const r = await client.testConnection('UF_PM_JobHeader');
    assert.equal(r.ok, false);
    assert.deepEqual(Object.keys(r).sort(), ['message', 'ok', 'status']);
    assert.ok(!JSON.stringify(r).includes('svc_pm'));
    assert.ok(!JSON.stringify(r).includes('KEY-SECRET-1'));
    const ok = await mkClient([{ status: 200, body: { value: [] } }]).client.testConnection('UF_PM_JobHeader');
    assert.equal(ok.ok, true);
  });
});

describe('field map and mapper', () => {
  test('every BAQ has a key and required columns', () => {
    for (const [key, spec] of Object.entries(BAQ_MAP)) {
      assert.ok(spec.id.startsWith('UF_PM_'), key);
      const fields = Object.values(spec.columns).map((c) => c[0]);
      for (const k of spec.keys) assert.ok(fields.includes(k), `${key} key ${k} not mapped`);
      assert.ok(Object.values(spec.columns).some((c) => c[2] === 'req'), key);
    }
  });

  test('coercion handles Epicor date strings, nulls, bools and numbers', () => {
    assert.equal(coerce('2025-03-04T00:00:00', 'date'), '2025-03-04');
    assert.equal(coerce('2025-03-04T00:00:00-05:00', 'date'), '2025-03-04');
    assert.equal(coerce('0001-01-01T00:00:00', 'date'), null, 'Epicor empty date');
    assert.equal(coerce(null, 'date'), null);
    assert.equal(coerce('true', 'bool'), true);
    assert.equal(coerce(0, 'bool'), false);
    assert.equal(coerce(null, 'bool'), false);
    assert.equal(coerce('12.5', 'number'), 12.5);
    assert.equal(coerce(null, 'number'), 0);
    assert.equal(coerce(' 104001 ', 'string'), '104001');
    assert.equal(coerce(7.9, 'int'), 7);
    assert.equal(coerce(null, 'id'), null, 'no order = null, not 0');
    assert.equal(coerce(0, 'id'), null);
    assert.equal(coerce(52001, 'id'), 52001);
  });

  test('maps a BAQ-shaped row to app fields', () => {
    const raw = toRawRow('jobOperations', { jobNum: '1001', assemblySeq: 0, oprSeq: 10, opCode: 'WELD', estSetHours: 1, estProdHours: 2, actSetupHours: 1, actProdHours: 3, runQty: 5, qtyCompleted: 5, opComplete: true, subcontract: false });
    const { rows, check } = mapRows('jobOperations', [raw]);
    assert.equal(rows[0].jobNum, '1001');
    assert.equal(rows[0].opCode, 'WELD');
    assert.equal(rows[0].opComplete, true);
    assert.ok(check.ok);
  });

  test('a missing REQUIRED column stops the sync with the column name', () => {
    const raw = toRawRow('jobOperations', { jobNum: '1001', assemblySeq: 0, oprSeq: 10, opCode: 'WELD' });
    delete raw.JobOper_EstProdHours;
    assert.throws(() => mapRows('jobOperations', [raw]), (e) => e instanceof FieldMapError && /JobOper_EstProdHours/.test(e.message));
  });

  test('field check reports missing (by severity) and unexpected columns', () => {
    const raw = { JobHead_JobNum: '1', JobHead_ProdQty: 1, JobHead_QtyCompleted: 0, JobHead_JobClosed: false, JobHead_Surprise: 'x' };
    const c = checkColumns('jobHeader', raw);
    assert.equal(c.ok, true);
    assert.ok(c.missing.warn.some((m) => m.column === 'JobHead_PartNum'));
    assert.ok(c.missing.optional.some((m) => m.column === 'JobHead_RevisionNum'));
    assert.deepEqual(c.unexpected, ['JobHead_Surprise']);
  });

  test('a one-line rename in the map is all it takes', () => {
    const spec = BAQ_MAP.jobOperations.columns;
    const orig = spec.JobOper_OpCode;
    delete spec.JobOper_OpCode;
    spec.JobOper_OpCodeNew = orig;
    try {
      const raw = toRawRow('jobOperations', { jobNum: '1', assemblySeq: 0, oprSeq: 10, estSetHours: 0, estProdHours: 0, actSetupHours: 0, actProdHours: 0, runQty: 0, qtyCompleted: 0, opComplete: true });
      raw.JobOper_OpCodeNew = 'WELD';
      assert.equal(mapRows('jobOperations', [raw]).rows[0].opCode, 'WELD');
    } finally {
      delete spec.JobOper_OpCodeNew;
      spec.JobOper_OpCode = orig;
    }
  });
});
