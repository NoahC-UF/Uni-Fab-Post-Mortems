// A data source that behaves like the five Epicor BAQs, but serves fake data.
// It applies the same scope rule as the real BAQs: open jobs always, closed jobs only
// when closed on/after FromDate. Rows come out with Epicor's column names, so the
// whole pipeline (field map -> staging -> variance engine) is exercised exactly as
// it will be with real data.

import { generateMockData } from './mockData.js';
import { toRawRow } from '../epicor/mapper.js';

export class MockSource {
  constructor(opts = {}) {
    this.name = 'mock';
    this.data = generateMockData(opts);
  }

  async fetchBaq(key, { fromDate } = {}) {
    const d = this.data;
    const inScope = (job) => (job.closed ? !!job.closedDate && job.closedDate >= (fromDate ?? '1900-01-01') : true);
    const jobs = d.jobs.filter(inScope);
    const scope = new Set(jobs.map((j) => j.jobNum));
    const stamp = (row) => ({ ...row, scopeDate: d.jobs.find((j) => j.jobNum === row.jobNum)?.scopeDate });

    switch (key) {
      case 'jobHeader': {
        const rows = [];
        for (const j of jobs) {
          rows.push(toRawRow(key, j));
          if (j._extraOrder) rows.push(toRawRow(key, { ...j, ...j._extraOrder }));
        }
        return rows;
      }
      case 'jobOperations':
        return d.ops.filter((o) => scope.has(o.jobNum)).map((o) => toRawRow(key, stamp(o)));
      case 'laborDetail':
        return d.labor.filter((l) => scope.has(l.jobNum)).map((l) => toRawRow(key, stamp(l)));
      case 'jobMaterials':
        return d.mtls.filter((m) => scope.has(m.jobNum)).map((m) => toRawRow(key, stamp(m)));
      case 'materialTransactions':
        return d.trans.filter((t) => scope.has(t.jobNum)).map((t) => toRawRow(key, stamp(t)));
      case 'jobRevenue':
        return d.revenue.filter((r) => scope.has(r.jobNum)).map((r) => toRawRow(key, r));
      default:
        throw new Error(`Unknown BAQ key: ${key}`);
    }
  }

  /**
   * Demo helper: pretend someone corrected hours in Epicor after a review started.
   * Adds hours to the first operation of a few closed jobs (and to its last labour row).
   * Returns the job numbers that changed.
   */
  simulateChanges(jobNums = null, extraHours = 2.5) {
    const targets = jobNums ?? this.data.jobs.filter((j) => j.closed).slice(0, 3).map((j) => j.jobNum);
    for (const jobNum of targets) {
      const op = this.data.ops.find((o) => o.jobNum === jobNum && !o.subcontract && o.actProdHours > 0);
      if (!op) continue;
      op.actProdHours = Math.round((op.actProdHours + extraHours) * 100) / 100;
      const rows = this.data.labor.filter((l) => l.jobNum === jobNum && l.oprSeq === op.oprSeq && l.assemblySeq === op.assemblySeq && l.laborType === 'P');
      const last = rows[rows.length - 1];
      if (last) {
        last.laborHrs = Math.round((last.laborHrs + extraHours) * 100) / 100;
        last.burdenHrs = last.laborHrs;
        last.clockOutTime = Math.round((last.clockInTime + last.laborHrs) * 100) / 100;
      }
    }
    return targets;
  }
}
