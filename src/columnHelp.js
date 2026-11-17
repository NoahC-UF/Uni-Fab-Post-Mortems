// Plain-words descriptions of table column headings. Shown as a hover tip when a person has "Column help" on
// (Your Account). One shared list, so a heading means the same thing on every page.
//
// Keys are the heading text, lower case. A heading that means different things in different tables is looked up
// as "scope.heading" first (the table says which scope it is in with data-help-scope="..."). A single heading can
// also carry its own text with data-help="...". The page script (public/column-help.js) does the lookup.

/** Normal form of a heading, used for matching: lower case, single spaces, no sort arrows. */
export function helpKey(text) {
  return String(text ?? '')
    .replace(/[▲▼▴▾]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const FLAG =
  'Red, yellow or green. On a job it is the worst flag among its lines. A line only flags when it is off by more than the set percentage AND by at least the minimum hours or dollars (both are set in Settings).';
const VAR_DOLLARS = 'Dollars: actual cost minus expected cost. Positive (red) means it cost more than expected; negative (blue) means it cost less.';

import { ACCURACY_HELP } from './columnHelpAccuracy.js';

export const COLUMN_HELP = {
  ...ACCURACY_HELP,
  // ---- Flagged Jobs grid, Dashboard
  'select all': 'Ticks or unticks every job in this list (every page that the filters match), to study them together.',
  flag: FLAG,
  job: 'The job number. Click it to open the job.',
  part: 'The part number being made. In the Flagged Jobs grid, hover the part number to see its description.',
  customer: 'Customer on the sales order. "(no order)" means the job is not tied to a sales order.',
  'customer / part': 'Who the job is for, and the part being made.',
  closed: 'The date the job was closed in Epicor.',
  '$ impact': 'Total dollars missed on the flagged lines: the $ over plus the $ under. It ignores direction, so it shows how far the job strayed from its estimate, for better or worse.',
  '$ over': 'Dollars spent beyond the estimate on flagged lines (hours or material that ran over). This is money lost.',
  '$ under': 'Dollars below the estimate on flagged lines (hours or material that ran under). Worth a look: the estimate may have been too high, or time or material may not have been booked.',
  net: '$ over minus $ under. Positive (red) means the job cost more than estimated overall; negative (blue) means it cost less.',
  'labour $': 'Labour dollar variance for the job: actual hours less estimated hours, at the labour and burden rates. Positive means over.',
  'material $': 'Material dollar variance for the job: actual material cost less expected. Positive means over.',
  lines: 'How many operations and materials are flagged on this job.',
  'sale price': 'What the customer is paying, in CAD: the sales order line prices for what this job makes (prorated if a line is split across jobs). Blank means no priced order was found.',
  'planned margin': "The margin the job's set-up allowed for: sale price minus planned cost (estimated hours at labour and burden rates, plus expected material), as a % of the price. Red means below the goal margin.",
  'actual margin': 'The margin the job really made: sale price minus actual cost, as a % of the price. Final for closed jobs, so far for open ones. Cost is labour, material, sub-assemblies and subcontract; freight and overhead are not included. Red means below the goal margin.',
  'matching lines $': 'Opened from a bar of the Dashboard chart: the dollars this job put into that bar (its flagged lines of that kind, over or under). Added up, the jobs in the list make the number on the bar.',
  'actual margin $': 'Sale price minus actual cost, in dollars. Cost is labour, material, sub-assemblies and subcontract (not freight or overhead).',
  'likely cause':
    'Where the lost margin most likely started. Price / Set-Up: the price was below the goal even against the job\'s own plan. Overrun: the plan was healthy but the job cost more. On Target: margin meets the goal. No Price / No Plan: the data needed is missing.',
  'biggest miss': 'The single flagged operation or material with the largest dollar variance on this job, and its amount. Red means over, blue means under.',
  'post-mortem': 'Where the post-mortem for this job stands: Flagged (not looked at yet), Under Review, Root Cause Found, Actions Assigned, Closed or Dismissed.',
  'grid.status': 'Closed means the job is finished in Epicor. In Progress means it is still open, so its actuals are still growing.',

  // ---- Job page: operations
  op: 'The operation (the step in the routing), such as a cut, weld or paint step.',
  resource: 'The resource group that did, or will do, the work.',
  state: 'Complete or open. Only completed operations count toward the flags on a job that is still in progress.',
  'setup est': 'Estimated setup hours.',
  'setup act': 'Actual setup hours booked.',
  'run est': 'Estimated run (production) hours.',
  'run act': 'Actual run (production) hours booked.',
  'total est': 'Estimated setup plus run hours.',
  'total act': 'Actual setup plus run hours.',
  'var hrs': 'Actual hours minus estimated hours. Positive means over.',
  'var %': 'Variance as a % of the estimate: (actual minus estimate) ÷ estimate.',
  'hrs/pc est → act': 'Hours per piece, estimated then actual. The flag uses this when the quantity made differs from the quantity the estimate was for.',
  '$ var': VAR_DOLLARS,
  'est hrs': 'Estimated hours.',
  'actual hrs': 'Actual hours booked.',
  'setup var': 'Actual setup hours minus estimated setup hours.',
  'run var': 'Actual run hours minus estimated run hours.',

  // ---- Job page: labour detail (one row per clock-in)
  date: 'Date of the labour transaction.',
  type: 'Setup or production time.',
  'in - out': 'Clock-in and clock-out times. A job still clocked in has no out time yet.',
  hours: 'Hours booked on this transaction. A warning mark means it is longer than 12 hours, which is often a missed clock-out.',
  qty: 'Quantity completed on this transaction.',
  scrap: 'Quantity scrapped on this transaction, with the reason if one was given.',
  'time status': 'The approval status of the time in Epicor.',
  operator: 'Who clocked the time. Visible to Admins only.',

  // ---- Job page: materials
  material: 'The part number of the material.',
  class: 'The material class or group, to compare like with like.',
  'expected qty': 'Quantity the job set-up said it would need (the required quantity).',
  'actual qty': 'Quantity actually issued to the job, net of any returns to stock.',
  'qty var': 'Actual quantity minus expected quantity. Positive means more was used.',
  'est $': 'Expected material cost: expected quantity at the estimated unit cost.',
  'actual $': 'Actual material cost issued to the job, net of returns to stock.',
  'usage $': 'The part of the dollar variance caused by using more or less material than expected (quantity difference at the estimated cost).',
  'cost basis $': 'The part of the dollar variance caused by a different unit cost than estimated. With average costing it reflects the running average at the time of issue, not necessarily the purchase price.',
  usage: 'The part of the dollar variance caused by using more or less material than expected.',
  'cost basis': 'The part of the dollar variance caused by a different unit cost than estimated.',
  notes: 'Anything worth knowing about this line, such as backflushed material or a data check.',
  where: 'Where in the job the data problem is.',
  issue: 'What looks wrong with the data.',

  // ---- Job page: price lines (sales orders)
  'order / line': 'The sales order and line this job is made for.',
  'line price': 'The full price of the order line, in CAD.',
  'share made by this job': 'The share of the order line this job makes (job quantity ÷ line quantity). When a line is split across jobs, each job counts only its share.',
  counted: 'The part of the line price counted as this job\'s sale price.',

  // ---- Job page: price and margin card
  'planned (job set-up)': 'What the job said it would cost, and the margin that leaves, when it was set up.',
  'actual (final)': 'What the job really cost, and the margin it left. Final, because the job is closed.',
  'actual (so far)': 'What the job has cost so far, and the margin so far. It will change while the job is open.',
  difference: 'Actual minus planned.',

  // ---- Job page: watchlist (open operations)
  'used hrs': 'Hours booked so far on the operation.',
  '% hrs used': 'Hours used so far as a % of the estimated hours.',
  '% qty done': 'Quantity completed as a % of the quantity required.',
  'projected hrs': 'Hours the operation is heading for if it keeps this pace: hours used ÷ % of quantity done.',
  'projected var': 'Projected hours against the estimate, as a %. Positive means heading over.',
  'projected $': 'The projected hour variance in dollars.',
  'watch.status': 'Trending Over, On Track, Not Started, or Too Early to Tell (it is not projected until 10% of the quantity is done).',

  // ---- Post-mortems and actions
  action: 'The corrective action to be taken.',
  owner: 'Who is responsible.',
  due: 'The date the action is due.',
  'actions.status': 'Where the action stands.',
  'review date': 'The date this post-mortem is planned to be reviewed.',
  'root causes': 'The reasons the team picked for why the job missed.',
  'open actions': 'Corrective actions on this post-mortem that are not done yet.',
  '$ impact now': 'The job\'s $ impact today, recalculated from current data. It can differ from the figure when the post-mortem was started.',
  updated: 'When the post-mortem was last changed.',
  'pm-list.status': 'Where the post-mortem stands: Flagged, Under Review, Root Cause Found, Actions Assigned, Closed or Dismissed.',
  'pm-ops.est': 'Estimated hours, as they were when the post-mortem was started.',
  'pm-ops.actual': 'Actual hours, as they were when the post-mortem was started.',
  'pm-mtl.expected': 'Expected material quantity, as it was when the post-mortem was started.',
  'pm-mtl.actual': 'Actual material quantity, as it was when the post-mortem was started.',

  // ---- Job Study
  measure: 'What is being measured, averaged across the jobs in the study.',
  planned: 'From the job set-up: what the jobs said they would cost, or the margin they would make.',
  actual: 'What really happened: final figures for closed jobs, so far for open ones.',
  'planned margin $': 'Sale price minus planned cost, in dollars.',
  'hours (actual / planned)': 'Actual hours as a multiple of planned hours across the whole job. 1.5x means it took half as long again as planned.',
  'price needed for goal': 'The price that would have given the goal margin at what the job really cost: actual cost ÷ (1 − goal margin).',
  'where to look': 'Which team the numbers point to: Estimating (the price was low against the job\'s own plan), Job Release + Shop (hours were set too low and the job still ran over), Shop (a sound plan that took longer), Met Target, Check Data, No Price or Still Open.',
  operation: 'The operation code.',
  jobs: 'How many of the jobs in the study include it.',
  'expected hrs': 'Estimated hours, added up over the jobs.',
  'variance hrs': 'Actual hours minus expected hours.',
  'hours (actual / expected)': 'Actual hours as a multiple of expected hours. 1.5x means it took half as long again.',
  'variance %': 'Variance as a % of what was expected.',
  'typical job': 'The middle job\'s variance %. It stops one bad job from hiding a steady pattern, or one outlier from creating one.',
  'over on': 'How many of the jobs ran over on this operation.',
  '$ variance': VAR_DOLLARS,
  'share of overrun': 'This operation\'s dollars as a share of the net operation overrun across the study.',
  pattern: 'Whether the operation is usually over (the estimate looks low), usually under (the estimate looks high), or mixed. Needs at least 3 jobs to say.',
  'below plan by': 'How many dollars lower the actual margin is than the planned margin.',
  'expected $': 'Expected material cost, added up over the jobs.',

  // ---- Settings
  'started (utc)': 'When the sync started, in UTC (not this computer\'s clock).',
  kind: 'The kind of sync, such as the daily sync or the Sunday full re-sync.',
  source: 'Where the data came from: Epicor or the demo data.',
  by: 'Who started it: a person, or the automatic schedule.',
  'sync.status': 'Whether the sync finished (ok), failed (error), or is still running.',
  rows: 'How many rows of each kind were stored by the sync.',
  'applies to': 'What the override covers: an operation code or a resource group.',
  'green below': 'A variance below this % is green.',
  'red above': 'A variance above this % is red. Between green and red is yellow.',
  'resource group': 'The resource group (a group of work centres that share rates).',
  'setup labour': 'Setup labour rate per hour. The Epicor rate is shown first; type in the box to override it.',
  'setup burden': 'Setup burden (overhead) rate per hour.',
  'prod labour': 'Production labour rate per hour.',
  'prod burden': 'Production burden (overhead) rate per hour.',
  active: 'Inactive entries are kept but not offered when choosing.',
  username: 'The name the person signs in with.',
  role: 'Admin can change settings and sees who clocked what. Reviewer can review jobs and run post-mortems.',
  'last sign-in': 'When the person last signed in.',
  'reset password': 'Set a new password for this person.',
};
