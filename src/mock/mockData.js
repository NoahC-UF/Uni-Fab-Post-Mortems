// Realistic FAKE job data for demos and development (USE_MOCK_DATA=true).
// Uses Uni-Fab's op codes: LSRSRT, PRGRMCHK, FORM, WELD, ASSY, PAINT, FQLTY, PACK.
// Everything here is invented: customers, part numbers, people, hours and costs.
//
// The generator is seeded, so the same seed gives the same jobs (dates are
// relative to "now", so there are always jobs in the last 12 months).

import { r2 } from '../engine/num.js';

// ------------------------------------------------------------------ helpers
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const round = (v, dp = 2) => Math.round(v * 10 ** dp) / 10 ** dp;
const quarter = (v) => Math.round(v * 4) / 4;

// ------------------------------------------------------------------ master data
export const RESOURCE_GROUPS = {
  PGM: { desc: 'Programming', setLab: 45, prodLab: 45, setBur: 15, prodBur: 15 },
  LASER: { desc: 'Laser cutting', setLab: 34, prodLab: 34, setBur: 66, prodBur: 66 },
  BRAKE: { desc: 'Press brake', setLab: 36, prodLab: 36, setBur: 34, prodBur: 34 },
  WELD1: { desc: 'Welding', setLab: 38, prodLab: 38, setBur: 22, prodBur: 22 },
  ASSY1: { desc: 'Assembly', setLab: 32, prodLab: 32, setBur: 18, prodBur: 18 },
  PAINT1: { desc: 'Paint booth', setLab: 34, prodLab: 34, setBur: 46, prodBur: 46 },
  QA1: { desc: 'Quality inspection', setLab: 40, prodLab: 40, setBur: 15, prodBur: 15 },
  PACK1: { desc: 'Packing and shipping', setLab: 28, prodLab: 28, setBur: 12, prodBur: 12 },
  OSP: { desc: 'Outside processing', setLab: 0, prodLab: 0, setBur: 0, prodBur: 0 },
};

// set = typical setup hours; biasSet/biasRun = how much actuals tend to differ from estimates
const OPS = {
  PRGRMCHK: { desc: 'Program check', rg: 'PGM', set: 0.75, biasSet: 1.08, biasRun: 1.0 },
  LSRSRT: { desc: 'Laser cut and sort', rg: 'LASER', set: 0.5, biasSet: 0.97, biasRun: 0.96 },
  FORM: { desc: 'Press brake forming', rg: 'BRAKE', set: 1.0, biasSet: 1.02, biasRun: 1.03 },
  WELD: { desc: 'Weld', rg: 'WELD1', set: 0.5, biasSet: 1.0, biasRun: 1.07 },
  ASSY: { desc: 'Assembly', rg: 'ASSY1', set: 0.25, biasSet: 1.03, biasRun: 1.04 },
  PAINT: { desc: 'Paint', rg: 'PAINT1', set: 0.75, biasSet: 0.98, biasRun: 0.97 },
  FQLTY: { desc: 'Final quality check', rg: 'QA1', set: 0.25, biasSet: 1.0, biasRun: 1.04 },
  PACK: { desc: 'Pack and ship', rg: 'PACK1', set: 0.1, biasSet: 0.95, biasRun: 0.95 },
  OSPLATE: { desc: 'Outside plating (subcontract)', rg: 'OSP', set: 0, biasSet: 1, biasRun: 1, subcontract: true },
};

const CUSTOMERS = [
  ['NORTHLN', 'Northline Equipment'],
  ['MAPLERG', 'Maple Ridge Industrial'],
  ['GLAGRI', 'Great Lakes Agri'],
  ['KESTREL', 'Kestrel Transit'],
  ['BAYVIEW', 'Bayview Food Equipment'],
  ['IRONWD', 'Ironwood Mining Supply'],
  ['TRICNTY', 'Tri-County Hydro'],
  ['PINECRS', 'Pinecrest Trailers'],
  ['LAKESHR', 'Lakeshore Controls'],
  ['HURONRL', 'Huron Rail Services'],
];

const EMPLOYEES = [
  ['1001', 'J. Tremblay', '1', ['LSRSRT', 'PRGRMCHK']],
  ['1002', 'M. Singh', '1', ['FORM', 'LSRSRT']],
  ['1003', 'D. Roy', '2', ['FORM']],
  ['1004', 'K. Patel', '1', ['WELD']],
  ['1005', 'L. Fortin', '1', ['WELD', 'ASSY']],
  ['1006', 'S. Nguyen', '2', ['WELD']],
  ['1007', 'B. MacDonald', '1', ['ASSY']],
  ['1008', 'A. Gagnon', '2', ['ASSY', 'PACK']],
  ['1009', 'R. Dhillon', '1', ['PAINT']],
  ['1010', 'T. Bouchard', '1', ['FQLTY']],
  ['1011', 'C. Wong', '2', ['PACK', 'FQLTY']],
  ['1012', 'P. Lavoie', '1', ['PRGRMCHK', 'LSRSRT']],
  ['1013', "E. O'Brien", '2', ['LSRSRT', 'FORM']],
  ['1014', 'N. Campbell', '2', ['WELD', 'PAINT']],
];

// A routing step is [opCode, assemblySeq]. perPc = hours per piece at each op.
const PARTS = [
  {
    num: 'BRKT-1001', desc: 'Mounting bracket 14ga', qty: [50, 400],
    route: [['LSRSRT', 0], ['FORM', 0], ['PACK', 0]],
    perPc: { LSRSRT: 0.03, FORM: 0.05, PACK: 0.01 },
    mtl: [['PL-14GA-A36', 'Plate 14ga A36', 'LB', 1.8, 0.92, 'PLATE', 0, false], ['HW-KIT-BRKT', 'Bracket hardware kit', 'EA', 1, 0.72, 'HARDWARE', 0, true]],
  },
  {
    num: 'ENCL-2200', desc: 'Control enclosure', qty: [5, 40],
    route: [['PRGRMCHK', 0], ['LSRSRT', 0], ['FORM', 0], ['WELD', 0], ['PAINT', 0], ['ASSY', 0], ['FQLTY', 0], ['PACK', 0]],
    perPc: { PRGRMCHK: 0.01, LSRSRT: 0.35, FORM: 0.6, WELD: 1.4, PAINT: 0.5, ASSY: 1.1, FQLTY: 0.25, PACK: 0.15 },
    mtl: [['PL-11GA-A36', 'Plate 11ga A36', 'LB', 38, 0.94, 'PLATE', 0, false], ['HW-ENCL-KIT', 'Enclosure hardware kit', 'EA', 1, 14.5, 'HARDWARE', 0, true], ['GSKT-FOAM', 'Door gasket', 'FT', 9, 0.85, 'HARDWARE', 0, true]],
  },
  {
    num: 'FRAME-3100', desc: 'Machine base frame', qty: [2, 12],
    route: [['PRGRMCHK', 0], ['LSRSRT', 0], ['FORM', 0], ['WELD', 0], ['ASSY', 0], ['PAINT', 0], ['FQLTY', 0], ['PACK', 0]],
    perPc: { PRGRMCHK: 0.1, LSRSRT: 1.2, FORM: 1.8, WELD: 9, ASSY: 3, PAINT: 1.5, FQLTY: 0.8, PACK: 0.5 },
    mtl: [['TUBE-2X2-125', 'Tube 2x2x.125 A500', 'FT', 36, 3.1, 'TUBE', 0, false], ['PL-3/16-A36', 'Plate 3/16 A36', 'LB', 60, 0.88, 'PLATE', 0, false], ['HW-FRAME-KIT', 'Frame hardware kit', 'EA', 1, 31, 'HARDWARE', 0, true]],
  },
  {
    num: 'GUARD-4010', desc: 'Machine guard panel', qty: [10, 60],
    route: [['LSRSRT', 0], ['FORM', 0], ['WELD', 0], ['PAINT', 0], ['PACK', 0]],
    perPc: { LSRSRT: 0.2, FORM: 0.35, WELD: 0.9, PAINT: 0.4, PACK: 0.12 },
    mtl: [['PL-11GA-A36', 'Plate 11ga A36', 'LB', 22, 0.94, 'PLATE', 0, false], ['MESH-EXP-1', 'Expanded mesh', 'SF', 6, 2.2, 'PLATE', 0, false]],
  },
  {
    num: 'PLATE-5005', desc: 'Base plate 1/2in', qty: [4, 50],
    route: [['PRGRMCHK', 0], ['LSRSRT', 0], ['PACK', 0]],
    perPc: { PRGRMCHK: 0.02, LSRSRT: 0.25, PACK: 0.05 },
    mtl: [['PL-1/2-A36', 'Plate 1/2 A36', 'LB', 45, 0.86, 'PLATE', 0, false]],
  },
  {
    num: 'HOPPER-6200', desc: 'Hopper assembly', qty: [2, 10],
    route: [['PRGRMCHK', 1], ['LSRSRT', 1], ['FORM', 1], ['WELD', 1], ['WELD', 0], ['ASSY', 0], ['FQLTY', 0], ['PACK', 0]],
    perPc: { PRGRMCHK: 0.1, LSRSRT: 0.9, FORM: 1.5, WELD: 5, ASSY: 2, FQLTY: 0.6, PACK: 0.4 },
    sub: { 1: ['HOPPER-6210', 'Hopper chute sub-assembly'] },
    mtl: [['PL-11GA-A36', 'Plate 11ga A36', 'LB', 80, 0.94, 'PLATE', 1, false], ['TUBE-1X1-120', 'Tube 1x1x.120', 'FT', 18, 1.7, 'TUBE', 0, false], ['HW-HOPPER-KIT', 'Hopper hardware kit', 'EA', 1, 22, 'HARDWARE', 0, true]],
  },
  {
    num: 'DOOR-7100', desc: 'Access door', qty: [8, 50],
    route: [['LSRSRT', 0], ['FORM', 0], ['WELD', 0], ['PAINT', 0], ['ASSY', 0], ['PACK', 0]],
    perPc: { LSRSRT: 0.25, FORM: 0.4, WELD: 0.8, PAINT: 0.35, ASSY: 0.5, PACK: 0.1 },
    mtl: [['PL-14GA-A36', 'Plate 14ga A36', 'LB', 14, 0.92, 'PLATE', 0, false], ['HINGE-SS-3', 'Hinge 3in SS', 'EA', 2, 6.4, 'HARDWARE', 0, true], ['LATCH-QT-1', 'Quarter turn latch', 'EA', 1, 3.9, 'HARDWARE', 0, true]],
  },
  {
    num: 'COVER-8001', desc: 'Cover plate stainless', qty: [20, 150],
    route: [['LSRSRT', 0], ['FORM', 0], ['FQLTY', 0], ['PACK', 0]],
    perPc: { LSRSRT: 0.06, FORM: 0.1, FQLTY: 0.04, PACK: 0.02 },
    mtl: [['SS304-16GA', 'Stainless 304 16ga', 'LB', 3.2, 3.4, 'STAINLESS', 0, false]],
  },
  {
    num: 'STAND-9020', desc: 'Equipment stand', qty: [3, 20],
    route: [['PRGRMCHK', 1], ['LSRSRT', 1], ['WELD', 1], ['PRGRMCHK', 2], ['LSRSRT', 2], ['FORM', 2], ['WELD', 0], ['ASSY', 0], ['PAINT', 0], ['FQLTY', 0], ['PACK', 0]],
    perPc: { PRGRMCHK: 0.05, LSRSRT: 0.5, FORM: 0.7, WELD: 3.2, ASSY: 1.4, PAINT: 0.9, FQLTY: 0.4, PACK: 0.3 },
    sub: { 1: ['STAND-9021', 'Stand legs sub-assembly'], 2: ['STAND-9022', 'Stand top sub-assembly'] },
    mtl: [['TUBE-2X2-125', 'Tube 2x2x.125 A500', 'FT', 20, 3.1, 'TUBE', 1, false], ['PL-11GA-A36', 'Plate 11ga A36', 'LB', 30, 0.94, 'PLATE', 2, false], ['HW-STAND-KIT', 'Stand hardware kit', 'EA', 1, 9.5, 'HARDWARE', 0, true]],
  },
  {
    num: 'XMEMBR-1150', desc: 'Trailer cross member (plated)', qty: [10, 80],
    route: [['LSRSRT', 0], ['FORM', 0], ['WELD', 0], ['OSPLATE', 0], ['FQLTY', 0], ['PACK', 0]],
    perPc: { LSRSRT: 0.12, FORM: 0.3, WELD: 0.7, FQLTY: 0.08, PACK: 0.05 },
    mtl: [['PL-3/16-A36', 'Plate 3/16 A36', 'LB', 12, 0.88, 'PLATE', 0, false]],
  },
  {
    num: 'TRAY-1300', desc: 'Cable tray section', qty: [40, 300],
    route: [['LSRSRT', 0], ['FORM', 0], ['PACK', 0]],
    perPc: { LSRSRT: 0.05, FORM: 0.07, PACK: 0.01 },
    mtl: [['PL-14GA-GALV', 'Galvanized 14ga', 'LB', 4.4, 0.98, 'PLATE', 0, false]],
  },
  {
    num: 'ARM-1400', desc: 'Support arm', qty: [6, 60],
    route: [['LSRSRT', 0], ['FORM', 0], ['WELD', 0], ['ASSY', 0], ['PAINT', 0], ['FQLTY', 0], ['PACK', 0]],
    perPc: { LSRSRT: 0.18, FORM: 0.3, WELD: 1.1, ASSY: 0.6, PAINT: 0.3, FQLTY: 0.12, PACK: 0.08 },
    mtl: [['TUBE-1X1-120', 'Tube 1x1x.120', 'FT', 8, 1.7, 'TUBE', 0, false], ['PL-3/16-A36', 'Plate 3/16 A36', 'LB', 9, 0.88, 'PLATE', 0, false], ['HW-ARM-KIT', 'Support arm hardware kit', 'EA', 1, 4.2, 'HARDWARE', 0, true]],
  },
];

// Hand-placed situations so every screen has something interesting to show.
// key = job index. Unlisted jobs are "normal" (typical biases and noise).
// (job index % 4 === 3 is an in-progress job; the others are closed)
const SCENARIOS = {
  2: { part: 'FRAME-3100', weldMult: 2.1, note: 'weld blowout' },
  17: { part: 'ENCL-2200', weldMult: 1.9, note: 'weld blowout' },
  8: { part: 'ARM-1400', allMult: 0.55, note: 'big under-run (over-quoted)' },
  12: { part: 'ENCL-2200', shortQty: 0.8, slow: 1.5, note: 'short run, slow per piece' },
  13: { part: 'FRAME-3100', priceSpike: 1.35, note: 'steel price spike' },
  16: { part: 'DOOR-7100', scrapMtl: 1.28, returnMtl: true, note: 'material usage overrun with a return' },
  22: { part: 'GUARD-4010', unplannedOp: ['ASSY', 6], note: 'unplanned assembly work' },
  5: { part: 'BRKT-1001', closedOpenOp: true, note: 'job closed with an op never completed' },
  9: { part: 'GUARD-4010', completeZero: true, note: 'op marked complete with 0 hours' },
  14: { part: 'ARM-1400', hoursZeroQty: true, note: 'hours reported but 0 qty' },
  20: { part: 'ENCL-2200', laborMismatch: 1.5, note: 'LaborDtl does not match JobOper' },
  33: { part: 'DOOR-7100', laborMismatch: -1.0, note: 'LaborDtl does not match JobOper' },
  25: { part: 'ARM-1400', longShift: true, note: 'a 14 hour clock-in' },
  6: { noOrder: true },
  21: { noOrder: true },
  30: { noOrder: true },
  26: { multiOrder: true, note: 'job supplies two order lines' },
  // in-progress jobs
  43: { part: 'XMEMBR-1150', open: 'trendingOver', note: '90% of hours used, 40% of qty complete' },
  47: { part: 'STAND-9020', open: 'onTrack' },
  51: { part: 'HOPPER-6200', open: 'ahead' },
  55: { part: 'BRKT-1001', open: 'activeClock', note: 'operator still clocked in' },
};

// ------------------------------------------------------------------ generator
export function generateMockData({ now = new Date(), seed = 20251109, jobCount = 70 } = {}) {
  const rng = mulberry32(seed);
  const rand = (a, b) => a + (b - a) * rng();
  const randInt = (a, b) => Math.floor(rand(a, b + 1));
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
  const lognorm = (sigma) => Math.exp(sigma * gauss() - (sigma * sigma) / 2);

  const data = { jobs: [], ops: [], labor: [], mtls: [], trans: [], revenue: [], resourceGroups: RESOURCE_GROUPS };
  let tranNum = 700000;
  let laborHed = 500000;
  let laborDtl = 1;

  for (let i = 0; i < jobCount; i++) {
    const sc = SCENARIOS[i] ?? {};
    // 5 is coprime with 12, so this walks through every part; the second term shuffles each lap
    const part = (sc.part && PARTS.find((p) => p.num === sc.part)) || PARTS[(i * 5 + Math.floor(i / PARTS.length) * 3) % PARTS.length];
    const qty = Math.max(1, randInt(part.qty[0], part.qty[1]));
    const open = i % 4 === 3 || !!sc.open;
    const jobNum = String(104000 + i);
    const [custId, custName] = CUSTOMERS[(i * 3 + 1) % CUSTOMERS.length];

    // ---- dates
    let startDate;
    let closedDate = null;
    if (open) {
      startDate = addDays(now, -randInt(2, 30));
    } else {
      const closedAgo = i < 4 ? randInt(3, 20) : randInt(3, 335);
      closedDate = addDays(now, -closedAgo);
      startDate = addDays(closedDate, -randInt(4, 35));
    }
    const lastDay = open ? now : closedDate;

    // ---- final quantity
    let finalQty = qty;
    if (!open) {
      if (sc.shortQty) finalQty = Math.max(1, Math.round(qty * sc.shortQty));
      else if (i % 9 === 4) finalQty = Math.max(1, Math.round(qty * rand(0.9, 0.98)));
      else if (i % 13 === 6) finalQty = Math.round(qty * rand(1.02, 1.06));
    }

    // ---- operations
    const perAsmCount = {};
    let inProgressIdx = -1;
    if (open) {
      const steps = part.route.length;
      inProgressIdx =
        sc.open === 'trendingOver' ? Math.max(0, part.route.findIndex(([c]) => c === 'WELD')) : Math.min(steps - 1, randInt(1, steps - 1));
    }
    const opRows = part.route.map(([code, asm], idx) => {
      const def = OPS[code];
      perAsmCount[asm] = (perAsmCount[asm] ?? 0) + 1;
      const oprSeq = perAsmCount[asm] * 10;
      const perPc = part.perPc[code] ?? 0;
      const estSet = def.subcontract ? 0 : quarter(def.set * (asm > 0 ? 0.8 : 1) + (rng() < 0.3 ? 0.25 : 0));
      const estRun = def.subcontract ? 0 : round(perPc * qty, 2);
      const rg = RESOURCE_GROUPS[def.rg];
      return { idx, code, asm, oprSeq, def, estSet, estRun, rg, perPc };
    });

    const ops = [];
    for (const o of opRows) {
      const { def } = o;
      let fSet = lognorm(0.15) * def.biasSet;
      let fRun = lognorm(0.09) * def.biasRun;
      if (sc.weldMult && o.code === 'WELD') fRun *= sc.weldMult;
      if (sc.allMult) {
        fRun *= sc.allMult;
        fSet *= sc.allMult;
      }
      if (sc.slow) fRun *= sc.slow;
      if (!sc.weldMult && !sc.allMult && rng() < 0.045) fRun *= rand(1.3, 1.7); // the odd bad op

      let complete = true;
      let qtyDone = finalQty;
      let actSet;
      let actRun;
      if (!open) {
        const qtyRatio = finalQty / qty;
        actSet = o.estSet * fSet;
        actRun = o.estRun * fRun * qtyRatio;
        if (sc.closedOpenOp && o.code === 'PACK') {
          complete = false;
          qtyDone = 0;
          actSet = 0;
          actRun = 0;
        }
        if (sc.completeZero && o.idx === part.route.length - 2) {
          actSet = 0;
          actRun = 0;
        }
        if (sc.hoursZeroQty && o.idx === 0) qtyDone = 0;
      } else if (o.idx < inProgressIdx) {
        actSet = o.estSet * fSet;
        actRun = o.estRun * fRun;
        qtyDone = qty;
      } else if (o.idx === inProgressIdx) {
        complete = false;
        const frac = sc.open === 'trendingOver' ? 0.4 : sc.open === 'ahead' ? 0.6 : rand(0.25, 0.8);
        qtyDone = Math.round(qty * frac);
        if (sc.open === 'trendingOver') {
          const total = (o.estSet + o.estRun) * 0.9;
          actSet = o.estSet;
          actRun = Math.max(0, total - o.estSet);
        } else if (sc.open === 'ahead') {
          actSet = o.estSet;
          actRun = o.estRun * frac * 0.6;
        } else {
          actSet = o.estSet * fSet;
          actRun = o.estRun * frac * fRun;
        }
      } else {
        complete = false;
        qtyDone = 0;
        actSet = 0;
        actRun = 0;
      }
      if (def.subcontract) {
        actSet = 0;
        actRun = 0;
      }
      ops.push({
        company: 'UF', jobNum, assemblySeq: o.asm, oprSeq: o.oprSeq,
        assemblyPart: o.asm === 0 ? part.num : part.sub?.[o.asm]?.[0] ?? part.num,
        assemblyDesc: o.asm === 0 ? part.desc : part.sub?.[o.asm]?.[1] ?? part.desc,
        opCode: o.code, opDesc: def.desc,
        estSetHours: o.estSet, estProdHours: o.estRun,
        actSetupHours: round(actSet, 2), actProdHours: round(actRun, 2),
        runQty: qty, qtyCompleted: qtyDone, opComplete: complete,
        prodStandard: o.perPc > 0 ? round(1 / o.perPc, 2) : 0, stdFormat: 'HP',
        subcontract: !!def.subcontract, opDtlSeq: 1,
        resourceGrpId: def.rg, resourceId: `${def.rg}-01`, rgDescription: o.rg.desc,
        setLabRate: o.rg.setLab, prodLabRate: o.rg.prodLab, setBurRate: o.rg.setBur, prodBurRate: o.rg.prodBur,
        _estRun: o.estRun, _estSet: o.estSet,
      });
    }
    if (sc.unplannedOp) {
      const [code, hrs] = sc.unplannedOp;
      const def = OPS[code];
      const rg = RESOURCE_GROUPS[def.rg];
      ops.push({
        company: 'UF', jobNum, assemblySeq: 0, oprSeq: 990, assemblyPart: part.num, assemblyDesc: part.desc,
        opCode: code, opDesc: `${def.desc} (added)`, estSetHours: 0, estProdHours: 0,
        actSetupHours: 0, actProdHours: hrs, runQty: qty, qtyCompleted: finalQty, opComplete: true,
        prodStandard: 0, stdFormat: 'HP', subcontract: false, opDtlSeq: 1,
        resourceGrpId: def.rg, resourceId: `${def.rg}-01`, rgDescription: rg.desc,
        setLabRate: rg.setLab, prodLabRate: rg.prodLab, setBurRate: rg.setBur, prodBurRate: rg.prodBur,
      });
    }

    // ---- labour transactions (sum to the op actuals; scenarios break that on purpose)
    for (const op of ops) {
      const emps = EMPLOYEES.filter((e) => e[3].includes(op.opCode));
      const bits = [];
      if (op.actSetupHours > 0) bits.push(['S', op.actSetupHours]);
      let remaining = op.actProdHours;
      while (remaining > 0.001) {
        const chunk = Math.min(remaining, round(rand(1.5, 7.5), 2));
        bits.push(['P', round(chunk, 2)]);
        remaining = round(remaining - chunk, 2);
      }
      const nProd = Math.max(1, bits.filter((b) => b[0] === 'P').length);
      let qtyLeft = op.qtyCompleted;
      const spanDays = Math.max(1, Math.round((lastDay - startDate) / 86400000));
      const isTarget = op === ops[Math.min(1, ops.length - 1)]; // scenario data problems land on the 2nd op
      const firstP = bits.findIndex((b) => b[0] === 'P');
      bits.forEach(([type, hrs], k) => {
        let h = hrs;
        if (sc.laborMismatch && isTarget && k === bits.length - 1) h = Math.max(0.25, round(h + sc.laborMismatch, 2));
        if (sc.longShift && isTarget && k === firstP) h = 14;
        const e = pick(emps) ?? EMPLOYEES[0];
        const day = addDays(startDate, Math.min(spanDays, Math.floor((k / bits.length) * spanDays + rng() * 2)));
        const clockIn = type === 'P' && h === 14 ? 6 : round(rand(6, 12), 2);
        const qtyHere = type === 'P' ? (k === bits.length - 1 ? qtyLeft : Math.min(qtyLeft, Math.round(op.qtyCompleted / nProd))) : 0;
        qtyLeft -= qtyHere;
        const recent = lastDay - day < 2 * 86400000;
        data.labor.push({
          company: 'UF', laborHedSeq: laborHed++, laborDtlSeq: laborDtl++, jobNum, assemblySeq: op.assemblySeq, oprSeq: op.oprSeq,
          employeeNum: e[0], employeeName: e[1], shift: e[2], dept: op.opCode,
          laborType: type, clockInDate: iso(day), clockInTime: clockIn, clockOutTime: round(clockIn + h, 2),
          laborHrs: h, burdenHrs: h, laborQty: qtyHere, scrapQty: rng() < 0.06 ? randInt(1, 3) : 0,
          scrapReason: '', discrepQty: 0, resourceGrpId: op.resourceGrpId,
          laborRate: round(rand(26, 38), 2), burdenRate: round(rand(18, 40), 2),
          activeTrans: false, timeStatus: open && recent ? 'E' : 'A',
        });
      });
      if (sc.open === 'activeClock' && op.opComplete === false && op.actProdHours > 0) {
        data.labor.push({
          company: 'UF', laborHedSeq: laborHed++, laborDtlSeq: laborDtl++, jobNum, assemblySeq: op.assemblySeq, oprSeq: op.oprSeq,
          employeeNum: '1004', employeeName: 'K. Patel', shift: '1', dept: op.opCode, laborType: 'P',
          clockInDate: iso(addDays(now, -1)), clockInTime: 14.5, clockOutTime: 0, laborHrs: 0, burdenHrs: 0,
          laborQty: 0, scrapQty: 0, scrapReason: '', discrepQty: 0, resourceGrpId: op.resourceGrpId,
          laborRate: 31, burdenRate: 22, activeTrans: true, timeStatus: 'E',
        });
      }
      delete op._estRun;
      delete op._estSet;
    }
    for (const op of ops) {
      delete op._estRun;
      delete op._estSet;
    }
    data.ops.push(...ops);

    // ---- materials and PartTran
    const lastOpReached = open ? inProgressIdx : part.route.length;
    part.mtl.forEach(([pn, desc, ium, qtyPer, unitCost, cls, asm, backflush], k) => {
      const mtlSeq = (k + 1) * 10;
      const required = round(qtyPer * qty, 2);
      const estUnit = round(unitCost * (open ? 1 : rand(0.97, 1.03)), 4);
      let usage = cls === 'PLATE' || cls === 'TUBE' ? lognorm(0.035) * 1.015 : 1;
      if (sc.scrapMtl && cls === 'PLATE') usage = sc.scrapMtl;
      let priceF = cls === 'PLATE' || cls === 'TUBE' ? lognorm(0.03) * 1.01 : lognorm(0.015);
      if (sc.priceSpike && cls === 'PLATE') priceF = sc.priceSpike;
      if (sc.allMult && cls === 'PLATE') usage = 0.7;
      const progress = open ? Math.min(1, Math.max(0.35, (inProgressIdx + 1) / part.route.length + rng() * 0.3)) : 1;
      const issuedTotal = backflush ? (open ? (progress >= 1 ? required : 0) : round(required * (finalQty / qty), 2)) : round(required * usage * progress, 2);
      const actUnit = round(estUnit * priceF, 4);
      const pieces = backflush ? 1 : issuedTotal > 0 ? randInt(1, 3) : 0;
      let issuedLeft = issuedTotal;
      let net = 0;
      for (let p = 0; p < pieces; p++) {
        const q = p === pieces - 1 ? issuedLeft : round(issuedTotal / pieces, 2);
        issuedLeft = round(issuedLeft - q, 2);
        const unit = round(actUnit * lognorm(0.01), 4);
        const buy = cls === 'TUBE' && rng() < 0.3;
        data.trans.push({
          company: 'UF', tranNum: tranNum++, tranDate: iso(addDays(startDate, Math.min(5, p + 1))),
          tranType: buy ? 'PUR-MTL' : 'STK-MTL', jobNum, assemblySeq: asm, mtlSeq, partNum: pn, tranQty: q, um: ium,
          mtlUnitCost: unit, lbrUnitCost: 0, burUnitCost: 0, subUnitCost: 0, mtlBurUnitCost: 0, extCost: round(q * unit, 2),
        });
        net += q;
      }
      if (!open && !backflush && (sc.returnMtl || (cls === 'PLATE' && rng() < 0.22)) && net > 0) {
        const rq = round(net * rand(0.04, 0.12), 2);
        data.trans.push({
          company: 'UF', tranNum: tranNum++, tranDate: iso(lastDay), tranType: 'MTL-STK', jobNum, assemblySeq: asm, mtlSeq,
          partNum: pn, tranQty: rq, um: ium, mtlUnitCost: actUnit, lbrUnitCost: 0, burUnitCost: 0, subUnitCost: 0, mtlBurUnitCost: 0,
          extCost: round(rq * actUnit, 2),
        });
        net = round(net - rq, 2);
      }
      data.mtls.push({
        company: 'UF', jobNum, assemblySeq: asm, mtlSeq, partNum: pn, description: desc, qtyPer, requiredQty: required,
        issuedQty: round(net, 2), ium, estUnitCost: estUnit, unitCost: estUnit, totalCost: round(required * estUnit, 2),
        issuedComplete: !open || (!backflush && progress >= 1), backflush, relatedOperation: 0, buyIt: false,
        classId: cls, prodCode: cls,
      });
    });
    if (i % 17 === 10 && !open) {
      // consumable added at the bench that was never on the job
      data.mtls.push({
        company: 'UF', jobNum, assemblySeq: 0, mtlSeq: 900, partNum: 'WELDWIRE-035', description: 'Weld wire .035 (added)', qtyPer: 0,
        requiredQty: 0, issuedQty: 60, ium: 'LB', estUnitCost: 2.4, unitCost: 2.4, totalCost: 0, issuedComplete: true, backflush: false,
        relatedOperation: 0, buyIt: false, classId: 'CONSUMABLE', prodCode: 'CONSUMABLE',
      });
      data.trans.push({
        company: 'UF', tranNum: tranNum++, tranDate: iso(lastDay), tranType: 'STK-MTL', jobNum, assemblySeq: 0, mtlSeq: 900,
        partNum: 'WELDWIRE-035', tranQty: 60, um: 'LB', mtlUnitCost: 2.4, lbrUnitCost: 0, burUnitCost: 0, subUnitCost: 0, mtlBurUnitCost: 0, extCost: 144,
      });
    }

    // ---- header
    const orderBase = 52000 + i * 3;
    data.jobs.push({
      company: 'UF', jobNum, partNum: part.num, revisionNum: 'A', partDescription: part.desc, prodQty: qty,
      qtyCompleted: open ? 0 : finalQty, released: true, complete: !open, closed: !open,
      closedDate: closedDate ? iso(closedDate) : null, completionDate: closedDate ? iso(addDays(closedDate, -1)) : null,
      startDate: iso(startDate), reqDueDate: iso(addDays(open ? now : closedDate, open ? randInt(3, 20) : -randInt(0, 5))),
      prodCode: part.num.split('-')[0], plannerId: i % 2 ? 'PLN1' : 'PLN2', quoteNum: 8000 + i, quoteLine: 1,
      orderNum: sc.noOrder ? null : orderBase, orderLine: sc.noOrder ? null : 1,
      custId: sc.noOrder ? null : custId, custName: sc.noOrder ? null : custName,
      scopeDate: closedDate ? iso(closedDate) : '9999-12-31',
      _extraOrder: sc.multiOrder ? { orderNum: orderBase + 1, orderLine: 2 } : null,
    });

    // ---- sale price (no random numbers used here, so the rest of the demo data is unchanged).
    // Price is set from the job's PLANNED cost: most jobs were quoted with a healthy margin,
    // but every 7th (starting at 2) was quoted thin, so the demo shows "the price was the problem".
    if (!sc.noOrder) {
      const plannedCost =
        ops.reduce((t, o) => t + o.estSetHours * (o.setLabRate + o.setBurRate) + o.estProdHours * (o.prodLabRate + o.prodBurRate), 0) +
        data.mtls.filter((m) => m.jobNum === jobNum).reduce((t, m) => t + m.requiredQty * m.estUnitCost, 0);
      const plannedMargin = i % 7 === 2 ? 0.05 : 0.22 + ((i * 37) % 25) / 100;
      const price = plannedCost / (1 - plannedMargin);
      const usd = custName.includes('USA');
      const links = sc.multiOrder
        ? [{ orderNum: orderBase, orderLine: 1, qty: Math.max(1, Math.round(qty * 0.6)) }, { orderNum: orderBase + 1, orderLine: 2, qty: Math.max(1, qty - Math.max(1, Math.round(qty * 0.6))) }]
        : [{ orderNum: orderBase, orderLine: 1, qty }];
      const total = links.reduce((t, l) => t + l.qty, 0);
      for (const l of links) {
        const ext = round((price * l.qty) / total, 2);
        data.revenue.push({
          company: 'UF', jobNum, orderNum: l.orderNum, orderLine: l.orderLine, orderRelNum: 1, allocQty: l.qty, orderQty: l.qty,
          extPrice: ext, docExtPrice: usd ? round(ext / 1.37, 2) : ext, currencyCode: usd ? 'USD' : 'CAD',
          scopeDate: closedDate ? iso(closedDate) : '9999-12-31',
        });
      }
    }
  }
  return data;
}
