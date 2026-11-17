# Quote Accuracy pages

Two pages that roll the job level results up, so you can see patterns instead of single jobs:

  **Ops & Materials** (`/accuracy/ops`): which operations and materials are most often over or under their estimates.
- **Customers** (`/accuracy/customers`): which customers' jobs most often miss their estimates, and one customer in full (`/accuracy/customers/<id>`).

Both are in the main menu next to the Dashboard, open to Admins and Reviewers, and take the same kind of filter bar as the Dashboard and Flagged Jobs.

## Words used (on both pages and in every label)

Every top list can be shown as **Jobs Over Estimates** (the default), **Jobs Under Estimates**, **Both - Horizontal Window** (side by side) or **Both - Vertical Window** (one above the other, each at the full width so more columns show). Use the Show dropdown above the lists; it applies to the operation, material and customer lists, and keeps your other filters.

| Word | Meaning |
|---|---|
| Jobs over estimates | actual is **more** than estimated (it cost more than planned). Variance is positive. This is the Dashboard's "over". |
| Jobs under estimates | actual is **less** than estimated (it cost less than planned). Variance is negative. This is the Dashboard's "under". |

The words are deliberately neutral: a job that runs over is not automatically a quoting problem. It can be the estimate, how the job was released, or the shop floor.
| Variance | actual minus estimate, in hours, $ and %. Variance % = (actual - estimate) / estimate, taken over the whole group. |
| Net variance | the signed variances added up. |
| Gross variance | the **size** of each line's variance added up. It shows total inaccuracy even when overs and unders cancel. |
| Off | the app's own flag: outside the green band **and** past the minimum hours / dollars set in Settings. Nothing new is hard-coded. |
| % of jobs off | the share of a group's jobs with at least one flagged line in it. |
| Accuracy | the share of lines (operations, or material lines) that are **not** off. |
| Attention score | gross $ variance x share of jobs off. Big money that is also often wrong scores highest. The formula is in the column's tooltip. |

Net and gross are always shown side by side.

## Where the numbers come from

Every operation and material line of every job is now stored by the same variance engine the rest of the app uses
(new table `line_results`, filled whenever jobs are re-checked; `flag_lines` still holds only the flagged ones).
Nothing is estimated again on these pages:

- Operation hours are the hours the job **should** have taken for the quantity it made (the same "expected" the flags use). Setup and run are scaled the same way, so they always add up to the total.
- Dollars: labour is hours x (labour + burden rate), the same cost basis as the Dashboard; material is quantity x estimated unit cost.
- Material variance is split into **usage** = (issued qty - expected qty) x estimated unit cost and **price** = issued cost - issued qty x estimated unit cost. (With average costing "price" is really a cost-basis variance, as on the job page.)
- Material is counted per material line, so material on several assemblies of one job is never counted twice. A job counts once per group however many lines it has there.

The first time the app starts after this update it re-checks every job once to fill the new table (like the margin update did). With thousands of jobs that can take a minute.

## Sale price and actual margin (Customers page)

The customer lists, each customer's page and the Customers CSV also show **Sale Price $**, **Margin $** and **Margin %** (the actual margin), so you can see where the shop still made money even when jobs ran over hours or material.

- Sale price is what the sales order lines say the job was made for (the share each job makes of a line), and actual margin is that price less the job's actual cost. These are the same stored figures the Flagged Jobs grid and the job page use, so the numbers agree everywhere. Freight and overhead are not in the cost.
- Only **closed jobs that have a sale price** count. An in-progress job's cost is only "so far" against its full price, which would flatter the margin, so it is left out. The tooltip on Sale Price says how many of the customer's jobs counted.
- Margin % is total margin divided by total sale price (price-weighted, not an average of job percentages). It is green when it meets the target margin in Settings and red when it is a loss; hover for the planned margin. "n/a" means no closed job of that customer has a price.
- A summary tile shows the shop-wide margin, and the CSV adds Priced Jobs, Sale Price, Actual Cost, Actual Margin $ / % and Planned Margin %.

## Tier and account manager (Customers page)

The customer lists, each customer's page and the Customers CSV show the customer's **Tier** (A, B, C, D, NEW) and **Account Manager**, and the customer lists show the **Top 25** by default (the **Show** filter on the Customers page offers Top 10, 25, 50 or 100, and the card titles follow it; operations and materials stay at 10). The customers table no longer has a Mainly column (the Customers CSV still does).

- They come from the Customer Organization list in **Settings > Customer Tiers and Account Managers**: one row per customer with the headings **Name**, **Level** and **Account Management** (several people separated by commas). "XXXXX" or an empty cell means nobody is assigned yet and shows as "Unassigned".
- **Import** takes an .xlsx or .csv. The first sheet with "Name" and "Level" headings is used and anything beside the list (such as a pivot table) is ignored. Choose **Replace the whole list** (customers not in the file are removed) or **Only add and change customers in this file**. A file that cannot be read changes nothing.
- **Export Excel / Export CSV** give the list back in the same layout so it can be edited and imported again. The Excel file also has a second sheet, "Not Yet Listed", with every customer that has jobs in the app but is not on the list, ready to fill in.
- Customers are matched to Epicor by **name** (the spreadsheet has no customer ID), ignoring capitals, extra spaces and curly quotes. A customer not on the list shows a dash. The Settings section lists those customers and how many matched.

## What "cost" means in a margin

Cost is what the job page's Price and Margin card shows. Besides labour (hours x rates, with burden) and material issued from stock, it includes three things the variance engine does not see. They change **margins only**: variances, flags and thresholds are untouched.

| Cost | Where it comes from | Planned side |
|---|---|---|
| **Sub-assemblies** | Epicor books the cost of a sub-assembly job (for example `090824-4-1-601`, a job whose number starts with its parent's) into the parent as a WIP-MFG transaction. The parent's material line for it has no estimated cost. | The sub-assembly job's own planned cost (or the actual when that job is not in the app). |
| **Purchased material received through inspection** (INS-MTL) | A line with no stock / purchase issue transactions was counted at issued qty x estimated cost; its real INS-MTL cost now replaces that guess. A line that also has issue transactions gets the INS-MTL cost added. | Already in the planned material. |
| **Subcontract** (PUR-SUB, INS-SUB) | Outside services received against the job. | No estimate is kept, so planned = actual: it never shows as an overrun. |

PUR-INS is not counted (it is the receipt into inspection; the same money arrives as INS-MTL / INS-SUB). Finance works out margin for a whole sales order, so on the Customers page the cost of **closed jobs with no price of their own on a priced order** (a cart or a pad job made for the order) is counted against that order's revenue.

On the Customers page the **Total Est $** and **Total Act $** columns are this same full planned and actual cost (so Sale Price less Total Act $ is the margin), **Net Var $** is Total Act less Total Est, and **Labour Var $** + **Material Var $** + **Other Var $** add up to it. Other is the sub-assembly, inspection and unestimated-work variance that the Dashboard's labour and material figures do not show. A job still in progress counts only the lines compared so far. Which jobs are "off" is still decided from the labour and material lines against the thresholds, as before.

Checked against Epicor: for the 3,347 closed jobs that have a completion cost, the new cost adds up to 102% of what Epicor booked at completion plus the close-out variance (it was 86% before), and the typical job is 3.3% off (it was 4.7%). Jobs that use sub-assemblies went from 46% to 102%, and subcontract jobs from 77% to 103%. What is left is mostly labour rates: the app prices hours at the current resource-group rates, which run about 5% above what Epicor posted.

## Target margin by customer tier

**Settings > Thresholds and Rules** has a **Default Target Margin** and one box each for **Tier A, B, C, D and New**. A job is held to the target of its customer's tier (from the Customer Organization list); a customer with no tier, one that is not on the list, or a tier left empty gets the default. With every tier box empty everything behaves as before, with one target for all.

The tier target is used everywhere a target margin is shown or used:

- **Margin vs Target $** and the green / red colouring of Margin % on the Customers pages, the Margin tile (the shop's target there is each customer's target weighted by what it was sold for), a customer's own page and the CSV (which adds a Target Margin % column). Hover over a margin to see which target applied.
- **Job page** (Price and Margin card and its verdict), **post-mortem snapshots and reports**, and **Flagged Jobs / Dashboard**: each row's margin is coloured against its own target, and **Likely Cause** (price / set-up, overrun, on target) uses it.
- **Job Study**: each job is compared with its own goal; the one goal shown for the group is the price-weighted average, and the chart's goal line follows each job.

Each job keeps its target with its other stored numbers. Saving Settings re-checks every job, and importing a customer list re-applies the targets to every job straight away (without re-running the variance checks), so a customer that moves tier is held to the new target at once. Post-mortems already started keep the target they were frozen with until their snapshot is retaken.

## Margin % colours

**Settings > Margin % Colours** colours each margin % by how far it is from **its own target**: the target margin of the customer's tier (see above). So a 25% margin is red for a Tier A customer with a 45% target (20 points under) and green for a Tier D customer with a 20% target (5 points over). Each threshold is a number of **percentage points from target**: 0 is the target itself, -5 is 5 points under it, 5 is 5 points over it. Add up to 8 thresholds, each with a colour (for example below -10 = red, below -5 = orange, below 0 = yellow), and optionally a colour for everything at or better than the highest one (green). A margin gets the colour of the lowest threshold its difference is below, and a difference exactly on a threshold is not below it. It is worked out from the margin and target as displayed (to one decimal), so 15.0% against a 20% target is exactly 5 under. **Fill in an example** puts in a starting set to adjust; nothing is saved until you press Save.

The colours show as a coloured badge on the Margin % column of the Customers pages (the two lists and a customer's own page) and on the Planned Margin and Actual Margin columns of Flagged Jobs and the Dashboard table; hover over a badge to see the target and how many points under or over it the margin is. A job is judged against its own customer's tier target. With no thresholds saved, the standard colouring stays (blue at or above the target margin, red below zero). The colours are display only: saving them does not re-check any jobs, and the tier targets, Margin vs Target $ and Likely Cause are not affected. The job page, Job Study, post-mortems and the CSV exports are not coloured by thresholds.

## Filters

Quick date buttons above the filters (Last 30 days, Last 90 days, This month, Last month, Year to date, Last 12 months, the same ranges as the Dashboard) switch the dates in one click and keep every other filter. **Tier** (a drop-down of tick boxes: tick one or more, such as A and B, or none for all tiers; *Not on the List* can be ticked with them) and **Account Manager** (both from the Customer Organization list in Settings) limit both pages to those customers: every figure, list, chart and CSV then covers only them, and Internal / Stock jobs drop out because they have no customer. Account Manager also offers Unassigned, and both offer Not on the List. Neither filter applies inside one customer's page. Date range (default last 12 months; closed date, or latest labour / material date for an in-progress job), Jobs (closed only by default, or include in-progress: only completed operations and issued material are compared, never a full estimate against partial actuals), Variance Basis ($ default, Hours, %), Minimum Jobs (default 3: smaller groups are left out of the lists, and the page says how many), Sort Lists By (Needs Attention default, Impact, % of Jobs Off, Avg Variance %, and on the Customers page Margin $ and Margin %; customers with no margin are always last) with a Sort Order of High to Low (default) or Low to High, group operations by Op Code or Resource Group, group materials by Part Number or Material Class, trend by Month or Quarter, Exclude Outliers (single lines over +/-300%; the page always says how many there are), Include Internal / Stock Jobs.

The filters are in the address, so a filtered view can be bookmarked or sent to someone. Every list has a CSV export (all groups, filters applied).

## Drill-down

Operation or material -> the part numbers it appears on (parts off on **3 or more jobs** are marked Repeat and listed first: the easiest wins) -> the contributing jobs (Job #, part, customer, expected vs actual, variance, post-mortem status, each linking to the job or its post-mortem).
Each group also shows its setup / run split (operations) or usage / price split (materials), and a trend of its variance % by month or quarter.
Customers: one customer in full with a summary, trend, the same operation and material lists for that customer only, repeat parts (off on 2 or more jobs), every job with its post-mortem status, how many flagged jobs have a completed post-mortem, and a count of the root causes picked.

## BAQ fields to add

**None.** Every field these pages use is already pulled by the existing BAQs: `JobOper_OpDesc`, `JobMtl_Description`, `Part_ClassID` (material class), `Customer_CustID` / `Customer_Name`, and the job, labour and material-transaction fields the variance engine already reads.
(Material Class is only as good as `Part_ClassID` is in Epicor; parts with no class land in "(No Class)".)

## Assumptions, and what I could not find

1. **Default sort.** Your brief says lists rank by $ impact by default and also that the Needs Attention score is the default sort. The default is **Needs Attention**; "Impact (Chosen Basis)" is one choice away. "$ impact" in a list means the **net** variance on the chosen basis (net $, net hours / quantity, or avg %), so the Jobs Over Estimates list is biggest overruns first and the Jobs Under Estimates list is biggest under-runs first. Gross is always shown next to it.
2. **"Needs attention" count.** You gave no rule. A group needs attention when it has enough jobs and **either** its overall variance % is outside the app's green band **or** it is off more often than the shop's norm (so +50% / -50% pairs that net to zero are still caught). Customers use the same rule.
3. **Customer "off".** A job is off when its whole-job variance % is outside the green band and passes the minimum hours / dollars. (For operations and materials, off = the engine flagged a line, as everywhere else.)
4. **Labour / material / both indicator.** "Labour" or "Material" when that one is at least 70% of the customer's variance, otherwise "Both". This is a display label, not a threshold for flagging.
5. **Internal / Stock jobs** (no customer or no sales order) are one bucket on the Customers page. They follow the Settings choice "Leave out jobs not linked to a sales order" until you tick or untick Include Internal / Stock Jobs on the page (quotes only exist for customer jobs, so out is the sensible default).
6. **Hours basis for material** means quantity; for customers (who mix hours and material) it falls back to dollars.
7. **Quadrant chart.** Across = share of jobs off, up = net variance %, bubble size = total job dollars. The horizontal dashed lines are the green band (+/- the global green limit) and the vertical line is the shop-wide share of jobs off.
8. **Minimum Jobs** is not applied inside one customer's page (it would hide most of a small customer's work); the job counts are shown.
9. **Unestimated work** (nothing estimated but there are actuals) is kept out of the variance lists and totals and shown in its own list and tile, so it cannot divide by zero or distort a ranking.
10. **Caching.** Loaded lines are kept in memory and thrown away whenever any job is re-checked; the stored `line_results` table is the main cache, built when jobs are re-checked, the same way the Dashboard's numbers are.
11. **Not changed:** the Dashboard, the threshold logic and the post-mortem data structure are untouched. The only change to existing code is that re-checking a job now also writes its lines to `line_results` (and the stored-metrics version went from 2 to 3 so every job is re-checked once).
