import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smoneyK } from '../src/format.js';

test('smoneyK: short signed amounts for small print', () => {
  assert.equal(smoneyK(201024), '+$201k');
  assert.equal(smoneyK(722107), '+$722k');
  assert.equal(smoneyK(2000), '+$2k');
  assert.equal(smoneyK(-214414), '-$214k');
  assert.equal(smoneyK(905.4), '+$905');
  assert.equal(smoneyK(-12), '-$12');
  assert.equal(smoneyK(0), '$0');
  assert.equal(smoneyK(0.2), '$0');
  assert.equal(smoneyK(1234567), '+$1.2M');
  assert.equal(smoneyK(-2000000), '-$2M');
  assert.equal(smoneyK(999600), '+$1M', 'rounds up to a million rather than showing 1000k');
  assert.equal(smoneyK(null), '');
  assert.equal(smoneyK('abc'), '');
});
