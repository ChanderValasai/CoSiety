export type LangCode = 'en' | 'sd' | 'ur';

export interface Society {
  id: string;
  slug: string;
  name_en: string;
  name_sd: string;
  name_ur: string;
  district: string;
  province: string;
  registration_no: string;
  status: string;
  created_at: string;
  activeMembers?: number;
  vfBalancePkr?: number;
  activeLevyPkr?: number;
}

export interface Household {
  id: string;
  name: string;
}

export interface PointsBreakdown {
  formulaId: string;
  formulaVersion: string;
  formulaStatus: string;
  educationPts: number;
  agePts: number;
  workPts: number;
  exposurePts: number;
  totalPts: number;
  maxPoints: number;
  pointsPending: boolean;
  hasUndecidedFactor: boolean;
  undecidedNote: string | null;
}

export interface PointsFormula {
  id: string;
  version: string;
  status: 'draft' | 'approved' | 'retired';
  max_points: number;
  age_basis: 'registration' | 'snapshot';
  resolution_id: string | null;
  trial_start: string | null;
  trial_end: string | null;
  approved_at: string | null;
}

export interface PointsFormulaItem {
  id: string;
  factor: 'education' | 'age' | 'work' | 'exposure';
  item_key: string;
  label_en: string;
  label_sd: string;
  label_ur: string;
  min_age: number | null;
  max_age: number | null;
  value_points: number | null;
}

export interface SessionUser {
  id: string;
  societyId: string;
  fullName: string;
  householdId: string;
  status: string;
  identityStatus: string;
  roles: string[];
  teamSide: 'woman' | 'man' | null;
  isVerifiedVoter: boolean;
  pointsSummary: PointsBreakdown | null;
}

export interface PersonaOption {
  id: string;
  fullName: string;
  status: string;
  identityStatus: string;
  roles: string[];
  teamSide: 'woman' | 'man' | null;
  isVerifiedVoter: boolean;
}

export interface BootstrapData {
  activeSociety: Society;
  societies: Society[];
  households: Household[];
  stats: {
    totalMembers: number;
    verifiedVoters: number;
    womenVoters: number;
    menVoters: number;
    pendingVerifications: number;
    householdsCount: number;
    pendingPointsCount: number;
    formulaVersion: string;
    formulaStatus: string;
  };
  personas: PersonaOption[];
  sessionUser: SessionUser | null;
}

export interface LedgerSummary {
  separationRule: string;
  villageFund: {
    bankBalancePkr: number;
    totalReceivedPkr: number;
    totalSpentPkr: number;
    allocatedProjectsPkr: number;
    unallocatedAvailablePkr: number;
    levyReceivablePkr: number;
    activeLevyPkr: number;
    levyCapPkr: number;
    transfersInFlightPkr: number;
    transfersInFlightCount: number;
  };
  contributorLedgerAggregate: {
    contributorCount: number;
    totalCapitalPkr: number;
    totalInfraPaidPkr: number;
    totalReturnsPaidPkr: number;
    clBankBalancePkr: number;
  };
  operationsReported: {
    totalPackagesSold: number;
    totalPackageRevenuePkr: number;
    totalLevyReportedPkr: number;
  };
}

export interface BallotOption {
  code: string;
  labelEn: string;
  labelSd: string;
  labelUr: string;
  symbol: string;
}

export interface ContestCandidate {
  id: string;
  contest_id: string;
  member_id: string;
  member_name: string;
  household_id: string;
  symbol_key: string;
  qualification_kind: 'bachelor_degree' | 'intermediate_plus';
  qualification_status: 'pending' | 'approved' | 'rejected';
  qualification_note: string | null;
  training_passed: number;
  training_score: number | null;
  status: string;
}

export interface ContestResult {
  resultStatus: string;
  tallies: {
    turnoutVoters: number;
    eligibleVoters: number;
    totalPointsCast: number;
    quorumRequired: number;
    minTurnoutRequired: number;
    quorumMet: boolean;
    minTurnoutMet: boolean;
    sealedBallotUnitsVerified: number;
    counts?: Array<{ choice_code: string; label?: string; points: number }>;
  };
  winnerCandidateId: string | null;
  winnerName: string | null;
  anonymityWarning: string | null;
  formulaVersion: string | null;
  certifiedBy1: string | null;
  certifiedBy2: string | null;
  certifiedAt: string;
  disputeNote: string | null;
}

export interface Contest {
  id: string;
  election_id: string;
  name_en: string;
  name_sd: string;
  name_ur: string;
  prompt_en: string;
  prompt_sd: string;
  prompt_ur: string;
  eligible_gender_rule: 'woman' | 'man' | 'any';
  weighting: 'points' | 'equal';
  formula_id: string | null;
  options: BallotOption[];
  snapshot_hash: string | null;
  snapshot_count: number;
  snapshot_total_points: number;
  state: 'draft' | 'nomination' | 'ready' | 'open' | 'closed' | 'tallied' | 'certified' | 'void';
  candidates: ContestCandidate[];
  participationCount: number;
  totalPointsUsed: number;
  sealedBallotCount: number;
  integrityCountsMatch: boolean;
  userEligible: boolean;
  eligibilityReason: string | null;
  hasVoted: boolean;
  userPointsAtSnapshot: number | null;
  quorumRequired: number;
  result: ContestResult | null;
}

export interface Election {
  id: string;
  type: 'co_president' | 'levy' | 'budget' | 'project' | 'recall' | 'resolution';
  title_en: string;
  title_sd: string;
  title_ur: string;
  description_en: string;
  description_sd: string;
  description_ur: string;
  state: 'draft' | 'nomination' | 'ready' | 'open' | 'closed' | 'tallied' | 'certified' | 'void';
  ballot_mode: 'secret' | 'open';
  opens_at: string;
  closes_at: string;
  quorum_fraction: number;
  pass_threshold: number;
  min_turnout_fraction: number;
  tie_rule: string;
  formula_id: string | null;
  project_id: string | null;
  config_hash: string | null;
  contests: Contest[];
  openingGate: {
    ready: boolean;
    blockers: string[];
    undecidedVoters: Array<{ memberId: string; fullName: string; reason: string }>;
  } | null;
}

export interface ProjectProposal {
  id: string;
  reference_no: string;
  member_id: string;
  proposer_name: string;
  submission_channel: 'portal' | 'helper' | 'general_body';
  title_en: string;
  title_sd: string;
  title_ur: string;
  description_en: string;
  description_sd: string;
  description_ur: string;
  category: string;
  est_budget_pkr: number;
  impact_text: string;
  levy_effect_text: string | null;
  state: 'proposal' | 'explainer' | 'discussion' | 'voting' | 'approved' | 'rejected' | 'execution' | 'reporting' | 'closed';
  feasibility_status: string | null;
  feasibility_note: string | null;
  explainer_summary_sd: string | null;
  discussion_deadline: string | null;
  election_id: string | null;
  allocated_budget_pkr: number;
  final_report_text: string | null;
  spentPkr: number;
  expenses: Array<{
    id: string;
    amount_pkr: number;
    vendor_name: string;
    description: string;
    invoice_doc_ref: string;
    requested_by: string;
    requested_team_side: 'woman' | 'man' | null;
    status: 'pending' | 'approved' | 'rejected';
    approved_by: string | null;
    vf_entry_id: string | null;
    created_at: string;
  }>;
  created_at: string;
}
