import express from 'express';
import { z } from 'zod';
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
  decryptField,
  encryptField,
  generateOtp,
  hashPin,
  maskCnic,
  newId,
  normalizeCnic,
} from './crypto.ts';
import { appendAuditEvent, verifyAuditChain } from './auditService.ts';
import { getClAggregateSummary, getVfSummary, postClEntry, postVfEntry } from './financeService.ts';
import {
  attachContext,
  computeAge,
  getMemberRoles,
  getMemberTeamSide,
  isVerifiedAdultVoter,
  requireAuth,
  requireRole,
  type AuthedRequest,
} from './authMiddleware.ts';
import { provisionSocietySkeleton } from './seed.ts';
import {
  checkElectionOpeningGate,
  getActiveFormula,
  recalculateMemberPoints,
} from './pointsService.ts';

export const apiRouter = express.Router();
apiRouter.use(attachContext);

const CO_PRESIDENTS_AND_TEAM = ['woman_co_president', 'man_co_president', 'treasurer', 'team_member', 'portal_admin'];
const CO_PRESIDENTS_OR_ADMIN = ['woman_co_president', 'man_co_president', 'portal_admin'];
const FINANCE_APPROVERS = ['woman_co_president', 'man_co_president', 'treasurer', 'portal_admin'];

function getRuleValue<T>(societyId: string, key: string, fallback: T): T {
  const row = govDb
    .prepare('SELECT value_json FROM gov_rule WHERE society_id = ? AND rule_key = ?')
    .get(societyId, key) as { value_json: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return fallback;
  }
}

function sendSms(societyId: string, mobile: string, message: string, category: string): void {
  coreDb
    .prepare(
      'INSERT INTO sms_sandbox (id, society_id, mobile_e164, message, category, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(newId('sms'), societyId, mobile, message, category, new Date().toISOString());
}

function issueOtp(societyId: string, mobile: string, purpose: string): string {
  const code = generateOtp();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
  coreDb
    .prepare(
      `INSERT INTO otp_code (id, society_id, mobile_e164, purpose, code, attempts, max_attempts, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, 0, 5, ?, ?)`
    )
    .run(newId('otp'), societyId, mobile, purpose, code, expiresAt, now.toISOString());
  sendSms(societyId, mobile, `[Cosiety] Your verification code for ${purpose} is ${code} (valid 5 min).`, 'otp');
  return code;
}

function verifyOtpCode(societyId: string, mobile: string, purpose: string, code: string): { ok: boolean; error?: string } {
  const row = coreDb
    .prepare(
      `SELECT id, code, attempts, max_attempts, expires_at, consumed_at
       FROM otp_code WHERE society_id = ? AND mobile_e164 = ? AND purpose = ?
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(societyId, mobile, purpose) as
    | { id: string; code: string; attempts: number; max_attempts: number; expires_at: string; consumed_at: string | null }
    | undefined;

  if (!row || row.consumed_at) {
    return { ok: false, error: 'No active OTP found. Please request a new code.' };
  }
  if (row.expires_at < new Date().toISOString()) {
    return { ok: false, error: 'OTP expired (5-minute window elapsed).' };
  }
  if (row.attempts >= row.max_attempts) {
    return { ok: false, error: 'Maximum OTP attempts (5) exceeded. Code invalidated.' };
  }
  if (row.code !== code.trim()) {
    coreDb.prepare('UPDATE otp_code SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    return { ok: false, error: 'Incorrect OTP code.' };
  }
  coreDb.prepare('UPDATE otp_code SET consumed_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
  return { ok: true };
}

function isGenderEligibleForRule(gender: string, rule: string): boolean {
  if (rule === 'any') return true;
  if (rule === 'woman') return gender === 'female';
  if (rule === 'man') return gender === 'male';
  return false;
}

// ============================================================================
// 1. BOOTSTRAP & MULTI-VILLAGE SOCIETY REGISTRY (AC-AUTH-04 zero PII leak!)
// ============================================================================
apiRouter.get('/bootstrap', (req, res) => {
  const areq = req as AuthedRequest;
  const sid = areq.societyId;

  const societies = coreDb
    .prepare('SELECT id, slug, name_en, name_sd, name_ur, district, province, registration_no, status, created_at FROM society ORDER BY created_at ASC')
    .all();

  const activeSociety = coreDb
    .prepare('SELECT id, slug, name_en, name_sd, name_ur, district, province, registration_no, status, created_at FROM society WHERE id = ?')
    .get(sid);

  const households = coreDb
    .prepare('SELECT id, name FROM household WHERE society_id = ? ORDER BY name ASC')
    .all(sid);

  const minAge = getRuleValue<number>(sid, 'eligibility.min_voting_age', 18);
  const allMembers = coreDb
    .prepare(
      `SELECT id, household_id, full_name, gender, date_of_birth, status, identity_status, voting_suspended_until
       FROM member WHERE society_id = ?`
    )
    .all(sid) as Array<{
    id: string;
    household_id: string;
    full_name: string;
    gender: string;
    date_of_birth: string;
    status: string;
    identity_status: string;
    voting_suspended_until: string | null;
  }>;

  const verifiedVoters = allMembers.filter(
    (m) =>
      m.status === 'active' &&
      m.identity_status === 'approved' &&
      (!m.voting_suspended_until || m.voting_suspended_until <= new Date().toISOString()) &&
      computeAge(m.date_of_birth) >= minAge
  );

  // AC-AUTH-04: Public personas omit CNIC, DOB, gender, phone, and private vote-points
  const personas = allMembers.map((m) => ({
    id: m.id,
    fullName: m.full_name,
    status: m.status,
    identityStatus: m.identity_status,
    roles: getMemberRoles(sid, m.id),
    teamSide: getMemberTeamSide(sid, m.id),
    isVerifiedVoter: verifiedVoters.some((v) => v.id === m.id),
  }));

  const pendingPointsRow = ptsDb
    .prepare('SELECT COUNT(DISTINCT member_id) AS cnt FROM pts_member_points WHERE society_id = ? AND (points_pending = 1 OR has_undecided_factor = 1)')
    .get(sid) as { cnt: number };

  const activeFormula = getActiveFormula(sid);

  const stats = {
    totalMembers: allMembers.length,
    verifiedVoters: verifiedVoters.length,
    womenVoters: verifiedVoters.filter((v) => v.gender === 'female').length,
    menVoters: verifiedVoters.filter((v) => v.gender === 'male').length,
    pendingVerifications: allMembers.filter((m) => m.status === 'applicant').length,
    householdsCount: households.length,
    pendingPointsCount: pendingPointsRow.cnt,
    formulaVersion: activeFormula?.version ?? 'v1.0-draft',
    formulaStatus: activeFormula?.status ?? 'draft',
  };

  let sessionUserPayload = null;
  if (areq.authMember) {
    const authPts =
      areq.authMember.society_id === sid
        ? recalculateMemberPoints(sid, areq.authMember.id, activeFormula?.age_basis ?? 'snapshot')
        : null;
    sessionUserPayload = {
      id: areq.authMember.id,
      societyId: areq.authMember.society_id,
      fullName: areq.authMember.full_name,
      householdId: areq.authMember.household_id,
      status: areq.authMember.status,
      identityStatus: areq.authMember.identity_status,
      roles: areq.authMember.roles,
      teamSide: areq.authMember.team_side,
      isVerifiedVoter:
        areq.authMember.society_id === sid && isVerifiedAdultVoter(areq.authMember, minAge),
      pointsSummary: authPts,
    };
  }

  res.json({
    activeSociety,
    societies,
    households,
    stats,
    personas,
    sessionUser: sessionUserPayload,
  });
});

apiRouter.get('/societies', (_req, res) => {
  const societies = coreDb
    .prepare('SELECT id, slug, name_en, name_sd, name_ur, district, province, registration_no, status, created_at FROM society ORDER BY created_at ASC')
    .all() as Array<{ id: string; slug: string; name_en: string; name_sd: string; name_ur: string; district: string; province: string; registration_no: string; status: string; created_at: string }>;

  const enriched = societies.map((s) => {
    const countRow = coreDb
      .prepare("SELECT COUNT(*) AS cnt FROM member WHERE society_id = ? AND status = 'active'")
      .get(s.id) as { cnt: number };
    const vf = getVfSummary(s.id);
    return {
      ...s,
      activeMembers: countRow.cnt,
      vfBalancePkr: vf.bankBalancePkr,
      activeLevyPkr: vf.activeLevyPkr,
    };
  });
  res.json({ societies: enriched });
});

apiRouter.post('/societies', (req, res) => {
  const schema = z.object({
    nameEn: z.string().min(2).max(80),
    nameSd: z.string().min(1).max(80).optional(),
    nameUr: z.string().min(1).max(80).optional(),
    district: z.string().min(2).max(60),
    province: z.string().min(2).max(60).default('Sindh'),
    levyAmountPkr: z.number().int().min(0).max(500).default(50),
    levyCapPkr: z.number().int().min(10).max(500).default(100),
    termLengthMonths: z.number().int().min(6).max(48).default(12),
    foundingAdminName: z.string().min(2).max(80).default('Founding Portal Admin'),
    foundingAdminMobile: z.string().min(7).max(20).default('+923009990001'),
    foundingAdminCnic: z.string().min(13).max(16).default('4430199999991'),
    foundingAdminGender: z.enum(['female', 'male']).default('female'),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'INVALID_INPUT', title: parsed.error.issues[0]?.message || 'Invalid input' });
    return;
  }

  const d = parsed.data;
  const slug = d.nameEn
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const existing = coreDb.prepare('SELECT id FROM society WHERE id = ? OR slug = ?').get(slug, slug);
  const id = existing ? `${slug}-${Date.now().toString(36).slice(-4)}` : slug;

  provisionSocietySkeleton({
    id,
    slug: id,
    nameEn: d.nameEn.trim(),
    nameSd: (d.nameSd || d.nameEn).trim(),
    nameUr: (d.nameUr || d.nameEn).trim(),
    district: d.district.trim(),
    province: d.province.trim(),
    actorId: (req as AuthedRequest).authMember?.id || 'system-onboarding',
    levyAmountPkr: d.levyAmountPkr,
    levyCapPkr: Math.max(d.levyCapPkr, d.levyAmountPkr),
    termLengthMonths: d.termLengthMonths,
  });

  const hhId = `${id}-hh-1`;
  coreDb
    .prepare('INSERT INTO household (id, society_id, name, created_at) VALUES (?, ?, ?, ?)')
    .run(hhId, id, `${d.foundingAdminName.split(' ')[0]} Household`, new Date().toISOString());

  const adminId = `${id}-m-admin`;
  const cnicNorm = normalizeCnic(d.foundingAdminCnic).padEnd(13, '1').slice(0, 13);
  coreDb
    .prepare(
      `INSERT INTO member (
        id, society_id, household_id, full_name, gender, date_of_birth,
        mobile_e164, cnic_enc, cnic_hmac, cnic_masked, status, identity_status,
        public_directory_consent, consent_version, preferred_lang, pin_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, '1988-01-01', ?, ?, ?, ?, 'active', 'approved', 1, '2026-11', 'en', ?, ?)`
    )
    .run(
      adminId,
      id,
      hhId,
      d.foundingAdminName,
      d.foundingAdminGender,
      d.foundingAdminMobile,
      encryptField(cnicNorm),
      cnicHmac(cnicNorm),
      maskCnic(cnicNorm),
      hashPin('1234'),
      new Date().toISOString()
    );

  const nowIso = new Date().toISOString();
  const futureIso = '2028-11-01T00:00:00.000Z';
  for (const rc of ['portal_admin', 'verification_officer', 'election_admin']) {
    coreDb
      .prepare(
        `INSERT INTO role_assignment (id, society_id, member_id, role_code, scope_type, valid_from, valid_to, source, created_at)
         VALUES (?, ?, ?, ?, 'society', ?, ?, 'appointment', ?)`
      )
      .run(newId('rol'), id, adminId, rc, nowIso, futureIso, nowIso);
  }
  for (const [f, k] of [
    ['education', 'bachelor_plus'],
    ['work', 'govt_job'],
    ['exposure', 'big_city'],
  ] as const) {
    ptsDb
      .prepare(
        `INSERT INTO pts_member_factor (id, society_id, member_id, factor, item_key, status, verified_by, verified_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'approved', 'system-onboarding', ?, ?)`
      )
      .run(newId('pmf'), id, adminId, f, k, nowIso, nowIso);
  }
  recalculateMemberPoints(id, adminId, 'snapshot');

  const society = coreDb.prepare('SELECT * FROM society WHERE id = ?').get(id);
  res.status(201).json({ society, societyId: id });
});

// ============================================================================
// 2. AUTHENTICATION, SMS SANDBOX & VERIFICATION (AUTH / MEM)
// ============================================================================
apiRouter.get('/sms-sandbox', (req, res) => {
  const sid = (req as AuthedRequest).societyId;
  const rows = coreDb
    .prepare('SELECT id, mobile_e164, message, category, created_at FROM sms_sandbox WHERE society_id = ? ORDER BY created_at DESC LIMIT 40')
    .all(sid);
  res.json({ messages: rows });
});

apiRouter.post('/auth/otp/request', (req, res) => {
  const sid = (req as AuthedRequest).societyId;
  const { mobile, purpose } = req.body as { mobile?: string; purpose?: string };
  if (!mobile || !purpose) {
    res.status(400).json({ code: 'INVALID_INPUT', title: 'Mobile number and purpose are required.' });
    return;
  }
  const code = issueOtp(sid, mobile.trim(), purpose);
  res.json({ sent: true, demoCode: code, expiresInSeconds: 300 });
});

apiRouter.post('/auth/otp/verify', (req, res) => {
  const sid = (req as AuthedRequest).societyId;
  const { mobile, purpose, code } = req.body as { mobile?: string; purpose?: string; code?: string };
  if (!mobile || !purpose || !code) {
    res.status(400).json({ code: 'INVALID_INPUT', title: 'Mobile, purpose, and 6-digit OTP code are required.' });
    return;
  }
  const check = verifyOtpCode(sid, mobile.trim(), purpose, code);
  if (!check.ok) {
    res.status(400).json({ code: 'OTP_INVALID', title: check.error });
    return;
  }

  if (purpose === 'login') {
    const member = coreDb
      .prepare('SELECT id, society_id, full_name FROM member WHERE society_id = ? AND mobile_e164 = ? LIMIT 1')
      .get(sid, mobile.trim()) as { id: string; society_id: string; full_name: string } | undefined;
    if (!member) {
      res.status(404).json({ code: 'MEMBER_NOT_FOUND', title: 'No member with this mobile number in this village society.' });
      return;
    }
    const token = newId('sess');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    coreDb
      .prepare('INSERT INTO session_token (token, society_id, member_id, device_label, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(token, sid, member.id, 'mobile-otp', expiresAt, new Date().toISOString());
    res.json({ verified: true, token, memberId: member.id });
    return;
  }

  res.json({ verified: true });
});

apiRouter.post('/auth/request-vote-otp', (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const { memberId } = req.body as { memberId?: string };
  const targetId = memberId || actor.id;

  if (targetId !== actor.id && !actor.roles.includes('village_helper')) {
    res.status(403).json({
      code: 'HELPER_ROLE_REQUIRED',
      title: 'Only a designated Village Helper can request step-up OTP for another villager in kiosk mode.',
    });
    return;
  }

  const target = coreDb
    .prepare('SELECT id, mobile_e164 FROM member WHERE id = ? AND society_id = ?')
    .get(targetId, sid) as { id: string; mobile_e164: string } | undefined;

  if (!target) {
    res.status(404).json({ code: 'VOTER_NOT_FOUND', title: 'Member not found in this society.' });
    return;
  }

  const code = issueOtp(sid, target.mobile_e164, 'vote_stepup');
  const m = target.mobile_e164;
  const mobileMasked = m.length > 6 ? `${m.slice(0, 4)}••••${m.slice(-3)}` : '••••';
  res.json({ sent: true, demoCode: code, mobileMasked, expiresInSeconds: 300 });
});

apiRouter.post('/auth/demo-switch', (req, res) => {
  const sid = (req as AuthedRequest).societyId;
  const { memberId } = req.body as { memberId?: string };
  if (!memberId) {
    res.status(400).json({ code: 'INVALID_INPUT', title: 'memberId is required' });
    return;
  }
  const member = coreDb
    .prepare('SELECT id, full_name FROM member WHERE id = ? AND society_id = ?')
    .get(memberId, sid) as { id: string; full_name: string } | undefined;
  if (!member) {
    res.status(404).json({ code: 'MEMBER_NOT_FOUND', title: 'Member not found in this village society.' });
    return;
  }
  const token = newId('sess');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  coreDb
    .prepare('INSERT INTO session_token (token, society_id, member_id, device_label, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(token, sid, member.id, 'role-switcher', expiresAt, new Date().toISOString());

  appendAuditEvent({
    societyId: sid,
    actorId: member.id,
    action: 'auth.session_started',
    entityType: 'member',
    entityId: member.id,
    after: { channel: 'role_switcher' },
  });

  res.json({ token, memberId: member.id });
});

apiRouter.post('/auth/logout', (req, res) => {
  const token = req.header('x-session-token');
  if (token) {
    coreDb.prepare('DELETE FROM session_token WHERE token = ?').run(token);
  }
  res.json({ ok: true });
});

apiRouter.get('/members', (req, res) => {
  const areq = req as AuthedRequest;
  const sid = areq.societyId;
  const auth = areq.authMember;
  const roles = auth?.society_id === sid ? auth.roles : [];
  const isOfficerOrAuditor = roles.some((r) =>
    ['verification_officer', 'portal_admin', 'auditor', 'woman_co_president', 'man_co_president', 'village_helper'].includes(r)
  );
  const canViewPoints = roles.some((r) => ['verification_officer', 'auditor'].includes(r));

  const households = coreDb.prepare('SELECT id, name FROM household WHERE society_id = ?').all(sid) as Array<{ id: string; name: string }>;
  const hhMap = new Map(households.map((h) => [h.id, h.name]));

  const rows = coreDb
    .prepare(
      `SELECT id, household_id, full_name, status, identity_status, cnic_masked,
              voting_suspended_until, suspension_reason, public_directory_consent, created_at
       FROM member WHERE society_id = ? ORDER BY created_at DESC, full_name ASC`
    )
    .all(sid) as Array<{
    id: string;
    household_id: string;
    full_name: string;
    status: string;
    identity_status: string;
    cnic_masked: string;
    voting_suspended_until: string | null;
    suspension_reason: string | null;
    public_directory_consent: number;
    created_at: string;
  }>;

  // AC-AUTH-04: Public/non-officer never sees CNIC, DOB, gender, phone, or private vote-points!
  if (!isOfficerOrAuditor) {
    const publicList = rows
      .filter((m) => m.status === 'active' && m.public_directory_consent === 1)
      .map((m) => ({
        id: m.id,
        full_name: m.full_name,
        household_id: m.household_id,
        household_name: hhMap.get(m.household_id) || 'Household',
        status: m.status,
        roles: getMemberRoles(sid, m.id),
        teamSide: getMemberTeamSide(sid, m.id),
      }));
    res.json({ members: publicList, publicDirectoryOnly: true });
    return;
  }

  const enriched = rows.map((m) => {
    const steps = coreDb
      .prepare(
        `SELECT step, actor_member_id, note, created_at FROM membership_verification
         WHERE society_id = ? AND member_id = ? ORDER BY created_at ASC`
      )
      .all(sid, m.id) as Array<{ step: string; actor_member_id: string; note: string; created_at: string }>;

    const factors = ptsDb
      .prepare('SELECT factor, item_key, status, verified_by, note FROM pts_member_factor WHERE society_id = ? AND member_id = ?')
      .all(sid, m.id) as Array<{ factor: string; item_key: string; status: string; verified_by: string | null; note: string | null }>;

    const ptsRow = ptsDb
      .prepare('SELECT total_pts, points_pending, has_undecided_factor, undecided_note FROM pts_member_points WHERE society_id = ? AND member_id = ? ORDER BY computed_at DESC LIMIT 1')
      .get(sid, m.id) as { total_pts: number; points_pending: number; has_undecided_factor: number; undecided_note: string | null } | undefined;

    return {
      id: m.id,
      full_name: m.full_name,
      household_id: m.household_id,
      household_name: hhMap.get(m.household_id) || 'Household',
      status: m.status,
      identity_status: m.identity_status,
      cnic_masked: roles.includes('verification_officer') || roles.includes('portal_admin') ? m.cnic_masked : undefined,
      voting_suspended_until: m.voting_suspended_until,
      suspension_reason: m.suspension_reason,
      roles: getMemberRoles(sid, m.id),
      teamSide: getMemberTeamSide(sid, m.id),
      verificationSteps: steps,
      factors,
      pointsTotal: canViewPoints || auth?.id === m.id ? (ptsRow?.total_pts ?? 0) : null,
      pointsPending: Boolean(ptsRow?.points_pending),
      hasUndecidedFactor: Boolean(ptsRow?.has_undecided_factor),
      undecidedNote: ptsRow?.undecided_note ?? null,
    };
  });

  res.json({ members: enriched, publicDirectoryOnly: false });
});

apiRouter.post('/members', (req, res) => {
  const sid = (req as AuthedRequest).societyId;
  const schema = z.object({
    fullName: z.string().min(2).max(100),
    gender: z.enum(['female', 'male', 'other']),
    dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    mobile: z.string().min(7).max(20),
    cnic: z.string().min(13).max(18),
    householdId: z.string().optional(),
    newHouseholdName: z.string().optional(),
    preferredLang: z.enum(['en', 'sd', 'ur']).default('en'),
    educationKey: z.enum(['bachelor_plus', 'intermediate', 'matric', 'class_1_5', 'no_schooling']).default('matric'),
    workKey: z.enum(['senior_professional', 'govt_job', 'private_or_self_employed', 'farmer_artisan', 'unemployed_homemaker']).default('farmer_artisan'),
    exposureKey: z.enum(['national_intl', 'big_city', 'district_town', 'no_exposure']).default('district_town'),
    docLabel: z.string().max(120).optional(),
    consent: z.boolean().default(true),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'INVALID_INPUT', title: parsed.error.issues[0]?.message || 'Invalid registration data' });
    return;
  }

  const d = parsed.data;
  const digits = normalizeCnic(d.cnic);
  if (digits.length !== 13) {
    res.status(400).json({ code: 'INVALID_CNIC', title: 'CNIC must contain exactly 13 digits.' });
    return;
  }

  const minAge = getRuleValue<number>(sid, 'eligibility.min_voting_age', 18);
  if (computeAge(d.dateOfBirth) < minAge) {
    res.status(422).json({ code: 'AGE_INELIGIBLE', title: `Minimum voting membership age is ${minAge} years.` });
    return;
  }

  // AC-AUTH-01: Duplicate CNIC MUST return neutral 202 response without leaking prior registration!
  const hmac = cnicHmac(digits);
  const existing = coreDb
    .prepare("SELECT id FROM member WHERE society_id = ? AND cnic_hmac = ? AND status != 'deactivated'")
    .get(sid, hmac);

  if (existing) {
    appendAuditEvent({
      societyId: sid,
      actorId: 'registration-portal',
      action: 'member.duplicate_cnic_held',
      entityType: 'member',
      entityId: 'masked',
      after: { status: 'under_review' },
    });
    res.status(202).json({
      status: 'under_review',
      message: 'Application received and placed under verification review.',
    });
    return;
  }

  let hhId = d.householdId;
  if (!hhId || hhId === '__new__') {
    hhId = newId('hh');
    const hhName = d.newHouseholdName?.trim() || `${d.fullName.split(' ')[0]} Household`;
    coreDb
      .prepare('INSERT INTO household (id, society_id, name, created_at) VALUES (?, ?, ?, ?)')
      .run(hhId, sid, hhName, new Date().toISOString());
  }

  const mId = newId('mem');
  const now = new Date().toISOString();
  const retainDays = getRuleValue<number>(sid, 'privacy.id_image_retention_days', 90);
  const retainUntil = new Date(Date.now() + retainDays * 24 * 60 * 60 * 1000).toISOString();

  coreDb
    .prepare(
      `INSERT INTO member (
        id, society_id, household_id, full_name, gender, date_of_birth,
        mobile_e164, cnic_enc, cnic_hmac, cnic_masked, status, identity_status,
        public_directory_consent, consent_version, preferred_lang, pin_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'applicant', 'otp_confirmed', ?, '2026-11', ?, ?, ?)`
    )
    .run(
      mId,
      sid,
      hhId,
      d.fullName.trim(),
      d.gender,
      d.dateOfBirth,
      d.mobile.trim(),
      encryptField(digits),
      hmac,
      maskCnic(digits),
      d.consent ? 1 : 0,
      d.preferredLang,
      hashPin('1234'),
      now
    );

  coreDb
    .prepare(
      `INSERT INTO membership_verification (id, society_id, member_id, step, actor_member_id, note, created_at)
       VALUES (?, ?, ?, 'otp_confirmed', ?, 'Registered via portal with mobile OTP', ?)`
    )
    .run(newId('ver'), sid, mId, mId, now);

  // Store supporting documents & submitted Vote-Points factors (AC-PTS-04: pending verification = 0 pts!)
  const factorPairs: Array<['education' | 'work' | 'exposure', string]> = [
    ['education', d.educationKey],
    ['work', d.workKey],
    ['exposure', d.exposureKey],
  ];

  coreDb
    .prepare(
      `INSERT INTO member_document (id, society_id, member_id, factor, doc_label, retention_until, created_at)
       VALUES (?, ?, ?, 'cnic', ?, ?, ?)`
    )
    .run(newId('doc'), sid, mId, d.docLabel?.trim() || 'Original CNIC scan', retainUntil, now);

  for (const [factor, itemKey] of factorPairs) {
    const docId = newId('doc');
    coreDb
      .prepare(
        `INSERT INTO member_document (id, society_id, member_id, factor, doc_label, retention_until, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(docId, sid, mId, factor, `${factor} proof (${itemKey})`, retainUntil, now);

    ptsDb
      .prepare(
        `INSERT INTO pts_member_factor (id, society_id, member_id, factor, item_key, document_id, status, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'submitted', 'Pending Verification Officer check', ?)`
      )
      .run(newId('pmf'), sid, mId, factor, itemKey, docId, now);
  }

  const formula = getActiveFormula(sid);
  recalculateMemberPoints(sid, mId, formula?.age_basis ?? 'snapshot');

  sendSms(
    sid,
    d.mobile.trim(),
    `[Cosiety] Welcome ${d.fullName.trim()}! Your application is waiting for Verification Officer document check.`,
    'membership'
  );

  appendAuditEvent({
    societyId: sid,
    actorId: mId,
    action: 'member.applied',
    entityType: 'member',
    entityId: mId,
    after: { status: 'applicant', identityStatus: 'otp_confirmed', pointsPending: true },
  });

  res.status(201).json({
    id: mId,
    status: 'applicant',
    identityStatus: 'otp_confirmed',
    message: 'Application submitted. Awaiting Verification Officer check and second approver.',
  });
});

function handleDocumentsCheck(req: express.Request, res: express.Response) {
  const actor = requireRole(req, res, ['verification_officer']);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const targetId = String(req.params.id);

  if (actor.id === targetId) {
    res.status(409).json({ code: 'SELF_CHECK_FORBIDDEN', title: 'Verification Officer cannot verify their own documents.' });
    return;
  }

  // R-6 / FR-PTS-05: Verification Officer who is an active candidate in an open/nomination contest cannot verify eligibility/points for that cycle
  const officerCandidate = voteDb
    .prepare(
      `SELECT c.id FROM candidate c JOIN election e ON e.id = c.election_id
       WHERE c.society_id = ? AND c.member_id = ? AND e.state IN ('nomination', 'ready', 'open') AND c.status != 'withdrawn'`
    )
    .get(sid, actor.id);
  if (officerCandidate) {
    res.status(409).json({
      code: 'OFFICER_CANDIDATE_CONFLICT',
      title: 'Conflict of interest: a Verification Officer who is an active candidate cannot perform checks during that contest.',
    });
    return;
  }

  const target = coreDb
    .prepare('SELECT id, mobile_e164, full_name, identity_status FROM member WHERE id = ? AND society_id = ?')
    .get(targetId, sid) as { id: string; mobile_e164: string; full_name: string; identity_status: string } | undefined;

  if (!target) {
    res.status(404).json({ code: 'MEMBER_NOT_FOUND', title: 'Member not found.' });
    return;
  }

  const { note, approveFactors = true, factorDecisions } = req.body as {
    note?: string;
    approveFactors?: boolean;
    factorDecisions?: Record<string, 'approved' | 'rejected'>;
  };
  const now = new Date().toISOString();

  coreDb
    .prepare(
      `INSERT INTO membership_verification (id, society_id, member_id, step, actor_member_id, note, created_at)
       VALUES (?, ?, ?, 'documents_checked', ?, ?, ?)`
    )
    .run(newId('ver'), sid, targetId, actor.id, note || 'CNIC and Vote-Points proof documents checked in person', now);

  coreDb.prepare("UPDATE member SET identity_status = 'documents_checked' WHERE id = ? AND society_id = ?").run(targetId, sid);

  for (const factor of ['education', 'work', 'exposure'] as const) {
    const decision = factorDecisions?.[factor] ?? (approveFactors ? 'approved' : 'submitted');
    ptsDb
      .prepare(
        `UPDATE pts_member_factor SET status = ?, verified_by = ?, verified_at = ?, note = ?
         WHERE society_id = ? AND member_id = ? AND factor = ?`
      )
      .run(decision, actor.id, now, note || 'Checked by Verification Officer', sid, targetId, factor);
  }

  const formula = getActiveFormula(sid);
  const pts = recalculateMemberPoints(sid, targetId, formula?.age_basis ?? 'snapshot');

  appendAuditEvent({
    societyId: sid,
    actorId: actor.id,
    action: 'member.documents_checked',
    entityType: 'member',
    entityId: targetId,
    after: { identityStatus: 'documents_checked', pointsTotal: pts?.totalPts ?? 0, pointsPending: pts?.pointsPending ?? false },
  });

  res.json({ ok: true, identityStatus: 'documents_checked', points: pts });
}

apiRouter.post('/verifications/:id/documents-check', handleDocumentsCheck);
apiRouter.post('/verifications/:id/identity-check', handleDocumentsCheck);

apiRouter.post('/verifications/:id/approve', (req, res) => {
  const actor = requireRole(req, res, [...CO_PRESIDENTS_OR_ADMIN, 'verification_officer']);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const targetId = String(req.params.id);

  if (actor.id === targetId) {
    res.status(409).json({ code: 'SELF_APPROVAL_FORBIDDEN', title: 'An applicant cannot approve their own membership.' });
    return;
  }

  const target = coreDb
    .prepare('SELECT id, full_name, mobile_e164, identity_status FROM member WHERE id = ? AND society_id = ?')
    .get(targetId, sid) as { id: string; full_name: string; mobile_e164: string; identity_status: string } | undefined;

  if (!target) {
    res.status(404).json({ code: 'MEMBER_NOT_FOUND', title: 'Applicant not found.' });
    return;
  }
  if (target.identity_status !== 'documents_checked') {
    res.status(409).json({
      code: 'DOCUMENTS_CHECK_REQUIRED',
      title: 'Step 1 (Verification Officer document check) must complete before Step 2 approval.',
    });
    return;
  }

  // AC-AUTH-03: Enforced two-person separation (checker != approver)
  const checkStep = coreDb
    .prepare(
      `SELECT actor_member_id FROM membership_verification
       WHERE society_id = ? AND member_id = ? AND step = 'documents_checked'
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(sid, targetId) as { actor_member_id: string } | undefined;

  if (checkStep && checkStep.actor_member_id === actor.id) {
    res.status(409).json({
      code: 'SEPARATION_OF_DUTIES',
      title: 'AC-AUTH-03: The approver must be a different person from the Verification Officer who checked documents.',
    });
    return;
  }

  const now = new Date().toISOString();
  coreDb
    .prepare("UPDATE member SET status = 'active', identity_status = 'approved' WHERE id = ? AND society_id = ?")
    .run(targetId, sid);
  coreDb
    .prepare(
      `INSERT INTO membership_verification (id, society_id, member_id, step, actor_member_id, note, created_at)
       VALUES (?, ?, ?, 'approved', ?, ?, ?)`
    )
    .run(newId('ver'), sid, targetId, actor.id, (req.body as { note?: string })?.note || 'Second-person approval completed', now);

  const formula = getActiveFormula(sid);
  recalculateMemberPoints(sid, targetId, formula?.age_basis ?? 'snapshot');

  sendSms(
    sid,
    target.mobile_e164,
    `[Cosiety] Congratulations ${target.full_name}! Your cooperative membership is now Active and Verified.`,
    'membership'
  );

  appendAuditEvent({
    societyId: sid,
    actorId: actor.id,
    action: 'member.approved',
    entityType: 'member',
    entityId: targetId,
    before: { identityStatus: 'documents_checked' },
    after: { status: 'active', identityStatus: 'approved', firstChecker: checkStep?.actor_member_id },
  });

  res.json({ ok: true, status: 'active', identityStatus: 'approved' });
});

apiRouter.post('/verifications/:id/reject', (req, res) => {
  const actor = requireRole(req, res, ['verification_officer', 'portal_admin', 'woman_co_president', 'man_co_president']);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const targetId = String(req.params.id);
  const { reason } = req.body as { reason?: string };

  coreDb
    .prepare("UPDATE member SET identity_status = 'rejected', suspension_reason = ? WHERE id = ? AND society_id = ?")
    .run(reason || 'Document mismatch', targetId, sid);

  coreDb
    .prepare(
      `INSERT INTO membership_verification (id, society_id, member_id, step, actor_member_id, note, created_at)
       VALUES (?, ?, ?, 'rejected', ?, ?, ?)`
    )
    .run(newId('ver'), sid, targetId, actor.id, reason || 'Document mismatch', new Date().toISOString());

  appendAuditEvent({
    societyId: sid,
    actorId: actor.id,
    action: 'member.rejected',
    entityType: 'member',
    entityId: targetId,
    reason: reason || 'Document mismatch',
  });

  res.json({ ok: true, identityStatus: 'rejected' });
});

apiRouter.post('/members/:id/break-glass-cnic', (req, res) => {
  const actor = requireRole(req, res, ['verification_officer', 'portal_admin']);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const targetId = String(req.params.id);
  const { coAuthorizerId, reason } = req.body as { coAuthorizerId?: string; reason?: string };

  if (!coAuthorizerId || coAuthorizerId === actor.id || !reason || reason.trim().length < 4) {
    res.status(422).json({
      code: 'DUAL_CONTROL_REQUIRED',
      title: 'NFR-PRV-002: Break-glass CNIC view requires a different co-authorizer and documented reason.',
    });
    return;
  }

  const coAuth = coreDb
    .prepare('SELECT id, full_name FROM member WHERE id = ? AND society_id = ?')
    .get(coAuthorizerId, sid) as { id: string; full_name: string } | undefined;
  if (!coAuth) {
    res.status(404).json({ code: 'CO_AUTHORIZER_NOT_FOUND', title: 'Co-authorizer member not found.' });
    return;
  }

  const target = coreDb
    .prepare('SELECT id, full_name, cnic_enc FROM member WHERE id = ? AND society_id = ?')
    .get(targetId, sid) as { id: string; full_name: string; cnic_enc: string } | undefined;
  if (!target) {
    res.status(404).json({ code: 'MEMBER_NOT_FOUND', title: 'Member not found.' });
    return;
  }

  const cnicDecrypted = decryptField(target.cnic_enc);
  const bgId = newId('bg');
  coreDb
    .prepare(
      `INSERT INTO break_glass_log (id, society_id, target_member_id, requester_id, co_authorizer_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(bgId, sid, targetId, actor.id, coAuthorizerId, reason.trim(), new Date().toISOString());

  appendAuditEvent({
    societyId: sid,
    actorId: actor.id,
    action: 'privacy.break_glass_cnic_viewed',
    entityType: 'member',
    entityId: targetId,
    after: { coAuthorizerId, coAuthorizerName: coAuth.full_name },
    reason: reason.trim(),
  });

  res.json({ fullName: target.full_name, cnicDecrypted });
});

// ============================================================================
// 3. VOTE-POINTS ENGINE (DC-PTS: Public Formula, Private Individual Points, Trial Review)
// ============================================================================
apiRouter.get('/public/points-formula', (req, res) => {
  const sid = (req as AuthedRequest).societyId;
  const formula = getActiveFormula(sid);
  if (!formula) {
    res.status(404).json({ code: 'FORMULA_NOT_FOUND', title: 'No vote-points formula configured.' });
    return;
  }

  const items = ptsDb
    .prepare('SELECT id, factor, item_key, label_en, label_sd, label_ur, min_age, max_age, value_points FROM pts_formula_item WHERE formula_id = ?')
    .all(formula.id);

  const agg = ptsDb
    .prepare(
      `SELECT COUNT(*) AS scored_count,
              COALESCE(AVG(total_pts), 0) AS avg_pts,
              COALESCE(MIN(total_pts), 0) AS min_pts,
              COALESCE(MAX(total_pts), 0) AS max_pts,
              SUM(CASE WHEN has_undecided_factor = 1 THEN 1 ELSE 0 END) AS undecided_count,
              SUM(CASE WHEN points_pending = 1 THEN 1 ELSE 0 END) AS pending_count
       FROM pts_member_points WHERE society_id = ? AND formula_id = ?`
    )
    .get(sid, formula.id) as {
    scored_count: number;
    avg_pts: number;
    min_pts: number;
    max_pts: number;
    undecided_count: number;
    pending_count: number;
  };

  const reviews = ptsDb
    .prepare('SELECT id, period_label, summary_text, decision, reviewed_by, reviewed_at FROM pts_trial_review WHERE society_id = ? ORDER BY reviewed_at DESC')
    .all(sid);

  res.json({
    formula,
    items,
    reviews,
    aggregateStats: {
      scoredMembers: agg.scored_count,
      avgPoints: Math.round((agg.avg_pts || 0) * 10) / 10,
      minPoints: agg.min_pts || 0,
      maxPoints: agg.max_pts || 0,
      undecidedMembersCount: agg.undecided_count || 0,
      pendingMembersCount: agg.pending_count || 0,
    },
  });
});

apiRouter.get('/me/points', (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const sid = (req as AuthedRequest).societyId;
  const formula = getActiveFormula(sid);
  const breakdown = recalculateMemberPoints(sid, auth.id, formula?.age_basis ?? 'snapshot');
  const factors = ptsDb
    .prepare('SELECT factor, item_key, status, verified_by, verified_at, note FROM pts_member_factor WHERE society_id = ? AND member_id = ?')
    .all(sid, auth.id);

  res.json({ breakdown, factors });
});

apiRouter.get('/points/members/:id', (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const sid = (req as AuthedRequest).societyId;
  const targetId = String(req.params.id);
  const canView =
    auth.id === targetId ||
    auth.roles.some((r) => ['verification_officer', 'auditor'].includes(r));

  if (!canView) {
    res.status(403).json({
      code: 'POINTS_PRIVATE',
      title: 'FR-PTS-07: Individual Vote-Points are private to the member, Verification Officer, and Auditor.',
    });
    return;
  }

  const formula = getActiveFormula(sid);
  const breakdown = recalculateMemberPoints(sid, targetId, formula?.age_basis ?? 'snapshot');
  if (!breakdown) {
    res.status(404).json({ code: 'MEMBER_NOT_FOUND', title: 'Member not found.' });
    return;
  }
  const factors = ptsDb
    .prepare('SELECT factor, item_key, status, verified_by, verified_at, note FROM pts_member_factor WHERE society_id = ? AND member_id = ?')
    .all(sid, targetId);

  res.json({ breakdown, factors });
});

apiRouter.post('/points/members/:id/reverify', (req, res) => {
  const actor = requireRole(req, res, ['verification_officer']);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const targetId = String(req.params.id);

  if (actor.id === targetId) {
    res.status(409).json({ code: 'SELF_VERIFY_FORBIDDEN', title: 'Verification Officer cannot verify their own Vote-Points.' });
    return;
  }

  const schema = z.object({
    factor: z.enum(['education', 'work', 'exposure']),
    itemKey: z.string().min(2),
    status: z.enum(['approved', 'rejected']).default('approved'),
    note: z.string().min(3),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'INVALID_INPUT', title: 'Factor, itemKey, and verification note are required.' });
    return;
  }

  const d = parsed.data;
  const now = new Date().toISOString();
  ptsDb
    .prepare(
      `INSERT INTO pts_member_factor (id, society_id, member_id, factor, item_key, status, verified_by, verified_at, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(society_id, member_id, factor) DO UPDATE SET
         item_key = excluded.item_key,
         status = excluded.status,
         verified_by = excluded.verified_by,
         verified_at = excluded.verified_at,
         note = excluded.note`
    )
    .run(newId('pmf'), sid, targetId, d.factor, d.itemKey, d.status, actor.id, now, d.note, now);

  const formula = getActiveFormula(sid);
  const breakdown = recalculateMemberPoints(sid, targetId, formula?.age_basis ?? 'snapshot');

  appendAuditEvent({
    societyId: sid,
    actorId: actor.id,
    action: 'points.factor_reverified',
    entityType: 'pts_member_factor',
    entityId: `${targetId}:${d.factor}`,
    after: { itemKey: d.itemKey, status: d.status, newTotal: breakdown?.totalPts ?? 0 },
    reason: d.note,
  });

  res.json({ ok: true, breakdown });
});

apiRouter.post('/points/formulas', (req, res) => {
  const actor = requireRole(req, res, CO_PRESIDENTS_OR_ADMIN);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;

  const schema = z.object({
    version: z.string().min(2).max(40),
    resolutionCode: z.string().min(2),
    maxPoints: z.number().int().min(4).max(100).default(22),
    ageBasis: z.enum(['registration', 'snapshot']).default('snapshot'),
    itemUpdates: z.array(z.object({
      factor: z.enum(['education', 'age', 'work', 'exposure']),
      itemKey: z.string().min(2),
      valuePoints: z.number().int().min(0).max(20).nullable(),
    })).optional(),
    approveImmediately: z.boolean().default(false),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'INVALID_INPUT', title: parsed.error.issues[0]?.message || 'Invalid formula payload' });
    return;
  }

  const d = parsed.data;
  const current = getActiveFormula(sid);
  if (!current) {
    res.status(404).json({ code: 'FORMULA_NOT_FOUND', title: 'Base formula missing.' });
    return;
  }

  const resRow = govDb
    .prepare('SELECT id FROM resolution WHERE society_id = ? AND code = ?')
    .get(sid, d.resolutionCode) as { id: string } | undefined;
  if (!resRow) {
    res.status(422).json({ code: 'RESOLUTION_REQUIRED', title: `General Body resolution ${d.resolutionCode} not found.` });
    return;
  }

  const dup = ptsDb.prepare('SELECT id FROM pts_formula WHERE society_id = ? AND version = ?').get(sid, d.version);
  if (dup) {
    res.status(409).json({ code: 'VERSION_EXISTS', title: `Formula version ${d.version} already exists.` });
    return;
  }

  const newFormulaId = newId('frm');
  const now = new Date().toISOString();
  const status = d.approveImmediately ? 'approved' : 'draft';
  if (status === 'approved') {
    ptsDb.prepare("UPDATE pts_formula SET status = 'retired' WHERE society_id = ? AND status = 'approved'").run(sid);
  }

  ptsDb
    .prepare(
      `INSERT INTO pts_formula (id, society_id, version, status, max_points, age_basis, resolution_id, trial_start, trial_end, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '2026-10-01', '2027-04-01', ?, ?)`
    )
    .run(newFormulaId, sid, d.version, status, d.maxPoints, d.ageBasis, resRow.id, actor.id, now);

  const baseItems = ptsDb
    .prepare('SELECT * FROM pts_formula_item WHERE formula_id = ?')
    .all(current.id) as Array<{
    factor: 'education' | 'age' | 'work' | 'exposure';
    item_key: string;
    label_en: string;
    label_sd: string;
    label_ur: string;
    min_age: number | null;
    max_age: number | null;
    value_points: number | null;
  }>;

  for (const item of baseItems) {
    const override = d.itemUpdates?.find((u) => u.factor === item.factor && u.itemKey === item.item_key);
    const val = override !== undefined ? override.valuePoints : item.value_points;
    ptsDb
      .prepare(
        `INSERT INTO pts_formula_item (id, society_id, formula_id, factor, item_key, label_en, label_sd, label_ur, min_age, max_age, value_points)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        newId('pfi'),
        sid,
        newFormulaId,
        item.factor,
        item.item_key,
        item.label_en,
        item.label_sd,
        item.label_ur,
        item.min_age,
        item.max_age,
        val
      );
  }

  // Recompute all members against newly approved formula
  const memberIds = coreDb.prepare('SELECT id FROM member WHERE society_id = ?').all(sid) as Array<{ id: string }>;
  for (const m of memberIds) {
    recalculateMemberPoints(sid, m.id, d.ageBasis);
  }

  appendAuditEvent({
    societyId: sid,
    actorId: actor.id,
    action: 'points.formula_created',
    entityType: 'pts_formula',
    entityId: newFormulaId,
    after: { version: d.version, status, resolutionCode: d.resolutionCode },
  });

  res.status(201).json({ id: newFormulaId, version: d.version, status });
});

apiRouter.post('/points/formulas/:id/approve', (req, res) => {
  const actor = requireRole(req, res, CO_PRESIDENTS_OR_ADMIN);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const formulaId = String(req.params.id);

  const formula = ptsDb
    .prepare('SELECT * FROM pts_formula WHERE id = ? AND society_id = ?')
    .get(formulaId, sid) as { id: string; version: string; status: string; age_basis: 'registration' | 'snapshot' } | undefined;
  if (!formula) {
    res.status(404).json({ code: 'FORMULA_NOT_FOUND', title: 'Formula not found.' });
    return;
  }

  const { resolutionCode, noSchoolingPts, noExposurePts } = req.body as {
    resolutionCode?: string;
    noSchoolingPts?: number | null;
    noExposurePts?: number | null;
  };
  if (!resolutionCode) {
    res.status(422).json({ code: 'RESOLUTION_REQUIRED', title: 'A General Body resolution code is required to approve a Vote-Points formula.' });
    return;
  }

  // Allow setting undecided null values during General Body resolution adoption (unblocks AC-PTS-03!)
  if (noSchoolingPts !== undefined) {
    ptsDb
      .prepare("UPDATE pts_formula_item SET value_points = ? WHERE formula_id = ? AND factor = 'education' AND item_key = 'no_schooling'")
      .run(noSchoolingPts, formulaId);
  }
  if (noExposurePts !== undefined) {
    ptsDb
      .prepare("UPDATE pts_formula_item SET value_points = ? WHERE formula_id = ? AND factor = 'exposure' AND item_key = 'no_exposure'")
      .run(noExposurePts, formulaId);
  }

  ptsDb.prepare("UPDATE pts_formula SET status = 'retired' WHERE society_id = ? AND status = 'approved'").run(sid);
  ptsDb
    .prepare("UPDATE pts_formula SET status = 'approved', resolution_id = ? WHERE id = ? AND society_id = ?")
    .run(resolutionCode, formulaId, sid);

  const memberIds = coreDb.prepare('SELECT id FROM member WHERE society_id = ?').all(sid) as Array<{ id: string }>;
  for (const m of memberIds) {
    recalculateMemberPoints(sid, m.id, formula.age_basis);
  }

  appendAuditEvent({
    societyId: sid,
    actorId: actor.id,
    action: 'points.formula_approved',
    entityType: 'pts_formula',
    entityId: formulaId,
    after: { version: formula.version, resolutionCode, noSchoolingPts, noExposurePts },
  });

  res.json({ ok: true, status: 'approved', version: formula.version });
});

apiRouter.post('/points/trial-reviews', (req, res) => {
  const actor = requireRole(req, res, [...CO_PRESIDENTS_OR_ADMIN, 'auditor']);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const formula = getActiveFormula(sid);
  if (!formula) {
    res.status(404).json({ code: 'FORMULA_NOT_FOUND', title: 'No formula found.' });
    return;
  }
  const { periodLabel, summaryText, decision } = req.body as { periodLabel?: string; summaryText?: string; decision?: string };
  if (!periodLabel || !summaryText || !decision) {
    res.status(400).json({ code: 'INVALID_INPUT', title: 'Period label, summary text, and decision are required.' });
    return;
  }

  const id = newId('rev');
  ptsDb
    .prepare(
      `INSERT INTO pts_trial_review (id, society_id, formula_id, period_label, summary_text, decision, reviewed_by, reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, sid, formula.id, periodLabel, summaryText, decision, actor.full_name, new Date().toISOString());

  appendAuditEvent({
    societyId: sid,
    actorId: actor.id,
    action: 'points.trial_reviewed',
    entityType: 'pts_trial_review',
    entityId: id,
    after: { periodLabel, decision },
  });

  res.status(201).json({ id });
});

// ============================================================================
// 4. ELECTIONS, GENDER CONTESTS, TRAINING GATE & WEIGHTED SEALED BALLOTS (ELE)
// ============================================================================
apiRouter.get('/elections', (req, res) => {
  const areq = req as AuthedRequest;
  const sid = areq.societyId;
  const auth = areq.authMember;
  const minAge = getRuleValue<number>(sid, 'eligibility.min_voting_age', 18);
  const authVerified = auth && auth.society_id === sid ? isVerifiedAdultVoter(auth, minAge) : false;

  const elections = voteDb
    .prepare('SELECT * FROM election WHERE society_id = ? ORDER BY created_at DESC')
    .all(sid) as Array<Record<string, any>>;

  const enriched = elections.map((e) => {
    const contestRows = voteDb
      .prepare('SELECT * FROM contest WHERE election_id = ? ORDER BY id ASC')
      .all(e.id) as Array<Record<string, any>>;

    const gate = e.state === 'nomination' || e.state === 'draft' ? checkElectionOpeningGate(sid, e.id) : null;

    const contests = contestRows.map((c) => {
      const candidates = voteDb
        .prepare(
          `SELECT id, contest_id, member_id, member_name, household_id, symbol_key,
                  qualification_kind, qualification_status, qualification_note,
                  training_passed, training_score, status
           FROM candidate WHERE contest_id = ? ORDER BY created_at ASC`
        )
        .all(c.id);

      const partRow = voteDb
        .prepare('SELECT COUNT(*) AS cnt, COALESCE(SUM(points_used), 0) AS pts FROM vote_participation WHERE contest_id = ?')
        .get(c.id) as { cnt: number; pts: number };

      const sealedRow = voteDb
        .prepare('SELECT COUNT(*) AS cnt FROM sealed_ballot WHERE contest_id = ?')
        .get(c.id) as { cnt: number };

      const openRow = voteDb
        .prepare('SELECT COALESCE(SUM(points_used), 0) AS pts FROM open_vote WHERE contest_id = ?')
        .get(c.id) as { pts: number };

      const hasVoted = auth
        ? Boolean(voteDb.prepare('SELECT 1 FROM vote_participation WHERE contest_id = ? AND member_id = ?').get(c.id, auth.id))
        : false;

      const snapRow = auth
        ? (voteDb
            .prepare('SELECT points_at_snapshot FROM voter_snapshot WHERE contest_id = ? AND member_id = ?')
            .get(c.id, auth.id) as { points_at_snapshot: number } | undefined)
        : undefined;

      const genderMatch = auth ? isGenderEligibleForRule(auth.gender, c.eligible_gender_rule) : false;
      const userEligible = Boolean(auth && authVerified && genderMatch && (c.state !== 'open' || snapRow));

      let eligibilityReason: string | null = null;
      if (!auth) {
        eligibilityReason = 'Sign in to check your contest eligibility.';
      } else if (!authVerified) {
        eligibilityReason = 'Only active verified adult members can vote in this contest.';
      } else if (!genderMatch) {
        eligibilityReason =
          c.eligible_gender_rule === 'woman'
            ? 'AC-ELE-01: Restricted to verified women voters (Woman Co-President contest).'
            : 'AC-ELE-01: Restricted to verified men voters (Man Co-President contest).';
      } else if (c.state === 'open' && !snapRow) {
        eligibilityReason = 'Verified after voter roll snapshot freeze for this contest.';
      }

      const resultRow = voteDb
        .prepare('SELECT * FROM contest_result WHERE contest_id = ? ORDER BY certified_at DESC LIMIT 1')
        .get(c.id) as Record<string, any> | undefined;

      const isClosedOrLater = ['closed', 'tallied', 'certified'].includes(c.state) || ['closed', 'tallied', 'certified'].includes(e.state);
      const ballotUnitCount = e.ballot_mode === 'secret' ? sealedRow.cnt : openRow.pts;

      return {
        id: c.id,
        election_id: c.election_id,
        name_en: c.name_en,
        name_sd: c.name_sd,
        name_ur: c.name_ur,
        prompt_en: c.prompt_en,
        prompt_sd: c.prompt_sd,
        prompt_ur: c.prompt_ur,
        eligible_gender_rule: c.eligible_gender_rule,
        weighting: c.weighting,
        formula_id: c.formula_id,
        options: JSON.parse(c.options_json || '[]'),
        snapshot_hash: c.snapshot_hash,
        snapshot_count: c.snapshot_count,
        snapshot_total_points: c.snapshot_total_points,
        state: c.state,
        candidates,
        participationCount: partRow.cnt,
        totalPointsUsed: partRow.pts,
        sealedBallotCount: ballotUnitCount,
        integrityCountsMatch: partRow.pts === ballotUnitCount,
        userEligible,
        eligibilityReason,
        hasVoted,
        userPointsAtSnapshot: snapRow?.points_at_snapshot ?? null,
        quorumRequired: Math.ceil((c.snapshot_count || 0) * e.quorum_fraction),
        result:
          isClosedOrLater && resultRow
            ? {
                resultStatus: resultRow.result_status,
                tallies: JSON.parse(resultRow.tallies_json),
                winnerCandidateId: resultRow.winner_candidate_id,
                winnerName: resultRow.winner_name,
                anonymityWarning: resultRow.anonymity_warning,
                formulaVersion: resultRow.formula_version,
                certifiedBy1: resultRow.certified_by_1,
                certifiedBy2: resultRow.certified_by_2,
                certifiedAt: resultRow.certified_at,
                disputeNote: resultRow.dispute_note,
              }
            : null,
      };
    });

    return {
      ...e,
      contests,
      openingGate: gate,
    };
  });

  res.json({ elections: enriched });
});

apiRouter.get('/contests/:id/ballot', (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const sid = (req as AuthedRequest).societyId;
  const contestId = String(req.params.id);

  // AC-ELE-09: Village Helper role cannot inspect ballot data directly for administrative reading
  const contest = voteDb
    .prepare('SELECT c.*, e.ballot_mode, e.state AS election_state FROM contest c JOIN election e ON e.id = c.election_id WHERE c.id = ? AND c.society_id = ?')
    .get(contestId, sid) as Record<string, any> | undefined;

  if (!contest) {
    res.status(404).json({ code: 'CONTEST_NOT_FOUND', title: 'Contest not found.' });
    return;
  }

  if (!isGenderEligibleForRule(auth.gender, contest.eligible_gender_rule)) {
    res.status(403).json({
      code: 'CONTEST_GENDER_INELIGIBLE',
      title: `AC-ELE-01: You are not eligible to open or vote in the '${contest.eligible_gender_rule}' contest.`,
    });
    return;
  }

  const snap = voteDb
    .prepare('SELECT points_at_snapshot FROM voter_snapshot WHERE contest_id = ? AND member_id = ?')
    .get(contestId, auth.id) as { points_at_snapshot: number } | undefined;

  if (!snap) {
    res.status(403).json({ code: 'NOT_IN_SNAPSHOT', title: 'You are not in the frozen eligible voter snapshot for this contest.' });
    return;
  }

  const participated = voteDb
    .prepare('SELECT cast_at FROM vote_participation WHERE contest_id = ? AND member_id = ?')
    .get(contestId, auth.id) as { cast_at: string } | undefined;

  res.json({
    contestId: contest.id,
    nameEn: contest.name_en,
    promptEn: contest.prompt_en,
    weighting: contest.weighting,
    ballotMode: contest.ballot_mode,
    pointsAtSnapshot: snap.points_at_snapshot,
    alreadyVoted: Boolean(participated),
    options: JSON.parse(contest.options_json || '[]'),
  });
});

apiRouter.get('/contests/:id/vote-status', (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const sid = (req as AuthedRequest).societyId;
  const contestId = String(req.params.id);

  const contest = voteDb
    .prepare('SELECT id, eligible_gender_rule FROM contest WHERE id = ? AND society_id = ?')
    .get(contestId, sid) as { id: string; eligible_gender_rule: string } | undefined;

  if (!contest) {
    res.status(404).json({ code: 'CONTEST_NOT_FOUND', title: 'Contest not found.' });
    return;
  }

  const snap = voteDb
    .prepare('SELECT points_at_snapshot FROM voter_snapshot WHERE contest_id = ? AND member_id = ?')
    .get(contestId, auth.id) as { points_at_snapshot: number } | undefined;

  const part = voteDb
    .prepare('SELECT points_used, cast_at, channel FROM vote_participation WHERE contest_id = ? AND member_id = ?')
    .get(contestId, auth.id) as { points_used: number; cast_at: string; channel: string } | undefined;

  // AC-ELE-08: Truthful recovery status without ever revealing ballot choice
  res.json({
    contestId,
    eligible: Boolean(snap && isGenderEligibleForRule(auth.gender, contest.eligible_gender_rule)),
    voted: Boolean(part),
    pointsAtSnapshot: snap?.points_at_snapshot ?? null,
    castAt: part?.cast_at ?? null,
    channel: part?.channel ?? null,
  });
});

apiRouter.post('/elections', (req, res) => {
  const actor = requireRole(req, res, ['election_admin', 'portal_admin']);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;

  const schema = z.object({
    type: z.enum(['co_president', 'levy', 'budget', 'project', 'recall', 'resolution']),
    titleEn: z.string().min(4),
    titleSd: z.string().optional(),
    titleUr: z.string().optional(),
    descriptionEn: z.string().min(4),
    ballotMode: z.enum(['secret', 'open']).default('secret'),
    projectId: z.string().optional(),
    options: z.array(z.object({
      code: z.string().min(1),
      labelEn: z.string().min(1),
      labelSd: z.string().optional(),
      labelUr: z.string().optional(),
      symbol: z.string().default('check'),
    })).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'INVALID_INPUT', title: parsed.error.issues[0]?.message || 'Invalid election data' });
    return;
  }

  const d = parsed.data;
  const minTurnout = getRuleValue<number>(sid, 'turnout.min_fraction', 0.3);
  const quorum =
    d.type === 'levy'
      ? getRuleValue<number>(sid, 'quorum.levy_change', 0.5)
      : getRuleValue<number>(sid, 'quorum.ordinary', 0.3);
  const threshold =
    d.type === 'levy'
      ? getRuleValue<number>(sid, 'threshold.levy_change', 0.67)
      : getRuleValue<number>(sid, 'threshold.ordinary', 0.5);
  const tieRule = getRuleValue<string>(sid, 'tie.rule', 'manual_decision');
  const nonElecMode = getRuleValue<string>(sid, 'points.non_election_mode', 'equal') === 'points' ? 'points' : 'equal';
  const formula = getActiveFormula(sid);

  const elecId = newId('elec');
  const now = new Date();
  const opensAt = now.toISOString();
  const closesAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const cfg = { type: d.type, ballotMode: d.ballotMode, quorum, threshold, minTurnout };

  voteDb
    .prepare(
      `INSERT INTO election (
        id, society_id, type, title_en, title_sd, title_ur, description_en, description_sd, description_ur,
        state, ballot_mode, opens_at, closes_at, quorum_fraction, pass_threshold, min_turnout_fraction,
        tie_rule, formula_id, project_id, config_json, config_hash, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'nomination', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      elecId,
      sid,
      d.type,
      d.titleEn,
      d.titleSd || d.titleEn,
      d.titleUr || d.titleEn,
      d.descriptionEn,
      d.descriptionEn,
      d.descriptionEn,
      d.ballotMode,
      opensAt,
      closesAt,
      quorum,
      threshold,
      minTurnout,
      tieRule,
      formula?.id ?? null,
      d.projectId ?? null,
      JSON.stringify(cfg),
      canonicalHash(cfg),
      actor.id,
      opensAt
    );

  if (d.type === 'co_president') {
    for (const [slug, nameEn, nameSd, nameUr, genderRule] of [
      ['woman', 'Woman Co-President Contest', 'عورت شريڪ صدر مقابلو', 'خاتون شریک صدر مقابلہ', 'woman'],
      ['man', 'Man Co-President Contest', 'مرد شريڪ صدر مقابلو', 'مرد شریک صدر مقابلہ', 'man'],
    ] as const) {
      voteDb
        .prepare(
          `INSERT INTO contest (
            id, society_id, election_id, name_en, name_sd, name_ur,
            prompt_en, prompt_sd, prompt_ur, eligible_gender_rule, weighting, formula_id, options_json, state
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'points', ?, '[]', 'nomination')`
        )
        .run(
          newId(`con-${slug}`),
          sid,
          elecId,
          nameEn,
          nameSd,
          nameUr,
          `Select 1 qualified ${slug === 'woman' ? 'Woman' : 'Man'} Co-President`,
          nameSd,
          nameUr,
          genderRule,
          formula?.id ?? null
        );
    }
  } else {
    const defaultOpts =
      d.options && d.options.length > 0
        ? d.options.map((o) => ({
            code: o.code,
            labelEn: o.labelEn,
            labelSd: o.labelSd || o.labelEn,
            labelUr: o.labelUr || o.labelEn,
            symbol: o.symbol,
          }))
        : [
            { code: 'YES', labelEn: 'Approve', labelSd: 'منظور', labelUr: 'منظور', symbol: 'check' },
            { code: 'NO', labelEn: 'Reject', labelSd: 'رد ڪريو', labelUr: 'مسترد', symbol: 'x' },
            { code: 'ABSTAIN', labelEn: 'Abstain', labelSd: 'غير جانبدار', labelUr: 'غیر جانبدار', symbol: 'minus' },
          ];
    voteDb
      .prepare(
        `INSERT INTO contest (
          id, society_id, election_id, name_en, name_sd, name_ur,
          prompt_en, prompt_sd, prompt_ur, eligible_gender_rule, weighting, formula_id, options_json, state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'any', ?, ?, ?, 'nomination')`
      )
      .run(
        newId('con'),
        sid,
        elecId,
        d.titleEn,
        d.titleSd || d.titleEn,
        d.titleUr || d.titleEn,
        d.descriptionEn,
        d.descriptionEn,
        d.descriptionEn,
        nonElecMode,
        nonElecMode === 'points' ? formula?.id ?? null : null,
        JSON.stringify(defaultOpts)
      );
  }

  appendAuditEvent({
    societyId: sid,
    actorId: actor.id,
    action: 'election.created',
    entityType: 'election',
    entityId: elecId,
    after: { type: d.type, titleEn: d.titleEn },
  });

  res.status(201).json({ id: elecId });
});

apiRouter.post('/contests/:id/candidates', (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const contestId = String(req.params.id);

  const minAge = getRuleValue<number>(sid, 'eligibility.min_voting_age', 18);
  if (!isVerifiedAdultVoter(actor, minAge)) {
    res.status(403).json({ code: 'VOTER_NOT_VERIFIED', title: 'Only verified active adult members may stand as candidates.' });
    return;
  }

  if (actor.roles.includes('election_admin')) {
    res.status(409).json({ code: 'ELECTION_ADMIN_NEUTRAL', title: 'Election Administrators cannot stand as candidates (FR-ELE-010).' });
    return;
  }

  const contest = voteDb
    .prepare('SELECT * FROM contest WHERE id = ? AND society_id = ?')
    .get(contestId, sid) as Record<string, any> | undefined;

  if (!contest) {
    res.status(404).json({ code: 'CONTEST_NOT_FOUND', title: 'Contest not found.' });
    return;
  }
  if (!isGenderEligibleForRule(actor.gender, contest.eligible_gender_rule)) {
    res.status(403).json({
      code: 'CANDIDATE_GENDER_MISMATCH',
      title: `This contest is reserved for '${contest.eligible_gender_rule}' candidates.`,
    });
    return;
  }

  const { qualificationKind = 'bachelor_degree', symbolKey = 'sun' } = req.body as {
    qualificationKind?: 'bachelor_degree' | 'intermediate_plus';
    symbolKey?: string;
  };

  // Household rule between co-president contests (OD-22)
  const blockSameHh = getRuleValue<boolean>(sid, 'household.co_president_restriction', true);
  if (blockSameHh) {
    const otherContest = voteDb
      .prepare('SELECT id FROM candidate WHERE election_id = ? AND contest_id != ? AND household_id = ? AND status != ?')
      .get(contest.election_id, contestId, actor.household_id, 'withdrawn');
    if (otherContest) {
      res.status(409).json({
        code: 'HOUSEHOLD_COPRESIDENT_CONFLICT',
        title: 'OD-22: A member from your household is already running in the paired Co-President contest.',
      });
      return;
    }
  }

  const candId = newId('cand');
  const now = new Date().toISOString();
  try {
    voteDb
      .prepare(
        `INSERT INTO candidate (
          id, society_id, contest_id, election_id, member_id, member_name, household_id, gender,
          symbol_key, qualification_kind, qualification_status, training_passed, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 'applied', ?)`
      )
      .run(candId, sid, contestId, contest.election_id, actor.id, actor.full_name, actor.household_id, actor.gender, symbolKey, qualificationKind, now);
  } catch {
    res.status(409).json({ code: 'ALREADY_NOMINATED', title: 'You have already filed a nomination in this contest.' });
    return;
  }

  const opts = JSON.parse(contest.options_json || '[]') as Array<Record<string, string>>;
  opts.push({ code: candId, labelEn: actor.full_name, labelSd: actor.full_name, labelUr: actor.full_name, symbol: symbolKey });
  voteDb.prepare('UPDATE contest SET options_json = ? WHERE id = ?').run(JSON.stringify(opts), contestId);

  appendAuditEvent({
    societyId: sid,
    actorId: actor.id,
    action: 'candidate.nominated',
    entityType: 'candidate',
    entityId: candId,
    after: { contestId, qualificationKind },
  });

  res.status(201).json({ id: candId, status: 'applied' });
});

apiRouter.post('/candidates/:id/qualification', (req, res) => {
  const actor = requireRole(req, res, ['verification_officer']);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const candId = String(req.params.id);

  const cand = voteDb
    .prepare('SELECT * FROM candidate WHERE id = ? AND society_id = ?')
    .get(candId, sid) as Record<string, any> | undefined;
  if (!cand) {
    res.status(404).json({ code: 'CANDIDATE_NOT_FOUND', title: 'Candidate not found.' });
    return;
  }
  if (cand.member_id === actor.id) {
    res.status(409).json({ code: 'SELF_VERIFY_FORBIDDEN', title: 'Verification Officer cannot verify their own qualification.' });
    return;
  }

  const { status, note } = req.body as { status?: 'approved' | 'rejected'; note?: string };
  const nextStatus = status === 'rejected' ? 'rejected' : 'approved';
  const nextCandStatus =
    nextStatus === 'rejected' ? 'rejected' : cand.training_passed ? 'qualified' : 'applied';

  voteDb
    .prepare(
      `UPDATE candidate SET qualification_status = ?, qualification_note = ?, eligibility_decision_by = ?, status = ?
       WHERE id = ? AND society_id = ?`
    )
    .run(nextStatus, note || 'Checked by Verification Officer', actor.id, nextCandStatus, candId, sid);

  appendAuditEvent({
    societyId: sid,
    actorId: actor.id,
    action: 'candidate.qualification_verified',
    entityType: 'candidate',
    entityId: candId,
    after: { qualificationStatus: nextStatus, candidateStatus: nextCandStatus },
  });

  res.json({ ok: true, qualificationStatus: nextStatus, candidateStatus: nextCandStatus });
});

apiRouter.post('/candidates/:id/training', (req, res) => {
  const actor = requireRole(req, res, ['verification_officer', 'election_admin', 'portal_admin']);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const candId = String(req.params.id);

  const cand = voteDb
    .prepare('SELECT * FROM candidate WHERE id = ? AND society_id = ?')
    .get(candId, sid) as Record<string, any> | undefined;
  if (!cand) {
    res.status(404).json({ code: 'CANDIDATE_NOT_FOUND', title: 'Candidate not found.' });
    return;
  }

  const { score, materialVersion = 'PresidencyBook-v1.1' } = req.body as { score?: number; materialVersion?: string };
  const passMark = getRuleValue<number>(sid, 'presidency_book.pass_mark', 70);
  const numScore = Number(score ?? 0);
  const passed = numScore >= passMark ? 1 : 0;
  const now = new Date().toISOString();

  voteDb
    .prepare(
      `INSERT INTO training_record (id, society_id, candidate_id, member_id, material_version, test_date, score, pass_mark, passed, verified_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(newId('trn'), sid, candId, cand.member_id, materialVersion, now.slice(0, 10), numScore, passMark, passed, actor.id, now);

  const nextCandStatus = passed && cand.qualification_status === 'approved' ? 'qualified' : cand.status;
  voteDb
    .prepare('UPDATE candidate SET training_passed = ?, training_score = ?, status = ? WHERE id = ?')
    .run(passed, numScore, nextCandStatus, candId);

  appendAuditEvent({
    societyId: sid,
    actorId: actor.id,
    action: 'candidate.training_recorded',
    entityType: 'candidate',
    entityId: candId,
    after: { score: numScore, passMark, passed: Boolean(passed), status: nextCandStatus },
  });

  res.json({ ok: true, passed: Boolean(passed), passMark, status: nextCandStatus });
});

apiRouter.post('/elections/:id/open', (req, res) => {
  const actor = requireRole(req, res, ['election_admin', 'portal_admin']);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const electionId = String(req.params.id);

  const gate = checkElectionOpeningGate(sid, electionId);
  if (!gate.ready) {
    res.status(422).json({
      code: 'ELECTION_OPENING_BLOCKED',
      title: gate.blockers[0],
      blockers: gate.blockers,
      undecidedVoters: gate.undecidedVoters,
    });
    return;
  }

  const minAge = getRuleValue<number>(sid, 'eligibility.min_voting_age', 18);
  const ageBasis = getRuleValue<'registration' | 'snapshot'>(sid, 'points.age_basis', 'snapshot');
  const formula = getActiveFormula(sid);
  const now = new Date().toISOString();

  const members = coreDb
    .prepare("SELECT id, gender, date_of_birth, status, identity_status, voting_suspended_until FROM member WHERE society_id = ? AND status = 'active' AND identity_status = 'approved'")
    .all(sid) as Array<{ id: string; gender: string; date_of_birth: string; status: string; identity_status: string; voting_suspended_until: string | null }>;

  const activeAdults = members.filter(
    (m) => (!m.voting_suspended_until || m.voting_suspended_until <= now) && computeAge(m.date_of_birth) >= minAge
  );

  const contests = voteDb.prepare('SELECT * FROM contest WHERE election_id = ?').all(electionId) as Array<Record<string, any>>;

  for (const c of contests) {
    voteDb.prepare('DELETE FROM voter_snapshot WHERE contest_id = ?').run(c.id);
    const eligible = activeAdults.filter((m) => isGenderEligibleForRule(m.gender, c.eligible_gender_rule));
    let totalPoints = 0;

    for (const v of eligible) {
      let pts = 1;
      if (c.weighting === 'points') {
        const calc = recalculateMemberPoints(sid, v.id, ageBasis, now);
        pts = Math.max(1, calc?.totalPts ?? 1);
      }
      totalPoints += pts;
      voteDb
        .prepare('INSERT INTO voter_snapshot (contest_id, society_id, member_id, points_at_snapshot) VALUES (?, ?, ?, ?)')
        .run(c.id, sid, v.id, pts);
    }

    const snapHash = canonicalHash(eligible.map((v) => v.id).sort());
    voteDb
      .prepare("UPDATE contest SET state = 'open', formula_id = ?, snapshot_hash = ?, snapshot_count = ?, snapshot_total_points = ? WHERE id = ?")
      .run(c.weighting === 'points' ? formula?.id ?? null : null, snapHash, eligible.length, totalPoints, c.id);
  }

  voteDb
    .prepare("UPDATE election SET state = 'open', opens_at = ?, formula_id = ? WHERE id = ? AND society_id = ?")
    .run(now, formula?.id ?? null, electionId, sid);

  appendAuditEvent({
    societyId: sid,
    actorId: actor.id,
    action: 'election.opened',
    entityType: 'election',
    entityId: electionId,
    after: { contests: contests.length },
  });

  res.json({ ok: true, state: 'open' });
});

apiRouter.post('/elections/:id/votes', (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const electionId = String(req.params.id);

  const {
    contestId,
    choiceCode,
    channel = 'self',
    voterMemberId,
    otpCode,
  } = req.body as {
    contestId?: string;
    choiceCode?: string;
    channel?: 'self' | 'assisted_kiosk';
    voterMemberId?: string;
    otpCode?: string;
  };

  if (!choiceCode) {
    res.status(400).json({ code: 'CHOICE_REQUIRED', title: 'Please choose an option before casting your ballot.' });
    return;
  }

  const election = voteDb
    .prepare('SELECT * FROM election WHERE id = ? AND society_id = ?')
    .get(electionId, sid) as Record<string, any> | undefined;

  if (!election) {
    res.status(404).json({ code: 'ELECTION_NOT_FOUND', title: 'Election not found.' });
    return;
  }
  if (election.state !== 'open') {
    res.status(409).json({ code: 'ELECTION_NOT_OPEN', title: 'Voting is not currently open for this election.' });
    return;
  }

  // Determine contest
  let contest = contestId
    ? (voteDb.prepare('SELECT * FROM contest WHERE id = ? AND election_id = ?').get(contestId, electionId) as Record<string, any> | undefined)
    : (voteDb.prepare('SELECT * FROM contest WHERE election_id = ? ORDER BY id ASC LIMIT 1').get(electionId) as Record<string, any> | undefined);

  if (!contest) {
    res.status(404).json({ code: 'CONTEST_NOT_FOUND', title: 'Contest not found.' });
    return;
  }

  // Determine voter (self vs assisted_kiosk)
  let targetVoterId = actor.id;
  let helperId: string | null = null;
  if (channel === 'assisted_kiosk') {
    if (!actor.roles.includes('village_helper')) {
      res.status(403).json({ code: 'HELPER_ROLE_REQUIRED', title: 'Only a designated Village Helper can operate Assisted Kiosk mode.' });
      return;
    }
    if (!voterMemberId) {
      res.status(400).json({ code: 'VOTER_REQUIRED', title: 'Select the verified villager casting this kiosk ballot.' });
      return;
    }
    targetVoterId = voterMemberId;
    helperId = actor.id;
  }

  const voter = coreDb
    .prepare('SELECT * FROM member WHERE id = ? AND society_id = ?')
    .get(targetVoterId, sid) as { id: string; mobile_e164: string; gender: string; date_of_birth: string; status: string; identity_status: string; voting_suspended_until: string | null } | undefined;

  if (!voter) {
    res.status(404).json({ code: 'VOTER_NOT_FOUND', title: 'Voter not found in this society.' });
    return;
  }

  const minAge = getRuleValue<number>(sid, 'eligibility.min_voting_age', 18);
  if (voter.status !== 'active' || voter.identity_status !== 'approved' || computeAge(voter.date_of_birth) < minAge) {
    res.status(403).json({ code: 'VOTER_INELIGIBLE', title: 'Voter must be active, verified, and of minimum voting age.' });
    return;
  }
  if (voter.voting_suspended_until && voter.voting_suspended_until > new Date().toISOString()) {
    res.status(403).json({ code: 'VOTING_SUSPENDED', title: 'Voting rights temporarily suspended.' });
    return;
  }

  // AC-ELE-01: Gender-specific contest enforcement
  if (!isGenderEligibleForRule(voter.gender, contest.eligible_gender_rule)) {
    res.status(403).json({
      code: 'CONTEST_GENDER_INELIGIBLE',
      title: `AC-ELE-01: ${contest.name_en} is restricted to '${contest.eligible_gender_rule}' voters.`,
    });
    return;
  }

  // Check snapshot
  const snap = voteDb
    .prepare('SELECT points_at_snapshot FROM voter_snapshot WHERE contest_id = ? AND member_id = ?')
    .get(contest.id, voter.id) as { points_at_snapshot: number } | undefined;

  if (!snap) {
    res.status(403).json({ code: 'NOT_IN_SNAPSHOT', title: 'Voter was not in the frozen eligible voter snapshot for this contest.' });
    return;
  }

  // Validate OTP step-up if provided
  if (otpCode) {
    const otpCheck = verifyOtpCode(sid, voter.mobile_e164, 'vote_stepup', otpCode);
    if (!otpCheck.ok) {
      res.status(400).json({ code: 'OTP_INVALID', title: otpCheck.error });
      return;
    }
  }

  const existing = voteDb
    .prepare('SELECT 1 FROM vote_participation WHERE contest_id = ? AND member_id = ?')
    .get(contest.id, voter.id);
  if (existing) {
    res.status(409).json({ code: 'ALREADY_VOTED', title: 'AC-ELE-06: One ballot per verified member per contest — vote already recorded.' });
    return;
  }

  const opts = JSON.parse(contest.options_json || '[]') as Array<{ code: string }>;
  if (!opts.some((o) => o.code === choiceCode)) {
    res.status(400).json({ code: 'INVALID_CHOICE', title: 'Selected choice is not a valid option on this ballot.' });
    return;
  }

  const pointsUsed = snap.points_at_snapshot;
  const now = new Date().toISOString();

  // SDS §7.6: Atomic transaction inserting 1 participation row + N identical encrypted sealed_ballot units!
  voteDb.exec('BEGIN IMMEDIATE');
  try {
    voteDb
      .prepare(
        `INSERT INTO vote_participation (contest_id, society_id, member_id, points_used, cast_at, channel, helper_member_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(contest.id, sid, voter.id, pointsUsed, now, channel, helperId);

    if (election.ballot_mode === 'secret') {
      const encryptedPayload = encryptField(JSON.stringify({ choiceCode }));
      const stmt = voteDb.prepare(
        'INSERT INTO sealed_ballot (ballot_id, society_id, contest_id, payload_enc) VALUES (?, ?, ?, ?)'
      );
      for (let i = 0; i < pointsUsed; i++) {
        stmt.run(newId('bal'), sid, contest.id, encryptedPayload);
      }
    } else {
      voteDb
        .prepare(
          `INSERT INTO open_vote (id, society_id, contest_id, member_id, member_name, choice_code, points_used, cast_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(newId('ov'), sid, contest.id, voter.id, actor.full_name, choiceCode, pointsUsed, now);
    }
    voteDb.exec('COMMIT');
  } catch (err) {
    voteDb.exec('ROLLBACK');
    res.status(409).json({ code: 'VOTE_CONFLICT', title: (err as Error).message });
    return;
  }

  // Never log choiceCode in audit!
  appendAuditEvent({
    societyId: sid,
    actorId: voter.id,
    action: 'vote.cast',
    entityType: 'contest',
    entityId: contest.id,
    after: { channel, ballotMode: election.ballot_mode, pointsUnitsCount: pointsUsed },
  });

  res.status(201).json({
    ok: true,
    contestId: contest.id,
    pointsUsed,
    sealedUnitsRecorded: pointsUsed,
    channel,
  });
});

function fisherYatesShuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

apiRouter.post('/elections/:id/close', (req, res) => {
  // AC-ELE-09: Only election_admin or portal_admin can close & tally (village_helper gets 403!)
  const actor = requireRole(req, res, ['election_admin', 'portal_admin']);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const electionId = String(req.params.id);

  const election = voteDb
    .prepare('SELECT * FROM election WHERE id = ? AND society_id = ?')
    .get(electionId, sid) as Record<string, any> | undefined;
  if (!election) {
    res.status(404).json({ code: 'ELECTION_NOT_FOUND', title: 'Election not found.' });
    return;
  }

  const minAnonymity = getRuleValue<number>(sid, 'voting.weighted_min_anonymity_set', 5);
  const tieRule = election.tie_rule || getRuleValue<string>(sid, 'tie.rule', 'manual_decision');
  const formula = election.formula_id
    ? (ptsDb.prepare('SELECT version FROM pts_formula WHERE id = ?').get(election.formula_id) as { version: string } | undefined)
    : getActiveFormula(sid);

  const contests = voteDb.prepare('SELECT * FROM contest WHERE election_id = ?').all(electionId) as Array<Record<string, any>>;
  const resultsSummary: Array<Record<string, any>> = [];
  const now = new Date().toISOString();

  for (const c of contests) {
    const partRow = voteDb
      .prepare('SELECT COUNT(*) AS turnout_voters, COALESCE(SUM(points_used), 0) AS total_points_used FROM vote_participation WHERE contest_id = ?')
      .get(c.id) as { turnout_voters: number; total_points_used: number };

    const pointMap = new Map<string, number>();

    if (election.ballot_mode === 'secret') {
      const rawBallots = voteDb
        .prepare('SELECT ballot_id, payload_enc FROM sealed_ballot WHERE contest_id = ?')
        .all(c.id) as Array<{ ballot_id: string; payload_enc: string }>;

      // TC-22 invariant: sealed_ballot count MUST equal SUM(vote_participation.points_used)
      if (rawBallots.length !== partRow.total_points_used) {
        res.status(500).json({
          code: 'BALLOT_INTEGRITY_MISMATCH',
          title: `Integrity failure: sealed ballot units (${rawBallots.length}) != SUM(points_used) (${partRow.total_points_used}).`,
        });
        return;
      }

      const shuffled = fisherYatesShuffle(rawBallots);
      for (const b of shuffled) {
        try {
          const dec = JSON.parse(decryptField(b.payload_enc)) as { choiceCode: string };
          pointMap.set(dec.choiceCode, (pointMap.get(dec.choiceCode) ?? 0) + 1);
        } catch {
          // ignore malformed
        }
      }
    } else {
      const openRows = voteDb
        .prepare('SELECT choice_code, COALESCE(SUM(points_used), 0) AS pts FROM open_vote WHERE contest_id = ? GROUP BY choice_code')
        .all(c.id) as Array<{ choice_code: string; pts: number }>;
      for (const o of openRows) {
        pointMap.set(o.choice_code, o.pts);
      }
    }

    const opts = JSON.parse(c.options_json || '[]') as Array<{ code: string; labelEn: string }>;
    const counts = Array.from(pointMap.entries())
      .map(([choice_code, points]) => ({
        choice_code,
        label: opts.find((o) => o.code === choice_code)?.labelEn || choice_code,
        points,
      }))
      .sort((a, b) => b.points - a.points);

    const eligible = c.snapshot_count || 0;
    const turnoutVoters = partRow.turnout_voters;
    const totalPointsCast = partRow.total_points_used;
    const turnoutFraction = eligible > 0 ? turnoutVoters / eligible : 0;
    const minTurnoutRequired = Math.ceil(eligible * (election.min_turnout_fraction ?? 0.3));
    const quorumRequired = Math.ceil(eligible * (election.quorum_fraction ?? 0.3));
    const minTurnoutMet = turnoutFraction >= (election.min_turnout_fraction ?? 0.3) && turnoutVoters > 0;
    const quorumMet = turnoutVoters >= quorumRequired && turnoutVoters > 0;

    let resultStatus = 'PASSED';
    let winnerCandidateId: string | null = null;
    let winnerName: string | null = null;

    if (!minTurnoutMet && election.type === 'co_president') {
      resultStatus = 'NO_VALID_RESULT_TURNOUT';
    } else if (!quorumMet) {
      resultStatus = 'NO_QUORUM';
    } else if (election.type === 'co_president') {
      if (counts.length >= 2 && counts[0].points === counts[1].points) {
        resultStatus = tieRule === 'manual_decision' ? 'TIE_DECISION_REQUIRED' : 'TIED';
      } else if (counts.length >= 1) {
        winnerCandidateId = counts[0].choice_code;
        winnerName = counts[0].label;
        resultStatus = 'PASSED';
      }
    } else {
      const yesPts = pointMap.get('YES') ?? 0;
      const noPts = pointMap.get('NO') ?? 0;
      const decidedPts = yesPts + noPts;
      const yesFrac = decidedPts > 0 ? yesPts / decidedPts : 0;
      resultStatus = yesFrac >= election.pass_threshold ? 'PASSED' : 'FAILED';
    }

    // FR-ELE-011 / TC-28: Small-turnout / rare-point anonymity warning
    let anonymityWarning: string | null = null;
    if (c.weighting === 'points' && turnoutVoters > 0 && turnoutVoters < minAnonymity) {
      anonymityWarning = `Small-turnout privacy notice: ${turnoutVoters} voter(s) participated (threshold ${minAnonymity}); rare point totals may increase inference risk.`;
    }

    const talliesObj = {
      turnoutVoters,
      eligibleVoters: eligible,
      totalPointsCast,
      quorumRequired,
      minTurnoutRequired,
      quorumMet,
      minTurnoutMet,
      sealedBallotUnitsVerified: totalPointsCast,
      counts,
    };

    voteDb.prepare('DELETE FROM contest_result WHERE contest_id = ?').run(c.id);
    voteDb
      .prepare(
        `INSERT INTO contest_result (
          id, society_id, contest_id, election_id, result_status, tallies_json,
          winner_candidate_id, winner_name, anonymity_warning, formula_version, certified_by_1, certified_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        newId('res'),
        sid,
        c.id,
        electionId,
        resultStatus,
        JSON.stringify(talliesObj),
        winnerCandidateId,
        winnerName,
        anonymityWarning,
        formula?.version ?? null,
        actor.id,
        now
      );

    voteDb.prepare("UPDATE contest SET state = 'tallied' WHERE id = ?").run(c.id);
    resultsSummary.push({ contestId: c.id, resultStatus, winnerName, totalPointsCast, turnoutVoters });

    // If project vote PASSED, allocate budget in VF & advance project!
    if (election.type === 'project' && election.project_id && resultStatus === 'PASSED') {
      const prj = prjDb
        .prepare('SELECT id, est_budget_pkr FROM prj_proposal WHERE id = ? AND society_id = ?')
        .get(election.project_id, sid) as { id: string; est_budget_pkr: number } | undefined;
      if (prj) {
        prjDb
          .prepare("UPDATE prj_proposal SET state = 'execution', allocated_budget_pkr = ? WHERE id = ?")
          .run(prj.est_budget_pkr, prj.id);
        vfDb
          .prepare(
            `INSERT OR IGNORE INTO vf_project_allocation (id, society_id, project_id, amount_pkr, resolution_id, status, created_at)
             VALUES (?, ?, ?, ?, ?, 'allocated', ?)`
          )
          .run(newId('alloc'), sid, prj.id, prj.est_budget_pkr, electionId, now);
      }
    }
  }

  voteDb.prepare("UPDATE election SET state = 'tallied', closes_at = ? WHERE id = ?").run(now, electionId);

  appendAuditEvent({
    societyId: sid,
    actorId: actor.id,
    action: 'election.closed_and_tallied',
    entityType: 'election',
    entityId: electionId,
    after: { resultsSummary },
  });

  res.json({ ok: true, state: 'tallied', results: resultsSummary });
});

apiRouter.post('/elections/:id/certify', (req, res) => {
  const actor = requireRole(req, res, ['election_admin', 'verification_officer', 'portal_admin']);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const electionId = String(req.params.id);

  const election = voteDb.prepare('SELECT * FROM election WHERE id = ? AND society_id = ?').get(electionId, sid) as Record<string, any> | undefined;
  if (!election) {
    res.status(404).json({ code: 'ELECTION_NOT_FOUND', title: 'Election not found.' });
    return;
  }

  const results = voteDb
    .prepare('SELECT * FROM contest_result WHERE election_id = ?')
    .all(electionId) as Array<Record<string, any>>;
  if (results.length === 0) {
    res.status(409).json({ code: 'NOT_TALLIED', title: 'Close and tally the election before certifying.' });
    return;
  }
  if (results.some((r) => r.certified_by_1 === actor.id)) {
    res.status(409).json({
      code: 'DUAL_CERTIFICATION_REQUIRED',
      title: 'Second certifier must be a different officer from the officer who closed and tallied the vote.',
    });
    return;
  }

  // AC-EXC-01: Cannot grant Co-President office permissions unless candidate passed Presidency Book training!
  if (election.type === 'co_president') {
    for (const r of results) {
      if (r.result_status === 'PASSED' && r.winner_candidate_id) {
        const cand = voteDb
          .prepare('SELECT member_name, training_passed, qualification_status FROM candidate WHERE id = ?')
          .get(r.winner_candidate_id) as { member_name: string; training_passed: number; qualification_status: string } | undefined;
        if (cand && (!cand.training_passed || cand.qualification_status !== 'approved')) {
          res.status(422).json({
            code: 'PRESIDENCY_TRAINING_REQUIRED',
            title: `AC-EXC-01: Winner ${cand.member_name} has not completed Cosiety Presidency Book training or qualification check.`,
          });
          return;
        }
      }
    }
  }

  voteDb.prepare("UPDATE contest_result SET certified_by_2 = ? WHERE election_id = ?").run(actor.id, electionId);
  voteDb.prepare("UPDATE contest SET state = 'certified' WHERE election_id = ?").run(electionId);
  voteDb.prepare("UPDATE election SET state = 'certified' WHERE id = ?").run(electionId);

  appendAuditEvent({
    societyId: sid,
    actorId: actor.id,
    action: 'election.certified',
    entityType: 'election',
    entityId: electionId,
    after: { certifiedBy2: actor.id },
  });

  res.json({ ok: true, state: 'certified' });
});

// ============================================================================
// 5. GOVERNANCE, CO-PRESIDENTS, TEAMS, OD-24 CLAIMS, AGENDA, COI & RECALL (GOV)
// ============================================================================
apiRouter.get('/governance', (req, res) => {
  const sid = (req as AuthedRequest).societyId;
  const members = coreDb.prepare('SELECT id, full_name, household_id FROM member WHERE society_id = ?').all(sid) as Array<{ id: string; full_name: string; household_id: string }>;
  const households = coreDb.prepare('SELECT id, name FROM household WHERE society_id = ?').all(sid) as Array<{ id: string; name: string }>;
  const mMap = new Map(members.map((m) => [m.id, m]));
  const hhMap = new Map(households.map((h) => [h.id, h.name]));

  const rules = govDb.prepare('SELECT * FROM gov_rule WHERE society_id = ? ORDER BY od_code ASC, rule_key ASC').all(sid);
  const terms = govDb.prepare('SELECT * FROM term WHERE society_id = ? ORDER BY start_date DESC').all(sid);
  const rawHolders = govDb.prepare('SELECT * FROM office_holder WHERE society_id = ? ORDER BY seat DESC').all(sid) as Array<Record<string, any>>;
  const officeHolders = rawHolders.map((h) => ({
    ...h,
    member_name: mMap.get(h.member_id)?.full_name || h.member_id,
    household_name: hhMap.get(h.household_id) || h.household_id,
  }));

  const rawTeam = govDb.prepare('SELECT * FROM team_member WHERE society_id = ? ORDER BY team_side DESC, role_code DESC').all(sid) as Array<Record<string, any>>;
  const teamMembers = rawTeam.map((tm) => ({
    ...tm,
    member_name: mMap.get(tm.member_id)?.full_name || tm.member_id,
    household_name: hhMap.get(tm.household_id) || tm.household_id,
  }));

  const agendaItems = govDb.prepare('SELECT * FROM agenda_item WHERE society_id = ? ORDER BY created_at DESC').all(sid);
  const meetings = govDb.prepare('SELECT * FROM meeting WHERE society_id = ? ORDER BY scheduled_at DESC').all(sid);
  const resolutions = govDb.prepare('SELECT * FROM resolution WHERE society_id = ? ORDER BY created_at DESC').all(sid);
  const conflicts = (govDb.prepare('SELECT * FROM conflict_declaration WHERE society_id = ? AND active = 1 ORDER BY created_at DESC').all(sid) as Array<Record<string, any>>).map((c) => ({
    ...c,
    member_name: mMap.get(c.member_id)?.full_name || c.member_id,
  }));

  const petitions = (govDb.prepare('SELECT * FROM recall_petition WHERE society_id = ? ORDER BY created_at DESC').all(sid) as Array<Record<string, any>>).map((p) => {
    const sigRow = govDb.prepare('SELECT COUNT(*) AS cnt FROM recall_signature WHERE petition_id = ?').get(p.id) as { cnt: number };
    return {
      ...p,
      target_name: mMap.get(p.target_member_id)?.full_name || p.target_member_id,
      signatureCount: sigRow.cnt,
    };
  });

  const expenseClaims = govDb.prepare('SELECT * FROM gov_expense_claim WHERE society_id = ? ORDER BY created_at DESC').all(sid);

  res.json({
    rules,
    terms,
    officeHolders,
    teamMembers,
    agendaItems,
    meetings,
    resolutions,
    conflicts,
    petitions,
    expenseClaims,
  });
});

apiRouter.patch('/governance/rules', (req, res) => {
  const actor = requireRole(req, res, CO_PRESIDENTS_OR_ADMIN);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const { ruleKey, value, resolutionCode } = req.body as { ruleKey?: string; value?: unknown; resolutionCode?: string };
  if (!ruleKey || value === undefined) {
    res.status(400).json({ code: 'INVALID_INPUT', title: 'ruleKey and value are required.' });
    return;
  }
  if (!resolutionCode) {
    res.status(422).json({ code: 'RESOLUTION_REQUIRED', title: 'FR-ADM-001: Governance rule changes require a General Body resolution reference.' });
    return;
  }

  const existing = govDb.prepare('SELECT * FROM gov_rule WHERE society_id = ? AND rule_key = ?').get(sid, ruleKey) as Record<string, any> | undefined;
  if (!existing) {
    res.status(404).json({ code: 'RULE_NOT_FOUND', title: 'Rule not found.' });
    return;
  }

  const now = new Date().toISOString();
  govDb
    .prepare(
      `UPDATE gov_rule SET value_json = ?, version = version + 1, approved_by_resolution_id = ?, updated_by = ?, updated_at = ?
       WHERE society_id = ? AND rule_key = ?`
    )
    .run(JSON.stringify(value), resolutionCode, actor.id, now, sid, ruleKey);

  appendAuditEvent({
    societyId: sid,
    actorId: actor.id,
    action: 'governance.rule_updated',
    entityType: 'gov_rule',
    entityId: ruleKey,
    before: JSON.parse(existing.value_json),
    after: value,
    reason: `Resolution ${resolutionCode}`,
  });

  res.json({ ok: true, ruleKey, value });
});

apiRouter.post('/governance/agenda', (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const { title, description, channel = 'portal' } = req.body as { title?: string; description?: string; channel?: 'portal' | 'helper' };
  if (!title || !description) {
    res.status(400).json({ code: 'INVALID_INPUT', title: 'Agenda title and description are required.' });
    return;
  }
  const id = newId('agd');
  govDb
    .prepare(
      `INSERT INTO agenda_item (id, society_id, submitted_by_member_id, submitted_by_name, title, description, channel, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'submitted', ?)`
    )
    .run(id, sid, actor.id, actor.full_name, title.trim(), description.trim(), channel, new Date().toISOString());

  res.status(201).json({ id });
});

apiRouter.post('/governance/meetings', (req, res) => {
  const actor = requireRole(req, res, CO_PRESIDENTS_AND_TEAM);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const { title, location, agenda, scheduledAt } = req.body as { title?: string; location?: string; agenda?: string; scheduledAt?: string };
  if (!title || !agenda) {
    res.status(400).json({ code: 'INVALID_INPUT', title: 'Meeting title and agenda are required.' });
    return;
  }
  const id = newId('mtg');
  govDb
    .prepare(
      `INSERT INTO meeting (id, society_id, body_type, title, scheduled_at, location, agenda, status, created_by, created_at)
       VALUES (?, ?, 'general_body', ?, ?, ?, ?, 'scheduled', ?, ?)`
    )
    .run(id, sid, title.trim(), scheduledAt || new Date(Date.now() + 7 * 86400000).toISOString(), location || 'Village Primary School Courtyard', agenda.trim(), actor.id, new Date().toISOString());

  res.status(201).json({ id });
});

apiRouter.post('/governance/teams', (req, res) => {
  const actor = requireRole(req, res, CO_PRESIDENTS_OR_ADMIN);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;

  const schema = z.object({
    memberId: z.string().min(2),
    roleCode: z.enum(['treasurer', 'team_member']),
    teamSide: z.enum(['woman', 'man']),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'INVALID_INPUT', title: 'memberId, roleCode, and teamSide are required.' });
    return;
  }

  const d = parsed.data;
  if (actor.roles.includes('woman_co_president') && !actor.roles.includes('portal_admin') && d.teamSide !== 'woman') {
    res.status(403).json({ code: 'TEAM_SIDE_FORBIDDEN', title: 'Woman Co-President can only appoint to the Woman Co-President team.' });
    return;
  }
  if (actor.roles.includes('man_co_president') && !actor.roles.includes('portal_admin') && d.teamSide !== 'man') {
    res.status(403).json({ code: 'TEAM_SIDE_FORBIDDEN', title: 'Man Co-President can only appoint to the Man Co-President team.' });
    return;
  }

  const activeTerm = govDb.prepare("SELECT * FROM term WHERE society_id = ? AND status = 'active' LIMIT 1").get(sid) as Record<string, any> | undefined;
  if (!activeTerm) {
    res.status(409).json({ code: 'NO_ACTIVE_TERM', title: 'No active Co-President term found.' });
    return;
  }

  const seatCode = d.teamSide === 'woman' ? 'woman_co_president' : 'man_co_president';
  const officeHolder = govDb
    .prepare('SELECT * FROM office_holder WHERE term_id = ? AND seat = ?')
    .get(activeTerm.id, seatCode) as Record<string, any> | undefined;
  if (!officeHolder) {
    res.status(409).json({ code: 'CO_PRESIDENT_MISSING', title: `No active ${seatCode} seated for this term.` });
    return;
  }

  const candidateMember = coreDb
    .prepare("SELECT id, full_name, household_id, status, identity_status FROM member WHERE id = ? AND society_id = ?")
    .get(d.memberId, sid) as { id: string; full_name: string; household_id: string; status: string; identity_status: string } | undefined;

  if (!candidateMember || candidateMember.status !== 'active' || candidateMember.identity_status !== 'approved') {
    res.status(422).json({ code: 'MEMBER_NOT_VERIFIED', title: 'Only verified active members can be appointed to a Co-President team.' });
    return;
  }

  // AC-EXC-03: Co-President's treasurer CANNOT be from the same household as that Co-President!
  if (d.roleCode === 'treasurer' && candidateMember.household_id === officeHolder.household_id) {
    res.status(409).json({
      code: 'TREASURER_HOUSEHOLD_CONFLICT',
      title: `AC-EXC-03: ${candidateMember.full_name} shares a household with the ${d.teamSide === 'woman' ? 'Woman' : 'Man'} Co-President and cannot serve as Treasurer.`,
    });
    return;
  }

  // AC-EXC-02 / BR-17: One household per executive/team member across scope (executive_wide or per_team)
  const hhScope = getRuleValue<string>(sid, 'household.scope', 'executive_wide');
  const existingHolders = govDb
    .prepare('SELECT member_id, household_id FROM office_holder WHERE term_id = ?')
    .all(activeTerm.id) as Array<{ member_id: string; household_id: string }>;
  const existingTeam = govDb
    .prepare(
      hhScope === 'per_team'
        ? 'SELECT member_id, household_id FROM team_member WHERE term_id = ? AND team_side = ?'
        : 'SELECT member_id, household_id FROM team_member WHERE term_id = ?'
    )
    .all(...(hhScope === 'per_team' ? [activeTerm.id, d.teamSide] : [activeTerm.id])) as Array<{ member_id: string; household_id: string }>;

  const occupiedHouseholds = new Set([
    ...existingHolders.map((h) => h.household_id),
    ...existingTeam.map((t) => t.household_id),
  ]);

  if (occupiedHouseholds.has(candidateMember.household_id)) {
    res.status(409).json({
      code: 'HOUSEHOLD_TEAM_CONFLICT',
      title: `AC-EXC-02 / BR-17: A member from ${candidateMember.full_name}'s household already holds an executive or team seat (${hhScope}).`,
    });
    return;
  }

  const maxSize = getRuleValue<number>(sid, 'team.size_max', 5);
  const currentTeamCount = govDb
    .prepare('SELECT COUNT(*) AS cnt FROM team_member WHERE term_id = ? AND team_side = ?')
    .get(activeTerm.id, d.teamSide) as { cnt: number };
  if (currentTeamCount.cnt >= maxSize) {
    res.status(409).json({ code: 'TEAM_SIZE_MAX', title: `Maximum team size (${maxSize}) reached for ${d.teamSide} team.` });
    return;
  }

  const tmId = newId('tm');
  const now = new Date().toISOString();
  try {
    govDb
      .prepare(
        `INSERT INTO team_member (
          id, society_id, term_id, office_holder_id, team_side, member_id, household_id, role_code, start_date, end_date, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(tmId, sid, activeTerm.id, officeHolder.id, d.teamSide, candidateMember.id, candidateMember.household_id, d.roleCode, now.slice(0, 10), activeTerm.end_date, now);
  } catch {
    res.status(409).json({ code: 'ALREADY_ON_TEAM', title: 'Member is already assigned to a Co-President team for this term.' });
    return;
  }

  coreDb
    .prepare(
      `INSERT INTO role_assignment (id, society_id, member_id, role_code, scope_type, team_side, office_holder_id, valid_from, valid_to, source, term_id, created_at)
       VALUES (?, ?, ?, ?, 'society', ?, ?, ?, ?, 'term', ?, ?)`
    )
    .run(newId('rol'), sid, candidateMember.id, d.roleCode, d.teamSide, officeHolder.id, now, `${activeTerm.end_date}T23:59:59.000Z`, activeTerm.id, now);

  appendAuditEvent({
    societyId: sid,
    actorId: actor.id,
    action: 'governance.team_appointed',
    entityType: 'team_member',
    entityId: tmId,
    after: { member: candidateMember.full_name, roleCode: d.roleCode, teamSide: d.teamSide },
  });

  res.status(201).json({ id: tmId });
});

apiRouter.post('/governance/expense-claims', (req, res) => {
  const actor = requireRole(req, res, CO_PRESIDENTS_AND_TEAM);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const { amountPkr, category, description, receiptRef } = req.body as {
    amountPkr?: number;
    category?: string;
    description?: string;
    receiptRef?: string;
  };
  if (!amountPkr || amountPkr <= 0 || !description) {
    res.status(400).json({ code: 'INVALID_INPUT', title: 'Positive amount and description required.' });
    return;
  }

  // SDS §8.9: Recorded & published as pending_od24, NEVER posted to Village Fund until General Body decides OD-24!
  const id = newId('gec');
  govDb
    .prepare(
      `INSERT INTO gov_expense_claim (
        id, society_id, claimant_member_id, claimant_name, team_side, amount_pkr, category,
        description, receipt_ref, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_od24', ?)`
    )
    .run(
      id,
      sid,
      actor.id,
      actor.full_name,
      actor.team_side,
      amountPkr,
      category || 'Administrative / Kiosk',
      description.trim(),
      receiptRef || `RCPT-${id.toUpperCase()}`,
      new Date().toISOString()
    );

  appendAuditEvent({
    societyId: sid,
    actorId: actor.id,
    action: 'governance.expense_claim_filed',
    entityType: 'gov_expense_claim',
    entityId: id,
    after: { amountPkr, status: 'pending_od24', postedToVf: false },
  });

  res.status(201).json({ id, status: 'pending_od24' });
});

apiRouter.post('/governance/expense-claims/:id/approve', (req, res) => {
  const actor = requireRole(req, res, CO_PRESIDENTS_OR_ADMIN);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const claimId = String(req.params.id);
  const claim = govDb.prepare('SELECT * FROM gov_expense_claim WHERE id = ? AND society_id = ?').get(claimId, sid) as Record<string, any> | undefined;
  if (!claim) {
    res.status(404).json({ code: 'NOT_FOUND', title: 'Claim not found.' });
    return;
  }
  if (claim.claimant_member_id === actor.id) {
    res.status(409).json({ code: 'SELF_APPROVAL_FORBIDDEN', title: 'Claimant cannot approve own reimbursement.' });
    return;
  }
  if (claim.team_side && actor.team_side && claim.team_side === actor.team_side && !actor.roles.includes('portal_admin')) {
    res.status(409).json({ code: 'CROSS_TEAM_REQUIRED', title: 'Cross-team check: another Co-President team must confirm this claim.' });
    return;
  }
  govDb
    .prepare("UPDATE gov_expense_claim SET status = 'approved_unfunded', approved_by = ? WHERE id = ?")
    .run(actor.id, claimId);
  res.json({ ok: true, status: 'approved_unfunded' });
});

apiRouter.post('/governance/conflicts', (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const { category, entityName, description } = req.body as { category?: 'family' | 'business' | 'household'; entityName?: string; description?: string };
  if (!entityName || !description) {
    res.status(400).json({ code: 'INVALID_INPUT', title: 'Entity name and description are required.' });
    return;
  }
  const id = newId('coi');
  govDb
    .prepare(
      `INSERT INTO conflict_declaration (id, society_id, member_id, category, entity_name, description, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
    )
    .run(id, sid, actor.id, category || 'business', entityName.trim(), description.trim(), new Date().toISOString());

  appendAuditEvent({
    societyId: sid,
    actorId: actor.id,
    action: 'governance.coi_declared',
    entityType: 'conflict_declaration',
    entityId: id,
    after: { entityName, category: category || 'business' },
  });
  res.status(201).json({ id });
});

apiRouter.post('/governance/recall', (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const { targetMemberId, targetRoleCode, reason } = req.body as { targetMemberId?: string; targetRoleCode?: string; reason?: string };
  if (!targetMemberId || !reason) {
    res.status(400).json({ code: 'INVALID_INPUT', title: 'Target member and reason are required.' });
    return;
  }

  const minAge = getRuleValue<number>(sid, 'eligibility.min_voting_age', 18);
  const voters = coreDb
    .prepare("SELECT date_of_birth FROM member WHERE society_id = ? AND status = 'active' AND identity_status = 'approved'")
    .all(sid) as Array<{ date_of_birth: string }>;
  const eligibleCount = voters.filter((v) => computeAge(v.date_of_birth) >= minAge).length;
  const share = getRuleValue<number>(sid, 'recall.petition_share', 0.25);
  const required = Math.max(2, Math.ceil(eligibleCount * share));

  const id = newId('rec');
  const now = new Date().toISOString();
  govDb
    .prepare(
      `INSERT INTO recall_petition (id, society_id, target_member_id, target_role_code, reason, required_signatures, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'collecting', ?, ?)`
    )
    .run(id, sid, targetMemberId, targetRoleCode || 'office_holder', reason.trim(), required, actor.id, now);
  govDb.prepare('INSERT INTO recall_signature (petition_id, society_id, member_id, signed_at) VALUES (?, ?, ?, ?)').run(id, sid, actor.id, now);

  res.status(201).json({ id, requiredSignatures: required });
});

apiRouter.post('/governance/recall/:id/sign', (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const petId = String(req.params.id);
  const pet = govDb.prepare('SELECT * FROM recall_petition WHERE id = ? AND society_id = ?').get(petId, sid) as Record<string, any> | undefined;
  if (!pet) {
    res.status(404).json({ code: 'NOT_FOUND', title: 'Petition not found.' });
    return;
  }
  try {
    govDb.prepare('INSERT INTO recall_signature (petition_id, society_id, member_id, signed_at) VALUES (?, ?, ?, ?)').run(petId, sid, actor.id, new Date().toISOString());
  } catch {
    res.status(409).json({ code: 'ALREADY_SIGNED', title: 'You have already signed this recall petition.' });
    return;
  }
  const cnt = (govDb.prepare('SELECT COUNT(*) AS c FROM recall_signature WHERE petition_id = ?').get(petId) as { c: number }).c;
  if (cnt >= pet.required_signatures && pet.status === 'collecting') {
    govDb.prepare("UPDATE recall_petition SET status = 'threshold_met' WHERE id = ?").run(petId);
  }
  res.json({ ok: true, signatureCount: cnt });
});

// ============================================================================
// 6. THREE SEPARATED MONEY STREAMS (FIN / PAY / RECON)
// ============================================================================
apiRouter.get('/public/ledger/summary', (req, res) => {
  const sid = (req as AuthedRequest).societyId;
  const vf = getVfSummary(sid);
  const cl = getClAggregateSummary(sid);

  const inFlightRow = reconDb
    .prepare(
      `SELECT COALESCE(SUM(amount_declared_pkr), 0) AS amt, COUNT(*) AS cnt
       FROM recon_levy_transfer WHERE society_id = ? AND state IN ('announced', 'sent')`
    )
    .get(sid) as { amt: number; cnt: number };

  const opsAgg = opsDb
    .prepare(
      `SELECT COALESCE(SUM(paid_units), 0) AS units,
              COALESCE(SUM(package_revenue_pkr), 0) AS rev,
              COALESCE(SUM(levy_due_pkr), 0) AS levy
       FROM ops_sales_report WHERE society_id = ? AND status = 'submitted'`
    )
    .get(sid) as { units: number; rev: number; levy: number };

  res.json({
    separationRule:
      'Village Fund (VF), Contributor Ledger (CL), and VilloThar Operations are kept in strictly separate bank accounts and ledgers.',
    villageFund: {
      ...vf,
      transfersInFlightPkr: inFlightRow.amt,
      transfersInFlightCount: inFlightRow.cnt,
    },
    contributorLedgerAggregate: cl,
    operationsReported: {
      totalPackagesSold: opsAgg.units,
      totalPackageRevenuePkr: opsAgg.rev,
      totalLevyReportedPkr: opsAgg.levy,
    },
  });
});

apiRouter.get('/vf/entries', (req, res) => {
  const sid = (req as AuthedRequest).societyId;
  const entries = vfDb
    .prepare('SELECT * FROM vf_journal_entry WHERE society_id = ? ORDER BY entry_date DESC, created_at DESC')
    .all(sid) as Array<Record<string, any>>;
  const enriched = entries.map((e) => {
    const lines = vfDb
      .prepare(
        `SELECT l.debit_pkr, l.credit_pkr, a.code, a.name
         FROM vf_journal_line l JOIN vf_account a ON a.id = l.account_id WHERE l.entry_id = ?`
      )
      .all(e.id);
    const amountPkr = (lines as Array<{ debit_pkr: number }>).reduce((acc, l) => acc + l.debit_pkr, 0);
    return { ...e, amountPkr, lines };
  });
  res.json({ entries: enriched });
});

apiRouter.get('/vf/levy-history', (req, res) => {
  const sid = (req as AuthedRequest).societyId;
  const history = vfDb.prepare('SELECT * FROM levy_configuration WHERE society_id = ? ORDER BY created_at DESC').all(sid);
  res.json({ history });
});

apiRouter.post('/vf/levy-config', (req, res) => {
  const actor = requireRole(req, res, FINANCE_APPROVERS);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const { amountPkr, resolutionCode } = req.body as { amountPkr?: number; resolutionCode?: string };
  if (amountPkr === undefined || amountPkr < 0 || !resolutionCode) {
    res.status(400).json({ code: 'INVALID_INPUT', title: 'Valid levy amount and General Body resolution code are required.' });
    return;
  }

  const cap = getRuleValue<number>(sid, 'levy.cap_pkr', 100);
  if (amountPkr > cap) {
    res.status(422).json({
      code: 'LEVY_EXCEEDS_CAP',
      title: `AC-FIN-02: Proposed levy Rs. ${amountPkr} exceeds constitutional cap of Rs. ${cap}.`,
    });
    return;
  }

  const now = new Date().toISOString();
  vfDb.prepare("UPDATE levy_configuration SET status = 'superseded' WHERE society_id = ? AND status = 'active'").run(sid);
  const id = newId('levy');
  vfDb
    .prepare(
      `INSERT INTO levy_configuration (id, society_id, amount_pkr, cap_at_time_pkr, effective_from, resolution_id, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`
    )
    .run(id, sid, amountPkr, cap, now, resolutionCode, actor.id, now);

  appendAuditEvent({
    societyId: sid,
    actorId: actor.id,
    action: 'vf.levy_updated',
    entityType: 'levy_configuration',
    entityId: id,
    after: { amountPkr, cap, resolutionCode },
  });

  res.status(201).json({ id, amountPkr, cap });
});

apiRouter.post('/vf/entries/:id/reverse', (req, res) => {
  const actor = requireRole(req, res, FINANCE_APPROVERS);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const entryId = String(req.params.id);
  const { reason } = req.body as { reason?: string };

  const orig = vfDb
    .prepare('SELECT * FROM vf_journal_entry WHERE id = ? AND society_id = ?')
    .get(entryId, sid) as Record<string, any> | undefined;
  if (!orig) {
    res.status(404).json({ code: 'ENTRY_NOT_FOUND', title: 'Village Fund entry not found.' });
    return;
  }
  if (orig.reverses_entry_id) {
    res.status(409).json({ code: 'ALREADY_REVERSAL', title: 'Cannot reverse a reversal entry.' });
    return;
  }
  if (orig.actor_id === actor.id) {
    res.status(409).json({
      code: 'MAKER_CHECKER_VIOLATION',
      title: 'AC-FIN-03: Reversal must be confirmed by a different officer from the original preparer.',
    });
    return;
  }
  const alreadyReversed = vfDb
    .prepare('SELECT id FROM vf_journal_entry WHERE reverses_entry_id = ?')
    .get(entryId);
  if (alreadyReversed) {
    res.status(409).json({ code: 'ALREADY_REVERSED', title: 'This entry has already been reversed.' });
    return;
  }

  const origLines = vfDb
    .prepare(
      `SELECT l.debit_pkr, l.credit_pkr, a.code
       FROM vf_journal_line l JOIN vf_account a ON a.id = l.account_id WHERE l.entry_id = ?`
    )
    .all(entryId) as Array<{ debit_pkr: number; credit_pkr: number; code: string }>;

  const rev = postVfEntry({
    societyId: sid,
    refNo: `VF-REV-${Date.now().toString(36).toUpperCase()}`,
    entryDate: new Date().toISOString().slice(0, 10),
    category: 'reversal',
    description: `Reversal of ${orig.ref_no}: ${reason || 'Audit correction'}`,
    sourceType: orig.source_type,
    sourceId: orig.source_id,
    idempotencyKey: `vf-rev-${entryId}`,
    actorId: orig.actor_id,
    approverId: actor.id,
    reversesEntryId: entryId,
    projectId: orig.project_id ?? null,
    lines: origLines.map((l) => ({
      accountCode: l.code,
      debitPkr: l.credit_pkr,
      creditPkr: l.debit_pkr,
    })),
  });

  res.status(201).json({ ok: true, reversalEntryId: rev.entryId, refNo: rev.refNo });
});

// CL Private Endpoints (AC-CON-01: strictly private to contributor self, treasurers, co-presidents, or auditor!)
apiRouter.get('/cl/contributors', (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const privileged = actor.roles.some((r) => [...FINANCE_APPROVERS, 'auditor'].includes(r));

  const rows = clDb
    .prepare('SELECT * FROM cl_contributor WHERE society_id = ? ORDER BY created_at ASC')
    .all(sid) as Array<Record<string, any>>;

  const visible = privileged ? rows : rows.filter((c) => c.member_id === actor.id);
  const enriched = visible.map((c) => {
    const agreements = clDb.prepare('SELECT * FROM cl_agreement WHERE contributor_id = ?').all(c.id);
    const contributions = clDb.prepare('SELECT * FROM cl_contribution WHERE contributor_id = ?').all(c.id) as Array<{ amount_pkr: number }>;
    const distributions = clDb.prepare('SELECT * FROM cl_return_distribution WHERE contributor_id = ?').all(c.id) as Array<{ amount_pkr: number; status: string }>;
    return {
      id: c.id,
      member_id: c.member_id,
      display_name: c.display_name,
      payout_masked: c.payout_masked,
      status: c.status,
      totalContributedPkr: contributions.reduce((a, x) => a + x.amount_pkr, 0),
      totalReturnedPkr: distributions.filter((d) => d.status === 'paid').reduce((a, x) => a + x.amount_pkr, 0),
      agreements,
      contributions,
      distributions,
    };
  });

  const invoices = clDb.prepare('SELECT * FROM cl_infra_invoice WHERE society_id = ? ORDER BY created_at DESC').all(sid);
  const calculations = clDb.prepare('SELECT * FROM cl_return_calculation WHERE society_id = ? ORDER BY created_at DESC').all(sid);
  const journalEntries = clDb.prepare('SELECT * FROM cl_journal_entry WHERE society_id = ? ORDER BY created_at DESC').all(sid);

  res.json({
    contributors: enriched,
    infraInvoices: invoices,
    returnCalculations: calculations,
    journalEntries,
  });
});

apiRouter.post('/cl/contributors', (req, res) => {
  const actor = requireRole(req, res, FINANCE_APPROVERS);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const { displayName, contact, payoutAccount, amountPkr, revenueShareBps = 350, returnCapMultiplier = 1.25 } = req.body as {
    displayName?: string;
    contact?: string;
    payoutAccount?: string;
    amountPkr?: number;
    revenueShareBps?: number;
    returnCapMultiplier?: number;
  };
  if (!displayName || !amountPkr || amountPkr <= 0) {
    res.status(400).json({ code: 'INVALID_INPUT', title: 'Display name and positive amount required.' });
    return;
  }

  const conId = newId('con');
  const agrId = newId('agr');
  const now = new Date().toISOString();
  const masked = payoutAccount ? `${payoutAccount.slice(0, 6)}••••••${payoutAccount.slice(-3)}` : 'PK00XXXX•••••000';

  clDb
    .prepare(
      `INSERT INTO cl_contributor (id, society_id, display_name, contact_enc, payout_account_enc, payout_masked, public_consent, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'active', ?)`
    )
    .run(conId, sid, displayName.trim(), encryptField(contact || '+923000000000'), encryptField(payoutAccount || 'PK00BANK0000'), masked, now);

  clDb
    .prepare(
      `INSERT INTO cl_agreement (id, society_id, contributor_id, version, document_ref, revenue_share_bps, return_cap_multiplier, accepted_at)
       VALUES (?, ?, ?, 'v1.0', ?, ?, ?, ?)`
    )
    .run(agrId, sid, conId, `DOC-${conId}.pdf`, revenueShareBps, returnCapMultiplier, now);

  const entry = postClEntry({
    societyId: sid,
    refNo: `CL-${Date.now().toString(36).toUpperCase()}`,
    entryDate: now.slice(0, 10),
    category: 'capital_receipt',
    description: `Infrastructure capital received (${conId})`,
    sourceType: 'cl_contribution',
    sourceId: conId,
    idempotencyKey: `cl-cap-${conId}`,
    actorId: actor.id,
    lines: [
      { accountCode: '1100', debitPkr: amountPkr, creditPkr: 0 },
      { accountCode: '2100', debitPkr: 0, creditPkr: amountPkr },
    ],
  });

  clDb
    .prepare(
      `INSERT INTO cl_contribution (id, society_id, contributor_id, agreement_id, amount_pkr, bank_line_ref, journal_entry_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(newId('contrib'), sid, conId, agrId, amountPkr, `IBFT-${conId}`, entry.entryId, now);

  res.status(201).json({ id: conId, entryId: entry.entryId });
});

apiRouter.post('/cl/return-calculations', (req, res) => {
  const actor = requireRole(req, res, FINANCE_APPROVERS);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const { periodLabel, revenueReportId } = req.body as { periodLabel?: string; revenueReportId?: string };

  const revReport = revenueReportId
    ? (opsDb.prepare('SELECT * FROM ops_revenue_report WHERE id = ? AND society_id = ?').get(revenueReportId, sid) as Record<string, any> | undefined)
    : (opsDb.prepare('SELECT * FROM ops_revenue_report WHERE society_id = ? ORDER BY submitted_at DESC LIMIT 1').get(sid) as Record<string, any> | undefined);

  if (!revReport) {
    res.status(404).json({ code: 'REVENUE_REPORT_REQUIRED', title: 'OPS revenue report is required before calculating contributor returns.' });
    return;
  }

  const calcId = newId('clc');
  const poolPkr = Math.round(revReport.package_revenue_basis_pkr * 0.08);
  const now = new Date().toISOString();

  clDb
    .prepare(
      `INSERT INTO cl_return_calculation (
        id, society_id, period_label, revenue_basis_pkr, revenue_report_id, pool_amount_pkr,
        formula_version, status, prepared_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'v1.1-pro-rata', 'draft', ?, ?)`
    )
    .run(calcId, sid, periodLabel || revReport.period_label, revReport.package_revenue_basis_pkr, revReport.id, poolPkr, actor.id, now);

  const contribs = clDb
    .prepare('SELECT contributor_id, SUM(amount_pkr) AS total FROM cl_contribution WHERE society_id = ? GROUP BY contributor_id')
    .all(sid) as Array<{ contributor_id: string; total: number }>;
  const grandTotal = contribs.reduce((a, c) => a + c.total, 0) || 1;

  for (const c of contribs) {
    const shareAmt = Math.round((c.total / grandTotal) * poolPkr);
    clDb
      .prepare(
        `INSERT INTO cl_return_distribution (id, society_id, calc_id, contributor_id, amount_pkr, status)
         VALUES (?, ?, ?, ?, ?, 'calculated')`
      )
      .run(newId('cld'), sid, calcId, c.contributor_id, shareAmt);
  }

  appendAuditEvent({
    societyId: sid,
    actorId: actor.id,
    action: 'cl.returns_calculated',
    entityType: 'cl_return_calculation',
    entityId: calcId,
    after: { poolPkr, revenueBasis: revReport.package_revenue_basis_pkr },
  });

  res.status(201).json({ id: calcId, poolPkr });
});

apiRouter.post('/cl/return-calculations/:id/approve', (req, res) => {
  const actor = requireRole(req, res, FINANCE_APPROVERS);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const calcId = String(req.params.id);

  const calc = clDb.prepare('SELECT * FROM cl_return_calculation WHERE id = ? AND society_id = ?').get(calcId, sid) as Record<string, any> | undefined;
  if (!calc) {
    res.status(404).json({ code: 'NOT_FOUND', title: 'Calculation not found.' });
    return;
  }
  if (calc.prepared_by === actor.id) {
    res.status(409).json({ code: 'MAKER_CHECKER_VIOLATION', title: 'Preparer cannot approve and distribute own CL return calculation.' });
    return;
  }

  postClEntry({
    societyId: sid,
    refNo: `CL-RET-${Date.now().toString(36).toUpperCase()}`,
    entryDate: new Date().toISOString().slice(0, 10),
    category: 'return_distribution',
    description: `Contributor returns distributed (${calc.period_label})`,
    sourceType: 'cl_return_calculation',
    sourceId: calcId,
    idempotencyKey: `cl-ret-${calcId}`,
    actorId: calc.prepared_by,
    approverId: actor.id,
    lines: [
      { accountCode: '2200', debitPkr: calc.pool_amount_pkr, creditPkr: 0 },
      { accountCode: '1100', debitPkr: 0, creditPkr: calc.pool_amount_pkr },
    ],
  });

  clDb.prepare("UPDATE cl_return_calculation SET status = 'distributed', approved_by = ? WHERE id = ?").run(actor.id, calcId);
  clDb.prepare("UPDATE cl_return_distribution SET status = 'paid', payout_ref = ? WHERE calc_id = ?").run(`PAYOUT-${calcId}`, calcId);

  res.json({ ok: true, status: 'distributed' });
});

// Packages & Purchases (PAY — AC-FIN-05 failed/pending excluded from collections!)
apiRouter.get('/packages', (req, res) => {
  const sid = (req as AuthedRequest).societyId;
  const packages = opsDb.prepare('SELECT * FROM pay_package WHERE society_id = ? AND active = 1 ORDER BY price_pkr ASC').all(sid);
  const vf = getVfSummary(sid);
  const purchases = opsDb.prepare('SELECT * FROM pay_purchase WHERE society_id = ? ORDER BY created_at DESC LIMIT 30').all(sid);
  res.json({ packages, activeLevyPkr: vf.activeLevyPkr, purchases });
});

apiRouter.post('/purchases', (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const { packageId, simulateStatus = 'paid' } = req.body as { packageId?: string; simulateStatus?: 'paid' | 'pending' | 'failed' };
  if (!packageId) {
    res.status(400).json({ code: 'INVALID_INPUT', title: 'packageId is required.' });
    return;
  }
  const pkg = opsDb.prepare('SELECT * FROM pay_package WHERE id = ? AND society_id = ?').get(packageId, sid) as Record<string, any> | undefined;
  if (!pkg) {
    res.status(404).json({ code: 'PACKAGE_NOT_FOUND', title: 'Package not found.' });
    return;
  }

  const vf = getVfSummary(sid);
  const levy = vf.activeLevyPkr;
  const total = pkg.price_pkr + levy;
  const id = newId('pur');

  opsDb
    .prepare(
      `INSERT INTO pay_purchase (
        id, society_id, member_id, member_name, package_id, package_name,
        price_pkr, levy_pkr, total_pkr, status, idempotency_key, followup_note, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      sid,
      actor.id,
      actor.full_name,
      pkg.id,
      pkg.name_en,
      pkg.price_pkr,
      levy,
      total,
      simulateStatus,
      `pur-${id}`,
      simulateStatus === 'failed' ? 'Simulated gateway timeout (excluded from totals)' : simulateStatus === 'pending' ? 'Awaiting confirmation (excluded from totals)' : null,
      new Date().toISOString()
    );

  // AC-FIN-05: Only 'paid' purchases count towards collections; purchase NEVER directly posts VF cash!
  res.status(201).json({ id, status: simulateStatus, pricePkr: pkg.price_pkr, levyPkr: levy, totalPkr: total });
});

// VilloThar OPS & Three-Way Reconciliation (RECON — AC-FIN-01/03)
apiRouter.get('/ops/reconciliation', (req, res) => {
  const sid = (req as AuthedRequest).societyId;
  const salesReports = opsDb.prepare('SELECT * FROM ops_sales_report WHERE society_id = ? ORDER BY period_end DESC').all(sid);
  const revenueReports = opsDb.prepare('SELECT * FROM ops_revenue_report WHERE society_id = ? ORDER BY submitted_at DESC').all(sid);
  const transfers = reconDb.prepare('SELECT * FROM recon_levy_transfer WHERE society_id = ? ORDER BY declared_at DESC').all(sid);
  const bankLines = reconDb.prepare('SELECT * FROM recon_bank_statement_line WHERE society_id = ? ORDER BY value_date DESC').all(sid);
  const matches = reconDb.prepare('SELECT * FROM recon_match WHERE society_id = ? ORDER BY matched_at DESC').all(sid);
  res.json({ salesReports, revenueReports, transfers, bankLines, matches });
});

apiRouter.post('/ops/sales-reports', (req, res) => {
  const actor = requireRole(req, res, ['villothar_ops', 'portal_admin']);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const { periodLabel, paidUnits, packageRevenuePkr, transferRef } = req.body as {
    periodLabel?: string;
    paidUnits?: number;
    packageRevenuePkr?: number;
    transferRef?: string;
  };
  if (!periodLabel || !paidUnits || !packageRevenuePkr) {
    res.status(400).json({ code: 'INVALID_INPUT', title: 'periodLabel, paidUnits, and packageRevenuePkr are required.' });
    return;
  }

  const vf = getVfSummary(sid);
  const levyDue = paidUnits * vf.activeLevyPkr;
  const srId = newId('opssr');
  const trId = newId('tr');
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const ref = transferRef || `IBFT-VT-${Date.now().toString().slice(-5)}`;

  opsDb
    .prepare(
      `INSERT INTO ops_sales_report (
        id, society_id, period_label, period_start, period_end, version, status,
        paid_units, package_revenue_pkr, levy_due_pkr, submitted_by, submitted_at, file_hash, note
      ) VALUES (?, ?, ?, ?, ?, 1, 'submitted', ?, ?, ?, ?, ?, ?, 'Submitted via VilloThar OPS Portal')`
    )
    .run(srId, sid, periodLabel, today, today, paidUnits, packageRevenuePkr, levyDue, actor.id, now, canonicalHash({ periodLabel, paidUnits, packageRevenuePkr }));

  postVfEntry({
    societyId: sid,
    refNo: `VF-DUE-${Date.now().toString(36).toUpperCase()}`,
    entryDate: today,
    category: 'levy_due',
    description: `Levy due from VilloThar (${periodLabel}: ${paidUnits} × Rs. ${vf.activeLevyPkr})`,
    sourceType: 'ops_sales_report',
    sourceId: srId,
    idempotencyKey: `vf-due-${srId}`,
    actorId: actor.id,
    lines: [
      { accountCode: '1200', debitPkr: levyDue, creditPkr: 0 },
      { accountCode: '4000', debitPkr: 0, creditPkr: levyDue },
    ],
  });

  // Create 'sent' transfer + unmatched bank line (does NOT enter VF balance until Treasurer confirms!)
  reconDb
    .prepare(
      `INSERT INTO recon_levy_transfer (
        id, society_id, period_label, amount_expected_pkr, amount_declared_pkr, reference_no,
        state, declared_by, declared_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'sent', ?, ?)`
    )
    .run(trId, sid, periodLabel, levyDue, levyDue, ref, actor.id, now);

  reconDb
    .prepare(
      `INSERT INTO recon_bank_statement_line (id, society_id, bank_account_id, domain, value_date, amount_pkr, narrative, bank_ref, matched)
       VALUES (?, ?, ?, 'VF', ?, ?, ?, ?, 0)`
    )
    .run(newId('bsl'), sid, `${sid}-bank-vf`, today, levyDue, `IBFT VILLOTHAR LEVY ${periodLabel}`, ref);

  res.status(201).json({ salesReportId: srId, transferId: trId, levyDue, state: 'sent' });
});

apiRouter.post('/recon/transfers/:id/confirm', (req, res) => {
  const actor = requireRole(req, res, ['treasurer', 'woman_co_president', 'man_co_president', 'portal_admin']);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const trId = String(req.params.id);
  const { bankStatementLineId } = req.body as { bankStatementLineId?: string };

  const transfer = reconDb.prepare('SELECT * FROM recon_levy_transfer WHERE id = ? AND society_id = ?').get(trId, sid) as Record<string, any> | undefined;
  if (!transfer) {
    res.status(404).json({ code: 'TRANSFER_NOT_FOUND', title: 'Transfer not found.' });
    return;
  }
  if (transfer.state === 'confirmed') {
    res.status(409).json({ code: 'ALREADY_CONFIRMED', title: 'Transfer already confirmed and reconciled.' });
    return;
  }

  const bankLine = bankStatementLineId
    ? (reconDb.prepare('SELECT * FROM recon_bank_statement_line WHERE id = ? AND society_id = ?').get(bankStatementLineId, sid) as Record<string, any> | undefined)
    : (reconDb.prepare("SELECT * FROM recon_bank_statement_line WHERE society_id = ? AND domain = 'VF' AND matched = 0 AND bank_ref = ?").get(sid, transfer.reference_no) as Record<string, any> | undefined);

  if (!bankLine || bankLine.matched === 1) {
    res.status(422).json({ code: 'BANK_LINE_REQUIRED', title: 'Matching unmatched VF bank statement line is required before confirmation.' });
    return;
  }
  if (bankLine.amount_pkr !== transfer.amount_declared_pkr) {
    res.status(409).json({ code: 'AMOUNT_MISMATCH', title: 'Bank statement amount does not match declared transfer amount.' });
    return;
  }

  const now = new Date().toISOString();
  const vfRec = postVfEntry({
    societyId: sid,
    refNo: `VF-REC-${Date.now().toString(36).toUpperCase()}`,
    entryDate: bankLine.value_date,
    category: 'levy_received',
    description: `Levy transfer confirmed on VF bank statement (${transfer.period_label})`,
    sourceType: 'recon_levy_transfer',
    sourceId: trId,
    idempotencyKey: `vf-rec-${trId}`,
    actorId: actor.id,
    evidenceRef: bankLine.bank_ref,
    lines: [
      { accountCode: '1100', debitPkr: transfer.amount_declared_pkr, creditPkr: 0 },
      { accountCode: '1200', debitPkr: 0, creditPkr: transfer.amount_declared_pkr },
    ],
  });

  reconDb.prepare("UPDATE recon_bank_statement_line SET matched = 1 WHERE id = ?").run(bankLine.id);
  reconDb
    .prepare("UPDATE recon_levy_transfer SET state = 'confirmed', confirmed_by = ?, confirmed_at = ?, vf_entry_id = ? WHERE id = ?")
    .run(actor.id, now, vfRec.entryId, trId);
  reconDb
    .prepare('INSERT INTO recon_match (id, society_id, statement_line_id, domain, entry_id, transfer_id, matched_by, matched_at) VALUES (?, ?, ?, \'VF\', ?, ?, ?, ?)')
    .run(newId('rm'), sid, bankLine.id, vfRec.entryId, trId, actor.id, now);

  res.json({ ok: true, vfEntryId: vfRec.entryId });
});

apiRouter.post('/recon/transfers/:id/dispute', (req, res) => {
  const actor = requireRole(req, res, FINANCE_APPROVERS);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const trId = String(req.params.id);
  const { reason } = req.body as { reason?: string };
  reconDb
    .prepare("UPDATE recon_levy_transfer SET state = 'disputed', dispute_reason = ? WHERE id = ? AND society_id = ?")
    .run(reason || 'Amount or bank reference mismatch', trId, sid);
  res.json({ ok: true, state: 'disputed' });
});

// ============================================================================
// 7. PARTICIPATORY PROJECTS & CROSS-TEAM + COI EXPENSES (PRJ)
// ============================================================================
apiRouter.get('/projects', (req, res) => {
  const sid = (req as AuthedRequest).societyId;
  const projects = prjDb.prepare('SELECT * FROM prj_proposal WHERE society_id = ? ORDER BY created_at DESC').all(sid) as Array<Record<string, any>>;

  const enriched = projects.map((p) => {
    const expenses = prjDb
      .prepare('SELECT * FROM prj_expense_request WHERE project_id = ? ORDER BY created_at DESC')
      .all(p.id) as Array<Record<string, any>>;
    const spentPkr = expenses.filter((e) => e.status === 'approved').reduce((acc, e) => acc + e.amount_pkr, 0);
    return { ...p, spentPkr, expenses };
  });

  res.json({ projects: enriched });
});

apiRouter.post('/projects', (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const { titleEn, titleSd, titleUr, descriptionEn, category, estBudgetPkr, impactText, levyEffectText, submissionChannel = 'portal' } = req.body as {
    titleEn?: string;
    titleSd?: string;
    titleUr?: string;
    descriptionEn?: string;
    category?: string;
    estBudgetPkr?: number;
    impactText?: string;
    levyEffectText?: string;
    submissionChannel?: 'portal' | 'helper' | 'general_body';
  };
  if (!titleEn || !descriptionEn || !estBudgetPkr || estBudgetPkr <= 0) {
    res.status(400).json({ code: 'INVALID_INPUT', title: 'Title, description, and positive budget estimate are required.' });
    return;
  }

  const countRow = prjDb.prepare('SELECT COUNT(*) AS cnt FROM prj_proposal WHERE society_id = ?').get(sid) as { cnt: number };
  const refNo = `PRJ-2026-${String(countRow.cnt + 1).padStart(2, '0')}`;
  const id = newId('prj');
  const now = new Date().toISOString();

  prjDb
    .prepare(
      `INSERT INTO prj_proposal (
        id, society_id, reference_no, member_id, proposer_name, submission_channel,
        title_en, title_sd, title_ur, description_en, description_sd, description_ur,
        category, est_budget_pkr, impact_text, levy_effect_text, state, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposal', ?)`
    )
    .run(
      id,
      sid,
      refNo,
      actor.id,
      actor.full_name,
      submissionChannel,
      titleEn.trim(),
      titleSd || titleEn.trim(),
      titleUr || titleEn.trim(),
      descriptionEn.trim(),
      descriptionEn.trim(),
      descriptionEn.trim(),
      category || 'Community Infrastructure',
      estBudgetPkr,
      impactText || 'Benefits all villagers equally',
      levyEffectText || 'No increase to Rs. 50 levy',
      now
    );

  appendAuditEvent({
    societyId: sid,
    actorId: actor.id,
    action: 'project.proposed',
    entityType: 'prj_proposal',
    entityId: id,
    after: { referenceNo: refNo, estBudgetPkr, channel: submissionChannel },
  });

  res.status(201).json({ id, referenceNo: refNo });
});

apiRouter.patch('/projects/:id/stage', (req, res) => {
  const actor = requireRole(req, res, CO_PRESIDENTS_AND_TEAM);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const prjId = String(req.params.id);
  const { nextState, feasibilityNote, explainerSummarySd, finalReportText } = req.body as {
    nextState?: string;
    feasibilityNote?: string;
    explainerSummarySd?: string;
    finalReportText?: string;
  };
  if (!nextState) {
    res.status(400).json({ code: 'INVALID_INPUT', title: 'nextState is required.' });
    return;
  }

  prjDb
    .prepare(
      `UPDATE prj_proposal
       SET state = ?,
           feasibility_status = CASE WHEN ? IN ('explainer','discussion') THEN 'feasible' ELSE feasibility_status END,
           feasibility_note = COALESCE(?, feasibility_note),
           explainer_summary_sd = COALESCE(?, explainer_summary_sd),
           final_report_text = COALESCE(?, final_report_text)
       WHERE id = ? AND society_id = ?`
    )
    .run(nextState, nextState, feasibilityNote ?? null, explainerSummarySd ?? null, finalReportText ?? null, prjId, sid);

  appendAuditEvent({
    societyId: sid,
    actorId: actor.id,
    action: 'project.stage_updated',
    entityType: 'prj_proposal',
    entityId: prjId,
    after: { nextState },
  });

  res.json({ ok: true, state: nextState });
});

apiRouter.post('/projects/:id/expenses', (req, res) => {
  const actor = requireRole(req, res, FINANCE_APPROVERS);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const prjId = String(req.params.id);
  const { amountPkr, vendorName, description, invoiceDocRef } = req.body as {
    amountPkr?: number;
    vendorName?: string;
    description?: string;
    invoiceDocRef?: string;
  };
  if (!amountPkr || amountPkr <= 0 || !vendorName || !description) {
    res.status(400).json({ code: 'INVALID_INPUT', title: 'Positive amount, vendor, and description are required.' });
    return;
  }

  const prj = prjDb.prepare('SELECT * FROM prj_proposal WHERE id = ? AND society_id = ?').get(prjId, sid) as Record<string, any> | undefined;
  if (!prj || !['execution', 'reporting', 'approved'].includes(prj.state)) {
    res.status(409).json({ code: 'PROJECT_NOT_APPROVED', title: 'Project must be approved / in execution before requesting VF expenses.' });
    return;
  }

  const id = newId('exp');
  prjDb
    .prepare(
      `INSERT INTO prj_expense_request (
        id, society_id, project_id, amount_pkr, vendor_name, description, invoice_doc_ref,
        requested_by, requested_team_side, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    )
    .run(
      id,
      sid,
      prjId,
      amountPkr,
      vendorName.trim(),
      description.trim(),
      invoiceDocRef || `INV-${id.toUpperCase()}.pdf`,
      actor.id,
      actor.team_side,
      new Date().toISOString()
    );

  res.status(201).json({ id, requestedTeamSide: actor.team_side });
});

apiRouter.post('/projects/:id/expenses/:expId/approve', (req, res) => {
  const actor = requireRole(req, res, CO_PRESIDENTS_AND_TEAM);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const prjId = String(req.params.id);
  const expId = String(req.params.expId);

  const prj = prjDb.prepare('SELECT * FROM prj_proposal WHERE id = ? AND society_id = ?').get(prjId, sid) as Record<string, any> | undefined;
  const exp = prjDb.prepare('SELECT * FROM prj_expense_request WHERE id = ? AND project_id = ?').get(expId, prjId) as Record<string, any> | undefined;
  if (!prj || !exp) {
    res.status(404).json({ code: 'NOT_FOUND', title: 'Expense request or project not found.' });
    return;
  }
  if (exp.status !== 'pending') {
    res.status(409).json({ code: 'ALREADY_PROCESSED', title: `Expense request already ${exp.status}.` });
    return;
  }

  // Maker != Checker
  if (exp.requested_by === actor.id) {
    res.status(409).json({ code: 'MAKER_CHECKER_VIOLATION', title: 'AC-FIN-03: Preparer cannot approve their own expense request.' });
    return;
  }

  // Cross-team maker-checker (FR-FIN-012 / TC-27)
  if (exp.requested_team_side && actor.team_side && exp.requested_team_side === actor.team_side) {
    res.status(409).json({
      code: 'CROSS_TEAM_APPROVAL_REQUIRED',
      title: `FR-FIN-012 / TC-27: Prepared on ${exp.requested_team_side} Co-President team; approval must come from the other Co-President's team.`,
    });
    return;
  }

  // Conflict of Interest Recusal (BR-19 / AC-PRJ-02)
  const conflicts = govDb
    .prepare('SELECT entity_name FROM conflict_declaration WHERE society_id = ? AND member_id = ? AND active = 1')
    .all(sid, actor.id) as Array<{ entity_name: string }>;

  const vendorLower = String(exp.vendor_name).toLowerCase();
  const matchedCoi = conflicts.find(
    (c) => vendorLower.includes(c.entity_name.toLowerCase()) || c.entity_name.toLowerCase().includes(vendorLower)
  );
  if (matchedCoi) {
    res.status(409).json({
      code: 'COI_RECUSAL_REQUIRED',
      title: `AC-PRJ-02: Conflict of interest recusal required (${matchedCoi.entity_name}). Another non-conflicted officer must approve.`,
    });
    return;
  }

  // Check allocated budget
  const spentRow = prjDb
    .prepare("SELECT COALESCE(SUM(amount_pkr), 0) AS spent FROM prj_expense_request WHERE project_id = ? AND status = 'approved'")
    .get(prjId) as { spent: number };
  if (spentRow.spent + exp.amount_pkr > prj.allocated_budget_pkr) {
    res.status(422).json({
      code: 'OVER_BUDGET',
      title: `AC-PRJ-01: Expense exceeds remaining allocated budget (Allocated Rs. ${prj.allocated_budget_pkr}, already spent Rs. ${spentRow.spent}).`,
    });
    return;
  }

  const vfEntry = postVfEntry({
    societyId: sid,
    refNo: `VF-EXP-${Date.now().toString(36).toUpperCase()}`,
    entryDate: new Date().toISOString().slice(0, 10),
    category: 'project_expense',
    description: `${prj.title_en} — ${exp.vendor_name}: ${exp.description}`,
    sourceType: 'prj_expense_request',
    sourceId: expId,
    idempotencyKey: `vf-prj-exp-${expId}`,
    actorId: exp.requested_by,
    approverId: actor.id,
    projectId: prjId,
    evidenceRef: exp.invoice_doc_ref,
    lines: [
      { accountCode: '5000', debitPkr: exp.amount_pkr, creditPkr: 0 },
      { accountCode: '1100', debitPkr: 0, creditPkr: exp.amount_pkr },
    ],
  });

  prjDb
    .prepare("UPDATE prj_expense_request SET status = 'approved', approved_by = ?, vf_entry_id = ? WHERE id = ?")
    .run(actor.id, vfEntry.entryId, expId);

  res.json({ ok: true, vfEntryId: vfEntry.entryId });
});

// ============================================================================
// 8. COMMUNITY: ISSUES (place_text + public/executive_only), Q&A, NOTICES, MEDIA
// ============================================================================
apiRouter.get('/issues', (req, res) => {
  const areq = req as AuthedRequest;
  const sid = areq.societyId;
  const auth = areq.authMember;
  const isOfficer = auth && auth.society_id === sid && auth.roles.some((r) => [...CO_PRESIDENTS_AND_TEAM, 'auditor'].includes(r));

  const issues = commDb.prepare('SELECT * FROM comm_issue WHERE society_id = ? ORDER BY created_at DESC').all(sid) as Array<Record<string, any>>;
  // AC-ISS-01: Confidential 'executive_only' issues hidden from general public unless reporter or officer
  const visible = issues.filter((iss) => {
    if (iss.visibility === 'public') return true;
    if (isOfficer) return true;
    if (auth && iss.reporter_member_id === auth.id) return true;
    return false;
  });

  res.json({ issues: visible });
});

apiRouter.post('/issues', (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const { placeText, category, description, visibility = 'public' } = req.body as {
    placeText?: string;
    category?: string;
    description?: string;
    visibility?: 'public' | 'executive_only';
  };
  if (!placeText || !description) {
    res.status(400).json({ code: 'INVALID_INPUT', title: 'Place/landmark description and issue details are required.' });
    return;
  }

  const id = newId('iss');
  commDb
    .prepare(
      `INSERT INTO comm_issue (
        id, society_id, reporter_member_id, reporter_name, place_text, category,
        description, visibility, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
    )
    .run(id, sid, actor.id, actor.full_name, placeText.trim(), category || 'Other', description.trim(), visibility, new Date().toISOString());

  res.status(201).json({ id });
});

apiRouter.patch('/issues/:id', (req, res) => {
  const actor = requireRole(req, res, CO_PRESIDENTS_AND_TEAM);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const issId = String(req.params.id);
  const { status, executiveResponse, convertToProject } = req.body as {
    status?: string;
    executiveResponse?: string;
    convertToProject?: boolean;
  };

  const iss = commDb.prepare('SELECT * FROM comm_issue WHERE id = ? AND society_id = ?').get(issId, sid) as Record<string, any> | undefined;
  if (!iss) {
    res.status(404).json({ code: 'NOT_FOUND', title: 'Issue not found.' });
    return;
  }

  let projectId = iss.converted_project_id;
  if (convertToProject && !projectId) {
    projectId = newId('prj');
    const countRow = prjDb.prepare('SELECT COUNT(*) AS cnt FROM prj_proposal WHERE society_id = ?').get(sid) as { cnt: number };
    const refNo = `PRJ-2026-${String(countRow.cnt + 1).padStart(2, '0')}`;
    prjDb
      .prepare(
        `INSERT INTO prj_proposal (
          id, society_id, reference_no, member_id, proposer_name, submission_channel,
          title_en, title_sd, title_ur, description_en, description_sd, description_ur,
          category, est_budget_pkr, impact_text, state, source_issue_id, created_at
        ) VALUES (?, ?, ?, ?, ?, 'portal', ?, ?, ?, ?, ?, ?, ?, 25000, ?, 'proposal', ?, ?)`
      )
      .run(
        projectId,
        sid,
        refNo,
        iss.reporter_member_id,
        iss.reporter_name,
        `Resolve: ${iss.category} (${iss.place_text})`,
        `حل: ${iss.category} (${iss.place_text})`,
        `حل: ${iss.category} (${iss.place_text})`,
        iss.description,
        iss.description,
        iss.description,
        iss.category,
        `Addresses community issue at ${iss.place_text}`,
        issId,
        new Date().toISOString()
      );
  }

  commDb
    .prepare(
      `UPDATE comm_issue SET status = ?, executive_response = COALESCE(?, executive_response),
       assignee_member_id = COALESCE(assignee_member_id, ?), converted_project_id = COALESCE(?, converted_project_id)
       WHERE id = ?`
    )
    .run(convertToProject ? 'converted_to_project' : status || 'in_progress', executiveResponse ?? null, actor.id, projectId ?? null, issId);

  res.json({ ok: true, convertedProjectId: projectId });
});

apiRouter.get('/questions', (req, res) => {
  const sid = (req as AuthedRequest).societyId;
  const rows = commDb.prepare('SELECT * FROM comm_question WHERE society_id = ? ORDER BY created_at DESC').all(sid) as Array<Record<string, any>>;
  const now = new Date().toISOString();
  const questions = rows.map((q) => ({
    ...q,
    isOverdue: !q.answer_text && q.deadline_at < now,
  }));
  res.json({ questions });
});

apiRouter.post('/questions', (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const { questionText, projectId } = req.body as { questionText?: string; projectId?: string };
  if (!questionText) {
    res.status(400).json({ code: 'INVALID_INPUT', title: 'Question text is required.' });
    return;
  }
  const id = newId('q');
  const now = new Date();
  const deadline = new Date(now.getTime() + 7 * 86400000).toISOString();
  commDb
    .prepare(
      `INSERT INTO comm_question (id, society_id, project_id, asked_by_member_id, asked_by_name, question_text, deadline_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, sid, projectId ?? null, actor.id, actor.full_name, questionText.trim(), deadline, now.toISOString());

  res.status(201).json({ id, deadlineAt: deadline });
});

apiRouter.post('/questions/:id/answer', (req, res) => {
  const actor = requireRole(req, res, CO_PRESIDENTS_AND_TEAM);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const qId = String(req.params.id);
  const { answerText } = req.body as { answerText?: string };
  if (!answerText) {
    res.status(400).json({ code: 'INVALID_INPUT', title: 'Answer text is required.' });
    return;
  }
  commDb
    .prepare('UPDATE comm_question SET answer_text = ?, answered_by_name = ?, answered_at = ? WHERE id = ? AND society_id = ?')
    .run(answerText.trim(), actor.full_name, new Date().toISOString(), qId, sid);
  res.json({ ok: true });
});

apiRouter.get('/notices', (req, res) => {
  const sid = (req as AuthedRequest).societyId;
  const notices = commDb.prepare('SELECT * FROM comm_notice WHERE society_id = ? ORDER BY created_at DESC').all(sid) as Array<Record<string, any>>;
  const enriched = notices.map((n) => {
    const versions = commDb.prepare('SELECT * FROM comm_notice_version WHERE notice_id = ? ORDER BY version DESC').all(n.id);
    return { ...n, versions };
  });
  res.json({ notices: enriched });
});

apiRouter.post('/notices', (req, res) => {
  const actor = requireRole(req, res, CO_PRESIDENTS_AND_TEAM);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const { category, titleEn, titleSd, titleUr, bodyEn, bodySd, bodyUr, criticalSms = false } = req.body as Record<string, any>;
  if (!titleEn || !bodyEn) {
    res.status(400).json({ code: 'INVALID_INPUT', title: 'Notice title and body are required.' });
    return;
  }

  const id = newId('ntc');
  const now = new Date().toISOString();
  commDb
    .prepare('INSERT INTO comm_notice (id, society_id, category, current_version, status, critical_sms, created_by, created_at) VALUES (?, ?, ?, 1, \'published\', ?, ?, ?)')
    .run(id, sid, category || 'General Notice', criticalSms ? 1 : 0, actor.id, now);
  commDb
    .prepare(
      `INSERT INTO comm_notice_version (id, society_id, notice_id, version, title_en, title_sd, title_ur, body_en, body_sd, body_ur, published_by, published_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(newId('ntcv'), sid, id, titleEn, titleSd || titleEn, titleUr || titleEn, bodyEn, bodySd || bodyEn, bodyUr || bodyEn, actor.id, now);

  if (criticalSms) {
    sendSms(sid, '+923001110001', `[Cosiety CRITICAL] ${titleEn}`, 'critical_notice');
  }
  res.status(201).json({ id });
});

apiRouter.get('/media', (req, res) => {
  const sid = (req as AuthedRequest).societyId;
  const media = commDb.prepare('SELECT * FROM comm_media_asset WHERE society_id = ? ORDER BY created_at DESC').all(sid);
  res.json({ media });
});

// ============================================================================
// 9. AUDIT HASH CHAIN & PUBLIC REPORTS (AUD)
// ============================================================================
apiRouter.get('/audit/events', (req, res) => {
  const sid = (req as AuthedRequest).societyId;
  const verification = verifyAuditChain(sid);
  const events = auditDb
    .prepare('SELECT seq, id, at, actor_id, action, entity_type, entity_id, after_json, reason, prev_hash, hash FROM audit_event_log WHERE society_id = ? ORDER BY seq DESC LIMIT 80')
    .all(sid);
  res.json({ verification, events });
});

apiRouter.get('/audit/export', (req, res) => {
  const actor = requireRole(req, res, ['auditor', 'portal_admin', 'woman_co_president', 'man_co_president']);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;

  appendAuditEvent({
    societyId: sid,
    actorId: actor.id,
    action: 'audit.exported',
    entityType: 'society',
    entityId: sid,
  });

  const verification = verifyAuditChain(sid);
  const events = auditDb.prepare('SELECT * FROM audit_event_log WHERE society_id = ? ORDER BY seq ASC').all(sid);
  const rules = govDb.prepare('SELECT * FROM gov_rule WHERE society_id = ? ORDER BY od_code ASC').all(sid);
  const vfSummary = getVfSummary(sid);
  const clSummary = getClAggregateSummary(sid);
  const monthlyReports = auditDb.prepare('SELECT * FROM monthly_report WHERE society_id = ? ORDER BY month_label DESC').all(sid);
  const annualReports = auditDb.prepare('SELECT * FROM annual_audit_report WHERE society_id = ? ORDER BY published_at DESC').all(sid);

  res.json({
    exportedAt: new Date().toISOString(),
    societyId: sid,
    exportedBy: actor.full_name,
    chainVerification: verification,
    vfSummary,
    clAggregateSummary: clSummary,
    rules,
    monthlyReports,
    annualReports,
    events,
  });
});

apiRouter.get('/reports', (req, res) => {
  const sid = (req as AuthedRequest).societyId;
  const monthly = auditDb.prepare('SELECT * FROM monthly_report WHERE society_id = ? ORDER BY month_label DESC').all(sid);
  const annual = auditDb.prepare('SELECT * FROM annual_audit_report WHERE society_id = ? ORDER BY published_at DESC').all(sid);
  res.json({ monthly, annual });
});

apiRouter.post('/reports/monthly', (req, res) => {
  const actor = requireRole(req, res, [...FINANCE_APPROVERS, 'auditor']);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const { monthLabel, unreconciledNotes } = req.body as { monthLabel?: string; unreconciledNotes?: string };
  const label = monthLabel || new Date().toISOString().slice(0, 7);
  const vf = getVfSummary(sid);
  const cl = getClAggregateSummary(sid);
  const opsAgg = opsDb
    .prepare("SELECT COALESCE(SUM(package_revenue_pkr), 0) AS rev FROM ops_sales_report WHERE society_id = ? AND status = 'submitted'")
    .get(sid) as { rev: number };

  const id = newId('mr');
  try {
    auditDb
      .prepare(
        `INSERT INTO monthly_report (
          id, society_id, month_label, vf_opening_pkr, vf_in_pkr, vf_out_pkr, vf_closing_pkr,
          cl_capital_pkr, cl_returns_paid_pkr, ops_reported_revenue_pkr, unreconciled_notes,
          status, prepared_by, approved_by, published_by, published_at
        ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?, ?)`
      )
      .run(
        id,
        sid,
        label,
        vf.totalReceivedPkr,
        vf.totalSpentPkr,
        vf.bankBalancePkr,
        cl.totalCapitalPkr,
        cl.totalReturnsPaidPkr,
        opsAgg.rev,
        unreconciledNotes || 'Generated directly from verified double-entry ledgers.',
        actor.id,
        actor.id,
        actor.id,
        new Date().toISOString()
      );
  } catch {
    res.status(409).json({ code: 'MONTH_EXISTS', title: `Monthly report for ${label} already exists.` });
    return;
  }

  res.status(201).json({ id, monthLabel: label });
});

apiRouter.post('/reports/annual', (req, res) => {
  const actor = requireRole(req, res, ['auditor']);
  if (!actor) return;
  const sid = (req as AuthedRequest).societyId;
  const { fiscalYear, opinion, findingsText, managementResponse } = req.body as {
    fiscalYear?: string;
    opinion?: string;
    findingsText?: string;
    managementResponse?: string;
  };
  if (!opinion || !findingsText) {
    res.status(400).json({ code: 'INVALID_INPUT', title: 'Audit opinion and findings are required.' });
    return;
  }
  const id = newId('aar');
  auditDb
    .prepare(
      `INSERT INTO annual_audit_report (id, society_id, fiscal_year, auditor_name, opinion, findings_text, management_response, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, sid, fiscalYear || '2026', actor.full_name, opinion, findingsText, managementResponse || null, new Date().toISOString());

  res.status(201).json({ id });
});
