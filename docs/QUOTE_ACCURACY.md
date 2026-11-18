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
| Attention score | gross $ variance x share of jobs off. Not a column in the Operations and Materials lists (it still drives the Needs Attention count and the drill-down); the CSV keeps it. |

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

## The cards on the Customers page

Six cards sit above the lists. They cover the customers the filters leave in (so Tier and Account Manager change them) and, like the lists, only closed jobs unless in-progress jobs are included.

- **Sold**: what the priced closed jobs sold for, with the number of customers and jobs. Blue: information only.
- **Margin**: the shop's margin %, and how many points it is over or under the shop target (each customer's tier target, weighted by what it sold for), with the margin dollars. Green = at or over target, yellow = under target, red = a loss.
- **Margin vs Target $**: the customers' Margin vs Target $ added up, and how many customers are under their own target. Red = short of target overall, green = over.
- **Customers at a Loss**: the margin of the customers whose margin is below zero, added up, and how many there are. Red when there are any, green when there are none.
- **Net Variance**: actual minus estimated cost over all jobs, with the gross (size, ignoring direction) and the labour / material / other split. Red = over the estimates overall, blue = under.
- **Customer-Level Accuracy**: the share of jobs that were not off. Green at 80% or more, yellow below (the 80% is fixed, not a setting).

## The top of the Customers page

The Customers page has the same pinned, shrinking top block as one customer's page (see below), with its own contents: the heading *Post-Mortem Review: Customers* and the date line (*dates*) at the left of the date row with the date buttons at the right, the filters, and the six cards. In the filter section, after the divider, the **Customers CSV** button sits left of the Scroll To arrow. Shrunk, the cards read *SOLD*, *MARGIN*, *MAR. VS TAR. $*, *AT A LOSS*, *NET VAR.* and *ACCURACY* with their value. The notes that only show sometimes (*Showing only tier A...*, *In-progress jobs are included*) sit just below the block, so it stays short. The Customers section's heading has the list layout box (**Show**) at its top right. The Customers page keeps its own default list layout (not side by side): its tables are wide.

## The top of the Flagged Jobs page

The Flagged Jobs page (a job list, not an Accuracy page) uses the same pinned, shrinking top block: the heading *Flagged Jobs* and the line *N jobs match. Ranked by...* at the left of the date row, the quick date buttons and the From / To dates at the right (they change the dates and keep every other filter), then the filters on one line. There are no cards on this page, so shrinking only fades the match-count line and brings the date buttons level with the heading. After the divider are the **Excel** export button and the Scroll To arrow (*Overview*, *Jobs*). The dates are no longer repeated in the filter boxes. *Include Jobs With No Sales Order* is now in an **Other Options** drop-down, like the Accuracy pages. The note about the Dashboard bar you clicked sits just below the block, and the page remembers where you were when a filter reloads it. The table, its Columns menu and the Study buttons are unchanged.

## The top of the Operations & Materials page

The same pinned, shrinking top block again: the heading *Post-Mortem Review: Operations & Materials* and the date line at the left of the date row (date buttons at the right), the filters and the six cards. Shrunk, the cards read *LABOUR VAR.*, *MATERIAL VAR.*, *OP. ACCURACY*, *MAT. ACCURACY*, *NEEDS ATTENTION* and *UNESTIMATED* with their value. This page has more filters than the others, so the two CSV downloads share **one CSV menu** (Operations CSV, Materials CSV) after the divider, left of the Scroll To arrow, which keeps the filter section on one line. The notes that only show sometimes (*Showing only <customer>*, *Showing only tier A...*, *In-progress jobs are included*) sit just below the block. In the Operations and Materials sections the **Show** box and the **Group by** buttons are at the top right of the section header. The list layout default is unchanged.

A link to a spot lower on the page (a drill-down, *#drill* or *#jobs*) lands just below the pinned block, not under it. The same is true on the Customers pages.

## The top of one customer's page

The heading, the date buttons, the filters and the seven cards below make up one block that **stays on screen while the rest of the page scrolls**, so the customer's figures are always in view. It pins only on a wide, tall window (at least 1,751 px wide, so all seven cards fit in one row, and at least 800 px tall); on a smaller window the page scrolls as usual.

**It shrinks as you scroll** to save room. Once the page has scrolled by about the amount the block gets shorter by (roughly 95 px), the block eases down from about 270 px to about 175 px: the date line (*Customers › name · dates*) fades away, so the name line and the date buttons end up on the same line (name at the left, date buttons at the right), and each card cross-fades to a single line with a short label: *MARGIN: 12.7%*, *MAR. VS TAR. $*, *LAB. VS MAT.*, *FLAGGED JOBS*, *PMRs IN PROGRESS*, *COMPLETED PMRs*, *ROOT CAUSES*. The small print under each card is hidden while it is shrunk. Scrolling back up grows it again (with a little slack, so it does not flicker at the edge). Everything that changes height uses the same time and curve, and the page below does not jump when the block changes size. Nothing animates for anyone whose system asks for reduced motion.

The customer's name, tier, account manager and a short note comparing the customer with the shop are on **one line** at the left of the date row, with the date line under them and the date buttons at the right. The note reads *Worse than normal / Better than normal / In line with the shop* and the share of the customer's jobs that were off (for example *Worse than normal: 58.3% of jobs off*); the shop-wide share and the difference in points are in its hover text.

### The cards

Seven cards, each a line or two of small print, all the same height:

- **Margin**: the customer's margin %, with the margin on what it sold for (priced jobs, and any cost from unpriced jobs on the same orders, are in the tooltip). Green at or over its target, yellow under, red for a loss.
- **Margin vs Target $**: the dollars short of (red) or over (green) this customer's own tier target, and how many points under or over that target the margin is.
- **Labour vs Material**: which one the variance is mainly in, with the labour, material, other and net amounts.
- **Flagged Jobs**: how many of this customer's jobs in the date range are flagged, of how many, split red and yellow, with a link to them in Flagged Jobs.
- **Post-Mortems In Progress** and **Completed Post-Mortems** (closed or dismissed): the count, the most recent one to open straight from the card, and **See all**, which opens the Post-Mortems list for this customer only. These cover all dates: a review that is open is open whatever the date range says.
- **Top Root Causes**: the cause picked most often in this customer's post-mortems (all dates) and the next one; hover for the top five.

Under the cards, two charts side by side (switch **Month / Quarter** above the first one; both follow it and the date range):

- **Margin Over Time**: a line of the margin % of the jobs closed in each month, with the customer's tier target as a dashed line. Hover for the margin on what it sold for and the number of priced jobs, so a month with only one or two jobs is easy to spot.
- **Margin vs Target $ Over Time**: one bar per month, green above target and red short of it. The bars add up to the Margin vs Target $ card.

Only closed jobs with a sale price count, the same as the Margin card.

## Scroll To menu

The right-hand end of the filter section holds, after a divider, the page's own buttons and an up / down button. On one customer's page the buttons are *All Customers* and *Open in Flagged Jobs*, in the same height as the filter boxes; **Reset** and **Apply Filters** sit directly after the filters. The up / down button, always the last one, opens a **Scroll To** list of the sections of the page: click one and the page glides to it (the section is opened if it is a fold-away one). The first item, Overview, goes back to the top. The section you are looking at is highlighted when the menu opens. Each page lists its own sections:

- **Operations & Materials**: Overview, Drill-Down (only while one is open), Operations, Materials, Biggest Net Variances, Unestimated Work.
- **Customers**: Overview, Customers, How Often vs How Far Off.
- **One customer**: Overview, Margin Charts, Operations & Material Review, Repeat Part Numbers, All Jobs.

## All Jobs and Repeat Part Numbers follow the filters

On one customer's page, the **All Jobs** and **Repeat Part Numbers** cards are ordered by the page's **Sort Lists By** and **Sort Order**, on the column each card has for that sort:

| Sort Lists By | All Jobs | Repeat Part Numbers |
|---|---|---|
| Net Var $ (the default) | Var $ | Net Var $ |
| Impact (Chosen Basis) | Var $ (or Var % on the % basis) | Net Var $ (or Avg Var % on the % basis) |
| Avg Variance % | Var % | Avg Var % |
| % of Jobs Off | the jobs that were off (the Off flag) | the share of the part's jobs that were off |
| Needs Attention | no such column: the usual order (the biggest miss first) | no such column: the usual order (the most jobs off first) |

High to Low puts the biggest first (for Var $ that means the most over the estimate); Low to High puts the smallest or most under the estimate first. Jobs or parts with no estimate (so no Var %) always go last. The Hours basis has no column in these cards, so it uses dollars.

## Repeat Part Numbers: columns and link

On a customer's page, each part that was off on two or more jobs shows: **Jobs**, **Jobs Off**, **Total Qty** (the pieces made, added up over all of that part's jobs in the date range), **Labour Var $**, **Material Var $**, **Net Var $** and **Avg Var %**. The description gets a narrower column (it is clipped to one line; hover for the whole text).

Click the **part number** to open Flagged Jobs filtered to that part, this customer and the same dates, with every flag shown, so you see the jobs the part was on. (The Flagged Jobs Part Number filter is a "contains" match, so a part number that is the start of a longer one also lists the longer one.)

## Long descriptions

A material or part with a long description (a drawing note, a purchase order, a finish) shows only the start of it, cut with "..." to the room its column has, so the numbers always stay on screen and nobody has to scroll sideways. The start is what matters (the kind and the size). Hover over it to read the whole text. This applies to the Operations and Materials lists, the parts a group appears on, and a customer's Repeat Part Numbers.

## Staying where you were

When you change a filter, press Apply Filters or Reset, use a date button, switch Month / Quarter or pick another "Show" layout, the page reloads. It remembers the section you were reading (the same sections as the Scroll To menu, and how far into it you were) and scrolls straight back to that spot, with the pinned block already in the right size. The memory lasts a minute and is used once; leaving for another page, opening a link to an anchor or coming back later starts at the top as usual. Nothing is remembered if you were at the very top.

## One customer's Operations & Material Review

The section with the operation and material lists is titled *Customer name - Operations & Material Review*, with the **Show** box (Jobs Over Estimates, Jobs Under Estimates, Both - Horizontal Window, Both - Vertical Window) at the right of the same header. A customer opens on **Both - Horizontal Window**: the over and under lists side by side. The Customers and Operations & Materials pages still open on Jobs Over Estimates, and the links between them do not pass this choice across.

## Filters

Quick date buttons above the filters (Last 30 days, Last 90 days, This month, Last month, Year to date, Last 12 months, the same ranges as the Dashboard) switch the dates in one click and keep every other filter. **Tier** (a drop-down of tick boxes: tick one or more, such as A and B, or none for all tiers; *Not on the List* can be ticked with them) and **Account Manager** (both from the Customer Organization list in Settings) limit both pages to those customers: every figure, list, chart and CSV then covers only them, and Internal / Stock jobs drop out because they have no customer. Account Manager also offers Unassigned, and both offer Not on the List. Neither filter applies inside one customer's page. Date range (default last 90 days, the same on the Dashboard, Flagged Jobs and these pages; closed date, or latest labour / material date for an in-progress job), Jobs (closed only by default, or include in-progress: only completed operations and issued material are compared, never a full estimate against partial actuals), Variance Basis ($ default, Hours, %), Minimum Jobs (default 3: smaller groups are left out of the lists, and the page says how many), Sort Lists By (Net Var $ is the default for operations and materials, biggest first, whatever the Variance Basis; Impact (Chosen Basis) follows the basis instead; Needs Attention is one choice away; the Customers page opens on Margin vs Target $, Low to High, so the customers furthest below their target come first; Impact, % of Jobs Off, Avg Variance %, and on the Customers page Margin $ and Margin %; customers with no margin are always last) with a Sort Order of High to Low (default) or Low to High, group operations by Op Code or Resource Group, group materials by Part Number or Material Class, trend by Month or Quarter, Exclude Outliers (in the **Other Options** drop-down with Include Internal / Stock Jobs; single lines over +/-300%; the page always says how many there are), Include Internal / Stock Jobs.

The filters are in the address, so a filtered view can be bookmarked or sent to someone. Every list has a CSV export (all groups, filters applied).

## Drill-down

Operation or material -> the part numbers it appears on (parts off on **3 or more jobs** are marked Repeat and listed first: the easiest wins) -> the contributing jobs (Job #, part, customer, expected vs actual, variance, post-mortem status, each linking to the job or its post-mortem).
Each group also shows its setup / run split (operations) or usage / price split (materials), and a trend of its variance % by month or quarter.
Customers: one customer in full with cards, margin and margin-vs-target charts over time, the same operation and material lists for that customer only, repeat parts (off on 2 or more jobs), and every job with its post-mortem status.

## BAQ fields to add

**None.** Every field these pages use is already pulled by the existing BAQs: `JobOper_OpDesc`, `JobMtl_Description`, `Part_ClassID` (material class), `Customer_CustID` / `Customer_Name`, and the job, labour and material-transaction fields the variance engine already reads.
(Material Class is only as good as `Part_ClassID` is in Epicor; parts with no class land in "(No Class)".)

## Assumptions, and what I could not find

1. **Default sort.** Your brief says lists rank by $ impact by default and also that the Needs Attention score is the default sort. The default is **Net Var $**; Needs Attention and Impact (Chosen Basis, which follows the Variance Basis) are one choice away. "$ impact" in a list means the **net** variance on the chosen basis (net $, net hours / quantity, or avg %), so the Jobs Over Estimates list is biggest overruns first and the Jobs Under Estimates list is biggest under-runs first. Avg Var % is shown next to it.
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
