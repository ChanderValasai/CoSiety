import { coreDb, govDb, ptsDb, voteDb } from './db.ts';
import { newId } from './crypto.ts';
import { computeAge } from './authMiddleware.ts';

export interface PointsBreakdown {
  memberId: string;
  formulaId: string;
  formulaVersion: string;
  formulaStatus: string;
  educationKey: string | null;
  educationStatus: string;
  educationPts: number;
  agePts: number;
  workKey: string | null;
  workStatus: string;
  workPts: number;
  exposureKey: string | null;
  exposureStatus: string;
  exposurePts: number;
  totalPts: number;
  maxPoints: number;
  pointsPending: boolean;
  hasUndecidedFactor: boolean;
  undecidedFactors: string[];
}

export function getActiveFormula(societyId: string) {
  const approved = ptsDb
    .prepare("SELECT * FROM pts_formula WHERE society_id = ? AND status = 'approved' ORDER BY created_at DESC LIMIT 1")
    .get(societyId) as
    | { id: string; version: string; status: string; max_points: number; age_basis: 'registration' | 'snapshot'; resolution_id: string | null }
    | undefined;
  if (approved) return approved;

  return ptsDb
    .prepare("SELECT * FROM pts_formula WHERE society_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(societyId) as
    | { id: string; version: string; status: string; max_points: number; age_basis: 'registration' | 'snapshot'; resolution_id: string | null }
    | undefined;
}

export function recalculateMemberPoints(
  societyId: string,
  memberId: string,
  basis: 'registration' | 'snapshot' = 'registration',
  referenceDateIso?: string
): PointsBreakdown | null {
  const formula = getActiveFormula(societyId);
  if (!formula) return null;

  const member = coreDb
    .prepare('SELECT id, date_of_birth, created_at FROM member WHERE id = ? AND society_id = ?')
    .get(memberId, societyId) as { id: string; date_of_birth: string; created_at: string } | undefined;
  if (!member) return null;

  const items = ptsDb
    .prepare('SELECT * FROM pts_formula_item WHERE formula_id = ?')
    .all(formula.id) as Array<{
    factor: 'education' | 'age' | 'work' | 'exposure';
    item_key: string;
    min_age: number | null;
    max_age: number | null;
    value_points: number | null;
  }>;

  const memberFactors = ptsDb
    .prepare('SELECT * FROM pts_member_factor WHERE society_id = ? AND member_id = ?')
    .all(societyId, memberId) as Array<{
    factor: 'education' | 'work' | 'exposure';
    item_key: string;
    status: 'submitted' | 'approved' | 'rejected';
  }>;

  const undecidedFactors: string[] = [];
  let pointsPending = false;

  const evalFactor = (factor: 'education' | 'work' | 'exposure') => {
    const mf = memberFactors.find((x) => x.factor === factor);
    if (!mf) {
      pointsPending = true;
      return { key: null, status: 'missing', pts: 0 };
    }
    if (mf.status !== 'approved') {
      pointsPending = true;
      return { key: mf.item_key, status: mf.status, pts: 0 };
    }
    const fi = items.find((i) => i.factor === factor && i.item_key === mf.item_key);
    if (!fi) {
      return { key: mf.item_key, status: mf.status, pts: 0 };
    }
    if (fi.value_points === null || fi.value_points === undefined) {
      undecidedFactors.push(`${factor}:${mf.item_key}`);
      return { key: mf.item_key, status: 'approved_undecided', pts: 0 };
    }
    return { key: mf.item_key, status: 'approved', pts: fi.value_points };
  };

  const edu = evalFactor('education');
  const work = evalFactor('work');
  const exp = evalFactor('exposure');

  // Age basis per OD-18 (registration vs snapshot date)
  const ageAtDate = basis === 'snapshot' ? (referenceDateIso || new Date().toISOString()) : member.created_at;
  const age = computeAgeAt(member.date_of_birth, ageAtDate);
  const ageItem = items.find(
    (i) =>
      i.factor === 'age' &&
      (i.min_age === null || age >= i.min_age) &&
      (i.max_age === null || age <= i.max_age)
  );
  const agePts = ageItem?.value_points ?? 0;

  const rawTotal = edu.pts + agePts + work.pts + exp.pts;
  const totalPts = Math.min(rawTotal, formula.max_points);
  const hasUndecided = undecidedFactors.length > 0;
  const now = new Date().toISOString();

  ptsDb
    .prepare(
      `INSERT INTO pts_member_points (
        id, society_id, member_id, formula_id, education_pts, age_pts, work_pts, exposure_pts,
        total_pts, basis, points_pending, has_undecided_factor, undecided_note, computed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(society_id, member_id, formula_id) DO UPDATE SET
        education_pts = excluded.education_pts,
        age_pts = excluded.age_pts,
        work_pts = excluded.work_pts,
        exposure_pts = excluded.exposure_pts,
        total_pts = excluded.total_pts,
        basis = excluded.basis,
        points_pending = excluded.points_pending,
        has_undecided_factor = excluded.has_undecided_factor,
        undecided_note = excluded.undecided_note,
        computed_at = excluded.computed_at`
    )
    .run(
      newId('pt'),
      societyId,
      memberId,
      formula.id,
      edu.pts,
      agePts,
      work.pts,
      exp.pts,
      totalPts,
      basis,
      pointsPending ? 1 : 0,
      hasUndecided ? 1 : 0,
      hasUndecided ? `Waiting for General Body decision (${undecidedFactors.join(', ')})` : null,
      now
    );

  return {
    memberId,
    formulaId: formula.id,
    formulaVersion: formula.version,
    formulaStatus: formula.status,
    educationKey: edu.key,
    educationStatus: edu.status,
    educationPts: edu.pts,
    agePts,
    workKey: work.key,
    workStatus: work.status,
    workPts: work.pts,
    exposureKey: exp.key,
    exposureStatus: exp.status,
    exposurePts: exp.pts,
    totalPts,
    maxPoints: formula.max_points,
    pointsPending,
    hasUndecidedFactor: hasUndecided,
    undecidedFactors,
  };
}

function computeAgeAt(dobIso: string, refIso: string): number {
  const dob = new Date(dobIso);
  const ref = new Date(refIso);
  let age = ref.getUTCFullYear() - dob.getUTCFullYear();
  const m = ref.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && ref.getUTCDate() < dob.getUTCDate())) {
    age--;
  }
  return age;
}

export function checkElectionOpeningGate(societyId: string, electionId: string): {
  ready: boolean;
  blockers: string[];
  undecidedVoters: Array<{ memberId: string; fullName: string; note: string }>;
} {
  const blockers: string[] = [];
  const undecidedVoters: Array<{ memberId: string; fullName: string; note: string }> = [];

  const elec = voteDb
    .prepare('SELECT * FROM election WHERE id = ? AND society_id = ?')
    .get(electionId, societyId) as { id: string; type: string; formula_id: string | null } | undefined;

  if (!elec) {
    return { ready: false, blockers: ['Election not found.'], undecidedVoters };
  }

  const contests = voteDb
    .prepare('SELECT * FROM contest WHERE election_id = ?')
    .all(electionId) as Array<{ id: string; name_en: string; eligible_gender_rule: string; weighting: string }>;

  const hasWeighted = contests.some((c) => c.weighting === 'points');
  const formula = getActiveFormula(societyId);

  if (hasWeighted) {
    if (!formula) {
      blockers.push('No vote-points formula found.');
    } else if (formula.status !== 'approved') {
      blockers.push(`Points formula ${formula.version} is still in '${formula.status}' status and must be approved by resolution.`);
    }

    // Check undecided factors across active verified voters in those contests (AC-PTS-03)
    const minAge = (() => {
      const r = govDb
        .prepare("SELECT value_json FROM gov_rule WHERE society_id = ? AND rule_key = 'eligibility.min_voting_age'")
        .get(societyId) as { value_json: string } | undefined;
      return r ? Number(JSON.parse(r.value_json)) : 18;
    })();

    const activeMembers = coreDb
      .prepare("SELECT id, full_name, gender, date_of_birth FROM member WHERE society_id = ? AND status = 'active' AND identity_status = 'approved'")
      .all(societyId) as Array<{ id: string; full_name: string; gender: string; date_of_birth: string }>;

    for (const m of activeMembers) {
      if (computeAge(m.date_of_birth) < minAge) continue;
      const relevant = contests.some(
        (c) =>
          c.weighting === 'points' &&
          (c.eligible_gender_rule === 'any' ||
            (c.eligible_gender_rule === 'woman' && m.gender === 'female') ||
            (c.eligible_gender_rule === 'man' && m.gender === 'male'))
      );
      if (!relevant) continue;

      const pts = recalculateMemberPoints(societyId, m.id, formula?.age_basis ?? 'snapshot');
      if (pts?.hasUndecidedFactor) {
        undecidedVoters.push({
          memberId: m.id,
          fullName: m.full_name,
          note: pts.undecidedFactors.join(', '),
        });
      } else if (pts?.pointsPending) {
        undecidedVoters.push({
          memberId: m.id,
          fullName: m.full_name,
          note: 'Unverified points factors (points pending)',
        });
      }
    }

    if (undecidedVoters.length > 0) {
      blockers.push(
        `AC-PTS-03: ${undecidedVoters.length} eligible voter(s) have undecided or pending points factors (e.g. no_schooling / no_exposure). Opening blocked until General Body decides values.`
      );
    }
  }

  // Check candidate qualification & Presidency Book training (FR-EXC-002, FR-EXC-003)
  if (elec.type === 'co_president') {
    const cands = voteDb
      .prepare('SELECT member_name, qualification_status, training_passed FROM candidate WHERE election_id = ?')
      .all(electionId) as Array<{ member_name: string; qualification_status: string; training_passed: number }>;

    for (const c of cands) {
      if (c.qualification_status !== 'approved') {
        blockers.push(`Candidate ${c.member_name} qualification is '${c.qualification_status}' (must be approved).`);
      }
      if (!c.training_passed) {
        blockers.push(`Candidate ${c.member_name} has not passed the Cosiety Presidency Book test (FR-EXC-003).`);
      }
    }
  }

  return { ready: blockers.length === 0, blockers, undecidedVoters };
}
