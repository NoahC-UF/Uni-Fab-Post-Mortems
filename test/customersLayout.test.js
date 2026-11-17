import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeSession } from './helpers.js';

const URL_ = '/accuracy/customers?from=2000-01-01&to=2999-01-01&minJobs=1';

describe('Customers page layout', () => {
  let S;
  let body;
  before(async () => { S = await makeSession(); body = (await S.admin.get(URL_)).body; });

  test('every shortened column heading still explains itself on hover (its own text, not the one of another table)', () => {
    const head = /<table data-table="acc-customers"[^>]*>\s*<thead>(.*?)<\/thead>/s.exec(body)[1];
    const th = (label) => new RegExp(`<th[^>]*data-help="([^"]*)"[^>]*>${label.replace(/[$%]/g, '\\$&')}</th>`).exec(head)?.[1];
    for (const label of ['Manager', 'Est $', 'Act $', 'Net Var $', 'Var %', 'Sale $', 'Target %', 'vs Target $', 'Labour $', 'Material $', 'Other $', '% Off']) {
      const text = th(label);
      assert.ok(text && text.length > 20, `${label} has its own help text`);
    }
    assert.match(th('Est $'), /set up to cost/, 'Est $ here is the planned job cost, not the material estimate of the other tables');
    assert.match(th('Act $'), /Sale \$ less Act \$ is the margin/);
    assert.match(th('Net Var $'), /Act \$ minus Est \$/);
    assert.ok(!/Total Est|Total Act|Avg Var|Sale Price/.test(head), 'no old long names left in the headings or their help');
  });

  test('"How Often vs How Far Off" is a fold that starts closed, and its chart is only drawn once opened', () => {
    const fold = /<details class="card card-fold" id="bubbleFold"([^>]*)>/.exec(body);
    assert.ok(fold, 'a fold');
    assert.ok(!/\sopen/.test(fold[1]), 'closed to begin with');
    assert.match(body, /<summary><h2>How Often vs How Far Off<\/h2>/);
    assert.ok(body.includes('id="bubbleChart"') && body.includes('id="bubbleData"'), 'the chart and its data are inside it');
    const fn = readFileSync(new URL('../public/accuracy.js', import.meta.url), 'utf8');
    assert.ok(fn.includes("getElementById('bubbleFold')") && fn.includes("addEventListener('toggle'") && fn.includes('drawBubble'), 'drawn when first opened');
  });
});
