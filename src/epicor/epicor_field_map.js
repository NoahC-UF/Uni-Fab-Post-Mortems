// ============================================================================
//  EPICOR FIELD MAP  -  the ONE place that knows what Epicor calls things.
// ============================================================================
// If a BAQ column has a different name in your system, change the column name on
// the left (the key). Nothing else in the app needs to change: a rename is a
// one-line fix.
//
//   <Epicor column as returned by the API>: [ '<app field name>', '<type>', '<level>' ]
//
//   type  : string | int | id | number | bool | date | time
//           (id = whole number where empty/0 means "none", e.g. order number)
//   level : 'req'  -> the sync stops with a clear error if this column is missing
//           'warn' -> the sync continues, the field check reports it as a warning
//           (omitted) -> optional
//
// Epicor returns columns as TableName_FieldName (JobHead_JobNum) and calculated
// fields as Calculated_Name. See docs/BAQ_SETUP.md. Do not edit the app field
// names (second item) unless you also change the code that uses them.
// ============================================================================

export const BAQ_MAP = {
  jobHeader: {
    id: 'Claude_PostMortem_JobHeader',
    label: 'Job header',
    keys: ['jobNum'],
    columns: {
      JobHead_Company: ['company', 'string'],
      JobHead_JobNum: ['jobNum', 'string', 'req'],
      JobHead_PartNum: ['partNum', 'string', 'warn'],
      JobHead_RevisionNum: ['revisionNum', 'string'],
      JobHead_PartDescription: ['partDescription', 'string'],
      JobHead_ProdQty: ['prodQty', 'number', 'req'],
      JobHead_QtyCompleted: ['qtyCompleted', 'number', 'req'],
      JobHead_JobReleased: ['released', 'bool', 'warn'],
      JobHead_JobComplete: ['complete', 'bool'],
      JobHead_JobClosed: ['closed', 'bool', 'req'],
      JobHead_ClosedDate: ['closedDate', 'date', 'warn'],
      JobHead_JobCompletionDate: ['completionDate', 'date'],
      JobHead_StartDate: ['startDate', 'date'],
      JobHead_ReqDueDate: ['reqDueDate', 'date'],
      JobHead_ProdCode: ['prodCode', 'string'],
      JobHead_PersonID: ['plannerId', 'string'],
      JobHead_QuoteNum: ['quoteNum', 'id'],
      JobHead_QuoteLine: ['quoteLine', 'id'],
      JobProd_OrderNum: ['orderNum', 'id'],
      JobProd_OrderLine: ['orderLine', 'id'],
      Customer_CustID: ['custId', 'string'],
      Customer_Name: ['custName', 'string', 'warn'],
      Calculated_ScopeDate: ['scopeDate', 'date'],
    },
  },

  jobOperations: {
    id: 'Claude_PostMortem_JobOperations',
    label: 'Job operations',
    keys: ['jobNum', 'assemblySeq', 'oprSeq'],
    columns: {
      JobOper_Company: ['company', 'string'],
      JobOper_JobNum: ['jobNum', 'string', 'req'],
      JobOper_AssemblySeq: ['assemblySeq', 'int', 'req'],
      JobOper_OprSeq: ['oprSeq', 'int', 'req'],
      JobAsmbl_PartNum: ['assemblyPart', 'string'],
      JobAsmbl_Description: ['assemblyDesc', 'string'],
      JobOper_OpCode: ['opCode', 'string', 'req'],
      JobOper_OpDesc: ['opDesc', 'string'],
      JobOper_EstSetHours: ['estSetHours', 'number', 'req'],
      JobOper_EstProdHours: ['estProdHours', 'number', 'req'],
      JobOper_ActSetupHours: ['actSetupHours', 'number', 'req'],
      JobOper_ActProdHours: ['actProdHours', 'number', 'req'],
      JobOper_RunQty: ['runQty', 'number', 'req'],
      JobOper_QtyCompleted: ['qtyCompleted', 'number', 'req'],
      JobOper_OpComplete: ['opComplete', 'bool', 'req'],
      JobOper_ProdStandard: ['prodStandard', 'number'],
      JobOper_StdFormat: ['stdFormat', 'string'],
      JobOper_SubContract: ['subcontract', 'bool', 'warn'],
      JobOpDtl_OpDtlSeq: ['opDtlSeq', 'int'],
      JobOpDtl_ResourceGrpID: ['resourceGrpId', 'string', 'warn'],
      JobOpDtl_ResourceID: ['resourceId', 'string'],
      ResourceGroup_Description: ['rgDescription', 'string'],
      ResourceGroup_SetupLabRate: ['setLabRate', 'number', 'warn'],
      ResourceGroup_ProdLabRate: ['prodLabRate', 'number', 'warn'],
      ResourceGroup_SetupBurRate: ['setBurRate', 'number', 'warn'],
      ResourceGroup_ProdBurRate: ['prodBurRate', 'number', 'warn'],
      Calculated_ScopeDate: ['scopeDate', 'date'],
    },
  },

  laborDetail: {
    id: 'Claude_PostMortem_LaborDetail',
    label: 'Labour detail',
    keys: ['laborHedSeq', 'laborDtlSeq'],
    columns: {
      LaborDtl_Company: ['company', 'string'],
      LaborDtl_LaborHedSeq: ['laborHedSeq', 'int', 'req'],
      LaborDtl_LaborDtlSeq: ['laborDtlSeq', 'int', 'req'],
      LaborDtl_JobNum: ['jobNum', 'string', 'req'],
      LaborDtl_AssemblySeq: ['assemblySeq', 'int', 'req'],
      LaborDtl_OprSeq: ['oprSeq', 'int', 'req'],
      LaborDtl_EmployeeNum: ['employeeNum', 'string'],
      EmpBasic_Name: ['employeeName', 'string'],
      EmpBasic_Shift: ['shift', 'string'],
      EmpBasic_JCDept: ['dept', 'string'],
      LaborDtl_LaborType: ['laborType', 'string', 'warn'],
      LaborDtl_ClockInDate: ['clockInDate', 'date', 'warn'],
      LaborDtl_ClockinTime: ['clockInTime', 'time'],
      LaborDtl_ClockOutTime: ['clockOutTime', 'time'],
      LaborDtl_LaborHrs: ['laborHrs', 'number', 'req'],
      LaborDtl_BurdenHrs: ['burdenHrs', 'number'],
      LaborDtl_LaborQty: ['laborQty', 'number'],
      LaborDtl_ScrapQty: ['scrapQty', 'number'],
      LaborDtl_ScrapReasonCode: ['scrapReason', 'string'],
      LaborDtl_DiscrepQty: ['discrepQty', 'number'],
      LaborDtl_ResourceGrpID: ['resourceGrpId', 'string'],
      LaborDtl_LaborRate: ['laborRate', 'number'],
      LaborDtl_BurdenRate: ['burdenRate', 'number'],
      LaborDtl_ActiveTrans: ['activeTrans', 'bool'],
      LaborDtl_TimeStatus: ['timeStatus', 'string'],
      Calculated_ScopeDate: ['scopeDate', 'date'],
    },
  },

  jobMaterials: {
    id: 'Claude_PostMortem_JobMaterials',
    label: 'Job materials',
    keys: ['jobNum', 'assemblySeq', 'mtlSeq'],
    columns: {
      JobMtl_Company: ['company', 'string'],
      JobMtl_JobNum: ['jobNum', 'string', 'req'],
      JobMtl_AssemblySeq: ['assemblySeq', 'int', 'req'],
      JobMtl_MtlSeq: ['mtlSeq', 'int', 'req'],
      JobMtl_PartNum: ['partNum', 'string'],
      JobMtl_Description: ['description', 'string'],
      JobMtl_QtyPer: ['qtyPer', 'number'],
      JobMtl_RequiredQty: ['requiredQty', 'number', 'req'],
      JobMtl_IssuedQty: ['issuedQty', 'number', 'req'],
      JobMtl_IUM: ['ium', 'string'],
      JobMtl_EstUnitCost: ['estUnitCost', 'number', 'warn'],
      JobMtl_IssuedComplete: ['issuedComplete', 'bool'],
      JobMtl_BackFlush: ['backflush', 'bool'],
      JobMtl_RelatedOperation: ['relatedOperation', 'int'],
      JobMtl_BuyIt: ['buyIt', 'bool'],
      Part_ClassID: ['classId', 'string'],
      Part_ProdCode: ['prodCode', 'string'],
      JobMtl_UnitCost: ['unitCost', 'number'],
      JobMtl_TotalCost: ['totalCost', 'number'],
      Calculated_ScopeDate: ['scopeDate', 'date'],
    },
  },

  materialTransactions: {
    id: 'Claude_PostMortem_MaterialTransactions',
    label: 'Material transactions',
    keys: ['tranNum'],
    columns: {
      PartTran_Company: ['company', 'string'],
      PartTran_TranNum: ['tranNum', 'int', 'req'],
      PartTran_TranDate: ['tranDate', 'date'],
      PartTran_TranType: ['tranType', 'string', 'req'],
      PartTran_JobNum: ['jobNum', 'string', 'req'],
      PartTran_AssemblySeq: ['assemblySeq', 'int', 'req'],
      PartTran_JobSeq: ['mtlSeq', 'int', 'req'],
      PartTran_PartNum: ['partNum', 'string'],
      PartTran_TranQty: ['tranQty', 'number', 'req'],
      PartTran_UM: ['um', 'string'],
      PartTran_MtlUnitCost: ['mtlUnitCost', 'number', 'warn'],
      PartTran_LbrUnitCost: ['lbrUnitCost', 'number'],
      PartTran_BurUnitCost: ['burUnitCost', 'number'],
      PartTran_SubUnitCost: ['subUnitCost', 'number'],
      PartTran_MtlBurUnitCost: ['mtlBurUnitCost', 'number'],
      PartTran_ExtCost: ['extCost', 'number', 'warn'],
      Calculated_ScopeDate: ['scopeDate', 'date'],
    },
  },
};

// Material transaction types. Verify against your system (docs/BAQ_SETUP.md 7.3).
// Issues add to actual material, returns reduce it.
export const TRAN_TYPES = {
  issue: ['STK-MTL', 'PUR-MTL'],
  return: ['MTL-STK'],
};

// Order the BAQs are pulled in during a sync.
export const SYNC_ORDER = ['jobHeader', 'jobOperations', 'laborDetail', 'jobMaterials', 'materialTransactions'];

/** field name -> Epicor column name (used by the mock data to produce BAQ-shaped rows). */
export function columnFor(baqKey, field) {
  const cols = BAQ_MAP[baqKey].columns;
  for (const [col, [f]] of Object.entries(cols)) if (f === field) return col;
  return null;
}
