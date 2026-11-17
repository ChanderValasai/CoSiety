import { clDb, govDb, vfDb } from './db.ts';
import { newId } from './crypto.ts';
import { appendAuditEvent } from './auditService.ts';

export interface JournalLineInput {
  accountCode: string;
  debitPkr: number;
  creditPkr: number;
}

export interface PostJournalInput {
  societyId: string;
  refNo: string;
  entryDate: string;
  category: string;
  description: string;
  sourceType: string;
  sourceId: string;
  idempotencyKey: string;
  actorId: string;
  approverId?: string | null;
  projectId?: string | null;
  evidenceRef?: string | null;
  reversesEntryId?: string | null;
  lines: JournalLineInput[];
}

function validateBalancedLines(lines: JournalLineInput[]): void {
  if (lines.length < 2) {
    throw new Error('Double-entry posting requires at least 2 lines.');
  }
  let totalDebit = 0;
  let totalCredit = 0;
  for (const line of lines) {
    if (line.debitPkr < 0 || line.creditPkr < 0) {
      throw new Error('Negative line amounts are forbidden.');
    }
    if ((line.debitPkr === 0) === (line.creditPkr === 0)) {
      throw new Error('Each line must have either debit or credit > 0.');
    }
    totalDebit += line.debitPkr;
    totalCredit += line.creditPkr;
  }
  if (totalDebit !== totalCredit || totalDebit === 0) {
    throw new Error(`Unbalanced journal entry: debit=${totalDebit}, credit=${totalCredit}`);
  }
}

export function postVfEntry(input: PostJournalInput): { entryId: string; refNo: string; deduplicated: boolean } {
  const existing = vfDb
    .prepare('SELECT id, ref_no FROM vf_journal_entry WHERE idempotency_key = ?')
    .get(input.idempotencyKey) as { id: string; ref_no: string } | undefined;
  if (existing) {
    return { entryId: existing.id, refNo: existing.ref_no, deduplicated: true };
  }

  validateBalancedLines(input.lines);

  // Enforce levy expenditure rule (BR-07 / FR-FIN-005 / FR-FIN-013)
  if (input.category === 'project_expense' && !input.projectId) {
    throw new Error('Village Fund expenditure requires an approved project reference (BR-07).');
  }

  if (input.approverId && input.approverId === input.actorId) {
    throw new Error('Maker-checker violation: preparer cannot approve own financial entry (NFR-SEC-008).');
  }

  const entryId = newId('vfe');
  const now = new Date().toISOString();

  vfDb.exec('BEGIN IMMEDIATE');
  try {
    vfDb
      .prepare(
        `INSERT INTO vf_journal_entry (
          id, society_id, ref_no, entry_date, category, description,
          source_type, source_id, idempotency_key, reverses_entry_id,
          status, actor_id, approver_id, project_id, evidence_ref, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?, ?, ?, ?)`
      )
      .run(
        entryId,
        input.societyId,
        input.refNo,
        input.entryDate,
        input.category,
        input.description,
        input.sourceType,
        input.sourceId,
        input.idempotencyKey,
        input.reversesEntryId ?? null,
        input.actorId,
        input.approverId ?? null,
        input.projectId ?? null,
        input.evidenceRef ?? null,
        now
      );

    for (const line of input.lines) {
      const account = vfDb
        .prepare('SELECT id FROM vf_account WHERE society_id = ? AND code = ?')
        .get(input.societyId, line.accountCode) as { id: string } | undefined;
      if (!account) {
        throw new Error(`VF account code ${line.accountCode} not found for society ${input.societyId}`);
      }
      vfDb
        .prepare(
          `INSERT INTO vf_journal_line (id, society_id, entry_id, account_id, debit_pkr, credit_pkr)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(newId('vfl'), input.societyId, entryId, account.id, line.debitPkr, line.creditPkr);
    }

    vfDb.exec('COMMIT');
  } catch (err) {
    vfDb.exec('ROLLBACK');
    throw err;
  }

  appendAuditEvent({
    societyId: input.societyId,
    actorId: input.actorId,
    action: input.reversesEntryId ? 'vf.entry_reversed' : 'vf.entry_posted',
    entityType: 'vf_journal_entry',
    entityId: entryId,
    after: { refNo: input.refNo, category: input.category, sourceType: input.sourceType },
  });

  return { entryId, refNo: input.refNo, deduplicated: false };
}

export function postClEntry(input: PostJournalInput): { entryId: string; refNo: string; deduplicated: boolean } {
  const existing = clDb
    .prepare('SELECT id, ref_no FROM cl_journal_entry WHERE idempotency_key = ?')
    .get(input.idempotencyKey) as { id: string; ref_no: string } | undefined;
  if (existing) {
    return { entryId: existing.id, refNo: existing.ref_no, deduplicated: true };
  }

  validateBalancedLines(input.lines);

  if (input.approverId && input.approverId === input.actorId) {
    throw new Error('Maker-checker violation: preparer cannot approve own CL entry.');
  }

  const entryId = newId('cle');
  const now = new Date().toISOString();

  clDb.exec('BEGIN IMMEDIATE');
  try {
    clDb
      .prepare(
        `INSERT INTO cl_journal_entry (
          id, society_id, ref_no, entry_date, category, description,
          source_type, source_id, idempotency_key, status, actor_id, approver_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?, ?)`
      )
      .run(
        entryId,
        input.societyId,
        input.refNo,
        input.entryDate,
        input.category,
        input.description,
        input.sourceType,
        input.sourceId,
        input.idempotencyKey,
        input.actorId,
        input.approverId ?? null,
        now
      );

    for (const line of input.lines) {
      const account = clDb
        .prepare('SELECT id FROM cl_account WHERE society_id = ? AND code = ?')
        .get(input.societyId, line.accountCode) as { id: string } | undefined;
      if (!account) {
        throw new Error(`CL account code ${line.accountCode} not found for society ${input.societyId}`);
      }
      clDb
        .prepare(
          `INSERT INTO cl_journal_line (id, society_id, entry_id, account_id, debit_pkr, credit_pkr)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(newId('cll'), input.societyId, entryId, account.id, line.debitPkr, line.creditPkr);
    }

    clDb.exec('COMMIT');
  } catch (err) {
    clDb.exec('ROLLBACK');
    throw err;
  }

  appendAuditEvent({
    societyId: input.societyId,
    actorId: input.actorId,
    action: 'cl.entry_posted',
    entityType: 'cl_journal_entry',
    entityId: entryId,
    after: { refNo: input.refNo, category: input.category },
  });

  return { entryId, refNo: input.refNo, deduplicated: false };
}

export function getVfSummary(societyId: string) {
  const rows = vfDb
    .prepare(
      `SELECT a.code, a.name, a.account_type,
              COALESCE(SUM(l.debit_pkr), 0) AS total_debit,
              COALESCE(SUM(l.credit_pkr), 0) AS total_credit
       FROM vf_account a
       LEFT JOIN vf_journal_line l ON l.account_id = a.id
       WHERE a.society_id = ?
       GROUP BY a.id`
    )
    .all(societyId) as Array<{
    code: string;
    name: string;
    account_type: string;
    total_debit: number;
    total_credit: number;
  }>;

  const bankRow = rows.find((r) => r.code === '1100');
  const dueRow = rows.find((r) => r.code === '1200');
  const incomeRow = rows.find((r) => r.code === '4000');
  const expenseRows = rows.filter((r) => r.account_type === 'expense');

  const bankBalancePkr = (bankRow?.total_debit ?? 0) - (bankRow?.total_credit ?? 0);
  const levyPayableFromVtPkr = (dueRow?.total_debit ?? 0) - (dueRow?.total_credit ?? 0);
  const totalReceivedPkr = bankRow?.total_debit ?? 0;
  const totalSpentPkr = expenseRows.reduce((acc, r) => acc + (r.total_debit - r.total_credit), 0);

  const allocRow = vfDb
    .prepare(
      `SELECT COALESCE(SUM(amount_pkr), 0) AS total_allocated
       FROM vf_project_allocation
       WHERE society_id = ? AND status = 'allocated'`
    )
    .get(societyId) as { total_allocated: number };

  const activeLevy = vfDb
    .prepare(
      `SELECT amount_pkr, cap_at_time_pkr, effective_from, resolution_id
       FROM levy_configuration WHERE society_id = ? AND status = 'active' LIMIT 1`
    )
    .get(societyId) as
    | { amount_pkr: number; cap_at_time_pkr: number; effective_from: string; resolution_id: string }
    | undefined;

  const capRule = govDb
    .prepare(`SELECT value_json FROM gov_rule WHERE society_id = ? AND rule_key = 'levy.cap_pkr'`)
    .get(societyId) as { value_json: string } | undefined;

  return {
    bankBalancePkr,
    levyReceivablePkr: Math.max(0, levyPayableFromVtPkr),
    totalIncomeAccruedPkr: (incomeRow?.total_credit ?? 0) - (incomeRow?.total_debit ?? 0),
    totalReceivedPkr,
    totalSpentPkr,
    allocatedProjectsPkr: allocRow.total_allocated,
    unallocatedAvailablePkr: Math.max(0, bankBalancePkr - (allocRow.total_allocated - totalSpentPkr)),
    activeLevyPkr: activeLevy?.amount_pkr ?? 0,
    levyCapPkr: capRule ? Number(JSON.parse(capRule.value_json)) : activeLevy?.cap_at_time_pkr ?? 100,
  };
}

export function getClAggregateSummary(societyId: string) {
  const contribRow = clDb
    .prepare(
      `SELECT COALESCE(SUM(amount_pkr), 0) AS total_capital, COUNT(DISTINCT contributor_id) AS contributor_count
       FROM cl_contribution WHERE society_id = ?`
    )
    .get(societyId) as { total_capital: number; contributor_count: number };

  const infraRow = clDb
    .prepare(`SELECT COALESCE(SUM(amount_pkr), 0) AS total_infra FROM cl_infra_invoice WHERE society_id = ?`)
    .get(societyId) as { total_infra: number };

  const returnsPaidRow = clDb
    .prepare(
      `SELECT COALESCE(SUM(amount_pkr), 0) AS total_returns_paid
       FROM cl_return_distribution WHERE society_id = ? AND status = 'paid'`
    )
    .get(societyId) as { total_returns_paid: number };

  const bankRow = clDb
    .prepare(
      `SELECT COALESCE(SUM(l.debit_pkr), 0) - COALESCE(SUM(l.credit_pkr), 0) AS bank_bal
       FROM cl_account a
       LEFT JOIN cl_journal_line l ON l.account_id = a.id
       WHERE a.society_id = ? AND a.code = '1100'`
    )
    .get(societyId) as { bank_bal: number };

  return {
    contributorCount: contribRow.contributor_count,
    totalCapitalPkr: contribRow.total_capital,
    totalInfraPaidPkr: infraRow.total_infra,
    totalReturnsPaidPkr: returnsPaidRow.total_returns_paid,
    clBankBalancePkr: bankRow?.bank_bal ?? 0,
  };
}
