# BAQ Setup Guide (Epicor Kinetic)

This guide walks you through building the Business Activity Queries (BAQs) that feed the
Uni-Fab Post-Mortem app. You build them in **BAQ Designer** (Query Builder) in Epicor.
The app only ever **reads** from Epicor (HTTP GET). It never creates, changes or deletes anything.

> **Read this first**
> - I cannot see your Epicor. I wrote this from my knowledge of the standard Epicor schema, so
>   **field names, and some Designer menu/checkbox labels, may differ slightly in your release.**
>   Section 1 lists everything I am unsure about. If something does not match, take a screenshot
>   (with no customer data showing) or just tell me what you see, and I will fix the guide and the app.
> - Build **BAQ 1 and BAQ 2 first**, test them (Section 8), then build the rest.
> - The app is built and demoed on mock data in the meantime, so nothing here blocks development.
> - Never paste your API key or password into chat. This guide never needs them.

---

## 0. Contents

1. [Things I could not verify (please check)](#1-things-i-could-not-verify-please-check)
2. [Where I changed your outline, and why](#2-where-i-changed-your-outline-and-why)
3. [Before you start](#3-before-you-start)
4. [Common building blocks used by every BAQ](#4-common-building-blocks-used-by-every-baq)
5. [BAQ 1: Claude_PostMortem_JobHeader](#5-baq-1-claude_postmortem_jobheader)
6. [BAQ 2: Claude_PostMortem_JobOperations](#6-baq-2-claude_postmortem_joboperations)
7. [BAQ 3, 4, 5: Labor, Materials, Material Transactions](#7-baqs-3-4-5)
8. [Testing, and what to send me](#8-testing-and-what-to-send-me)
9. [Optional BAQs (Phase 2 and 3), outline only](#9-optional-baqs-phase-2-and-3-outline-only)

---

## 1. Things I could not verify (please check)

Check each in BAQ Designer when you add the table: double-click the table and look at its field list.

| # | What | My concern | What to do |
|---|------|-----------|------------|
| 1 | `JobHead.PersonID` ("planner") | Not sure this field exists on JobHead, or that it means "planner". | If you cannot find it, skip it. If there is a planner/engineer field, tell me its name. |
| 2 | `JobHead.QuoteNum`, `JobHead.QuoteLine` | Probably exist, but only filled when the job came from a quote. | Include if present. |
| 3 | `JobProd.AssemblySeq` | Not yet confirmed. The only similar field seen so far is `TargetAssemblySeq`, which means something else. | Use no criteria on JobProd. The app tolerates duplicate rows and keeps the lowest order and line. |
| 4 | `JobMtl.EstUnitCost` | **Highest risk.** Name may differ, or it may be 0 on jobs not created from a quote. The whole material dollar estimate depends on it. | Check a couple of real jobs. If it is empty, also include `JobMtl.UnitCost` (listed as optional extra) and tell me which holds the estimate. |
| 5 | `ResourceGroup` rate fields | I expect `SetupLabRate`, `ProdLabRate`, `SetupBurRate`, `ProdBurRate`. These are **current** group rates, not rates frozen when the job ran. | Confirm names. Tell me if JobOper or JobOpDtl also carry rate fields in your system. |
| 6 | `LaborDtl.TimeStatus` codes | I do not know which letter means Entered, Submitted, Approved, etc. in your release. | Tell me the codes you see in real data (Section 7.1 test). |
| 7 | `LaborDtl.LaborRate` / `BurdenRate` | These are the **employee's pay rate**, which is sensitive. The dollar impact in the app uses **ResourceGroup** rates, so these are not needed. | They are marked optional. Omit them if you do not want wage data to leave Epicor. The app never shows them to Reviewers either way. |
| 8 | `PartTran.TranType` list | `STK-MTL`, `PUR-MTL`, `MTL-STK` are the ones I am confident about. There may be others in your system (job-to-job transfers, etc.). | Run the TranType check in Section 7.3. |
| 9 | `PartTran.TranQty` sign | I do not know if returns (`MTL-STK`) are stored as positive or negative quantities. | The app handles both (it applies the direction from TranType). The Section 7.3 test confirms what you have. |
| 10 | `LaborDtl.ClockinTime` spelling | Epicor really does use `ClockInDate` but `ClockinTime` (lowercase "i"). I kept your spelling. | If Designer shows a different case, use what it shows. |
| 11 | Costing and `PartTran` unit costs | With **average costing**, `MtlUnitCost` at issue is the running average, not the invoice price. | Not a BAQ problem. The app labels the price split "cost-basis variance" and the README explains it. |

---

## 2. Where I changed your outline, and why

**a. The date parameter uses job scope, not `ClockInDate` (BAQ 3, 4, 5).**
You asked for `@FromDate` on `LaborDtl.ClockInDate`. If the labour BAQ only returned clock-ins since the
date, a job that started before that date would arrive with *half* its labour, and actual hours would
never reconcile with `JobOper`. So **all five BAQs use the same rule**: pull *every* row for every job in
scope, where scope = **released jobs that are still open, plus jobs closed on or after `@FromDate`.**
Open jobs are always included (as you asked). Jobs closed long ago drop out, so incremental syncs stay small.

**b. "Labour activity since" is folded into that rule.**
A closed job can only have new labour if it was reopened, which is rare. A reopened job is "open"
again, so it is included automatically.

**c. Extra columns I added** (each is needed to make rows unique or to join correctly):

| BAQ | Added | Why |
|-----|-------|-----|
| JobOperations | `JobOpDtl.OpDtlSeq` | Lets the app pick one row if an op ever has two resources. |
| LaborDetail | `LaborDtl.LaborHedSeq` | `LaborDtlSeq` alone is not guaranteed unique. The real key is HedSeq + DtlSeq. |
| Materials | `JobMtl.UnitCost`, `JobMtl.TotalCost` (optional) | Fallback if `EstUnitCost` is empty (see item 4 above). |

**d. Column names.** The Epicor API returns columns as `TableName_FieldName` (for example
`JobHead_JobNum`) and calculated fields as `Calculated_Name`. **Do not rename columns in Designer.**
Each BAQ below lists the exact "expected API column" so we can check them. The app maps these names
to its own names in one file (`epicor_field_map.js`).

**e. One row per job.** A job can be linked to several order lines, which would repeat the job's row.
BAQ 1 is built the simple way (direct joins). If duplicates appear, the app keeps the lowest order and
line and tells you how many it merged. This avoids a complicated subquery for you to build.

---

## 3. Before you start

### 3.1 Naming and settings (every BAQ)

- **Query ID:** exactly as given (`Claude_PostMortem_...`). The ID is case-sensitive in the URL the app calls.
- **Description:** use the one given.
- **Updatable / "Updatable Query":** **OFF** (unchecked). Every Claude_PostMortem_ BAQ is read-only.
- **Shared:** **ON** (shared with everyone, not a private query). The API user is not the author, so a
  private query will not be found.
- **Security:** see 3.2.
- Do not enable any "process server" or "allow write" style option.

### 3.2 The API integration user

You said a read-only integration user already exists. Checklist:

1. The user can sign in through the API (API Key created in **API Key Maintenance** and tied to the right company).
2. The user belongs to a **security group** that allows running BAQs. If you use a dedicated group
   (for example `Claude_PostMortem_API`), give it access to the BAQ service and to each Claude_PostMortem_ query. In Kinetic
   this is normally done through **Security Maintenance / Group Maintenance** (menu and business-object
   security) plus the BAQ's sharing settings. The exact screens depend on how your company set up
   security, so ask whoever administers Epicor if the test in 8.1 fails.
3. The user does **not** need any update rights anywhere, and should not have them.

### 3.3 Dates

Each BAQ has one parameter `FromDate`. When Designer asks for a value to test with, use a date about
60 days ago, not 1900, so the preview stays fast. The app will pass dates as `YYYY-MM-DD`.

---

## 4. Common building blocks used by every BAQ

### 4.1 Parameter `FromDate`

| Property | Value |
|----------|-------|
| Name | `FromDate` |
| Type / data type | Date |
| Required / prompt | Yes (prompt when run) |
| Default | leave blank |

Find it in Designer under the **Criteria** tab (Parameters / "Query Parameters"). In some releases you
add parameters from the criteria row itself by choosing a compare-to type of *Parameter*.

### 4.2 The Scope block (JobHead + `ScopeDate` + criteria)

Every BAQ starts with `JobHead` as its first (anchor) table and applies the same scope rule, so all
five BAQs always describe the same set of jobs.

**Table criteria on JobHead:** `JobHead.JobReleased = true`

**Calculated field `ScopeDate`** (in the Display Fields phase, add a calculated field):

| Property | Value |
|----------|-------|
| Field name | `ScopeDate` |
| Data type | `date` |
| Formula | see below |

```sql
case
  when JobHead.JobClosed = 1
    then coalesce(JobHead.ClosedDate, JobHead.JobCompletionDate)
  else cast('9999-12-31' as date)
end
```

Meaning: an **open** job gets the date 9999-12-31 so it always passes. A **closed** job uses its
closed date (or its completion date if the closed date is empty).

**Criteria on that field:** `Calculated_ScopeDate  >=  @FromDate` (compare to the parameter).

> **If Designer will not let you filter on a calculated field** (no `ScopeDate` in the criteria
> field list), use this fallback:
> 1. In the query, add a **Subquery** named `Scope`. In it, put `JobHead` with the table criteria above.
>    Display `JobHead.Company`, `JobHead.JobNum`, plus the calculated field `ScopeDate`.
> 2. In the main query, join to the subquery on `Company` and `JobNum` (inner join).
> 3. Set the criteria `Scope.ScopeDate >= @FromDate` in the main query. Fields coming from a
>    subquery can always be filtered there.
>
> If neither works, tell me. The app can also filter with an OData `$filter` as a last resort.

**Join from JobHead to the detail table** is always on `Company` and `JobNum` (inner join), so only
jobs in scope bring detail rows.

---

## 5. BAQ 1: Claude_PostMortem_JobHeader

One row per job (see 2e about multi-order jobs).

- **Query ID:** `Claude_PostMortem_JobHeader`
- **Description:** `Post-mortem app: one row per released job (open, or closed since @FromDate)`

### 5.1 Tables and joins

| Order | Table | Join to | Join type | Join fields | Table criteria |
|-------|-------|---------|-----------|-------------|----------------|
| 1 | `JobHead` | (anchor) | | | `JobReleased = true` |
| 2 | `JobProd` | JobHead | **Left outer** (Designer: "All rows from JobHead") | `JobHead.Company = JobProd.Company` and `JobHead.JobNum = JobProd.JobNum` | none (no `JobProd.AssemblySeq` criteria; see 1, item 3) |
| 3 | `OrderHed` | JobProd | **Left outer** (Designer: "All rows from JobProd") | `JobProd.Company = OrderHed.Company` and `JobProd.OrderNum = OrderHed.OrderNum` | none |
| 4 | `Customer` | OrderHed | **Left outer** (Designer: "All rows from OrderHed") | `OrderHed.Company = Customer.Company` and `OrderHed.CustNum = Customer.CustNum` | none |

In Kinetic's Join Type dropdown, "All rows from X" (X = the table on the left) is the left outer join.
Do **not** pick "All rows from X and Y" (that is a full outer join and returns every order and customer).

Why left outer: jobs with no sales order (stock or internal jobs) must still appear. The app excludes
them by default through a Settings toggle, so you can change your mind later without rebuilding the BAQ.
Table criteria on a left-outer table are applied inside the join, so those jobs are kept.

### 5.2 Query-level criteria

- `Calculated_ScopeDate >= @FromDate` (see 4.2).

### 5.3 Display fields (in this order)

| # | Table.Field | Expected API column | Notes |
|---|-------------|---------------------|-------|
| 1 | `JobHead.Company` | `JobHead_Company` | |
| 2 | `JobHead.JobNum` | `JobHead_JobNum` | key |
| 3 | `JobHead.PartNum` | `JobHead_PartNum` | |
| 4 | `JobHead.RevisionNum` | `JobHead_RevisionNum` | |
| 5 | `JobHead.PartDescription` | `JobHead_PartDescription` | |
| 6 | `JobHead.ProdQty` | `JobHead_ProdQty` | |
| 7 | `JobHead.QtyCompleted` | `JobHead_QtyCompleted` | |
| 8 | `JobHead.JobReleased` | `JobHead_JobReleased` | |
| 9 | `JobHead.JobComplete` | `JobHead_JobComplete` | |
| 10 | `JobHead.JobClosed` | `JobHead_JobClosed` | |
| 11 | `JobHead.ClosedDate` | `JobHead_ClosedDate` | |
| 12 | `JobHead.JobCompletionDate` | `JobHead_JobCompletionDate` | |
| 13 | `JobHead.StartDate` | `JobHead_StartDate` | |
| 14 | `JobHead.ReqDueDate` | `JobHead_ReqDueDate` | |
| 15 | `JobHead.ProdCode` | `JobHead_ProdCode` | |
| 16 | `JobHead.PersonID` | `JobHead_PersonID` | planner; see 1, item 1 |
| 17 | `JobHead.QuoteNum` | `JobHead_QuoteNum` | |
| 18 | `JobHead.QuoteLine` | `JobHead_QuoteLine` | |
| 19 | `JobProd.OrderNum` | `JobProd_OrderNum` | |
| 20 | `JobProd.OrderLine` | `JobProd_OrderLine` | |
| 21 | `Customer.CustID` | `Customer_CustID` | |
| 22 | `Customer.Name` | `Customer_Name` | |
| 23 | calculated `ScopeDate` | `Calculated_ScopeDate` | used by the app for incremental sync |

### 5.4 Calculated fields and parameters

- `ScopeDate`: see 4.2.
- Parameter `FromDate`: see 4.1.

### 5.5 Settings

Updatable OFF, Shared ON, security per 3.2.

### 5.6 Quick test (Analyze, then Get List)

1. Enter `FromDate` = 60 days ago and run.
2. Rows with `JobClosed = false` should roughly equal the number of **open released** jobs in Job Tracker.
3. Change `FromDate` to yesterday and run again: the closed rows should mostly disappear, the **open
   rows should stay the same**.
4. Pick one job you know. Compare part, qty, dates and customer with Job Entry.
5. Look for a job number that appears twice. That is a multi-order job (fine, see 2e).
6. Jobs with no order should appear with empty `JobProd_OrderNum` and customer.

---

## 6. BAQ 2: Claude_PostMortem_JobOperations

One row per job operation.

- **Query ID:** `Claude_PostMortem_JobOperations`
- **Description:** `Post-mortem app: estimated vs actual hours per job operation`

### 6.1 Tables and joins

| Order | Table | Join to | Join type | Join fields | Table criteria |
|-------|-------|---------|-----------|-------------|----------------|
| 1 | `JobHead` | (anchor) | | | `JobReleased = true` |
| 2 | `JobOper` | JobHead | **Inner** | `Company`, `JobNum` | none |
| 3 | `JobOpDtl` | JobOper | **Left outer** | `Company`, `JobNum`, `AssemblySeq`, `OprSeq` | none |
| 4 | `ResourceGroup` | JobOpDtl | **Left outer** | `JobOpDtl.Company = ResourceGroup.Company` and `JobOpDtl.ResourceGrpID = ResourceGroup.ResourceGrpID` | none |
| 5 | `JobAsmbl` | JobOper | **Left outer** | `Company`, `JobNum`, `AssemblySeq` | none |

Notes: Join 3 and 5 start from `JobOper`, not `JobHead`. You said each op has one resource, so
`JobOpDtl` should add no extra rows. If it does, `OpDtlSeq` lets the app choose one.

### 6.2 Query-level criteria

- `Calculated_ScopeDate >= @FromDate` (see 4.2).

### 6.3 Display fields (in this order)

| # | Table.Field | Expected API column | Notes |
|---|-------------|---------------------|-------|
| 1 | `JobOper.Company` | `JobOper_Company` | |
| 2 | `JobOper.JobNum` | `JobOper_JobNum` | key |
| 3 | `JobOper.AssemblySeq` | `JobOper_AssemblySeq` | key |
| 4 | `JobOper.OprSeq` | `JobOper_OprSeq` | key |
| 5 | `JobAsmbl.PartNum` | `JobAsmbl_PartNum` | assembly part |
| 6 | `JobAsmbl.Description` | `JobAsmbl_Description` | |
| 7 | `JobOper.OpCode` | `JobOper_OpCode` | |
| 8 | `JobOper.OpDesc` | `JobOper_OpDesc` | |
| 9 | `JobOper.EstSetHours` | `JobOper_EstSetHours` | |
| 10 | `JobOper.EstProdHours` | `JobOper_EstProdHours` | |
| 11 | `JobOper.ActSetupHours` | `JobOper_ActSetupHours` | |
| 12 | `JobOper.ActProdHours` | `JobOper_ActProdHours` | |
| 13 | `JobOper.RunQty` | `JobOper_RunQty` | |
| 14 | `JobOper.QtyCompleted` | `JobOper_QtyCompleted` | |
| 15 | `JobOper.OpComplete` | `JobOper_OpComplete` | |
| 16 | `JobOper.ProdStandard` | `JobOper_ProdStandard` | |
| 17 | `JobOper.StdFormat` | `JobOper_StdFormat` | |
| 18 | `JobOper.SubContract` | `JobOper_SubContract` | |
| 19 | `JobOpDtl.OpDtlSeq` | `JobOpDtl_OpDtlSeq` | added by me |
| 20 | `JobOpDtl.ResourceGrpID` | `JobOpDtl_ResourceGrpID` | |
| 21 | `JobOpDtl.ResourceID` | `JobOpDtl_ResourceID` | |
| 22 | `ResourceGroup.Description` | `ResourceGroup_Description` | |
| 23 | `ResourceGroup.SetupLabRate` | `ResourceGroup_SetupLabRate` | verify, see 1, item 5 |
| 24 | `ResourceGroup.ProdLabRate` | `ResourceGroup_ProdLabRate` | verify |
| 25 | `ResourceGroup.SetupBurRate` | `ResourceGroup_SetupBurRate` | verify |
| 26 | `ResourceGroup.ProdBurRate` | `ResourceGroup_ProdBurRate` | verify |
| 27 | calculated `ScopeDate` | `Calculated_ScopeDate` | |

(`JobHead` fields are not displayed here. `JobHead` is only used for scope. The app matches rows to
BAQ 1 by `JobNum`.)

### 6.4 Calculated fields, parameters, settings

- Calculated `ScopeDate` and parameter `FromDate`: see 4.1 and 4.2.
- Updatable OFF, Shared ON, security per 3.2.

### 6.5 Quick test

1. Row count: roughly (jobs from BAQ 1) x (ops per job).
2. Open **one closed job** in Job Entry, Operations tab. For each op compare:
   `EstSetHours`, `EstProdHours`, `ActSetupHours`, `ActProdHours`, `OpComplete`, `RunQty`, `QtyCompleted`.
3. A multi-level job should show several `AssemblySeq` values, with assembly part numbers.
4. The rate columns should be filled for every op with a resource group. If they are all 0 or empty, tell me.
5. No `JobNum + AssemblySeq + OprSeq` combination should appear twice. If one does, that op has two
   resources. Tell me which.

---

## 7. BAQs 3, 4, 5

### 7.1 BAQ 3: Claude_PostMortem_LaborDetail

One row per labour transaction. **Direct labour only** (indirect is excluded).

- **Query ID:** `Claude_PostMortem_LaborDetail`
- **Description:** `Post-mortem app: labour transactions per job operation (direct labour only)`

**Tables and joins**

| Order | Table | Join to | Join type | Join fields | Table criteria |
|-------|-------|---------|-----------|-------------|----------------|
| 1 | `JobHead` | (anchor) | | | `JobReleased = true` |
| 2 | `LaborDtl` | JobHead | **Inner** | `Company`, `JobNum` | `LaborDtl.LaborType <> 'I'` (excludes indirect) |
| 3 | `EmpBasic` | LaborDtl | **Left outer** | `LaborDtl.Company = EmpBasic.Company` and `LaborDtl.EmployeeNum = EmpBasic.EmpID` | none |

The inner join to `JobHead` also removes indirect rows (they have no job number).

**Query-level criteria:** `Calculated_ScopeDate >= @FromDate` (see 4.2).

**Display fields (in this order)**

| # | Table.Field | Expected API column | Notes |
|---|-------------|---------------------|-------|
| 1 | `LaborDtl.Company` | `LaborDtl_Company` | |
| 2 | `LaborDtl.LaborHedSeq` | `LaborDtl_LaborHedSeq` | key, added by me |
| 3 | `LaborDtl.LaborDtlSeq` | `LaborDtl_LaborDtlSeq` | key |
| 4 | `LaborDtl.JobNum` | `LaborDtl_JobNum` | |
| 5 | `LaborDtl.AssemblySeq` | `LaborDtl_AssemblySeq` | |
| 6 | `LaborDtl.OprSeq` | `LaborDtl_OprSeq` | |
| 7 | `LaborDtl.EmployeeNum` | `LaborDtl_EmployeeNum` | |
| 8 | `EmpBasic.Name` | `EmpBasic_Name` | employee-level, Admin only in the app |
| 9 | `EmpBasic.Shift` | `EmpBasic_Shift` | |
| 10 | `EmpBasic.JCDept` | `EmpBasic_JCDept` | |
| 11 | `LaborDtl.LaborType` | `LaborDtl_LaborType` | Setup vs Production |
| 12 | `LaborDtl.ClockInDate` | `LaborDtl_ClockInDate` | |
| 13 | `LaborDtl.ClockinTime` | `LaborDtl_ClockinTime` | decimal hours (14.5 = 2:30 pm) |
| 14 | `LaborDtl.ClockOutTime` | `LaborDtl_ClockOutTime` | |
| 15 | `LaborDtl.LaborHrs` | `LaborDtl_LaborHrs` | |
| 16 | `LaborDtl.BurdenHrs` | `LaborDtl_BurdenHrs` | |
| 17 | `LaborDtl.LaborQty` | `LaborDtl_LaborQty` | |
| 18 | `LaborDtl.ScrapQty` | `LaborDtl_ScrapQty` | |
| 19 | `LaborDtl.ScrapReasonCode` | `LaborDtl_ScrapReasonCode` | |
| 20 | `LaborDtl.DiscrepQty` | `LaborDtl_DiscrepQty` | |
| 21 | `LaborDtl.ResourceGrpID` | `LaborDtl_ResourceGrpID` | |
| 22 | `LaborDtl.LaborRate` | `LaborDtl_LaborRate` | **optional**, wage data, see 1, item 7 |
| 23 | `LaborDtl.BurdenRate` | `LaborDtl_BurdenRate` | **optional** |
| 24 | `LaborDtl.ActiveTrans` | `LaborDtl_ActiveTrans` | still clocked in |
| 25 | `LaborDtl.TimeStatus` | `LaborDtl_TimeStatus` | approval status |
| 26 | calculated `ScopeDate` | `Calculated_ScopeDate` | |

**Settings:** Updatable OFF, Shared ON, security per 3.2.

**Quick test**

1. For one closed job, add up `LaborHrs` for one operation (Setup + Production). It should match that
   op's `ActSetupHours + ActProdHours` in BAQ 2.
2. Make sure no row has an empty job number, and no indirect codes appear.
3. Tell me the distinct `TimeStatus` values you see, and what each means to you (Section 1, item 6).
4. Check one row that is still clocked in: `ActiveTrans` should be true and the clock-out empty or 0.

### 7.2 BAQ 4: Claude_PostMortem_JobMaterials

One row per job material line.

- **Query ID:** `Claude_PostMortem_JobMaterials`
- **Description:** `Post-mortem app: required vs issued material per job material line`

**Tables and joins**

| Order | Table | Join to | Join type | Join fields | Table criteria |
|-------|-------|---------|-----------|-------------|----------------|
| 1 | `JobHead` | (anchor) | | | `JobReleased = true` |
| 2 | `JobMtl` | JobHead | **Inner** | `Company`, `JobNum` | none |
| 3 | `Part` | JobMtl | **Left outer** | `JobMtl.Company = Part.Company` and `JobMtl.PartNum = Part.PartNum` | none |

(Left outer on `Part` keeps non-stocked or description-only lines.)

**Query-level criteria:** `Calculated_ScopeDate >= @FromDate` (see 4.2).

**Display fields (in this order)**

| # | Table.Field | Expected API column | Notes |
|---|-------------|---------------------|-------|
| 1 | `JobMtl.Company` | `JobMtl_Company` | |
| 2 | `JobMtl.JobNum` | `JobMtl_JobNum` | key |
| 3 | `JobMtl.AssemblySeq` | `JobMtl_AssemblySeq` | key |
| 4 | `JobMtl.MtlSeq` | `JobMtl_MtlSeq` | key |
| 5 | `JobMtl.PartNum` | `JobMtl_PartNum` | |
| 6 | `JobMtl.Description` | `JobMtl_Description` | |
| 7 | `JobMtl.QtyPer` | `JobMtl_QtyPer` | |
| 8 | `JobMtl.RequiredQty` | `JobMtl_RequiredQty` | |
| 9 | `JobMtl.IssuedQty` | `JobMtl_IssuedQty` | |
| 10 | `JobMtl.IUM` | `JobMtl_IUM` | |
| 11 | `JobMtl.EstUnitCost` | `JobMtl_EstUnitCost` | **verify**, see 1, item 4 |
| 12 | `JobMtl.IssuedComplete` | `JobMtl_IssuedComplete` | |
| 13 | `JobMtl.BackFlush` | `JobMtl_BackFlush` | |
| 14 | `JobMtl.RelatedOperation` | `JobMtl_RelatedOperation` | |
| 15 | `JobMtl.BuyIt` | `JobMtl_BuyIt` | |
| 16 | `Part.ClassID` | `Part_ClassID` | |
| 17 | `Part.ProdCode` | `Part_ProdCode` | |
| 18 | `JobMtl.UnitCost` | `JobMtl_UnitCost` | **optional**, fallback estimate |
| 19 | `JobMtl.TotalCost` | `JobMtl_TotalCost` | **optional** |
| 20 | calculated `ScopeDate` | `Calculated_ScopeDate` | |

**Settings:** Updatable OFF, Shared ON, security per 3.2.

**Quick test**

1. Compare a closed job with Job Entry, Materials tab: required qty, issued qty, backflush flag.
2. Check `EstUnitCost` on 3 or 4 recent jobs, including one created **without** a quote. If it is 0 or
   empty on many lines, tell me. Estimated material dollars will need another source.
3. `Part_ClassID` and `Part_ProdCode` should be filled for stocked parts.

### 7.3 BAQ 5: Claude_PostMortem_MaterialTransactions

One row per material transaction. This is where **actual** material cost comes from (net of returns).

- **Query ID:** `Claude_PostMortem_MaterialTransactions`
- **Description:** `Post-mortem app: material issues and returns per job material line`

**Step 0 (one-time check): which TranTypes exist for jobs?**
Before building BAQ 5, find the real list. Make a throw-away BAQ `Claude_PostMortem_TEMP_TranTypes` (do not
share it, delete it afterwards): table `PartTran`, criteria `PartTran.JobNum` is not empty, display
`PartTran.TranType` and a **count** of rows (group by TranType) for the last 60 days. Look for every
type that moves material **to** a job, or **back** from a job. Send me the list. I expect
`STK-MTL`, `PUR-MTL` and `MTL-STK`, and there may be others in your system.

**Tables and joins**

| Order | Table | Join to | Join type | Join fields | Table criteria |
|-------|-------|---------|-----------|-------------|----------------|
| 1 | `JobHead` | (anchor) | | | `JobReleased = true` |
| 2 | `PartTran` | JobHead | **Inner** | `Company`, `JobNum` | `PartTran.TranType` in the confirmed list, for example `STK-MTL, PUR-MTL, MTL-STK` |

If Designer will not accept a list in the criteria, use one criteria row per type (grouped with **Or** if
available). **Fallback:** leave the TranType criteria off. The BAQ gets bigger, but the app filters on
`TranType` itself (the list is in the field map).

**Query-level criteria:** `Calculated_ScopeDate >= @FromDate` (see 4.2).

**Display fields (in this order)**

| # | Table.Field | Expected API column | Notes |
|---|-------------|---------------------|-------|
| 1 | `PartTran.Company` | `PartTran_Company` | |
| 2 | `PartTran.TranNum` | `PartTran_TranNum` | key |
| 3 | `PartTran.TranDate` | `PartTran_TranDate` | |
| 4 | `PartTran.TranType` | `PartTran_TranType` | |
| 5 | `PartTran.JobNum` | `PartTran_JobNum` | |
| 6 | `PartTran.AssemblySeq` | `PartTran_AssemblySeq` | |
| 7 | `PartTran.JobSeq` | `PartTran_JobSeq` | this is the `MtlSeq` |
| 8 | `PartTran.PartNum` | `PartTran_PartNum` | |
| 9 | `PartTran.TranQty` | `PartTran_TranQty` | |
| 10 | `PartTran.UM` | `PartTran_UM` | |
| 11 | `PartTran.MtlUnitCost` | `PartTran_MtlUnitCost` | |
| 12 | `PartTran.LbrUnitCost` | `PartTran_LbrUnitCost` | |
| 13 | `PartTran.BurUnitCost` | `PartTran_BurUnitCost` | |
| 14 | `PartTran.SubUnitCost` | `PartTran_SubUnitCost` | |
| 15 | `PartTran.MtlBurUnitCost` | `PartTran_MtlBurUnitCost` | |
| 16 | `PartTran.ExtCost` | `PartTran_ExtCost` | |
| 17 | calculated `ScopeDate` | `Calculated_ScopeDate` | |

**Settings:** Updatable OFF, Shared ON, security per 3.2.

**Quick test**

1. Pick a job and one material line. Add the `STK-MTL` / `PUR-MTL` quantities and subtract the
   `MTL-STK` returns. The result should equal `JobMtl.IssuedQty` in BAQ 4 (small differences can be
   unit-of-measure conversions; tell me about big ones).
2. Find a **return** (`MTL-STK`). Tell me whether `TranQty` and `ExtCost` are **positive or negative**.
3. For one line, confirm `ExtCost` is about `TranQty x total unit cost` (the sum of the five unit costs).

---

## 8. Testing, and what to send me

### 8.1 Test with the Epicor API help page (the real API user)

When a BAQ passes the Analyze preview, test it the way the app will call it:

1. In your browser, open your Epicor API help page, normally
   `https://<your-server>/<your-instance>/api/help/v2/`. (This is the page where Epicor documents
   the REST API. Your Epicor administrator can confirm the exact address.)
2. Sign in, authorize with the integration user and API key (**you** type them in; I never need them).
3. Find the `BaqSvc` section, choose your BAQ, run **GET Data** with `$top=3` and a `FromDate`.
4. You should get JSON with columns named like `JobHead_JobNum`.

If it fails:

| Symptom | Usually means |
|---------|---------------|
| 401 | Wrong user, password or API key |
| 403 or "not authorized" | Security group or BAQ sharing (see 3.1 and 3.2) |
| 404 or "query not found" | Typo in Query ID, or the query is not Shared |
| 400 about a parameter | `FromDate` name or type is wrong |

### 8.2 What to send me after each BAQ

Either of these (pick the easier one):

- **A) Connect the app.** Put the credentials in `.env` yourself (copy `.env.example`) once Phase 1b
  is built. The app's **field check** compares the real columns with what it expects.
- **B) Send a sample.** In Analyze → Get List, export **5 to 10 rows** to Excel/CSV and give me the file.
  Before sending: delete the `EmpBasic_Name` column if you prefer to keep names private (the column
  *headers* are what I need), and remove anything that identifies a customer if you like. I only need
  the column names and a few realistic values.

Also tell me the answers to these checks, in a short list:

- [ ] Section 1, items 1 to 5: which fields were missing, or named differently
- [ ] `TimeStatus` codes (7.1)
- [ ] TranType list, and the sign of returns (7.3)
- [ ] Is `EstUnitCost` filled on jobs without a quote? (7.2)
- [ ] Any job number that appeared twice in BAQ 1 or BAQ 2

---

## 9. Optional BAQs (Phase 2 and 3), outline only

Do **not** build these yet. I will write the full step-by-step guide for each when we reach that
phase, once the first five work. They also use `FromDate`, the same scope block (Section 4.2),
Updatable OFF and Shared ON. Here is the plan so you know what is coming.

### Claude_PostMortem_Subcontract (Phase 2)

Estimated subcontract cost vs actual PO receipt cost, for operations where `JobOper.SubContract = true`.
Sources: `JobOper` (estimate), the PO release/detail linked to the job operation (`PORel` and
`PODetail`), and `PartTran` receipts of type `PUR-SUB`. Left outer joins so unreceived subcontract ops
still show. I need to confirm in your system how POs link to job operations (the `PORel` job fields).

### Claude_PostMortem_NonConformance (Phase 2)

Scrap and rework tied to a job and operation: `NonConf` (job, assembly, operation, quantity, reason
code), `DMRHead` and `DMRActn` (disposition, cost). Lets the app say whether an overrun came from
scrap or rework. Field names vary between releases, so I will check them with you first.

### Claude_PostMortem_QuoteVsJob (Phase 3)

`QuoteOpr` and `QuoteMtl` joined to the job through `JobHead.QuoteNum` / `QuoteLine`, giving
estimated quote hours and material next to the job's own estimate. This answers "did the quote or
the job method cause the miss?". It depends on `JobHead.QuoteNum` being filled, so check that in
BAQ 1 first (Section 5.6).
