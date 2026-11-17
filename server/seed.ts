import {
  auditDb,
  clDb,
  commDb,
  coreDb,
  govDb,
  opsDb,
  prjDb,
  ptsDb,
  reconDb,
  vfDb,
  voteDb,
} from './db.ts';
import {
  canonicalHash,
  cnicHmac,
  encryptField,
  hashPin,
  maskCnic,
  newId,
} from './crypto.ts';
import { appendAuditEvent } from './auditService.ts';
import { postClEntry, postVfEntry } from './financeService.ts';
import { recalculateMemberPoints } from './pointsService.ts';

export interface ProvisionSocietyParams {
  id: string;
  slug: string;
  nameEn: string;
  nameSd: string;
  nameUr: string;
  district: string;
  province: string;
  registrationNo?: string;
  actorId: string;
  levyAmountPkr?: number;
  levyCapPkr?: number;
  termLengthMonths?: number;
  termMaxConsecutive?: number;
}

export function seedDefaultPointsFormula(
  societyId: string,
  actorId: string,
  createdAt: string,
  opts?: { version?: string; status?: 'draft' | 'approved'; resolutionId?: string | null }
): string {
  const formulaId = `${societyId}-formula-${opts?.version ?? 'v1.0-draft'}`;
  ptsDb
    .prepare(
      `INSERT INTO pts_formula (
        id, society_id, version, status, max_points, age_basis, resolution_id, trial_start, trial_end, created_by, created_at
      ) VALUES (?, ?, ?, ?, 22, 'snapshot', ?, '2026-10-01', '2027-04-01', ?, ?)`
    )
    .run(
      formulaId,
      societyId,
      opts?.version ?? 'v1.0-draft',
      opts?.status ?? 'draft',
      opts?.resolutionId ?? null,
      actorId,
      createdAt
    );

  // Exact SRS §6.3 / §15 Draft Vote-Points Table (max 22; no_schooling & no_exposure start as null = General Body decision pending)
  const items: Array<
    ['education' | 'age' | 'work' | 'exposure', string, string, string, string, number | null, number | null, number | null]
  > = [
    ['education', 'bachelor_plus', "Bachelor's degree or higher", 'بيچلرز يا مٿي', 'بیچلر ڈگری یا اس سے اوپر', null, null, 10],
    ['education', 'intermediate', 'Intermediate (FA / FSc / ICS)', 'انٽرميڊيٽ', 'انٹرمیڈیٹ', null, null, 6],
    ['education', 'matric', 'Matriculation (Class 10)', 'ميٽرڪ', 'میٹرک', null, null, 3],
    ['education', 'class_1_5', 'Primary (Class 1–5)', 'پرائمري (1–5)', 'پرائمری (جماعت 1–5)', null, null, 1],
    ['education', 'no_schooling', 'No formal schooling (OD pending)', 'اسڪول نه ويو (فيصلو باقي)', 'رسمی تعلیم نہیں (فیصلہ باقی)', null, null, null],

    ['age', 'age_45_plus', 'Age 45 and above', 'عمر 45 سال يا وڌيڪ', 'عمر 45 سال یا زیادہ', 45, null, 4],
    ['age', 'age_30_44', 'Age 30 to 44', 'عمر 30 کان 44 سال', 'عمر 30 سے 44 سال', 30, 44, 3],
    ['age', 'age_25_29', 'Age 25 to 29', 'عمر 25 کان 29 سال', 'عمر 25 سے 29 سال', 25, 29, 2],
    ['age', 'age_18_24', 'Age 18 to 24', 'عمر 18 کان 24 سال', 'عمر 18 سے 24 سال', 18, 24, 1],

    ['work', 'senior_professional', 'Senior professional / specialist', 'سينئر پروفيشنل', 'سینئر پروفیشنل / ماہر', null, null, 4],
    ['work', 'govt_job', 'Government employee', 'سرڪاري ملازم', 'سرکاری ملازم', null, null, 3],
    ['work', 'private_or_self_employed', 'Private job / self-employed / business', 'پرائيويٽ نوڪري / ڪاروبار', 'نجی ملازمت / کاروبار', null, null, 3],
    ['work', 'farmer_artisan', 'Farmer / skilled artisan / trade', 'هاري / هنر مند', 'کسان / ہنرمند', null, null, 2],
    ['work', 'unemployed_homemaker', 'Unemployed / homemaker / student', 'بيروزگار / گهريلو / شاگرد', 'بے روزگار / گھریلو / طالب علم', null, null, 1],

    ['exposure', 'national_intl', 'National or international exposure', 'ملڪي يا عالمي تجربو', 'قومی یا بین الاقوامی تجربہ', null, null, 4],
    ['exposure', 'big_city', 'Big city work / study exposure', 'وڏي شهر جو تجربو', 'بڑے شہر کا تجربہ', null, null, 2],
    ['exposure', 'district_town', 'District town exposure (Mithi / Umerkot)', 'ضلعي شهر جو تجربو', 'ضلعی شہر کا تجربہ', null, null, 1],
    ['exposure', 'no_exposure', 'Village-only exposure (OD pending)', 'صرف ڳوٺ جو تجربو (فيصلو باقي)', 'صرف گاؤں تک محدود (فیصلہ باقی)', null, null, null],
  ];

  for (const [factor, key, lEn, lSd, lUr, minAge, maxAge, val] of items) {
    ptsDb
      .prepare(
        `INSERT INTO pts_formula_item (
          id, society_id, formula_id, factor, item_key, label_en, label_sd, label_ur, min_age, max_age, value_points
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(`${formulaId}-${factor}-${key}`, societyId, formulaId, factor, key, lEn, lSd, lUr, minAge, maxAge, val);
  }

  return formulaId;
}

export function provisionSocietySkeleton(params: ProvisionSocietyParams): void {
  const now = '2026-10-01T08:00:00.000Z';
  const isPabohar = params.id === 'pabohar';
  const createdAt = isPabohar ? now : new Date().toISOString();

  coreDb
    .prepare(
      `INSERT INTO society (id, slug, name_en, name_sd, name_ur, district, province, registration_no, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`
    )
    .run(
      params.id,
      params.slug,
      params.nameEn,
      params.nameSd,
      params.nameUr,
      params.district,
      params.province,
      params.registrationNo ?? `SINDH-COOP-${params.slug.toUpperCase()}-2026`,
      createdAt
    );

  // Default VF & CL Charts of Accounts (SDS §5.7 — strictly separated streams)
  const vfAccounts: Array<[string, string, 'asset' | 'income' | 'expense' | 'fund']> = [
    ['1100', 'Village Fund Bank Account', 'asset'],
    ['1200', 'Levy Due from VilloThar', 'asset'],
    ['3000', 'Village Fund (Unallocated)', 'fund'],
    ['4000', 'Package Levy Income', 'income'],
    ['5000', 'Approved Project Spending', 'expense'],
  ];
  for (const [code, name, type] of vfAccounts) {
    vfDb
      .prepare('INSERT INTO vf_account (id, society_id, code, name, account_type) VALUES (?, ?, ?, ?, ?)')
      .run(`${params.id}-vfa-${code}`, params.id, code, name, type);
  }

  const clAccounts: Array<[string, string, 'asset' | 'liability' | 'equity' | 'receivable']> = [
    ['1100', 'Contributor Ledger Bank Account', 'asset'],
    ['1200', 'Contribution Returns Due from VilloThar', 'receivable'],
    ['1300', 'Infrastructure Paid For (Equipment & Tower)', 'asset'],
    ['2100', 'Contributor Capital Pool', 'equity'],
    ['2200', 'Returns Payable to Contributors', 'liability'],
  ];
  for (const [code, name, type] of clAccounts) {
    clDb
      .prepare('INSERT INTO cl_account (id, society_id, code, name, account_type) VALUES (?, ?, ?, ?, ?)')
      .run(`${params.id}-cla-${code}`, params.id, code, name, type);
  }

  // Separate bank accounts per domain
  reconDb
    .prepare(
      'INSERT INTO recon_bank_account (id, society_id, domain, bank_name, masked_number) VALUES (?, ?, ?, ?, ?)'
    )
    .run(`${params.id}-bank-vf`, params.id, 'VF', 'Sindh Bank Mithi', 'PK38SIND-XXXX-4401');
  reconDb
    .prepare(
      'INSERT INTO recon_bank_account (id, society_id, domain, bank_name, masked_number) VALUES (?, ?, ?, ?, ?)'
    )
    .run(`${params.id}-bank-cl`, params.id, 'CL', 'Sindh Bank Mithi', 'PK91SIND-XXXX-4402');

  // Configurable Governance Rules (OD-01..OD-36, SRS §13)
  const levyCap = params.levyCapPkr ?? 100;
  const levyAmount = Math.min(params.levyAmountPkr ?? 50, levyCap);
  const rules: Array<[string, string, string, unknown]> = [
    ['turnout.min_fraction', 'OD-01', 'Minimum Turnout for Valid Co-President Election', 0.3],
    ['points.non_election_mode', 'OD-02', 'Vote Weighting on Non-Election Referenda (Levy/Project/Recall)', 'equal'],
    ['verification.officer_authority', 'OD-03', 'Verification Officer Sign-Off Authority', 'independent_panel'],
    ['team.size_min', 'OD-04', 'Minimum Team Members per Co-President', 2],
    ['team.size_max', 'OD-04', 'Maximum Team Members per Co-President', 5],
    ['term.length_months', 'OD-05', 'Co-President & Team Term Length (months)', params.termLengthMonths ?? 12],
    ['term.max_consecutive', 'OD-05', 'Max Consecutive Terms per Co-President', params.termMaxConsecutive ?? 2],
    ['levy.cap_pkr', 'OD-06', 'Maximum Monthly Package Levy Cap (PKR)', levyCap],
    ['quorum.ordinary', 'OD-07', 'Quorum Fraction — Ordinary Resolution / Project', 0.3],
    ['quorum.major_project', 'OD-07', 'Quorum Fraction — Major Spending (> PKR 50,000)', 0.4],
    ['quorum.levy_change', 'OD-07', 'Quorum Fraction — Levy Change Vote', 0.5],
    ['threshold.ordinary', 'OD-07', 'Approval Threshold — Ordinary Vote', 0.5],
    ['threshold.major_project', 'OD-07', 'Approval Threshold — Major Project', 0.6],
    ['threshold.levy_change', 'OD-07', 'Approval Threshold — Levy Change', 0.67],
    ['transfer.cadence', 'OD-08', 'VilloThar Levy Transfer Schedule', 'weekly'],
    ['recall.petition_share', 'OD-13', 'Verified Voter Share Required for Recall Petition', 0.25],
    ['coi.scope', 'OD-14', 'Conflict-of-Interest Scope', 'Household, close kin, and business interests'],
    ['points.age_basis', 'OD-18', 'Age Bracket Computation Basis for Vote-Points', 'snapshot'],
    ['tie.rule', 'OD-19', 'Tie Resolution Rule for Weighted Co-President Contests', 'manual_decision'],
    ['contest.other_gender_policy', 'OD-20', 'Non-Binary / Other Gender Contest Policy', 'general_body_decision_required'],
    ['household.co_president_restriction', 'OD-22', 'Block Same-Household Simultaneous Co-Presidents', true],
    ['household.scope', 'OD-23', 'One Team Member Per Household Scope', 'executive_wide'],
    ['expenses.od24_funding_source', 'OD-24', 'Executive Governance Expense Funding Source', 'pending_od24'],
    ['eligibility.min_voting_age', 'OD-29', 'Minimum Voting Age (years)', 18],
    ['presidency_book.pass_mark', 'OD-30', 'Cosiety Presidency Book Pass Mark (%)', 70],
    ['privacy.id_image_retention_days', 'OD-31', 'ID & Qualification Doc Retention After Verification (days)', 90],
    ['voting.ballot_mode_default', 'OD-32', 'Default Ballot Mode', 'secret'],
    ['voting.weighted_min_anonymity_set', 'OD-32', 'Minimum Turnout for Weighted Secret Anonymity', 5],
    ['villothar.support_end_date', 'OD-36', 'VilloThar Start-Up Support End Date', '2028-11-16'],
  ];

  for (const [key, odCode, label, val] of rules) {
    govDb
      .prepare(
        `INSERT INTO gov_rule (id, society_id, rule_key, od_code, label, value_json, version, approved_by_resolution_id, effective_from, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
      )
      .run(
        `${params.id}-rule-${key}`,
        params.id,
        key,
        odCode,
        label,
        JSON.stringify(val),
        `${params.id}-res-founding`,
        createdAt,
        params.actorId,
        createdAt
      );
  }

  // Founding resolution & initial levy configuration
  govDb
    .prepare(
      `INSERT INTO resolution (id, society_id, code, title, description, decision_type, status, yes_count, no_count, abstain_count, published_at, created_at)
       VALUES (?, ?, 'RES-2026-01', 'Founding Governance Charter & Initial Levy Adoption', 'General Body adoption of equal-village charter (no neighbourhood/caste groups), dual Co-President structure, and Rs. ' || ? || ' individual package levy within cap.', 'levy_change', 'published', 41, 1, 2, ?, ?)`
    )
    .run(`${params.id}-res-founding`, params.id, String(levyAmount), createdAt, createdAt);

  vfDb
    .prepare(
      `INSERT INTO levy_configuration (id, society_id, amount_pkr, cap_at_time_pkr, effective_from, resolution_id, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`
    )
    .run(
      `${params.id}-levy-1`,
      params.id,
      levyAmount,
      levyCap,
      createdAt,
      `${params.id}-res-founding`,
      params.actorId,
      createdAt
    );

  // Default draft Vote-Points formula (SRS §6.3)
  seedDefaultPointsFormula(params.id, params.actorId, createdAt, {
    version: 'v1.0-draft',
    status: 'draft',
  });

  // Single-price internet packages (BR-03: same price for every villager)
  const pkgs = [
    ['basic', 'Basic Village 5 Mbps', 'بنيادي 5 ايم بي پي ايس', 'بنیادی 5 ایم بی پی ایس', '5 Mbps Unlimited', 800],
    ['family', 'Family Study 12 Mbps', 'فيملِي اسٽڊي 12 ايم بي', 'فیملی اسٹڈی 12 ایم بی', '12 Mbps Unlimited', 1400],
    ['shop', 'Shop & Community 20 Mbps', 'دڪان ۽ ڪميونٽي 20 ايم بي', 'دکان اور کمیونٹی 20 ایم بی', '20 Mbps Priority', 2200],
  ] as const;

  for (const [slug, nEn, nSd, nUr, speed, price] of pkgs) {
    opsDb
      .prepare(
        `INSERT INTO pay_package (id, society_id, name_en, name_sd, name_ur, speed_label, price_pkr, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
      )
      .run(`${params.id}-pkg-${slug}`, params.id, nEn, nSd, nUr, speed, price);
  }

  appendAuditEvent({
    societyId: params.id,
    actorId: params.actorId,
    action: 'society.provisioned',
    entityType: 'society',
    entityId: params.id,
    after: { name: params.nameEn, district: params.district, levyAmountPkr: levyAmount, levyCapPkr: levyCap },
    at: createdAt,
  });
}

export function seedInitialData(): void {
  const existing = coreDb.prepare("SELECT id FROM society WHERE id = 'pabohar'").get();
  if (existing) return;

  // Provision Pabohar (first pilot village)
  provisionSocietySkeleton({
    id: 'pabohar',
    slug: 'pabohar',
    nameEn: 'Pabohar',
    nameSd: 'پٻوهر',
    nameUr: 'پبوہار',
    district: 'Tharparkar',
    province: 'Sindh',
    registrationNo: 'SINDH-COOP-THAR-2026-001',
    actorId: 'system-seed',
    levyAmountPkr: 50,
    levyCapPkr: 100,
    termLengthMonths: 12,
    termMaxConsecutive: 2,
  });

  // Households (no neighbourhood_id, no caste/religion grouping per FR-MEM-005/006)
  const households = [
    ['hh-01', 'Bheel Household (Ali)'],
    ['hh-02', 'Meghwar Household (Fatima & Salma)'],
    ['hh-03', 'Nohrio Household (Bilawal)'],
    ['hh-04', 'Nohrio Household (Sajjad)'],
    ['hh-05', 'Thakur Household (Hira)'],
    ['hh-06', 'Junejo Household (Parveen)'],
    ['hh-07', 'Samoon Household (Rehman)'],
    ['hh-08', 'Zeeshan Household'],
    ['hh-09', 'Bheel Household (Kiran)'],
    ['hh-10', 'Solangi Household (Tariq)'],
    ['hh-11', 'Mirza Audit Household'],
    ['hh-12', 'Asad Household'],
    ['hh-13', 'Memon Household (Saeed)'],
    ['hh-14', 'Junejo Household (Amina)'],
    ['hh-15', 'Baksh Household (Karim)'],
    ['hh-16', 'Kolhi Household (Nasreen)'],
    ['hh-17', 'Khaskheli Household (Bilal)'],
    ['hh-18', 'Bheel Household (Gulshan)'],
  ] as const;

  for (const [hhId, name] of households) {
    coreDb
      .prepare('INSERT INTO household (id, society_id, name, created_at) VALUES (?, ?, ?, ?)')
      .run(hhId, 'pabohar', name, '2026-10-02T09:00:00.000Z');
  }

  // Members covering all v1.1 roles & exact SRS AC test fixtures:
  // - m-bilawal: AC-PTS-01 fixture -> Bachelor (10) + Age 28 (2) + Govt Job (3) + Big City (2) = 17 pts
  // - m-ali:     AC-PTS-02 fixture -> Bachelor (10) + Age 48 (4) + Senior Prof (4) + Natl/Intl (4) = 22 pts (max)
  // - m-karim:   AC-PTS-03 fixture -> no_schooling (null) + no_exposure (null) -> blocks election opening until decided!
  // - m-salma:   AC-EXC-02/03 fixture -> shares hh-02 with Woman Co-President Fatima -> blocked from team/treasurer appointment!
  // - m-bilal:   AC-PTS-04 fixture -> applicant with submitted unverified points -> shows pointsPending = true (0 pts)
  // - m-gulshan: AC-AUTH-03 fixture -> documents_checked by m-ali -> awaiting 2nd approver
  const defaultPin = hashPin('1234');
  const members: Array<{
    id: string;
    hh: string;
    name: string;
    gender: 'female' | 'male';
    dob: string;
    mobile: string;
    cnic: string;
    status: 'applicant' | 'active';
    idStatus: 'unverified' | 'otp_confirmed' | 'documents_checked' | 'approved';
    role?: string;
    teamSide?: 'woman' | 'man';
    termLinked?: boolean;
    officeHolderId?: string;
    edu: string;
    work: string;
    exp: string;
    factorStatus: 'approved' | 'submitted';
  }> = [
    { id: 'm-fatima', hh: 'hh-02', name: 'Fatima Meghwar', gender: 'female', dob: '1986-08-20', mobile: '+923001110002', cnic: '4430122345672', status: 'active', idStatus: 'approved', role: 'woman_co_president', teamSide: 'woman', termLinked: true, officeHolderId: 'oh-woman-1', edu: 'bachelor_plus', work: 'govt_job', exp: 'big_city', factorStatus: 'approved' },
    { id: 'm-salma', hh: 'hh-02', name: 'Salma Meghwar', gender: 'female', dob: '1993-05-11', mobile: '+923001110015', cnic: '4430122345699', status: 'active', idStatus: 'approved', edu: 'intermediate', work: 'private_or_self_employed', exp: 'district_town', factorStatus: 'approved' },
    { id: 'm-bilawal', hh: 'hh-03', name: 'Bilawal Nohrio', gender: 'male', dob: '1998-06-15', mobile: '+923001110004', cnic: '4430142345675', status: 'active', idStatus: 'approved', role: 'treasurer', teamSide: 'woman', termLinked: true, officeHolderId: 'oh-woman-1', edu: 'bachelor_plus', work: 'govt_job', exp: 'big_city', factorStatus: 'approved' },
    { id: 'm-hira', hh: 'hh-05', name: 'Hira Thakur', gender: 'female', dob: '1995-07-09', mobile: '+923001110005', cnic: '4430152345676', status: 'active', idStatus: 'approved', role: 'team_member', teamSide: 'woman', termLinked: true, officeHolderId: 'oh-woman-1', edu: 'intermediate', work: 'private_or_self_employed', exp: 'district_town', factorStatus: 'approved' },

    { id: 'm-sajjad', hh: 'hh-04', name: 'Sajjad Nohrio', gender: 'male', dob: '1984-11-03', mobile: '+923001110006', cnic: '4430162345677', status: 'active', idStatus: 'approved', role: 'man_co_president', teamSide: 'man', termLinked: true, officeHolderId: 'oh-man-1', edu: 'bachelor_plus', work: 'private_or_self_employed', exp: 'big_city', factorStatus: 'approved' },
    { id: 'm-parveen', hh: 'hh-06', name: 'Parveen Junejo', gender: 'female', dob: '1992-04-17', mobile: '+923001110016', cnic: '4430162345691', status: 'active', idStatus: 'approved', role: 'treasurer', teamSide: 'man', termLinked: true, officeHolderId: 'oh-man-1', edu: 'bachelor_plus', work: 'private_or_self_employed', exp: 'district_town', factorStatus: 'approved' },
    { id: 'm-rehman', hh: 'hh-07', name: 'Rehman Samoon', gender: 'male', dob: '1982-01-19', mobile: '+923001110007', cnic: '4430172345678', status: 'active', idStatus: 'approved', role: 'team_member', teamSide: 'man', termLinked: true, officeHolderId: 'oh-man-1', edu: 'matric', work: 'private_or_self_employed', exp: 'district_town', factorStatus: 'approved' },

    { id: 'm-ali', hh: 'hh-01', name: 'Ali Bheel', gender: 'male', dob: '1978-04-12', mobile: '+923001110001', cnic: '4430112345671', status: 'active', idStatus: 'approved', role: 'verification_officer', edu: 'bachelor_plus', work: 'senior_professional', exp: 'national_intl', factorStatus: 'approved' },
    { id: 'm-zeeshan', hh: 'hh-08', name: 'Zeeshan Kolhi', gender: 'male', dob: '1990-02-14', mobile: '+923001110008', cnic: '4430182345679', status: 'active', idStatus: 'approved', role: 'election_admin', edu: 'bachelor_plus', work: 'govt_job', exp: 'big_city', factorStatus: 'approved' },
    { id: 'm-kiran', hh: 'hh-09', name: 'Kiran Bheel', gender: 'female', dob: '1993-02-14', mobile: '+923001110003', cnic: '4430132345674', status: 'active', idStatus: 'approved', role: 'village_helper', edu: 'intermediate', work: 'private_or_self_employed', exp: 'district_town', factorStatus: 'approved' },
    { id: 'm-tariq', hh: 'hh-10', name: 'Tariq Solangi', gender: 'male', dob: '1988-06-15', mobile: '+923001110009', cnic: '4430192345681', status: 'active', idStatus: 'approved', role: 'villothar_ops', edu: 'bachelor_plus', work: 'private_or_self_employed', exp: 'big_city', factorStatus: 'approved' },
    { id: 'm-zahid', hh: 'hh-11', name: 'Zahid Mirza (Auditor)', gender: 'male', dob: '1981-12-01', mobile: '+923001110010', cnic: '4430119345682', status: 'active', idStatus: 'approved', role: 'auditor', edu: 'bachelor_plus', work: 'senior_professional', exp: 'national_intl', factorStatus: 'approved' },
    { id: 'm-asad', hh: 'hh-12', name: 'Asad Memon', gender: 'male', dob: '1987-10-18', mobile: '+923001110011', cnic: '4430129345683', status: 'active', idStatus: 'approved', role: 'portal_admin', edu: 'bachelor_plus', work: 'senior_professional', exp: 'big_city', factorStatus: 'approved' },
    { id: 'm-saeed', hh: 'hh-13', name: 'Saeed Memon', gender: 'male', dob: '1979-10-18', mobile: '+923001110012', cnic: '4430139345685', status: 'active', idStatus: 'approved', role: 'contributor', edu: 'bachelor_plus', work: 'private_or_self_employed', exp: 'national_intl', factorStatus: 'approved' },

    { id: 'm-amina', hh: 'hh-14', name: 'Amina Junejo', gender: 'female', dob: '1989-09-25', mobile: '+923001110017', cnic: '4430172345692', status: 'active', idStatus: 'approved', edu: 'bachelor_plus', work: 'govt_job', exp: 'big_city', factorStatus: 'approved' },
    { id: 'm-nasreen', hh: 'hh-16', name: 'Nasreen Kolhi', gender: 'female', dob: '1991-06-08', mobile: '+923001110018', cnic: '4430182345693', status: 'active', idStatus: 'approved', edu: 'intermediate', work: 'farmer_artisan', exp: 'district_town', factorStatus: 'approved' },
    { id: 'm-karim', hh: 'hh-15', name: 'Karim Baksh', gender: 'male', dob: '1990-05-30', mobile: '+923001110019', cnic: '4430129345694', status: 'active', idStatus: 'approved', edu: 'no_schooling', work: 'farmer_artisan', exp: 'no_exposure', factorStatus: 'approved' },

    { id: 'm-bilal', hh: 'hh-17', name: 'Bilal Khaskheli', gender: 'male', dob: '1999-03-22', mobile: '+923001110013', cnic: '4430149345687', status: 'applicant', idStatus: 'otp_confirmed', edu: 'intermediate', work: 'farmer_artisan', exp: 'district_town', factorStatus: 'submitted' },
    { id: 'm-gulshan', hh: 'hh-18', name: 'Gulshan Bheel', gender: 'female', dob: '1997-08-05', mobile: '+923001110014', cnic: '4430159345688', status: 'applicant', idStatus: 'documents_checked', edu: 'matric', work: 'unemployed_homemaker', exp: 'district_town', factorStatus: 'approved' },
  ];

  for (const m of members) {
    coreDb
      .prepare(
        `INSERT INTO member (
          id, society_id, household_id, full_name, gender, date_of_birth,
          mobile_e164, cnic_enc, cnic_hmac, cnic_masked, status, identity_status,
          public_directory_consent, consent_version, preferred_lang, pin_hash, created_at
        ) VALUES (?, 'pabohar', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, '2026-11', 'en', ?, ?)`
      )
      .run(
        m.id,
        m.hh,
        m.name,
        m.gender,
        m.dob,
        m.mobile,
        encryptField(m.cnic),
        cnicHmac(m.cnic),
        maskCnic(m.cnic),
        m.status,
        m.idStatus,
        defaultPin,
        '2026-10-03T10:00:00.000Z'
      );

    // Verification steps
    if (m.idStatus === 'approved') {
      coreDb
        .prepare(
          `INSERT INTO membership_verification (id, society_id, member_id, step, actor_member_id, note, created_at)
           VALUES (?, 'pabohar', ?, 'otp_confirmed', ?, 'OTP verified', '2026-10-03T10:05:00.000Z')`
        )
        .run(newId('ver'), m.id, m.id);
      coreDb
        .prepare(
          `INSERT INTO membership_verification (id, society_id, member_id, step, actor_member_id, note, created_at)
           VALUES (?, 'pabohar', ?, 'documents_checked', 'm-ali', 'Original CNIC & supporting factor documents inspected', '2026-10-03T11:00:00.000Z')`
        )
        .run(newId('ver'), m.id);
      coreDb
        .prepare(
          `INSERT INTO membership_verification (id, society_id, member_id, step, actor_member_id, note, created_at)
           VALUES (?, 'pabohar', ?, 'approved', 'm-asad', 'Approved onto General Body register', '2026-10-03T12:00:00.000Z')`
        )
        .run(newId('ver'), m.id);
    } else if (m.idStatus === 'documents_checked') {
      coreDb
        .prepare(
          `INSERT INTO membership_verification (id, society_id, member_id, step, actor_member_id, note, created_at)
           VALUES (?, 'pabohar', ?, 'otp_confirmed', ?, 'OTP verified', '2026-11-14T10:05:00.000Z')`
        )
        .run(newId('ver'), m.id, m.id);
      coreDb
        .prepare(
          `INSERT INTO membership_verification (id, society_id, member_id, step, actor_member_id, note, created_at)
           VALUES (?, 'pabohar', ?, 'documents_checked', 'm-ali', 'CNIC & education certificate checked by Verification Officer', '2026-11-14T14:00:00.000Z')`
        )
        .run(newId('ver'), m.id);
    } else {
      coreDb
        .prepare(
          `INSERT INTO membership_verification (id, society_id, member_id, step, actor_member_id, note, created_at)
           VALUES (?, 'pabohar', ?, 'otp_confirmed', ?, 'OTP verified; documents pending check', '2026-11-15T09:00:00.000Z')`
        )
        .run(newId('ver'), m.id, m.id);
    }

    // Roles
    if (m.role) {
      coreDb
        .prepare(
          `INSERT INTO role_assignment (
            id, society_id, member_id, role_code, scope_type, team_side, office_holder_id,
            valid_from, valid_to, source, term_id, created_at
          ) VALUES (?, 'pabohar', ?, ?, 'society', ?, ?, '2026-10-05T00:00:00.000Z', '2027-10-05T00:00:00.000Z', ?, ?, '2026-10-05T00:00:00.000Z')`
        )
        .run(
          newId('rol'),
          m.id,
          m.role,
          m.teamSide ?? null,
          m.officeHolderId ?? null,
          m.termLinked ? 'term' : 'appointment',
          m.termLinked ? 'pabohar-term-1' : null
        );
    }

    // Seed PTS factors & compute points (in Oct 2026 registration/snapshot window)
    const factors: Array<['education' | 'work' | 'exposure', string]> = [
      ['education', m.edu],
      ['work', m.work],
      ['exposure', m.exp],
    ];
    for (const [factor, key] of factors) {
      const docId = newId('doc');
      coreDb
        .prepare(
          `INSERT INTO member_document (id, society_id, member_id, factor, doc_label, mime_type, retention_until, created_at)
           VALUES (?, 'pabohar', ?, ?, ?, 'application/pdf', '2027-01-05T00:00:00.000Z', '2026-10-03T10:30:00.000Z')`
        )
        .run(docId, m.id, factor, `${factor.toUpperCase()} proof — ${key}`);

      ptsDb
        .prepare(
          `INSERT INTO pts_member_factor (
            id, society_id, member_id, factor, item_key, document_id, status, verified_by, verified_at, note, created_at
          ) VALUES (?, 'pabohar', ?, ?, ?, ?, ?, ?, ?, ?, '2026-10-03T11:00:00.000Z')`
        )
        .run(
          newId('pmf'),
          m.id,
          factor,
          key,
          docId,
          m.factorStatus,
          m.factorStatus === 'approved' ? 'm-ali' : null,
          m.factorStatus === 'approved' ? '2026-10-03T11:00:00.000Z' : null,
          m.factorStatus === 'approved' ? 'Verified against original document' : 'Submitted, waiting for Verification Officer'
        );
    }

    recalculateMemberPoints('pabohar', m.id, 'snapshot', '2026-11-15T00:00:00.000Z');
  }

  // Two Co-Presidents Term & Teams (FR-EXC-001..008)
  govDb
    .prepare(
      `INSERT INTO term (id, society_id, kind, title, start_date, end_date, status, created_at)
       VALUES ('pabohar-term-1', 'pabohar', 'co_president', '2026–2027 Dual Co-President Term (12 months)', '2026-10-05', '2027-10-05', 'active', '2026-10-05T00:00:00.000Z')`
    )
    .run();

  govDb
    .prepare(
      `INSERT INTO office_holder (
        id, society_id, term_id, contest_id, seat, member_id, household_id, training_passed,
        start_date, end_date, meetings_attended, questions_answered, proposals_reviewed
      ) VALUES
        ('oh-woman-1', 'pabohar', 'pabohar-term-1', 'contest-founding-woman', 'woman_co_president', 'm-fatima', 'hh-02', 1, '2026-10-05', '2027-10-05', 6, 9, 4),
        ('oh-man-1', 'pabohar', 'pabohar-term-1', 'contest-founding-man', 'man_co_president', 'm-sajjad', 'hh-04', 1, '2026-10-05', '2027-10-05', 6, 7, 4)`
    )
    .run();

  govDb
    .prepare(
      `INSERT INTO team_member (
        id, society_id, term_id, office_holder_id, team_side, member_id, household_id, role_code, start_date, end_date, created_at
      ) VALUES
        ('tm-w-1', 'pabohar', 'pabohar-term-1', 'oh-woman-1', 'woman', 'm-bilawal', 'hh-03', 'treasurer', '2026-10-05', '2027-10-05', '2026-10-05T09:00:00.000Z'),
        ('tm-w-2', 'pabohar', 'pabohar-term-1', 'oh-woman-1', 'woman', 'm-hira', 'hh-05', 'team_member', '2026-10-05', '2027-10-05', '2026-10-05T09:00:00.000Z'),
        ('tm-m-1', 'pabohar', 'pabohar-term-1', 'oh-man-1', 'man', 'm-parveen', 'hh-06', 'treasurer', '2026-10-05', '2027-10-05', '2026-10-05T09:00:00.000Z'),
        ('tm-m-2', 'pabohar', 'pabohar-term-1', 'oh-man-1', 'man', 'm-rehman', 'hh-07', 'team_member', '2026-10-05', '2027-10-05', '2026-10-05T09:00:00.000Z')`
    )
    .run();

  // Conflict of interest declaration (Rehman Samoon — Thar Solar & Hardware)
  govDb
    .prepare(
      `INSERT INTO conflict_declaration (id, society_id, member_id, category, entity_name, description, active, created_at)
       VALUES ('coi-1', 'pabohar', 'm-rehman', 'business', 'Thar Solar & Hardware', 'Family-owned solar & plumbing supply shop in Mithi/Pabohar.', 1, '2026-10-06T10:00:00.000Z')`
    )
    .run();

  // General Body Meetings & Member-Submitted Agenda Items (FR-GB-001/002)
  govDb
    .prepare(
      `INSERT INTO meeting (id, society_id, body_type, title, scheduled_at, location, agenda, attendance_count, minutes, status, created_by, created_at)
       VALUES ('mtg-gb-1', 'pabohar', 'general_body', 'Monthly General Body & Vote-Points Trial Review', '2026-11-22T16:00:00.000Z', 'Pabohar Primary School Courtyard', '1. Village Fund statement 2. Decide OD-02/OD-24 & undecided points values (no_schooling, no_exposure) 3. Girls Digital Literacy vote', 0, NULL, 'scheduled', 'm-fatima', '2026-11-14T10:00:00.000Z')`
    )
    .run();

  govDb
    .prepare(
      `INSERT INTO agenda_item (id, society_id, submitted_by_member_id, submitted_by_name, title, description, channel, status, created_at)
       VALUES
         ('agd-1', 'pabohar', 'm-karim', 'Karim Baksh', 'Approve Vote-Points Values for No Formal Schooling & Village-Only Exposure', 'Request General Body decision on draft points table null values so all villagers can participate in next weighted election.', 'helper', 'tabled', '2026-11-13T11:00:00.000Z'),
         ('agd-2', 'pabohar', 'm-amina', 'Amina Junejo', 'Settle OD-24 Funding Source for Executive Photocopy & Kiosk Supplies', 'Table whether routine paper/receipt printing comes from administrative contribution or member-approved budget.', 'portal', 'submitted', '2026-11-14T16:00:00.000Z')`
    )
    .run();

  // Expense Reimbursement Claim pending OD-24 (SDS §8.9 — NEVER posted to VF until General Body decides!)
  govDb
    .prepare(
      `INSERT INTO gov_expense_claim (
        id, society_id, claimant_member_id, claimant_name, team_side, amount_pkr, category,
        description, receipt_ref, status, funding_source_note, approved_by, created_at
      ) VALUES (
        'gec-1', 'pabohar', 'm-hira', 'Hira Thakur', 'woman', 1800, 'Kiosk Stationery & Notices',
        'Printed Sindhi/Urdu monthly ledger posters and ballot voice scripts for community notice board.',
        'RCPT-STATIONERY-109.pdf', 'approved_unfunded',
        'Approved across teams; awaiting General Body OD-24 funding decision (excluded from VF ledger).',
        'm-sajjad', '2026-11-14T15:00:00.000Z'
      )`
    )
    .run();

  // Contributors & Agreements (Stream 2 — strictly isolated)
  const contributors = [
    { id: 'con-1', memberId: 'm-saeed', name: 'Saeed Memon', contact: '+923001110012', payout: 'PK44MEZN00011223344', masked: 'PK44MEZN•••••••344', amount: 250000, bps: 400, cap: 1.25 },
    { id: 'con-2', memberId: null, name: 'Thar Diaspora Friends Pool', contact: '+923331239988', payout: 'PK88HABB00099887766', masked: 'PK88HABB•••••••766', amount: 120000, bps: 350, cap: 1.2 },
    { id: 'con-3', memberId: null, name: 'Dr. Lachhman Das', contact: '+923212233445', payout: 'PK19UBL00055667788', masked: 'PK19UBL0•••••••788', amount: 80000, bps: 350, cap: 1.2 },
  ];

  let totalClCapital = 0;
  for (const c of contributors) {
    totalClCapital += c.amount;
    clDb
      .prepare(
        `INSERT INTO cl_contributor (id, society_id, member_id, display_name, contact_enc, payout_account_enc, payout_masked, public_consent, status, created_at)
         VALUES (?, 'pabohar', ?, ?, ?, ?, ?, 0, 'active', '2026-10-04T09:00:00.000Z')`
      )
      .run(c.id, c.memberId, c.name, encryptField(c.contact), encryptField(c.payout), c.masked);

    const agrId = `agr-${c.id}`;
    clDb
      .prepare(
        `INSERT INTO cl_agreement (id, society_id, contributor_id, version, document_ref, revenue_share_bps, return_cap_multiplier, accepted_at)
         VALUES (?, 'pabohar', ?, 'v1.0', ?, ?, ?, '2026-10-04T09:30:00.000Z')`
      )
      .run(agrId, c.id, `DOC-CL-AGR-${c.id.toUpperCase()}.pdf`, c.bps, c.cap);

    const entry = postClEntry({
      societyId: 'pabohar',
      refNo: `CL-2026-CAP-${c.id}`,
      entryDate: '2026-10-05',
      category: 'capital_receipt',
      description: `Infrastructure capital received (${c.id}, agreement v1.0)`,
      sourceType: 'cl_contribution',
      sourceId: `contrib-${c.id}`,
      idempotencyKey: `seed-cl-cap-${c.id}`,
      actorId: 'm-bilawal',
      approverId: 'm-parveen',
      lines: [
        { accountCode: '1100', debitPkr: c.amount, creditPkr: 0 },
        { accountCode: '2100', debitPkr: 0, creditPkr: c.amount },
      ],
    });

    clDb
      .prepare(
        `INSERT INTO cl_contribution (id, society_id, contributor_id, agreement_id, amount_pkr, bank_line_ref, journal_entry_id, created_at)
         VALUES (?, 'pabohar', ?, ?, ?, ?, ?, '2026-10-05T12:00:00.000Z')`
      )
      .run(`contrib-${c.id}`, c.id, agrId, c.amount, `IBFT-CL-${c.id}`, entry.entryId);
  }

  // CL Infrastructure Equipment Invoice paid to VilloThar
  const infraEntry = postClEntry({
    societyId: 'pabohar',
    refNo: 'CL-2026-INFRA-01',
    entryDate: '2026-10-08',
    category: 'infrastructure_invoice',
    description: 'VilloThar Tower, Backhaul Radio & Fiber Distribution Equipment (Pabohar Node)',
    sourceType: 'cl_infra_invoice',
    sourceId: 'inv-vt-01',
    idempotencyKey: 'seed-cl-infra-01',
    actorId: 'm-bilawal',
    approverId: 'm-sajjad',
    lines: [
      { accountCode: '1300', debitPkr: 380000, creditPkr: 0 },
      { accountCode: '1100', debitPkr: 0, creditPkr: 380000 },
    ],
  });

  clDb
    .prepare(
      `INSERT INTO cl_infra_invoice (id, society_id, vendor_name, invoice_no, description, amount_pkr, document_ref, paid_entry_id, created_by, approved_by, created_at)
       VALUES ('inv-vt-01', 'pabohar', 'VilloThar Networks', 'VT-INV-2026-108', '30m Guyed Mast, Solar Battery Bank, Main Backhaul & Distribution', 380000, 'INV-VT-2026-108.pdf', ?, 'm-bilawal', 'm-sajjad', '2026-10-08T15:00:00.000Z')`
    )
    .run(infraEntry.entryId);

  // OPS Sales Reports & Transfers (Stream 3 & Reconciliation)
  const weeklyReports = [
    { id: 'ops-sr-w1', label: '2026-W42 (Oct 12–18)', start: '2026-10-12', end: '2026-10-18', units: 520, rev: 584000, levy: 26000, state: 'confirmed' as const, ref: 'IBFT-VT-88101' },
    { id: 'ops-sr-w2', label: '2026-W43 (Oct 19–25)', start: '2026-10-19', end: '2026-10-25', units: 580, rev: 642000, levy: 29000, state: 'confirmed' as const, ref: 'IBFT-VT-88240' },
    { id: 'ops-sr-w3', label: '2026-W44 (Oct 26–Nov 1)', start: '2026-10-26', end: '2026-11-01', units: 610, rev: 678000, levy: 30500, state: 'confirmed' as const, ref: 'IBFT-VT-88412' },
    { id: 'ops-sr-w4', label: '2026-W45 (Nov 2–8)', start: '2026-11-02', end: '2026-11-08', units: 660, rev: 731000, levy: 33000, state: 'confirmed' as const, ref: 'IBFT-VT-88590' },
    { id: 'ops-sr-w5', label: '2026-W46 (Nov 9–15)', start: '2026-11-09', end: '2026-11-15', units: 290, rev: 318000, levy: 14500, state: 'sent' as const, ref: 'IBFT-VT-88711' },
  ];

  for (let i = 0; i < weeklyReports.length; i++) {
    const r = weeklyReports[i];
    opsDb
      .prepare(
        `INSERT INTO ops_sales_report (
          id, society_id, period_label, period_start, period_end, version, status,
          paid_units, package_revenue_pkr, levy_due_pkr, submitted_by, submitted_at, file_hash, note
        ) VALUES (?, 'pabohar', ?, ?, ?, 1, 'submitted', ?, ?, ?, 'm-tariq', ?, ?, ?)`
      )
      .run(
        r.id,
        r.label,
        r.start,
        r.end,
        r.units,
        r.rev,
        r.levy,
        `${r.end}T18:00:00.000Z`,
        canonicalHash(r),
        'Weekly verified package collection feed from VilloThar'
      );

    postVfEntry({
      societyId: 'pabohar',
      refNo: `VF-DUE-W${42 + i}`,
      entryDate: r.end,
      category: 'levy_due',
      description: `Levy due from VilloThar (${r.label}: ${r.units} packages × Rs. 50)`,
      sourceType: 'ops_sales_report',
      sourceId: r.id,
      idempotencyKey: `seed-vf-due-${r.id}`,
      actorId: 'm-bilawal',
      lines: [
        { accountCode: '1200', debitPkr: r.levy, creditPkr: 0 },
        { accountCode: '4000', debitPkr: 0, creditPkr: r.levy },
      ],
    });

    if (r.state === 'confirmed') {
      const bankLineId = `bsl-vf-${i + 1}`;
      reconDb
        .prepare(
          `INSERT INTO recon_bank_statement_line (id, society_id, bank_account_id, domain, value_date, amount_pkr, narrative, bank_ref, matched)
           VALUES (?, 'pabohar', 'pabohar-bank-vf', 'VF', ?, ?, ?, ?, 1)`
        )
        .run(bankLineId, r.end, r.levy, `IBFT VILLOTHAR LEVY ${r.label}`, r.ref);

      const vfRec = postVfEntry({
        societyId: 'pabohar',
        refNo: `VF-REC-W${42 + i}`,
        entryDate: r.end,
        category: 'levy_received',
        description: `Levy transfer confirmed on VF bank statement (${r.label})`,
        sourceType: 'recon_levy_transfer',
        sourceId: `tr-${i + 1}`,
        idempotencyKey: `seed-vf-rec-${r.id}`,
        actorId: 'm-bilawal',
        approverId: 'm-parveen',
        evidenceRef: r.ref,
        lines: [
          { accountCode: '1100', debitPkr: r.levy, creditPkr: 0 },
          { accountCode: '1200', debitPkr: 0, creditPkr: r.levy },
        ],
      });

      reconDb
        .prepare(
          `INSERT INTO recon_levy_transfer (
            id, society_id, period_label, amount_expected_pkr, amount_declared_pkr, reference_no,
            state, declared_by, declared_at, confirmed_by, confirmed_at, vf_entry_id
          ) VALUES (?, 'pabohar', ?, ?, ?, ?, 'confirmed', 'm-tariq', ?, 'm-bilawal', ?, ?)`
        )
        .run(`tr-${i + 1}`, r.label, r.levy, r.levy, r.ref, `${r.end}T19:00:00.000Z`, `${r.end}T20:00:00.000Z`, vfRec.entryId);

      reconDb
        .prepare(
          `INSERT INTO recon_match (id, society_id, statement_line_id, domain, entry_id, transfer_id, matched_by, matched_at)
           VALUES (?, 'pabohar', ?, 'VF', ?, ?, 'm-bilawal', ?)`
        )
        .run(`rm-${i + 1}`, bankLineId, vfRec.entryId, `tr-${i + 1}`, `${r.end}T20:00:00.000Z`);
    } else {
      reconDb
        .prepare(
          `INSERT INTO recon_bank_statement_line (id, society_id, bank_account_id, domain, value_date, amount_pkr, narrative, bank_ref, matched)
           VALUES ('bsl-vf-5', 'pabohar', 'pabohar-bank-vf', 'VF', '2026-11-15', 14500, 'IBFT VILLOTHAR LEVY 2026-W46', 'IBFT-VT-88711', 0)`
        )
        .run();

      reconDb
        .prepare(
          `INSERT INTO recon_levy_transfer (
            id, society_id, period_label, amount_expected_pkr, amount_declared_pkr, reference_no,
            state, declared_by, declared_at
          ) VALUES ('tr-5', 'pabohar', ?, 14500, 14500, 'IBFT-VT-88711', 'sent', 'm-tariq', '2026-11-15T19:00:00.000Z')`
        )
        .run(r.label);
    }
  }

  opsDb
    .prepare(
      `INSERT INTO ops_revenue_report (id, society_id, period_label, sales_report_id, package_revenue_basis_pkr, version, submitted_by, submitted_at)
       VALUES ('rev-2026-10', 'pabohar', '2026-10', 'ops-sr-w3', 1904000, 1, 'm-tariq', '2026-11-02T10:00:00.000Z')`
    )
    .run();

  const purchases = [
    ['pur-1', 'm-ali', 'Ali Bheel', 'pabohar-pkg-family', 'Family Study 12 Mbps', 1400, 50, 1450, 'paid', '2026-11-12T08:30:00.000Z', null],
    ['pur-2', 'm-fatima', 'Fatima Meghwar', 'pabohar-pkg-basic', 'Basic Village 5 Mbps', 800, 50, 850, 'paid', '2026-11-13T11:15:00.000Z', null],
    ['pur-3', 'm-saeed', 'Saeed Memon', 'pabohar-pkg-shop', 'Shop & Community 20 Mbps', 2200, 50, 2250, 'paid', '2026-11-14T09:40:00.000Z', null],
    ['pur-4', 'm-rehman', 'Rehman Samoon', 'pabohar-pkg-family', 'Family Study 12 Mbps', 1400, 50, 1450, 'pending', '2026-11-15T14:20:00.000Z', 'Awaiting mobile wallet confirmation'],
    ['pur-5', 'm-amina', 'Amina Junejo', 'pabohar-pkg-basic', 'Basic Village 5 Mbps', 800, 50, 850, 'failed', '2026-11-15T16:10:00.000Z', 'Gateway timeout — retry advised'],
  ] as const;

  for (const [id, mId, mName, pId, pName, pr, lv, tot, st, at, note] of purchases) {
    opsDb
      .prepare(
        `INSERT INTO pay_purchase (id, society_id, member_id, member_name, package_id, package_name, price_pkr, levy_pkr, total_pkr, status, idempotency_key, followup_note, created_at)
         VALUES (?, 'pabohar', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, mId, mName, pId, pName, pr, lv, tot, st, `seed-${id}`, note, at);
  }

  // Projects (no neighbourhood_id, reference_no + submission_channel per FR-PRJ-001)
  prjDb
    .prepare(
      `INSERT INTO prj_proposal (
        id, society_id, reference_no, member_id, proposer_name, submission_channel,
        title_en, title_sd, title_ur, description_en, description_sd, description_ur,
        category, est_budget_pkr, impact_text, levy_effect_text, state, feasibility_status, feasibility_note,
        explainer_summary_sd, discussion_deadline, allocated_budget_pkr, created_at
      ) VALUES (
        'prj-solar-water', 'pabohar', 'PRJ-2026-01', 'm-ali', 'Ali Bheel', 'portal',
        'Solar Water Filtration Pump — Primary School Courtyard',
        'شمسي پاڻي فلٽريشن پمپ — پرائمري اسڪول وٽ',
        'سولر واٹر فلٹریشن پمپ — پرائمری اسکول کے پاس',
        'Install a solar-powered clean drinking water filtration unit near Pabohar Primary School serving the entire village.',
        'پٻوهر پرائمري اسڪول ويجھو شمسي توانائي سان هلندڙ صاف پيئڻ جي پاڻي جو فلٽر پلانٽ لڳائڻ، جنهن مان سڄي ڳوٺ کي فائدو ٿيندو.',
        'پبوہار پرائمری اسکول کے قریب سولر پاور سے چلنے والا صاف پینے کے پانی کا فلٹریشن یونٹ لگانا جس سے پورے گاؤں کو فائدہ ہوگا۔',
        'Water & Sanitation', 65000, 'Clean drinking water within 200m for 95+ village households.',
        'No increase to Rs. 50 levy',
        'execution', 'feasible', 'Technical site check passed; school committee confirmed space.',
        'هن منصوبي تي ڪل خرچ 65,000 رپيا ايندو. ليوي ۾ ڪا به واڌ نه ٿيندي.',
        '2026-10-28T23:59:59.000Z', 65000, '2026-10-15T10:00:00.000Z'
      )`
    )
    .run();

  vfDb
    .prepare(
      `INSERT INTO vf_project_allocation (id, society_id, project_id, amount_pkr, resolution_id, status, created_at)
       VALUES ('alloc-solar', 'pabohar', 'prj-solar-water', 65000, 'res-solar-water', 'allocated', '2026-11-01T12:00:00.000Z')`
    )
    .run();

  const solarExpEntry = postVfEntry({
    societyId: 'pabohar',
    refNo: 'VF-EXP-2026-01',
    entryDate: '2026-11-06',
    category: 'project_expense',
    description: 'Solar Water Filtration Pump — Phase 1 Bore & Submersible Unit',
    sourceType: 'prj_expense_request',
    sourceId: 'exp-solar-1',
    idempotencyKey: 'seed-vf-exp-solar-1',
    actorId: 'm-bilawal',
    approverId: 'm-parveen',
    projectId: 'prj-solar-water',
    evidenceRef: 'RCPT-MITHI-PUMP-402.pdf',
    lines: [
      { accountCode: '5000', debitPkr: 32000, creditPkr: 0 },
      { accountCode: '1100', debitPkr: 0, creditPkr: 32000 },
    ],
  });

  prjDb
    .prepare(
      `INSERT INTO prj_expense_request (
        id, society_id, project_id, amount_pkr, vendor_name, description, invoice_doc_ref,
        requested_by, requested_team_side, status, approved_by, vf_entry_id, created_at
      ) VALUES (
        'exp-solar-1', 'pabohar', 'prj-solar-water', 32000, 'Mithi Water Engineering',
        'Borehole casing & 1HP DC submersible pump', 'RCPT-MITHI-PUMP-402.pdf',
        'm-bilawal', 'woman', 'approved', 'm-parveen', ?, '2026-11-06T11:00:00.000Z'
      )`
    )
    .run(solarExpEntry.entryId);

  // Pending expense on woman's team from vendor linked to Man-team member Rehman (tests both Cross-Team Maker-Checker AND COI recusal!)
  prjDb
    .prepare(
      `INSERT INTO prj_expense_request (
        id, society_id, project_id, amount_pkr, vendor_name, description, invoice_doc_ref,
        requested_by, requested_team_side, status, created_at
      ) VALUES (
        'exp-solar-2', 'pabohar', 'prj-solar-water', 18500, 'Thar Solar & Hardware',
        '2x 450W monocrystalline solar panels & mounting frame', 'QUOT-TSH-911.pdf',
        'm-bilawal', 'woman', 'pending', '2026-11-15T12:00:00.000Z'
      )`
    )
    .run();

  prjDb
    .prepare(
      `INSERT INTO prj_proposal (
        id, society_id, reference_no, member_id, proposer_name, submission_channel,
        title_en, title_sd, title_ur, description_en, description_sd, description_ur,
        category, est_budget_pkr, impact_text, levy_effect_text, state, feasibility_status, feasibility_note,
        explainer_summary_sd, discussion_deadline, election_id, created_at
      ) VALUES (
        'prj-girls-literacy', 'pabohar', 'PRJ-2026-02', 'm-amina', 'Amina Junejo', 'portal',
        'Girls Digital Literacy & Voice Kiosk Room',
        'ڇوڪرين لاءِ ڊجيٽل سکيا ۽ وائيس ڪيوسڪ روم',
        'لڑکیوں کے لیے ڈیجیٹل لٹریسی اور وائس کیوسک روم',
        'Equip a quiet community room with 3 low-power tablets, solar inverter, and Sindhi/Urdu literacy software for women and girls across the village.',
        'ڳوٺ جي عورتن ۽ ڇوڪرين لاءِ 3 ٽيبليٽس، سولر انورٽر ۽ سنڌي/اردو سکيا واري سافٽويئر سان محفوظ ڪمرو تيار ڪرڻ.',
        'گاؤں کی خواتین اور لڑکیوں کے لیے 3 ٹیبلیٹس، سولر انورٹر اور سندھی/اردو تعلیمی سافٹ ویئر سے لیس کمرہ تیار کرنا۔',
        'Education & Inclusion', 42000, 'Supports 60+ girls and women in weekly digital & cooperative literacy.',
        'No increase to Rs. 50 levy',
        'voting', 'feasible', 'Room provided rent-free by village school annex; budget covers hardware only.',
        'هن منصوبي تي 42,000 رپيا خرچ ايندو جيڪو موجوده وليج فنڊ مان پورو ٿيندو.',
        '2026-11-12T23:59:59.000Z', 'elec-girls-lab', '2026-11-04T09:00:00.000Z'
      )`
    )
    .run();

  prjDb
    .prepare(
      `INSERT INTO prj_proposal (
        id, society_id, reference_no, member_id, proposer_name, submission_channel,
        title_en, title_sd, title_ur, description_en, description_sd, description_ur,
        category, est_budget_pkr, impact_text, levy_effect_text, state, feasibility_status, feasibility_note,
        explainer_summary_sd, discussion_deadline, created_at
      ) VALUES (
        'prj-village-lights', 'pabohar', 'PRJ-2026-03', 'm-hira', 'Hira Thakur', 'helper',
        'Solar Streetlights for Main Village Footpaths',
        'ڳوٺ جي مکيه رستن لاءِ شمسي اسٽريٽ لائيٽون',
        'گاؤں کی مرکزی گلیوں کے لیے سولر اسٹریٹ لائٹس',
        'Install 8 pole-mounted solar LED streetlights along main village footpaths and the clinic walkway for evening safety.',
        'ڳوٺ جي مکيه رستن ۽ ڪلينڪ واري واٽ تي رات جي حفاظت لاءِ 8 شمسي اسٽريٽ لائيٽون لڳائڻ.',
        'گاؤں کی مرکزی گلیوں اور کلینک کے راستے پر رات کی حفاظت کے لیے 8 سولر اسٹریٹ لائٹس لگانا۔',
        'Safety & Infrastructure', 38000, 'Safer evening movement for all households.',
        'No increase to Rs. 50 levy',
        'discussion', 'feasible', 'Poles available locally; maintenance assigned to village volunteers.',
        '8 شمسي بتين تي 38,000 رپيا خرچ ايندو. ليوي تبديل نه ٿيندي.',
        '2026-11-25T23:59:59.000Z', '2026-11-10T11:00:00.000Z'
      )`
    )
    .run();

  prjDb
    .prepare(
      `INSERT INTO prj_proposal (
        id, society_id, reference_no, member_id, proposer_name, submission_channel,
        title_en, title_sd, title_ur, description_en, description_sd, description_ur,
        category, est_budget_pkr, impact_text, levy_effect_text, state, feasibility_status, feasibility_note,
        allocated_budget_pkr, final_report_text, created_at
      ) VALUES (
        'prj-kiosk-shade', 'pabohar', 'PRJ-2026-00', 'm-kiran', 'Kiran Bheel', 'general_body',
        'Community Notice Board & Helper Kiosk Shade',
        'ڳوٺاڻو نوٽيس بورڊ ۽ هيلپر ڪيوسڪ ڇانو',
        'کمیونٹی نوٹس بورڈ اور ہیلپر کیوسک شیڈ',
        'Built a weatherproof notice board and shaded seating bench where villagers view printed monthly ledgers and get portal assistance.',
        'ڇپيل ماهوار حساب ڪتاب ڏسڻ ۽ پورٽل مدد لاءِ نوٽيس بورڊ ۽ ڇانو واري جاءِ تيار ڪئي وئي.',
        'پرنٹ شدہ ماہانہ حساب کتاب دیکھنے اور پورٹل مدد کے لیے نوٹس بورڈ اور سایہ دار جگہ بنائی گئی۔',
        'Civic Space', 14000, 'Daily physical access point for residents without smartphones.',
        'No increase to Rs. 50 levy',
        'closed', 'feasible', 'Completed within budget.',
        14000, 'Completed on 2026-10-28 for PKR 13,500 (PKR 500 unspent returned to VF). Receipts verified across teams.', '2026-10-06T09:00:00.000Z'
      )`
    )
    .run();

  // ============================================================================
  // ELECTIONS & CONTESTS (v1.1 Gender-Specific Contests + Weighted Secret Units)
  // ============================================================================
  const activeVerifiedAdults = members.filter((m) => m.status === 'active' && m.idStatus === 'approved');
  const pointsMap = new Map<string, number>();
  for (const m of activeVerifiedAdults) {
    const row = ptsDb
      .prepare('SELECT total_pts FROM pts_member_points WHERE society_id = ? AND member_id = ? ORDER BY computed_at DESC LIMIT 1')
      .get('pabohar', m.id) as { total_pts: number } | undefined;
    pointsMap.set(m.id, Math.max(1, row?.total_pts ?? 1));
  }

  // Election 1: Open Equal-Weight Project Referendum (OD-02 default equal weighting)
  const elec1Config = {
    type: 'project',
    ballotMode: 'secret',
    quorumFraction: 0.3,
    passThreshold: 0.5,
    minTurnoutFraction: 0.3,
    estBudgetPkr: 42000,
    levyChange: false,
  };
  voteDb
    .prepare(
      `INSERT INTO election (
        id, society_id, type, title_en, title_sd, title_ur,
        description_en, description_sd, description_ur,
        state, ballot_mode, opens_at, closes_at, quorum_fraction, pass_threshold, min_turnout_fraction,
        project_id, config_json, config_hash, created_by, created_at
      ) VALUES (
        'elec-girls-lab', 'pabohar', 'project',
        'Village Fund Project Vote: Girls Digital Literacy Room (PKR 42,000)',
        'وليج فنڊ منصوبي جو ووٽ: ڇوڪرين جو ڊجيٽل سکيا روم (42,000 رپيا)',
        'ولیج فنڈ منصوبے کا ووٹ: لڑکیوں کا ڈیجیٹل لٹریسی روم (42,000 روپے)',
        'Secret ballot (equal 1-point weight per OD-02) to allocate PKR 42,000 from the Village Fund. No change to Rs. 50 levy.',
        'ڳوٺاڻي فنڊ مان 42,000 رپيا جاري ڪرڻ لاءِ رازداري ووٽ (برابري وارو ووٽ). ليوي 50 رپيا برقرار رهندي.',
        'ولیج فنڈ سے 42,000 روپے جاری کرنے کے لیے خفیہ ووٹ (مساوی ووٹ)۔ لیوی 50 روپے برقرار رہے گی۔',
        'open', 'secret', '2026-11-12T00:00:00.000Z', '2026-12-10T23:59:59.000Z',
        0.3, 0.5, 0.3, 'prj-girls-literacy', ?, ?, 'm-zeeshan', '2026-11-12T00:00:00.000Z'
      )`
    )
    .run(JSON.stringify(elec1Config), canonicalHash(elec1Config));

  const projectSnapIds = activeVerifiedAdults.map((m) => m.id).sort();
  voteDb
    .prepare(
      `INSERT INTO contest (
        id, society_id, election_id, name_en, name_sd, name_ur,
        prompt_en, prompt_sd, prompt_ur, eligible_gender_rule, weighting, formula_id, options_json,
        snapshot_hash, snapshot_count, snapshot_total_points, state
      ) VALUES (
        'contest-girls-lab', 'pabohar', 'elec-girls-lab',
        'Project Funding Approval (Equal Weight)', 'منصوبي جي منظوري (برابري ووٽ)', 'منصوبے کی منظوری (مساوی ووٹ)',
        'Do you approve allocating PKR 42,000 from the Village Fund for the Girls Digital Literacy Room?',
        'ڇا توهان وليج فنڊ مان 42,000 رپيا ڇوڪرين جي ڊجيٽل روم لاءِ منظور ڪريو ٿا؟',
        'کیا آپ ولیج فنڈ سے لڑکیوں کے ڈیجیٹل روم کے لیے 42,000 روپے کی منظوری دیتے ہیں؟',
        'any', 'equal', NULL, ?, ?, ?, ?, 'open'
      )`
    )
    .run(
      JSON.stringify([
        { code: 'YES', labelEn: 'Approve Project (PKR 42,000)', labelSd: 'منصوبو منظور (42,000 رپيا)', labelUr: 'منصوبہ منظور (42,000 روپے)', symbol: 'check' },
        { code: 'NO', labelEn: 'Reject Project', labelSd: 'منصوبو رد ڪريو', labelUr: 'منصوبہ مسترد کریں', symbol: 'x' },
        { code: 'ABSTAIN', labelEn: 'Abstain', labelSd: 'غير جانبدار', labelUr: 'غیر جانبدار', symbol: 'minus' },
      ]),
      canonicalHash(projectSnapIds),
      projectSnapIds.length,
      projectSnapIds.length
    );

  for (const mId of projectSnapIds) {
    voteDb
      .prepare('INSERT INTO voter_snapshot (contest_id, society_id, member_id, points_at_snapshot) VALUES (?, ?, ?, 1)')
      .run('contest-girls-lab', 'pabohar', mId);
  }

  for (const [idx, mId] of ['m-fatima', 'm-kiran', 'm-hira'].entries()) {
    voteDb
      .prepare(
        `INSERT INTO vote_participation (contest_id, society_id, member_id, points_used, cast_at, channel)
         VALUES ('contest-girls-lab', 'pabohar', ?, 1, ?, 'self')`
      )
      .run(mId, `2026-11-14T10:${10 + idx}:00.000Z`);
    voteDb
      .prepare('INSERT INTO sealed_ballot (ballot_id, society_id, contest_id, payload_enc) VALUES (?, ?, ?, ?)')
      .run(newId('bal'), 'pabohar', 'contest-girls-lab', encryptField(JSON.stringify({ choiceCode: 'YES' })));
  }

  // Election 2: Open Pilot Gender-Specific Weighted Co-President Contests (AC-ELE-01 & weighted sealed_ballot units)
  const elec2Config = {
    type: 'co_president',
    ballotMode: 'secret',
    quorumFraction: 0.3,
    passThreshold: 0.5,
    minTurnoutFraction: 0.3,
    tieRule: 'manual_decision',
  };
  voteDb
    .prepare(
      `INSERT INTO election (
        id, society_id, type, title_en, title_sd, title_ur,
        description_en, description_sd, description_ur,
        state, ballot_mode, opens_at, closes_at, quorum_fraction, pass_threshold, min_turnout_fraction,
        tie_rule, formula_id, config_json, config_hash, created_by, created_at
      ) VALUES (
        'elec-copres-2026', 'pabohar', 'co_president',
        'Co-President Trial Election 2026 (Women & Men Separate Contests)',
        'ٻن شريڪ صدرن جي آزمائشي چونڊ 2026 (عورتن ۽ مردن جا الڳ مقابلا)',
        'شریک صدور کا آزمائشی انتخاب 2026 (خواتین و مردوں کے الگ مقابلے)',
        'Gender-specific weighted contests: verified women vote in the Woman Co-President contest; verified men vote in the Man Co-President contest. Each vote-point casts 1 anonymous ballot unit.',
        'صنف مطابق الڳ مقابلا: تصديق ٿيل عورتون عورت شريڪ صدر لاءِ ۽ مرد مرد شريڪ صدر لاءِ ووٽ ڏيندا. هر ووٽ پوائنٽ هڪ خفيه پرچي وجهندو.',
        'صنف کے مطابق الگ مقابلے: تصدیق شدہ خواتین خاتون شریک صدر اور مرد حضرات مرد شریک صدر کے لیے ووٹ دیں گے۔ ہر ووٹ پوائنٹ ایک خفیہ یونٹ ڈالتا ہے۔',
        'open', 'secret', '2026-11-13T00:00:00.000Z', '2026-12-12T23:59:59.000Z',
        0.3, 0.5, 0.3, 'manual_decision', 'pabohar-formula-v1.0-draft', ?, ?, 'm-zeeshan', '2026-11-13T00:00:00.000Z'
      )`
    )
    .run(JSON.stringify(elec2Config), canonicalHash(elec2Config));

  const womanVoters = activeVerifiedAdults.filter((m) => m.gender === 'female');
  const manVoters = activeVerifiedAdults.filter((m) => m.gender === 'male' && m.id !== 'm-karim');

  const womanCandidates = [
    { id: 'cand-w-1', mId: 'm-amina', name: 'Amina Junejo', hhId: 'hh-14', gender: 'female', symbol: 'sun', qual: 'bachelor_degree', score: 88 },
    { id: 'cand-w-2', mId: 'm-nasreen', name: 'Nasreen Kolhi', hhId: 'hh-16', gender: 'female', symbol: 'wheat', qual: 'intermediate_plus', score: 78 },
  ];
  const manCandidates = [
    { id: 'cand-m-1', mId: 'm-asad', name: 'Asad Memon', hhId: 'hh-12', gender: 'male', symbol: 'book', qual: 'bachelor_degree', score: 92 },
    { id: 'cand-m-2', mId: 'm-saeed', name: 'Saeed Memon', hhId: 'hh-13', gender: 'male', symbol: 'droplet', qual: 'bachelor_degree', score: 84 },
  ];

  const womanTotalPts = womanVoters.reduce((acc, m) => acc + (pointsMap.get(m.id) ?? 1), 0);
  const manTotalPts = manVoters.reduce((acc, m) => acc + (pointsMap.get(m.id) ?? 1), 0);

  voteDb
    .prepare(
      `INSERT INTO contest (
        id, society_id, election_id, name_en, name_sd, name_ur,
        prompt_en, prompt_sd, prompt_ur, eligible_gender_rule, weighting, formula_id, options_json,
        snapshot_hash, snapshot_count, snapshot_total_points, state
      ) VALUES (
        'contest-woman-2026', 'pabohar', 'elec-copres-2026',
        'Woman Co-President Contest (Women Voters Only)', 'عورت شريڪ صدر جو مقابلو (صرف عورت ووٽر)', 'خاتون شریک صدر کا مقابلہ (صرف خواتین ووٹر)',
        'Select 1 qualified Woman Co-President candidate (weighted by verified Vote-Points).',
        'عورت شريڪ صدر لاءِ 1 اهل اميدوار چونڊيو (ووٽ پوائنٽس موجب).',
        'خاتون شریک صدر کے لیے 1 اہل امیدوار منتخب کریں (ووٹ پوائنٹس کے مطابق)۔',
        'woman', 'points', 'pabohar-formula-v1.0-draft', ?, ?, ?, ?, 'open'
      )`
    )
    .run(
      JSON.stringify(
        womanCandidates.map((c) => ({
          code: c.id,
          labelEn: `${c.name} (${c.qual === 'bachelor_degree' ? "Bachelor's" : 'Inter+'})`,
          labelSd: c.name,
          labelUr: c.name,
          symbol: c.symbol,
        }))
      ),
      canonicalHash(womanVoters.map((v) => v.id).sort()),
      womanVoters.length,
      womanTotalPts
    );

  voteDb
    .prepare(
      `INSERT INTO contest (
        id, society_id, election_id, name_en, name_sd, name_ur,
        prompt_en, prompt_sd, prompt_ur, eligible_gender_rule, weighting, formula_id, options_json,
        snapshot_hash, snapshot_count, snapshot_total_points, state
      ) VALUES (
        'contest-man-2026', 'pabohar', 'elec-copres-2026',
        'Man Co-President Contest (Men Voters Only)', 'مرد شريڪ صدر جو مقابلو (صرف مرد ووٽر)', 'مرد شریک صدر کا مقابلہ (صرف مرد ووٹر)',
        'Select 1 qualified Man Co-President candidate (weighted by verified Vote-Points).',
        'مرد شريڪ صدر لاءِ 1 اهل اميدوار چونڊيو (ووٽ پوائنٽس موجب).',
        'مرد شریک صدر کے لیے 1 اہل امیدوار منتخب کریں (ووٹ پوائنٹس کے مطابق)۔',
        'man', 'points', 'pabohar-formula-v1.0-draft', ?, ?, ?, ?, 'open'
      )`
    )
    .run(
      JSON.stringify(
        manCandidates.map((c) => ({
          code: c.id,
          labelEn: `${c.name} (${c.qual === 'bachelor_degree' ? "Bachelor's" : 'Inter+'})`,
          labelSd: c.name,
          labelUr: c.name,
          symbol: c.symbol,
        }))
      ),
      canonicalHash(manVoters.map((v) => v.id).sort()),
      manVoters.length,
      manTotalPts
    );

  for (const w of womanVoters) {
    voteDb
      .prepare('INSERT INTO voter_snapshot (contest_id, society_id, member_id, points_at_snapshot) VALUES (?, ?, ?, ?)')
      .run('contest-woman-2026', 'pabohar', w.id, pointsMap.get(w.id) ?? 1);
  }
  for (const mn of manVoters) {
    voteDb
      .prepare('INSERT INTO voter_snapshot (contest_id, society_id, member_id, points_at_snapshot) VALUES (?, ?, ?, ?)')
      .run('contest-man-2026', 'pabohar', mn.id, pointsMap.get(mn.id) ?? 1);
  }

  for (const [contestId, list] of [
    ['contest-woman-2026', womanCandidates],
    ['contest-man-2026', manCandidates],
  ] as const) {
    for (const c of list) {
      voteDb
        .prepare(
          `INSERT INTO candidate (
            id, society_id, contest_id, election_id, member_id, member_name, household_id, gender,
            symbol_key, qualification_kind, qualification_status, qualification_note,
            training_passed, training_score, eligibility_decision_by, status, created_at
          ) VALUES (?, 'pabohar', ?, 'elec-copres-2026', ?, ?, ?, ?, ?, ?, 'approved', 'Degree verified by Verification Officer', 1, ?, 'm-ali', 'qualified', '2026-11-12T10:00:00.000Z')`
        )
        .run(c.id, contestId, c.mId, c.name, c.hhId, c.gender, c.symbol, c.qual, c.score);

      voteDb
        .prepare(
          `INSERT INTO training_record (
            id, society_id, candidate_id, member_id, material_version, test_date, score, pass_mark, passed, verified_by, created_at
          ) VALUES (?, 'pabohar', ?, ?, 'PresidencyBook-v1.1', '2026-11-12', ?, 70, 1, 'm-ali', '2026-11-12T12:00:00.000Z')`
        )
        .run(newId('trn'), c.id, c.mId, c.score);
    }
  }

  // Election 3: Upcoming Co-President Nomination Cycle (Blocked by AC-PTS-03 undecided factors + untrained candidate AC-EXC-01!)
  voteDb
    .prepare(
      `INSERT INTO election (
        id, society_id, type, title_en, title_sd, title_ur,
        description_en, description_sd, description_ur,
        state, ballot_mode, opens_at, closes_at, quorum_fraction, pass_threshold, min_turnout_fraction,
        tie_rule, formula_id, config_json, config_hash, created_by, created_at
      ) VALUES (
        'elec-copres-upcoming', 'pabohar', 'co_president',
        'Next-Term Co-President Election (Nomination Gate Check)',
        'ايندڙ مدي لاءِ شريڪ صدر چونڊ (نامزدگي مرحلو)',
        'آئندہ مدت کے شریک صدور کا انتخاب (نامزدگی مرحلہ)',
        'In nomination phase. Opening is automatically blocked until General Body decides undecided Vote-Points factors (no_schooling, no_exposure) and every candidate completes Presidency Book training.',
        'نامزدگي واري مرحلي ۾. جنرل باڊي جي فيصلن ۽ صدارتي ڪتاب جي تربيت تائين ووٽنگ کلي نٿي سگهي.',
        'نامزدگی کے مرحلے میں۔ جنرل باڈی کے فیصلوں اور صدارتی کتاب کی تربیت مکمل ہونے تک ووٹنگ نہیں کھل سکتی۔',
        'nomination', 'secret', '2026-12-01T08:00:00.000Z', '2026-12-15T20:00:00.000Z',
        0.3, 0.5, 0.3, 'manual_decision', 'pabohar-formula-v1.0-draft', ?, ?, 'm-zeeshan', '2026-11-15T08:00:00.000Z'
      )`
    )
    .run(JSON.stringify(elec2Config), canonicalHash(elec2Config));

  voteDb
    .prepare(
      `INSERT INTO contest (
        id, society_id, election_id, name_en, name_sd, name_ur,
        prompt_en, prompt_sd, prompt_ur, eligible_gender_rule, weighting, formula_id, options_json, state
      ) VALUES (
        'contest-man-upcoming', 'pabohar', 'elec-copres-upcoming',
        'Next Man Co-President Contest', 'ايندڙ مرد شريڪ صدر مقابلو', 'آئندہ مرد شریک صدر مقابلہ',
        'Select 1 qualified Man Co-President candidate', '1 مرد شريڪ صدر چونڊيو', '1 مرد شریک صدر منتخب کریں',
        'man', 'points', 'pabohar-formula-v1.0-draft', ?, 'nomination'
      )`
    )
    .run(JSON.stringify([{ code: 'cand-up-1', labelEn: 'Rehman Samoon', labelSd: 'Rehman Samoon', labelUr: 'Rehman Samoon', symbol: 'sun' }]));

  voteDb
    .prepare(
      `INSERT INTO candidate (
        id, society_id, contest_id, election_id, member_id, member_name, household_id, gender,
        symbol_key, qualification_kind, qualification_status, qualification_note,
        training_passed, status, created_at
      ) VALUES (
        'cand-up-1', 'pabohar', 'contest-man-upcoming', 'elec-copres-upcoming',
        'm-rehman', 'Rehman Samoon', 'hh-07', 'male', 'sun', 'intermediate_plus', 'approved',
        'Intermediate verified; Presidency Book training pending', 0, 'applied', '2026-11-15T09:00:00.000Z'
      )`
    )
    .run();

  // Election 4: Certified Founding Co-President Election demonstrating AC-ELE-02 (25 voters/160 pts > 40 voters/150 pts)
  voteDb
    .prepare(
      `INSERT INTO election (
        id, society_id, type, title_en, title_sd, title_ur,
        description_en, description_sd, description_ur,
        state, ballot_mode, opens_at, closes_at, quorum_fraction, pass_threshold, min_turnout_fraction,
        tie_rule, config_json, config_hash, created_by, created_at
      ) VALUES (
        'elec-founding-2026', 'pabohar', 'co_president',
        'Founding Co-President Election (Certified Oct 2026)',
        'بنيادي شريڪ صدر چونڊ (تصديق ٿيل آڪٽوبر 2026)',
        'بنیادی شریک صدور انتخاب (تصدیق شدہ اکتوبر 2026)',
        'Certified founding election establishing Woman Co-President Fatima Meghwar and Man Co-President Sajjad Nohrio, illustrating weighted points tally (higher points wins even with fewer headcount).',
        'بنيادي چونڊ جنهن ۾ فاطمه ميگهواڙ ۽ سجاد نوهڙيو شريڪ صدر چونڊيا ويا.',
        'بنیادی انتخاب جس میں فاطمہ میگھواڑ اور سجاد نوہڑیو شریک صدور منتخب ہوئے۔',
        'certified', 'secret', '2026-10-03T08:00:00.000Z', '2026-10-04T20:00:00.000Z',
        0.3, 0.5, 0.3, 'manual_decision', '{"mode":"weighted","contests":2}', ?, 'm-zeeshan', '2026-10-03T08:00:00.000Z'
      )`
    )
    .run(canonicalHash({ mode: 'weighted', contests: 2 }));

  voteDb
    .prepare(
      `INSERT INTO contest (
        id, society_id, election_id, name_en, name_sd, name_ur,
        prompt_en, prompt_sd, prompt_ur, eligible_gender_rule, weighting, options_json,
        snapshot_hash, snapshot_count, snapshot_total_points, state
      ) VALUES
        ('contest-founding-woman', 'pabohar', 'elec-founding-2026', 'Woman Co-President (Founding)', 'عورت شريڪ صدر', 'خاتون شریک صدر', 'Woman Co-President', 'عورت شريڪ صدر', 'خاتون شریک صدر', 'woman', 'points', '[]', ?, 65, 310, 'certified'),
        ('contest-founding-man', 'pabohar', 'elec-founding-2026', 'Man Co-President (Founding)', 'مرد شريڪ صدر', 'مرد شریک صدر', 'Man Co-President', 'مرد شريڪ صدر', 'مرد شریک صدر', 'man', 'points', '[]', ?, 65, 320, 'certified')`
    )
    .run(canonicalHash(['founding-woman']), canonicalHash(['founding-man']));

  voteDb
    .prepare(
      `INSERT INTO contest_result (
        id, society_id, contest_id, election_id, result_status, tallies_json,
        winner_candidate_id, winner_name, formula_version, certified_by_1, certified_by_2, certified_at
      ) VALUES
        (
          'res-founding-w', 'pabohar', 'contest-founding-woman', 'elec-founding-2026', 'PASSED', ?,
          'oh-woman-1', 'Fatima Meghwar', 'v1.0-draft', 'm-zeeshan', 'm-ali', '2026-10-05T08:00:00.000Z'
        ),
        (
          'res-founding-m', 'pabohar', 'contest-founding-man', 'elec-founding-2026', 'PASSED', ?,
          'oh-man-1', 'Sajjad Nohrio', 'v1.0-draft', 'm-zeeshan', 'm-ali', '2026-10-05T08:00:00.000Z'
        )`
    )
    .run(
      JSON.stringify({
        turnoutVoters: 65,
        eligibleVoters: 80,
        totalPointsCast: 310,
        quorumMet: true,
        minTurnoutMet: true,
        counts: [
          { choice_code: 'Fatima Meghwar', label: 'Fatima Meghwar', points: 160, headcountApprox: 25 },
          { choice_code: 'Runner-up', label: 'Contestant B', points: 150, headcountApprox: 40 },
        ],
      }),
      JSON.stringify({
        turnoutVoters: 65,
        eligibleVoters: 82,
        totalPointsCast: 320,
        quorumMet: true,
        minTurnoutMet: true,
        counts: [
          { choice_code: 'Sajjad Nohrio', label: 'Sajjad Nohrio', points: 185 },
          { choice_code: 'Runner-up', label: 'Contestant B', points: 135 },
        ],
      })
    );

  // Community Issues (place_text + public/executive_only per FR-ISS-001/003 — NO neighbourhood groups!)
  commDb
    .prepare(
      `INSERT INTO comm_issue (
        id, society_id, reporter_member_id, reporter_name, place_text, category,
        description, visibility, status, assignee_member_id, executive_response, created_at
      ) VALUES
        ('iss-1', 'pabohar', 'm-ali', 'Ali Bheel', 'Near eastern primary school well', 'Water', 'Handpump near eastern lane has loose valve and leaks stagnant water.', 'public', 'in_progress', 'm-rehman', 'Spare gasket ordered from Mithi; repair scheduled this Friday.', '2026-11-11T08:00:00.000Z'),
        ('iss-2', 'pabohar', 'm-fatima', 'Fatima Meghwar', 'Northern courtyard access pole', 'Connectivity', 'Signal drops inside northern courtyard during evening peak hours.', 'public', 'open', 'm-tariq', NULL, '2026-11-14T15:00:00.000Z'),
        ('iss-3', 'pabohar', 'm-hira', 'Hira Thakur', 'Western lane household #18', 'Dispute / Sensitive', 'Confidential concern regarding shared line dispute.', 'executive_only', 'open', 'm-fatima', NULL, '2026-11-15T10:00:00.000Z')`
    )
    .run();

  // Public Questions (including 1 overdue past deadline)
  commDb
    .prepare(
      `INSERT INTO comm_question (id, society_id, project_id, asked_by_member_id, asked_by_name, question_text, assigned_to_member_id, assigned_to_name, deadline_at, answer_text, answered_by_name, answered_at, created_at)
       VALUES ('q-1', 'pabohar', 'prj-girls-literacy', 'm-ali', 'Ali Bheel', 'Will the 3 tablets in the Girls Digital Literacy Room also be usable for evening Sindhi reading classes?', 'm-amina', 'Amina Junejo', '2026-11-18T23:59:59.000Z', 'Yes — morning sessions are for school-age girls and late afternoon sessions are open for adult women literacy.', 'Amina Junejo', '2026-11-14T12:00:00.000Z', '2026-11-13T09:00:00.000Z')`
    )
    .run();

  commDb
    .prepare(
      `INSERT INTO comm_question (id, society_id, project_id, asked_by_member_id, asked_by_name, question_text, assigned_to_member_id, assigned_to_name, deadline_at, created_at)
       VALUES ('q-2', 'pabohar', 'prj-solar-water', 'm-saeed', 'Saeed Memon', 'Who will hold the replacement filter cartridges key once the school courtyard solar pump starts?', 'm-rehman', 'Rehman Samoon', '2026-11-13T23:59:59.000Z', '2026-11-09T11:00:00.000Z')`
    )
    .run();

  // Multilingual Notices
  commDb
    .prepare(
      `INSERT INTO comm_notice (id, society_id, category, current_version, status, critical_sms, created_by, created_at)
       VALUES ('ntc-1', 'pabohar', 'Election Notice', 1, 'published', 1, 'm-fatima', '2026-11-12T08:00:00.000Z')`
    )
    .run();

  commDb
    .prepare(
      `INSERT INTO comm_notice_version (id, society_id, notice_id, version, title_en, title_sd, title_ur, body_en, body_sd, body_ur, published_by, published_at)
       VALUES (
         'ntcv-1', 'pabohar', 'ntc-1', 1,
         'Voting Open: Woman/Man Co-President Contests & Girls Digital Literacy Room',
         'ووٽنگ کليل آهي: شريڪ صدر چونڊ ۽ ڇوڪرين جو ڊجيٽل روم',
         'ووٹنگ کھلی ہے: شریک صدور مقابلہ اور لڑکیوں کا ڈیجیٹل روم',
         'Verified adult women vote in the Woman Co-President contest and verified adult men vote in the Man Co-President contest. Everyone votes in the equal-weight Girls Digital Literacy project vote.',
         'تصديق ٿيل عورتون عورت شريڪ صدر ۽ مرد مرد شريڪ صدر جي مقابلي ۾ ووٽ ڏيندا. منصوبي جي ووٽ ۾ سڀ حصو وٺي سگهن ٿا.',
         'تصدیق شدہ خواتین خاتون شریک صدر اور مرد حضرات مرد شریک صدر کے مقابلے میں ووٹ ڈالیں گے۔ منصوبے کے ووٹ میں سب شریک ہو سکتے ہیں۔',
         'm-fatima', '2026-11-12T08:00:00.000Z'
       )`
    )
    .run();

  commDb
    .prepare(
      `INSERT INTO comm_notice (id, society_id, category, current_version, status, critical_sms, created_by, created_at)
       VALUES ('ntc-2', 'pabohar', 'Financial Update', 1, 'published', 0, 'm-sajjad', '2026-11-10T10:00:00.000Z')`
    )
    .run();

  commDb
    .prepare(
      `INSERT INTO comm_notice_version (id, society_id, notice_id, version, title_en, title_sd, title_ur, body_en, body_sd, body_ur, published_by, published_at)
       VALUES (
         'ntcv-2', 'pabohar', 'ntc-2', 1,
         'October 2026 Village Fund Public Statement Published',
         'آڪٽوبر 2026 وليج فنڊ جو عوامي حساب جاري',
         'اکتوبر 2026 ولیج فنڈ کا عوامی گوشوارہ شائع',
         'All four October weekly levy transfers from VilloThar have been verified against the Sindh Bank statement and published on the Public Ledger.',
         'آڪٽوبر جا چارئي هفتيوار ليوي ٽرانسفر بينڪ اسٽيٽمينٽ سان ملائي عوامي کاتي ۾ شايع ڪيا ويا آهن.',
         'اکتوبر کے چاروں ہفتہ وار لیوی ٹرانسفر بینک اسٹیٹمنٹ سے تصدیق کے بعد عوامی لیجر میں شائع کر دیے گئے ہیں۔',
         'm-sajjad', '2026-11-10T10:00:00.000Z'
       )`
    )
    .run();

  // Media Library
  const media = [
    [
      'med-1', 'Governance Rules',
      'Why Three Money Streams Never Mix', 'ٽي مالي کاتا الڳ ڇو آهن', 'تین مالی کھاتے الگ کیوں ہیں',
      'Plain guide explaining the separation between Village Fund (Rs. 50 levy), Infrastructure Contributors, and VilloThar Operations.',
      'وليج فنڊ، سيڙپڪار کاتي ۽ ولوٿر آپريشنز جي الڳ الڳ حسابن جي آسان سنڌي وضاحت.',
      'ولیج فنڈ، کنٹری بیوٹر لیجر اور ولوتھر آپریشنز کے الگ الگ حسابات کی آسان اردو وضاحت۔',
      95, 1850, 290, null,
    ],
    [
      'med-2', 'Vote-Points Trial',
      'How Vote-Points Work & How Ballot Units Protect Privacy', 'ووٽ پوائنٽس ۽ خفيه پرچين بابت وضاحت', 'ووٹ پوائنٹس اور خفیہ بیلٹ یونٹس کی وضاحت',
      'Explains how your verified points equal identical sealed ballot units with zero link to your name, household, or time of vote.',
      'وضاحت ته توهان جا ووٽ پوائنٽس بنا نالي جي خفيه پرچين ۾ تبديل ٿين ٿا.',
      'وضاحت کہ آپ کے ووٹ پوائنٹس بغیر نام یا شناخت کے خفیہ یونٹس میں کیسے تبدیل ہوتے ہیں۔',
      115, 2050, 310, 'elec-copres-2026',
    ],
    [
      'med-3', 'Presidency Book',
      'Cosiety Presidency Book Audio Summary', 'ڪوسائٽي صدارتي ڪتاب جو آڊيو خلاصو', 'کوسائٹی صدارتی کتاب کا آڈیو خلاصہ',
      'Mandatory reading summary on equal village governance, cross-team checking, and household rules for Co-President candidates.',
      'شريڪ صدر اميدوارن لاءِ صدارتي ڪتاب جو لازمي آڊيو خلاصو.',
      'شریک صدر امیدواروں کے لیے صدارتی کتاب کا لازمی آڈیو خلاصہ۔',
      130, 2240, 350, null,
    ],
  ] as const;

  for (const [id, cat, tEn, tSd, tUr, sEn, sSd, sUr, dur, kbV, kbA, rel] of media) {
    commDb
      .prepare(
        `INSERT INTO comm_media_asset (
          id, society_id, category, title_en, title_sd, title_ur,
          summary_en, summary_sd, summary_ur, duration_sec, size_kb_360p, size_kb_audio, related_id, created_at
        ) VALUES (?, 'pabohar', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-11-12T08:00:00.000Z')`
      )
      .run(id, cat, tEn, tSd, tUr, sEn, sSd, sUr, dur, kbV, kbA, rel);
  }

  // Monthly Public Report
  auditDb
    .prepare(
      `INSERT INTO monthly_report (
        id, society_id, month_label, vf_opening_pkr, vf_in_pkr, vf_out_pkr, vf_closing_pkr,
        cl_capital_pkr, cl_returns_paid_pkr, ops_reported_revenue_pkr, unreconciled_notes,
        status, prepared_by, approved_by, published_by, published_at
      ) VALUES (
        'mr-2026-10', 'pabohar', '2026-10', 0, 85500, 13500, 72000,
        ?, 0, 1904000, 'None — all October weekly transfers confirmed against Sindh Bank statement.',
        'published', 'm-bilawal', 'm-parveen', 'm-fatima', '2026-11-04T16:00:00.000Z'
      )`
    )
    .run(totalClCapital);

  // Sample SMS Sandbox notification
  coreDb
    .prepare(
      `INSERT INTO sms_sandbox (id, society_id, mobile_e164, message, category, created_at)
       VALUES ('sms-seed-1', 'pabohar', '+923001110001', '[Cosiety Pabohar] Co-President trial contests and Girls Digital Literacy project vote are open!', 'notice', '2026-11-12T08:05:00.000Z')`
    )
    .run();
}
