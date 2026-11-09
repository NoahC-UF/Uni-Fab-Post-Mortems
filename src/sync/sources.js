// Chooses where data comes from: fake data (mock), or Epicor over the REST API.
// (A CSV/Excel import-folder source is added in phase 1b.)

import { EpicorClient } from '../epicor/client.js';
import { BAQ_MAP, columnFor } from '../epicor/epicor_field_map.js';
import { MockSource } from '../mock/mockSource.js';
import { missingEpicorSettings, secretValues } from '../config.js';

export class EpicorSource {
  constructor(cfg, logger) {
    this.name = 'epicor';
    this.client = new EpicorClient(cfg.epicor, { logger, secrets: secretValues(cfg) });
  }

  async fetchBaq(key, { fromDate }) {
    const spec = BAQ_MAP[key];
    const orderBy = spec.keys.map((f) => columnFor(key, f)).filter(Boolean).join(',');
    return this.client.fetchAll(spec.id, { params: { FromDate: fromDate }, orderBy });
  }
}

let mockSingleton = null;

/** The mock source is kept for the life of the process so "simulate change" sticks until restart. */
export function createSource(cfg, logger) {
  if (cfg.useMock) {
    mockSingleton ??= new MockSource();
    return mockSingleton;
  }
  const missing = missingEpicorSettings(cfg);
  if (missing.length) {
    throw new Error(`Epicor is not configured. These .env settings are empty: ${missing.join(', ')}. Fill them in, or set USE_MOCK_DATA=true.`);
  }
  return new EpicorSource(cfg, logger);
}

export function resetMockSource() {
  mockSingleton = null;
}
