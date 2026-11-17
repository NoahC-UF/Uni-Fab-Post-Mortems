# Uni-Fab Post-Mortem

A small web app that finds jobs where we went over or under the estimated **hours** or **material**,
and lets the team run and track a post-mortem on each one (status, root causes, notes, owner, action
items). It reads job data from Epicor Kinetic through BAQs. **It only ever reads from Epicor. It can
never create, change or delete anything there.**

You do not need to be a developer to run it. Everything below is click-and-type.

---

## 1. Start it

1. Double-click **`start.bat`**.
2. The first time, it:
   - checks that Node.js is installed (it is on this PC),
   - installs what it needs (needs internet once),
   - creates a `.env` file in **demo mode** (fake data) if you do not have one yet,
   - creates the database and starts the server,
   - opens your browser at **http://localhost:8080**.
3. The first time you open it, create the **Admin** account (name, username, password).
4. In demo mode you will see about 70 fake jobs, so you can click around right away.

Leave the black window open while people use the app. Close it (or press Ctrl+C) to stop.

> Port 8080 busy? Add `PORT=8081` (or any free number) to `.env` and start again.

---

## 2. What is on each page

| Page | What it is for |
|------|----------------|
| **Dashboard** | Tiles for the last 30 days (change the dates at the top): jobs reviewed, % within tolerance, $ over, $ under, open post-mortems. A **Top 10 biggest $ misses** table (use **Columns** to add or remove columns, drag a column title to move it, and **Save as my default**) and a chart of where the variance comes from: **hover a bar** to see the three biggest jobs behind it, and **click it** to open Flagged Jobs filtered to every job in that bar (red = over-runs, blue = under-runs, same dates as the dashboard). A **Matching Lines $** column shows what each job put into the bar, and the jobs add up to the number on the bar. **Sync now** pulls fresh data. |
| **Ops & Materials** and **Customers** (next to Dashboard) | **Quote Accuracy**: which operations, materials and customers our estimates miss most, rolled up from the job results. Quick date buttons (Last 30 days to Last 12 months) and **Tier** / **Account Manager** filters on both pages. Sale price and actual margin per customer (closed priced jobs only), Top 10 **Jobs Over Estimates** (actual more than estimate; the default) and **Jobs Under Estimates** lists, chosen with a **Show** dropdown (over, under, both side by side, or both stacked so each table has the full width), net and gross variance side by side, a Needs Attention score, a diverging bar chart and (for customers) a how-often vs how-far quadrant chart. Click any row to drill down: operation or material, then part numbers (repeat offenders marked), then the jobs, each linking to its job or post-mortem; or one customer in full. Filters for dates, closed / in-progress, minimum jobs, $ / hours / % basis, outliers and internal jobs, and a CSV of the current table. See docs/QUOTE_ACCURACY.md for the definitions and assumptions. |
| **Flagged Jobs** | Every flagged job, biggest $ impact first. Includes **Sale Price**, **Planned Margin**, **Actual Margin** and **Likely Cause** (price / set-up, overrun, on target) for each job, with a Likely Cause filter, so you can compare margins across jobs; the Excel export has the same, plus planned and actual cost. Filter by dates, closed / in progress, flag colour (choose **All jobs (flagged or not)** to see every job), include jobs with no sales order, over / under, customer, part, op code, resource group, $ impact. Click a column title to sort, drag it to move the column, and use **Columns** to show or hide columns (**Save as my default** remembers your columns, their order and the widths you dragged them to); type in the boxes under the titles to filter further. **Export to Excel** downloads exactly what you see. |
| **Job Study** (tick jobs on Flagged Jobs, then **Study ticked jobs**, or **Study all** in the list) | Looks at several jobs together to find patterns. A plain-words **summary** (average planned and actual margin against the goal, and a readout for Estimating, Job Release and Shop); a **margin table** (simple average, median, revenue-weighted, margin dollars, labour hours); a **line graph** of planned vs actual margin for each job in close-date order; **Where to Look, Job by Job** (hours multiple, the price that would have earned the goal, and whether the loss points at estimating, job release plus shop, or the shop); each **operation across the jobs** (hours multiple, how many jobs ran over, share of the overrun, usually over or under); a job-by-operation colour **heat map**; **repeat parts** (the same part across jobs, and whether it lost money every run); the materials with the biggest dollar differences; and any jobs whose quantities disagree. **Print / Save as PDF** and **Export Study to Excel** are at the top. The split between estimating and job release is a rule of thumb: for a firm answer the app needs the quoted hours (the optional Quote vs Job BAQ, `docs/BAQ_SETUP.md` section 9). Drag the right edge of a column title on any Study table to resize it; **Save Column Widths** remembers your widths on any computer. |
| **Job detail** (click a job) | Customer, part, qty, dates. **Operations**: estimated vs actual (setup, run, total, hours per piece), variance %, $, flag, complete or open. Click **Labour** on a row to see each clock-in. **Price and Margin (CAD)**: the sale price, the job's planned cost and its actual (final, or so far) cost, and the margin each leaves (cost is labour, material, the sub-assembly jobs it used, and subcontract; see `docs/QUOTE_ACCURACY.md`), with a plain-words note on whether the price, the job set-up or the shop floor is the likelier cause (needs the optional `Claude_PostMortem_JobRevenue` BAQ, see `docs/BAQ_SETUP.md` section 9; set the target margin in Settings). **Materials**: estimated vs actual quantity and dollars, usage vs cost-basis split, backflush marker. A bar chart of estimated vs actual hours. **Start post-mortem** and **Printable report** buttons. |
| **Post-Mortems** | Reviews that have been started. Open one to set the owner and review date, pick root causes, add notes and action items, and move it along: Under Review, Root Cause Found, Actions Assigned, Closed (or Dismissed with a reason such as "data entry error"). |
| **Open Actions** | Every action item from every job, soonest due first, with overdue ones marked. |
| **Settings** (Admin) | A **Target Margin by Customer Tier** setting (A, B, C, D, New, with a default) that every margin is judged against. A **Margin % Colours** section (thresholds in points from each customer's own tier target, each with a colour, so the margins that are furthest below target stand out on the Customers pages and job tables). A **Customer Tiers and Account Managers** section (import the Customer Organization spreadsheet, or export it to edit; feeds the Tier and Account Manager columns on the Customers page). A **Jump To** menu on the left (it follows you down the page and lights up the section you are in) goes straight to any section. Thresholds, minimums, per-op overrides, rate overrides, root cause list, users, Epicor connection test, sync (the **Recent Syncs** log is a fold, closed until you open it). **Table Appearance**: pick any table from the dropdown and change its text size, minimum column width, and its row lines, column lines and cell borders (standard, on or off; thickness; colour), with a live preview. The change is the same for everyone, and **Back to standard** undoes it for that table. |
| **Your Account** (click your name) | Change your password, choose light or dark for this browser, set the **Page Width** (Full Width by default; Wide or Standard leave room at the sides of a big screen), and turn **Column Help** on or off: with it on, hovering over a table's column title shows what the column means. It is on by default and is saved per person. |
| **Printable report** | One page for the review meeting: numbers, chart, root causes, actions, notes. Press **Print / Save as PDF**. |

When you **Start post-mortem**, the app freezes a **snapshot** of the job's numbers. If someone later
corrects hours in Epicor, the post-mortem keeps the old numbers and shows a **warning** with what
changed. You can then press **Retake snapshot** if you want to accept the new numbers.

---

## 3. How a job gets flagged (in plain words)

**Labour (per operation)**
- Estimated hours = estimated setup + estimated run. Actual = actual setup + actual run.
  Variance = actual minus estimated; variance % = variance divided by estimated.
- Setup and run are shown **separately** too, because a setup overrun and a run overrun need different fixes.
- If the quantity made differs from the run quantity, the flag uses **hours per piece** instead
  (so a short run does not look like a big under-run). Both are shown.
- Estimated 0 but hours booked = **Unplanned work** (flagged, never a divide-by-zero).
- Dollars = hours x (labour rate + burden rate) for that resource group, setup and run rates separate.
  Epicor's rates are used; you can override any of them in Settings.
- On an **in-progress** job, only **completed** operations count. Open operations go on the
  **Watchlist** tab: % of estimated hours used vs % of quantity done, projected to the finish.
  (90% of hours used with 40% of the qty done projects to 2.25x the estimate.)
- Subcontract operations have no clock-ins, so they are left out of labour variance.

**Materials (per material line)**
- Both **quantity** and **dollars** are checked; the line flags on whichever trips.
- Actual comes from material transactions **net of returns to stock**.
- Dollar variance is split into **usage** (we used more or less) and **cost basis** (the unit cost
  differed). Because parts use **average costing**, the second part is the running average at issue
  versus the estimate, which is a good signal but not exactly the purchase price.
- **Backflushed** lines are marked: their quantity is system-generated, not a real count.
- On a job still in progress, a line that has not finished issuing is "Pending", not a miss.

**Colours** (defaults, change in Settings)
- Green: under 10% off. Yellow: 10 to 25% off. Red: more than 25% off. Over **and** under both count.
- A variance is only flagged if it is also at least **2 hours or $250**. This stops tiny jobs from flooding the list.
- Per op code or resource group you can set different limits (for example WELD 10%, ASSY 20%).

**Ranking**: jobs are ranked by **$ impact** (the dollars on the flagged lines, labour plus material), not by percentage.

---

## 4. Changing settings (Admin)

Open **Settings**. Every change below re-checks all jobs immediately.
- **Thresholds and rules**: green / red limits, minimum hours and dollars, sync window, whether to scale
  material to the quantity made, whether to leave out jobs with no sales order (on by default).
- **Overrides**: add an op code or resource group with its own limits.
- **Rates**: type over any Epicor rate. Blank = use Epicor's.
- **Root cause list**: add, rename or hide causes. Old reviews keep what they had.
- **Users**: add people, set Admin or Reviewer, reset passwords, deactivate.

**Admin** can see settings, users and **employee-level data** (who clocked what). **Reviewers** see
everything else; operator names and numbers are hidden from them (and from printed reports).

---

## 5. Getting data from Epicor

The app keeps its **own copy** of the data (it never asks Epicor on every page view).
- **Sync now** (Dashboard or Settings): open jobs plus anything closed since the last sync.
- **Full re-sync** (Settings): re-reads everything in the sync window (default 12 months). You can pick a start date.
- **Automatic sync** (Settings, "Automatic sync"): on by default for real Epicor data. Every day at the
  chosen time (default 02:00, this PC's clock) it runs **Sync now** by itself; on **Sundays** it does a full
  re-sync instead, which also picks up late corrections to older jobs. You can change the time, turn the
  Sunday full re-sync off, or turn the whole thing off. It is not used in demo mode.
  - The PC and the app (the black window) must be running at that time. If it was off, the sync runs
    about a minute after the app starts.
  - If a sync fails (for example Epicor is down) it retries every 30 minutes, up to 3 times, then waits for the next day.
  - Automatic runs show as "automatic" in the sync log.
- Every sync is logged in Settings (start, end, rows, errors).

### Connecting for real
1. Build the BAQs in Epicor by following **`docs/BAQ_SETUP.md`** (step by step).
2. Copy **`.env.example`** to **`.env`** (start.bat already made one in demo mode) and fill in the values
   **yourself**: `EPICOR_BASE_URL`, `EPICOR_COMPANY`, `EPICOR_API_KEY`, `EPICOR_USERNAME`, `EPICOR_PASSWORD`.
   Then set `USE_MOCK_DATA=false`.
   - **Never paste these into chat, email or a ticket.** `.env` is excluded from git.
   - The app never prints them. Error messages and logs hide them.
3. Close and restart the app. In **Settings** press **Test connection**: it shows only PASS or FAIL and the reason.
4. Press **Full re-sync**.
5. If a BAQ column is named differently in your Epicor, fix it in **one line** of
   `src/epicor/epicor_field_map.js` (the left-hand name). Nothing else changes.

(The guided "field check" report and the CSV/Excel import fallback are the next build step.)

---

## 6. Backups

Everything the app stores (post-mortems, notes, users, settings) is in **one file**: `data\postmortem.db`.
- **Back up**: double-click **`backup.bat`**. It saves a dated copy in `backups\` (keeps the newest 30)
  and is safe to run while the app is running. Copy that folder somewhere safe (a network drive).
- **Restore**: stop the app, copy a backup over `data\postmortem.db`, start the app.
- The Epicor data in the database can always be re-created with a Full re-sync; the **post-mortem work** is what you must protect.

---

## 7. Letting coworkers use it (later)

Right now the app is **local only** (just this PC). To let others on the network open it:
1. Right-click **`allow_network.bat`** and **Run as administrator** (opens just the app's port, private networks only).
2. In `.env` add `HOST=0.0.0.0`, then restart the app.
3. Others open **http://NCHACKO-LP:8080** (this PC's name and the port).

Notes: the app is plain HTTP, so passwords travel unencrypted on your network. That is normal for a
small trusted office LAN; see "Moving to a server" for HTTPS. This PC must be on and awake. To undo:
run `allow_network.bat remove` as administrator and remove `HOST=` from `.env`.

---

## 8. Moving it to a server later

1. Install Node.js 22 or newer on the server.
2. Copy the whole app folder, **including** `.env` and the `data` folder, to the server.
3. Run `start.bat` once (or `npm install --omit=dev` then `npm start`) to check it works.
4. Run it as a Windows service so it starts by itself: NSSM (free) or Task Scheduler "at startup",
   command `node --env-file=.env src/server.js` in the app folder.
5. Set `HOST=0.0.0.0` and open the port in the server's firewall.
6. For HTTPS, put a reverse proxy (IIS with ARR, Caddy or nginx) in front and point it at the app's port.
7. SQLite is fine for a small team. If you outgrow it, the data layer is isolated in `src/` and can be moved to another database.

---

## 9. If something is wrong

| What you see | What to do |
|--------------|-----------|
| "Node.js was not found" | Install Node.js LTS from nodejs.org, then run start.bat again. |
| "Port 8080 is already in use" | The app may already be running (check the taskbar), or set `PORT=8081` in `.env`. |
| Dashboard says "No job data yet" | Settings, Sync now. |
| The automatic sync did not run | Check Settings, "Automatic sync" is ticked and the app was running at that time. The sync log shows each attempt; a failed one shows its reason. |
| Sync fails with 401 / 403 / 404 | See the plain-English message in Settings. It usually means wrong credentials, BAQ not shared, or a typo in the BAQ ID (see BAQ_SETUP.md section 8.1). |
| Sync says a BAQ is "missing required column" | A column name differs: fix it in `src/epicor/epicor_field_map.js`. |
| Forgot the Admin password | Another Admin can reset it in Settings. If there is no other Admin, ask for help: it needs a one-line database change. |
| "Your page expired" | Reload the page and try again (you were signed out or the page was old). |
| A job looks wrong | Check the **Data quality** tab on the job (bad clock-ins, zero-hour operations). **Dismiss** the job with a reason if the data cannot be trusted. |

Times shown in logs and notes are **UTC**.

---

## 10. Security

- Credentials only in `.env`; `.env` is in `.gitignore`; never logged or shown.
- GET requests only toward Epicor (the code has no way to send anything else).
- Passwords are stored hashed (bcrypt). Sessions are signed, HttpOnly cookies that expire after 12 hours.
- Forms are protected against cross-site requests. Repeated wrong passwords lock that user for 5 minutes.
- Employee-level data and settings are Admin only.

---

## 11. For whoever maintains it

```
npm start          start the server            npm run backup    back up the database
npm run dev        restart on file changes     npm run migrate   apply database updates
npm test           run all unit and page tests (about 200)
```

- `src/engine/` - the variance rules (pure functions, heavily unit tested; start here to understand the maths)
- `src/epicor/` - read-only Epicor client and the field map
- `src/mock/` - the demo data (uses our op codes)
- `src/sync/` - pulls BAQs into local tables (`scheduler.js` is the automatic daily sync); `src/metrics.js` recomputes variance after each sync
- `src/routes/`, `src/views/` - pages; `public/` - small browser scripts and the stylesheet
- `src/migrations/` - database changes (applied automatically at start)
- `docs/BAQ_SETUP.md` - how to build the BAQs in Epicor

Stack: Node.js 22+, Fastify, SQLite (built into Node), server-rendered pages with Nunjucks, HTMX,
Alpine.js, Chart.js and Tabulator. No build step.
