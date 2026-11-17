import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DATA_DIR = path.resolve(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// Bump when schema changes significantly (v1.0 -> v1.1: vote-points, co-presidents, contests, no neighbourhood groups)
const SCHEMA_VERSION = 'v1.1-2026-11-17';
const VERSION_FILE = path.join(DATA_DIR, '.schema_version');

function ensureSchemaVersion(): void {
  const current = fs.existsSync(VERSION_FILE) ? fs.readFileSync(VERSION_FILE, 'utf8').trim() : '';
  if (current !== SCHEMA_VERSION) {
    for (const entry of fs.readdirSync(DATA_DIR)) {
      if (entry.endsWith('.db') || entry.endsWith('.db-wal') || entry.endsWith('.db-shm')) {
        fs.unlinkSync(path.join(DATA_DIR, entry));
      }
    }
    fs.writeFileSync(VERSION_FILE, SCHEMA_VERSION, 'utf8');
  }
}

ensureSchemaVersion();

function openDomainDb(name: string): DatabaseSync {
  const dbPath = path.join(DATA_DIR, `${name}.db`);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

// Physically isolated SQLite stores per SDS v1.1 §5.1 (DD-02, DD-05)
export const coreDb = openDomainDb('core');
export const ptsDb = openDomainDb('pts');
export const govDb = openDomainDb('gov');
export const voteDb = openDomainDb('vote');
export const vfDb = openDomainDb('vf');
export const clDb = openDomainDb('cl');
export const opsDb = openDomainDb('ops');
export const reconDb = openDomainDb('recon');
export const prjDb = openDomainDb('prj');
export const commDb = openDomainDb('comm');
export const auditDb = openDomainDb('audit');

export function initAllSchemas(): void {
  // 1. CORE (societies, households, members without caste/race/religion/neighbourhood, verifications, documents, roles, sessions, OTPs, break-glass)
  coreDb.exec(`
    CREATE TABLE IF NOT EXISTS society (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name_en TEXT NOT NULL,
      name_sd TEXT NOT NULL,
      name_ur TEXT NOT NULL,
      district TEXT NOT NULL,
      province TEXT NOT NULL,
      registration_no TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS household (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- FR-MEM-005 & FR-MEM-006: NO neighbourhood, caste, race, ethnicity, or religion columns!
    CREATE TABLE IF NOT EXISTS member (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      household_id TEXT NOT NULL,
      full_name TEXT NOT NULL,
      gender TEXT NOT NULL CHECK(gender IN ('female', 'male', 'other')),
      date_of_birth TEXT NOT NULL,
      mobile_e164 TEXT NOT NULL,
      cnic_enc TEXT NOT NULL,
      cnic_hmac TEXT NOT NULL,
      cnic_masked TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('applicant', 'active', 'suspended', 'deactivated', 'left')),
      identity_status TEXT NOT NULL CHECK(identity_status IN ('unverified', 'otp_confirmed', 'documents_checked', 'approved', 'rejected')),
      voting_suspended_until TEXT,
      suspension_reason TEXT,
      appeal_note TEXT,
      public_directory_consent INTEGER NOT NULL DEFAULT 1,
      consent_version TEXT NOT NULL DEFAULT '2026-11',
      preferred_lang TEXT NOT NULL DEFAULT 'en',
      pin_hash TEXT,
      created_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_member_cnic_unique
      ON member(society_id, cnic_hmac)
      WHERE status != 'deactivated';

    CREATE TABLE IF NOT EXISTS member_history (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      change_type TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS member_document (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      factor TEXT NOT NULL CHECK(factor IN ('cnic', 'education', 'work', 'exposure', 'qualification')),
      doc_label TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'application/pdf',
      retention_until TEXT NOT NULL,
      purged_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS membership_verification (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      step TEXT NOT NULL CHECK(step IN ('otp_confirmed', 'documents_checked', 'approved', 'rejected')),
      actor_member_id TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS role_assignment (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      role_code TEXT NOT NULL,
      scope_type TEXT NOT NULL DEFAULT 'society',
      team_side TEXT CHECK(team_side IN ('woman', 'man') OR team_side IS NULL),
      office_holder_id TEXT,
      valid_from TEXT NOT NULL,
      valid_to TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('term', 'appointment', 'system')),
      term_id TEXT,
      created_at TEXT NOT NULL,
      CHECK(valid_to > valid_from)
    );

    CREATE TABLE IF NOT EXISTS otp_code (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      mobile_e164 TEXT NOT NULL,
      purpose TEXT NOT NULL,
      code TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sms_sandbox (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      mobile_e164 TEXT NOT NULL,
      message TEXT NOT NULL,
      category TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_token (
      token TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      device_label TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS break_glass_log (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      target_member_id TEXT NOT NULL,
      requester_id TEXT NOT NULL,
      co_authorizer_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CHECK(requester_id != co_authorizer_id)
    );
  `);

  // 2. PTS (Vote-Points Engine — SDS §5.4: formula, formula items with nullable undecided points, member factors, member points)
  ptsDb.exec(`
    CREATE TABLE IF NOT EXISTS pts_formula (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      version TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft', 'approved', 'retired')),
      max_points INTEGER NOT NULL DEFAULT 22,
      age_basis TEXT NOT NULL DEFAULT 'snapshot' CHECK(age_basis IN ('registration', 'snapshot')),
      resolution_id TEXT,
      trial_start TEXT,
      trial_end TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(society_id, version)
    );

    CREATE TABLE IF NOT EXISTS pts_formula_item (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      formula_id TEXT NOT NULL,
      factor TEXT NOT NULL CHECK(factor IN ('education', 'age', 'work', 'exposure')),
      item_key TEXT NOT NULL,
      label_en TEXT NOT NULL,
      label_sd TEXT NOT NULL,
      label_ur TEXT NOT NULL,
      min_age INTEGER,
      max_age INTEGER,
      value_points INTEGER,
      UNIQUE(formula_id, factor, item_key)
    );

    CREATE TABLE IF NOT EXISTS pts_member_factor (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      factor TEXT NOT NULL CHECK(factor IN ('education', 'work', 'exposure')),
      item_key TEXT NOT NULL,
      document_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('submitted', 'approved', 'rejected')),
      verified_by TEXT,
      verified_at TEXT,
      note TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(society_id, member_id, factor)
    );

    CREATE TABLE IF NOT EXISTS pts_member_points (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      formula_id TEXT NOT NULL,
      education_pts INTEGER NOT NULL DEFAULT 0,
      age_pts INTEGER NOT NULL DEFAULT 0,
      work_pts INTEGER NOT NULL DEFAULT 0,
      exposure_pts INTEGER NOT NULL DEFAULT 0,
      total_pts INTEGER NOT NULL DEFAULT 0,
      basis TEXT NOT NULL CHECK(basis IN ('registration', 'snapshot')),
      points_pending INTEGER NOT NULL DEFAULT 0,
      has_undecided_factor INTEGER NOT NULL DEFAULT 0,
      undecided_note TEXT,
      computed_at TEXT NOT NULL,
      CHECK(total_pts = education_pts + age_pts + work_pts + exposure_pts),
      UNIQUE(society_id, member_id, formula_id)
    );

    CREATE TABLE IF NOT EXISTS pts_trial_review (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      formula_id TEXT NOT NULL,
      period_label TEXT NOT NULL,
      summary_text TEXT NOT NULL,
      decision TEXT NOT NULL,
      reviewed_by TEXT NOT NULL,
      reviewed_at TEXT NOT NULL
    );
  `);

  // 3. GOV (Rules OD-01..OD-36, GB meetings, agenda items, resolutions, co-presidents, teams, COI, recall, expense claims)
  govDb.exec(`
    CREATE TABLE IF NOT EXISTS gov_rule (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      rule_key TEXT NOT NULL,
      od_code TEXT NOT NULL,
      label TEXT NOT NULL,
      value_json TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      approved_by_resolution_id TEXT,
      effective_from TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(society_id, rule_key)
    );

    CREATE TABLE IF NOT EXISTS meeting (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      body_type TEXT NOT NULL CHECK(body_type IN ('general_body', 'executive')),
      title TEXT NOT NULL,
      scheduled_at TEXT NOT NULL,
      location TEXT NOT NULL,
      agenda TEXT NOT NULL,
      attendance_count INTEGER NOT NULL DEFAULT 0,
      minutes TEXT,
      status TEXT NOT NULL CHECK(status IN ('scheduled', 'completed')),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agenda_item (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      submitted_by_member_id TEXT NOT NULL,
      submitted_by_name TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'portal' CHECK(channel IN ('portal', 'helper')),
      status TEXT NOT NULL CHECK(status IN ('submitted', 'tabled', 'resolved')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS resolution (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      code TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      decision_type TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('drafted', 'tabled', 'voted', 'passed', 'failed', 'published')),
      yes_count INTEGER NOT NULL DEFAULT 0,
      no_count INTEGER NOT NULL DEFAULT 0,
      abstain_count INTEGER NOT NULL DEFAULT 0,
      published_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(society_id, code)
    );

    CREATE TABLE IF NOT EXISTS term (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('co_president')),
      title TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active', 'completed')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS office_holder (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      term_id TEXT NOT NULL,
      contest_id TEXT,
      seat TEXT NOT NULL CHECK(seat IN ('woman_co_president', 'man_co_president')),
      member_id TEXT NOT NULL,
      household_id TEXT NOT NULL,
      training_passed INTEGER NOT NULL DEFAULT 0,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      meetings_attended INTEGER NOT NULL DEFAULT 0,
      questions_answered INTEGER NOT NULL DEFAULT 0,
      proposals_reviewed INTEGER NOT NULL DEFAULT 0,
      UNIQUE(term_id, seat)
    );

    CREATE TABLE IF NOT EXISTS team_member (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      term_id TEXT NOT NULL,
      office_holder_id TEXT NOT NULL,
      team_side TEXT NOT NULL CHECK(team_side IN ('woman', 'man')),
      member_id TEXT NOT NULL,
      household_id TEXT NOT NULL,
      role_code TEXT NOT NULL CHECK(role_code IN ('treasurer', 'team_member')),
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(term_id, member_id)
    );

    CREATE TABLE IF NOT EXISTS conflict_declaration (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('family', 'business', 'household')),
      entity_name TEXT NOT NULL,
      description TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recall_petition (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      target_member_id TEXT NOT NULL,
      target_role_code TEXT NOT NULL,
      reason TEXT NOT NULL,
      required_signatures INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('collecting', 'threshold_met', 'vote_scheduled', 'closed')),
      election_id TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recall_signature (
      petition_id TEXT NOT NULL,
      society_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      signed_at TEXT NOT NULL,
      PRIMARY KEY (petition_id, member_id)
    );

    -- SDS §8.9 / OD-24: recorded and published publicly, never posted to VF until General Body approves funding source
    CREATE TABLE IF NOT EXISTS gov_expense_claim (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      claimant_member_id TEXT NOT NULL,
      claimant_name TEXT NOT NULL,
      team_side TEXT CHECK(team_side IN ('woman', 'man') OR team_side IS NULL),
      amount_pkr INTEGER NOT NULL CHECK(amount_pkr > 0),
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      receipt_ref TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending_od24', 'approved_unfunded', 'paid', 'rejected')),
      funding_source_note TEXT NOT NULL DEFAULT 'Pending General Body decision OD-24 (VF funds approved projects only)',
      approved_by TEXT,
      created_at TEXT NOT NULL
    );
  `);

  // 4. VOTE (elections, gender-specific contests, candidate qualification + Presidency Book training, frozen weighted snapshot, participation, sealed ballot units)
  voteDb.exec(`
    CREATE TABLE IF NOT EXISTS election (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('co_president', 'levy', 'budget', 'project', 'recall', 'resolution')),
      title_en TEXT NOT NULL,
      title_sd TEXT NOT NULL,
      title_ur TEXT NOT NULL,
      description_en TEXT NOT NULL,
      description_sd TEXT NOT NULL,
      description_ur TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('draft', 'nomination', 'ready', 'open', 'closed', 'tallied', 'certified', 'void')),
      ballot_mode TEXT NOT NULL CHECK(ballot_mode IN ('secret', 'open')),
      opens_at TEXT NOT NULL,
      closes_at TEXT NOT NULL,
      quorum_fraction REAL NOT NULL,
      pass_threshold REAL NOT NULL,
      min_turnout_fraction REAL NOT NULL DEFAULT 0.3,
      tie_rule TEXT,
      formula_id TEXT,
      project_id TEXT,
      config_json TEXT NOT NULL,
      config_hash TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CHECK(closes_at > opens_at)
    );

    CREATE TABLE IF NOT EXISTS contest (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      election_id TEXT NOT NULL,
      name_en TEXT NOT NULL,
      name_sd TEXT NOT NULL,
      name_ur TEXT NOT NULL,
      prompt_en TEXT NOT NULL,
      prompt_sd TEXT NOT NULL,
      prompt_ur TEXT NOT NULL,
      eligible_gender_rule TEXT NOT NULL CHECK(eligible_gender_rule IN ('woman', 'man', 'any')),
      weighting TEXT NOT NULL CHECK(weighting IN ('points', 'equal')),
      formula_id TEXT,
      options_json TEXT NOT NULL,
      snapshot_hash TEXT,
      snapshot_count INTEGER NOT NULL DEFAULT 0,
      snapshot_total_points INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL CHECK(state IN ('draft', 'nomination', 'ready', 'open', 'closed', 'tallied', 'certified', 'void'))
    );

    CREATE TABLE IF NOT EXISTS candidate (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      contest_id TEXT NOT NULL,
      election_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      member_name TEXT NOT NULL,
      household_id TEXT NOT NULL,
      gender TEXT NOT NULL,
      symbol_key TEXT NOT NULL,
      qualification_kind TEXT NOT NULL CHECK(qualification_kind IN ('bachelor_degree', 'intermediate_plus')),
      qualification_status TEXT NOT NULL CHECK(qualification_status IN ('pending', 'approved', 'rejected')),
      qualification_note TEXT,
      training_passed INTEGER NOT NULL DEFAULT 0,
      training_score INTEGER,
      eligibility_decision_by TEXT,
      status TEXT NOT NULL CHECK(status IN ('applied', 'qualified', 'rejected', 'withdrawn')),
      created_at TEXT NOT NULL,
      UNIQUE(contest_id, member_id)
    );

    CREATE TABLE IF NOT EXISTS training_record (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      material_version TEXT NOT NULL,
      test_date TEXT NOT NULL,
      score INTEGER NOT NULL,
      pass_mark INTEGER NOT NULL,
      passed INTEGER NOT NULL CHECK(passed IN (0, 1)),
      verified_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS voter_snapshot (
      contest_id TEXT NOT NULL,
      society_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      points_at_snapshot INTEGER NOT NULL CHECK(points_at_snapshot >= 1),
      PRIMARY KEY (contest_id, member_id)
    );

    CREATE TABLE IF NOT EXISTS vote_participation (
      contest_id TEXT NOT NULL,
      society_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      points_used INTEGER NOT NULL,
      cast_at TEXT NOT NULL,
      channel TEXT NOT NULL CHECK(channel IN ('self', 'assisted_kiosk')),
      helper_member_id TEXT,
      PRIMARY KEY (contest_id, member_id)
    );

    -- SDS §7.6 SEALED BALLOT UNITS: N identical encrypted units per N vote points!
    -- Deliberately has NO member_id, NO weight column, NO timestamp, NO auto-increment sequence!
    CREATE TABLE IF NOT EXISTS sealed_ballot (
      ballot_id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      contest_id TEXT NOT NULL,
      payload_enc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS open_vote (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      contest_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      member_name TEXT NOT NULL,
      choice_code TEXT NOT NULL,
      points_used INTEGER NOT NULL,
      cast_at TEXT NOT NULL,
      UNIQUE(contest_id, member_id)
    );

    CREATE TABLE IF NOT EXISTS contest_result (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      contest_id TEXT NOT NULL,
      election_id TEXT NOT NULL,
      result_status TEXT NOT NULL,
      tallies_json TEXT NOT NULL,
      winner_candidate_id TEXT,
      winner_name TEXT,
      anonymity_warning TEXT,
      formula_version TEXT,
      certified_by_1 TEXT,
      certified_by_2 TEXT,
      certified_at TEXT NOT NULL,
      dispute_note TEXT
    );

    CREATE TRIGGER IF NOT EXISTS trg_sealed_ballot_no_update BEFORE UPDATE ON sealed_ballot
    BEGIN SELECT RAISE(ABORT, 'Sealed ballot records are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_sealed_ballot_no_delete BEFORE DELETE ON sealed_ballot
    BEGIN SELECT RAISE(ABORT, 'Sealed ballot records cannot be deleted'); END;

    CREATE TRIGGER IF NOT EXISTS trg_vote_part_no_update BEFORE UPDATE ON vote_participation
    BEGIN SELECT RAISE(ABORT, 'Participation records are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_vote_part_no_delete BEFORE DELETE ON vote_participation
    BEGIN SELECT RAISE(ABORT, 'Participation records cannot be deleted'); END;
  `);

  // 5. VF (Village Fund — Stream 1, strictly isolated)
  vfDb.exec(`
    CREATE TABLE IF NOT EXISTS vf_account (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      account_type TEXT NOT NULL CHECK(account_type IN ('asset', 'income', 'expense', 'fund')),
      project_id TEXT,
      UNIQUE(society_id, code)
    );

    CREATE TABLE IF NOT EXISTS vf_journal_entry (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      ref_no TEXT NOT NULL,
      entry_date TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      reverses_entry_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('posted', 'reversed')),
      actor_id TEXT NOT NULL,
      approver_id TEXT,
      project_id TEXT,
      evidence_ref TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(society_id, ref_no)
    );

    CREATE TABLE IF NOT EXISTS vf_journal_line (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      debit_pkr INTEGER NOT NULL DEFAULT 0 CHECK(debit_pkr >= 0),
      credit_pkr INTEGER NOT NULL DEFAULT 0 CHECK(credit_pkr >= 0),
      CHECK((debit_pkr = 0) != (credit_pkr = 0))
    );

    CREATE TABLE IF NOT EXISTS levy_configuration (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      amount_pkr INTEGER NOT NULL,
      cap_at_time_pkr INTEGER NOT NULL,
      effective_from TEXT NOT NULL,
      resolution_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active', 'superseded')),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CHECK(amount_pkr <= cap_at_time_pkr AND amount_pkr >= 0)
    );

    CREATE TABLE IF NOT EXISTS vf_project_allocation (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      amount_pkr INTEGER NOT NULL,
      resolution_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('allocated', 'closed')),
      created_at TEXT NOT NULL,
      UNIQUE(society_id, project_id)
    );

    CREATE TRIGGER IF NOT EXISTS trg_vf_line_no_update BEFORE UPDATE ON vf_journal_line
    BEGIN SELECT RAISE(ABORT, 'VF journal lines are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS trg_vf_line_no_delete BEFORE DELETE ON vf_journal_line
    BEGIN SELECT RAISE(ABORT, 'VF journal lines cannot be deleted'); END;
  `);

  // 6. CL (Contributor Ledger — Stream 2, strictly isolated, zero role/vote links)
  clDb.exec(`
    CREATE TABLE IF NOT EXISTS cl_account (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      account_type TEXT NOT NULL CHECK(account_type IN ('asset', 'liability', 'equity', 'receivable')),
      contributor_id TEXT,
      UNIQUE(society_id, code)
    );

    CREATE TABLE IF NOT EXISTS cl_contributor (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      member_id TEXT,
      display_name TEXT NOT NULL,
      contact_enc TEXT NOT NULL,
      payout_account_enc TEXT NOT NULL,
      payout_masked TEXT NOT NULL,
      public_consent INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('active', 'settled')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cl_agreement (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      contributor_id TEXT NOT NULL,
      version TEXT NOT NULL,
      document_ref TEXT NOT NULL,
      revenue_share_bps INTEGER NOT NULL,
      return_cap_multiplier REAL NOT NULL,
      accepted_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cl_contribution (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      contributor_id TEXT NOT NULL,
      agreement_id TEXT NOT NULL,
      amount_pkr INTEGER NOT NULL CHECK(amount_pkr > 0),
      bank_line_ref TEXT NOT NULL,
      journal_entry_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cl_infra_invoice (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      vendor_name TEXT NOT NULL,
      invoice_no TEXT NOT NULL,
      description TEXT NOT NULL,
      amount_pkr INTEGER NOT NULL CHECK(amount_pkr > 0),
      document_ref TEXT NOT NULL,
      paid_entry_id TEXT NOT NULL,
      created_by TEXT NOT NULL,
      approved_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CHECK(created_by != approved_by)
    );

    CREATE TABLE IF NOT EXISTS cl_return_calculation (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      period_label TEXT NOT NULL,
      revenue_basis_pkr INTEGER NOT NULL,
      revenue_report_id TEXT NOT NULL,
      pool_amount_pkr INTEGER NOT NULL,
      formula_version TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft', 'approved', 'distributed')),
      prepared_by TEXT NOT NULL,
      approved_by TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cl_return_distribution (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      calc_id TEXT NOT NULL,
      contributor_id TEXT NOT NULL,
      amount_pkr INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('calculated', 'approved', 'paid')),
      payout_ref TEXT,
      paid_entry_id TEXT
    );

    CREATE TABLE IF NOT EXISTS cl_journal_entry (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      ref_no TEXT NOT NULL,
      entry_date TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('posted', 'reversed')),
      actor_id TEXT NOT NULL,
      approver_id TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(society_id, ref_no)
    );

    CREATE TABLE IF NOT EXISTS cl_journal_line (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      debit_pkr INTEGER NOT NULL DEFAULT 0 CHECK(debit_pkr >= 0),
      credit_pkr INTEGER NOT NULL DEFAULT 0 CHECK(credit_pkr >= 0),
      CHECK((debit_pkr = 0) != (credit_pkr = 0))
    );

    CREATE TRIGGER IF NOT EXISTS trg_cl_line_no_update BEFORE UPDATE ON cl_journal_line
    BEGIN SELECT RAISE(ABORT, 'CL journal lines are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS trg_cl_line_no_delete BEFORE DELETE ON cl_journal_line
    BEGIN SELECT RAISE(ABORT, 'CL journal lines cannot be deleted'); END;
  `);

  // 7. OPS (Operations Reconciliation & Packages — Stream 3)
  opsDb.exec(`
    CREATE TABLE IF NOT EXISTS pay_package (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      name_en TEXT NOT NULL,
      name_sd TEXT NOT NULL,
      name_ur TEXT NOT NULL,
      speed_label TEXT NOT NULL,
      price_pkr INTEGER NOT NULL CHECK(price_pkr > 0),
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS pay_purchase (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      member_name TEXT NOT NULL,
      package_id TEXT NOT NULL,
      package_name TEXT NOT NULL,
      price_pkr INTEGER NOT NULL,
      levy_pkr INTEGER NOT NULL,
      total_pkr INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('initiated', 'pending', 'paid', 'failed', 'refunded', 'reversed')),
      idempotency_key TEXT NOT NULL UNIQUE,
      followup_note TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ops_sales_report (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      period_label TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      version INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('submitted', 'superseded')),
      paid_units INTEGER NOT NULL,
      package_revenue_pkr INTEGER NOT NULL,
      levy_due_pkr INTEGER NOT NULL,
      submitted_by TEXT NOT NULL,
      submitted_at TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS ops_revenue_report (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      period_label TEXT NOT NULL,
      sales_report_id TEXT NOT NULL,
      package_revenue_basis_pkr INTEGER NOT NULL,
      version INTEGER NOT NULL,
      submitted_by TEXT NOT NULL,
      submitted_at TEXT NOT NULL
    );
  `);

  // 8. RECON (Three-way matching only, no direct ledger posting power)
  reconDb.exec(`
    CREATE TABLE IF NOT EXISTS recon_bank_account (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      domain TEXT NOT NULL CHECK(domain IN ('VF', 'CL')),
      bank_name TEXT NOT NULL,
      masked_number TEXT NOT NULL,
      UNIQUE(society_id, domain)
    );

    CREATE TABLE IF NOT EXISTS recon_bank_statement_line (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      bank_account_id TEXT NOT NULL,
      domain TEXT NOT NULL CHECK(domain IN ('VF', 'CL')),
      value_date TEXT NOT NULL,
      amount_pkr INTEGER NOT NULL,
      narrative TEXT NOT NULL,
      bank_ref TEXT NOT NULL,
      matched INTEGER NOT NULL DEFAULT 0,
      UNIQUE(bank_account_id, bank_ref)
    );

    CREATE TABLE IF NOT EXISTS recon_levy_transfer (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      period_label TEXT NOT NULL,
      amount_expected_pkr INTEGER NOT NULL,
      amount_declared_pkr INTEGER NOT NULL,
      reference_no TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('announced', 'sent', 'confirmed', 'disputed', 'cancelled')),
      declared_by TEXT NOT NULL,
      declared_at TEXT NOT NULL,
      confirmed_by TEXT,
      confirmed_at TEXT,
      dispute_reason TEXT,
      vf_entry_id TEXT
    );

    CREATE TABLE IF NOT EXISTS recon_match (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      statement_line_id TEXT NOT NULL,
      domain TEXT NOT NULL CHECK(domain IN ('VF', 'CL')),
      entry_id TEXT NOT NULL,
      transfer_id TEXT,
      matched_by TEXT NOT NULL,
      matched_at TEXT NOT NULL
    );
  `);

  // 9. PRJ (Participatory Project Proposals — NO neighbourhood columns, channel: portal | helper | general_body)
  prjDb.exec(`
    CREATE TABLE IF NOT EXISTS prj_proposal (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      reference_no TEXT NOT NULL,
      member_id TEXT NOT NULL,
      proposer_name TEXT NOT NULL,
      submission_channel TEXT NOT NULL DEFAULT 'portal' CHECK(submission_channel IN ('portal', 'helper', 'general_body')),
      title_en TEXT NOT NULL,
      title_sd TEXT NOT NULL,
      title_ur TEXT NOT NULL,
      description_en TEXT NOT NULL,
      description_sd TEXT NOT NULL,
      description_ur TEXT NOT NULL,
      category TEXT NOT NULL,
      est_budget_pkr INTEGER NOT NULL CHECK(est_budget_pkr > 0),
      impact_text TEXT NOT NULL,
      levy_effect_text TEXT NOT NULL DEFAULT 'No increase to Rs. 50 levy',
      state TEXT NOT NULL CHECK(state IN ('proposal', 'explainer', 'discussion', 'voting', 'approved', 'rejected', 'execution', 'reporting', 'closed')),
      feasibility_status TEXT,
      feasibility_note TEXT,
      explainer_summary_sd TEXT,
      discussion_deadline TEXT,
      election_id TEXT,
      allocated_budget_pkr INTEGER NOT NULL DEFAULT 0,
      final_report_text TEXT,
      source_issue_id TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(society_id, reference_no)
    );

    CREATE TABLE IF NOT EXISTS prj_expense_request (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      amount_pkr INTEGER NOT NULL CHECK(amount_pkr > 0),
      vendor_name TEXT NOT NULL,
      description TEXT NOT NULL,
      invoice_doc_ref TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      requested_team_side TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')),
      approved_by TEXT,
      vf_entry_id TEXT,
      rejection_reason TEXT,
      created_at TEXT NOT NULL
    );
  `);

  // 10. COMM (Issues with free-text place & public/executive_only visibility, Public Questions, Notices, Media Library)
  commDb.exec(`
    CREATE TABLE IF NOT EXISTS comm_issue (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      reporter_member_id TEXT NOT NULL,
      reporter_name TEXT NOT NULL,
      place_text TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      visibility TEXT NOT NULL CHECK(visibility IN ('public', 'executive_only')),
      status TEXT NOT NULL CHECK(status IN ('open', 'in_progress', 'resolved', 'converted_to_project')),
      assignee_member_id TEXT,
      executive_response TEXT,
      attachment_data_url TEXT,
      converted_project_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS comm_question (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      project_id TEXT,
      meeting_id TEXT,
      asked_by_member_id TEXT NOT NULL,
      asked_by_name TEXT NOT NULL,
      question_text TEXT NOT NULL,
      assigned_to_member_id TEXT,
      assigned_to_name TEXT,
      deadline_at TEXT NOT NULL,
      answer_text TEXT,
      answered_by_name TEXT,
      answered_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS comm_notice (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      category TEXT NOT NULL,
      current_version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL CHECK(status IN ('draft', 'published')),
      critical_sms INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS comm_notice_version (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      notice_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      title_en TEXT NOT NULL,
      title_sd TEXT NOT NULL,
      title_ur TEXT NOT NULL,
      body_en TEXT NOT NULL,
      body_sd TEXT NOT NULL,
      body_ur TEXT NOT NULL,
      published_by TEXT NOT NULL,
      published_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS comm_media_asset (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      category TEXT NOT NULL,
      title_en TEXT NOT NULL,
      title_sd TEXT NOT NULL,
      title_ur TEXT NOT NULL,
      summary_en TEXT NOT NULL,
      summary_sd TEXT NOT NULL,
      summary_ur TEXT NOT NULL,
      duration_sec INTEGER NOT NULL,
      size_kb_360p INTEGER NOT NULL,
      size_kb_audio INTEGER NOT NULL,
      related_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TRIGGER IF NOT EXISTS trg_notice_ver_no_update BEFORE UPDATE ON comm_notice_version
    BEGIN SELECT RAISE(ABORT, 'Published notice versions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_notice_ver_no_delete BEFORE DELETE ON comm_notice_version
    BEGIN SELECT RAISE(ABORT, 'Published notice versions cannot be deleted'); END;
  `);

  // 11. AUDIT (Tamper-evident hash chain, monthly reports, annual audit reports)
  auditDb.exec(`
    CREATE TABLE IF NOT EXISTS audit_event_log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      society_id TEXT NOT NULL,
      at TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      reason TEXT,
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS monthly_report (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      month_label TEXT NOT NULL,
      vf_opening_pkr INTEGER NOT NULL,
      vf_in_pkr INTEGER NOT NULL,
      vf_out_pkr INTEGER NOT NULL,
      vf_closing_pkr INTEGER NOT NULL,
      cl_capital_pkr INTEGER NOT NULL,
      cl_returns_paid_pkr INTEGER NOT NULL,
      ops_reported_revenue_pkr INTEGER NOT NULL,
      unreconciled_notes TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft', 'approved', 'published')),
      prepared_by TEXT NOT NULL,
      approved_by TEXT,
      published_by TEXT,
      published_at TEXT,
      UNIQUE(society_id, month_label)
    );

    CREATE TABLE IF NOT EXISTS annual_audit_report (
      id TEXT PRIMARY KEY,
      society_id TEXT NOT NULL,
      fiscal_year TEXT NOT NULL,
      auditor_name TEXT NOT NULL,
      opinion TEXT NOT NULL,
      findings_text TEXT NOT NULL,
      management_response TEXT,
      published_at TEXT NOT NULL
    );

    CREATE TRIGGER IF NOT EXISTS trg_audit_no_update BEFORE UPDATE ON audit_event_log
    BEGIN SELECT RAISE(ABORT, 'Audit event log is tamper-evident and append-only'); END;
    CREATE TRIGGER IF NOT EXISTS trg_audit_no_delete BEFORE DELETE ON audit_event_log
    BEGIN SELECT RAISE(ABORT, 'Audit event log cannot be deleted'); END;
  `);
}
