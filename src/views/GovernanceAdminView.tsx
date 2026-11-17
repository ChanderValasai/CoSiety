import React, { useEffect, useState } from 'react';
import {
  Award,
  Building2,
  CheckCircle2,
  Download,
  Eye,
  FileCheck2,
  Lock,
  ReceiptText,
  ShieldCheck,
  Sliders,
  UserCheck,
  Users,
} from 'lucide-react';
import type { BootstrapData, LangCode, PointsFormula, PointsFormulaItem, Society } from '../types';
import { formatPkr, pickLang } from '../i18n/translations';
import { apiFetch } from '../utils/api';

interface GovernanceAdminViewProps {
  bootstrap: BootstrapData;
  lang: LangCode;
  sessionToken: string | null;
  onRefresh: () => Promise<void>;
  onSelectSociety: (societyId: string) => void;
  onOpenOnboardVillage: () => void;
}

export const GovernanceAdminView: React.FC<GovernanceAdminViewProps> = ({
  bootstrap,
  lang,
  sessionToken,
  onRefresh,
  onSelectSociety,
  onOpenOnboardVillage,
}) => {
  const sid = bootstrap.activeSociety.id;
  const [subTab, setSubTab] = useState<'members' | 'committee' | 'audit' | 'villages'>('members');

  const [membersData, setMembersData] = useState<{
    members: Array<{
      id: string;
      full_name: string;
      household_id: string;
      household_name: string;
      status: string;
      identity_status?: string;
      cnic_masked?: string;
      roles: string[];
      teamSide: 'woman' | 'man' | null;
      pointsTotal?: number | null;
      pointsPending?: boolean;
      hasUndecidedFactor?: boolean;
      undecidedNote?: string | null;
      factors?: Array<{ factor: string; item_key: string; status: string }>;
    }>;
    publicDirectoryOnly: boolean;
  } | null>(null);

  const [govData, setGovData] = useState<{
    rules: Array<{ id: string; rule_key: string; od_code: string; label: string; value_json: string; version: number; approved_by_resolution_id: string | null }>;
    officeHolders: Array<{ id: string; seat: string; member_id: string; member_name: string; household_name: string; start_date: string; end_date: string; training_passed: number }>;
    teamMembers: Array<{ id: string; team_side: string; role_code: string; member_id: string; member_name: string; household_name: string }>;
    conflicts: Array<{ id: string; member_name: string; category: string; entity_name: string; description: string }>;
    petitions: Array<{ id: string; target_name: string; target_role_code: string; reason: string; signatureCount: number; required_signatures: number; status: string }>;
    expenseClaims: Array<{ id: string; claimant_name: string; team_side: string | null; amount_pkr: number; category: string; description: string; status: string; created_at: string }>;
  } | null>(null);

  const [formulaData, setFormulaData] = useState<{
    formula: PointsFormula;
    items: PointsFormulaItem[];
    reviews: Array<{ id: string; period_label: string; summary_text: string; decision: string; reviewed_by: string; reviewed_at: string }>;
  } | null>(null);

  const [auditEventsData, setAuditEventsData] = useState<{
    verification: { valid: boolean; totalEvents: number; headHash: string | null; brokenAtSeq: number | null };
    events: Array<{ seq: number; at: string; actor_id: string; action: string; entity_type: string; entity_id: string; reason: string | null; hash: string }>;
  } | null>(null);

  const [reportsData, setReportsData] = useState<{
    monthly: Array<{ id: string; month_label: string; vf_in_pkr: number; vf_out_pkr: number; vf_closing_pkr: number; cl_capital_pkr: number; unreconciled_notes: string }>;
    annual: Array<{ id: string; fiscal_year: string; auditor_name: string; opinion: string; findings_text: string }>;
  } | null>(null);

  const [societiesList, setSocietiesList] = useState<Society[]>([]);
  const [breakGlassResult, setBreakGlassResult] = useState<string | null>(null);

  // Interactive governance states
  const [appointMemberId, setAppointMemberId] = useState('m-salma');
  const [appointRole, setAppointRole] = useState<'treasurer' | 'team_member'>('treasurer');
  const [appointSide, setAppointSide] = useState<'woman' | 'man'>('woman');

  const [noSchoolPts, setNoSchoolPts] = useState(0);
  const [noExposurePts, setNoExposurePts] = useState(0);
  const [reviewDecision, setReviewDecision] = useState('continue');
  const [reviewSummary, setReviewSummary] = useState('6-month Pabohar Vote-Points pilot review: fair representation verified.');

  const [claimDesc, setClaimDesc] = useState('');
  const [claimAmount, setClaimAmount] = useState(1800);

  const [ruleEdits, setRuleEdits] = useState<Record<string, string>>({});
  const [coiEntity, setCoiEntity] = useState('');
  const [coiDesc, setCoiDesc] = useState('');
  const [recallTarget, setRecallTarget] = useState(bootstrap.personas.find((p) => p.roles.length > 0)?.id || '');
  const [recallReason, setRecallReason] = useState('');

  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isVerificationOfficer = bootstrap.sessionUser?.roles.includes('verification_officer');

  const loadAll = async () => {
    try {
      const [m, g, f, a, r, s] = await Promise.all([
        apiFetch<NonNullable<typeof membersData>>('/members', {}, sid, sessionToken),
        apiFetch<NonNullable<typeof govData>>('/governance', {}, sid, sessionToken),
        apiFetch<NonNullable<typeof formulaData>>('/public/points-formula', {}, sid, sessionToken),
        apiFetch<NonNullable<typeof auditEventsData>>('/audit/events', {}, sid, sessionToken),
        apiFetch<NonNullable<typeof reportsData>>('/reports', {}, sid, sessionToken),
        apiFetch<{ societies: Society[] }>('/societies', {}, sid, sessionToken),
      ]);
      setMembersData(m);
      setGovData(g);
      setFormulaData(f);
      setAuditEventsData(a);
      setReportsData(r);
      setSocietiesList(s.societies);
    } catch {
      // handled gracefully
    }
  };

  useEffect(() => {
    loadAll();
  }, [sid, sessionToken]);

  const handleDocumentsCheck = async (memberId: string) => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await apiFetch<{ points?: { totalPts: number } }>(
        `/verifications/${memberId}/documents-check`,
        { method: 'POST', body: JSON.stringify({ note: 'Original CNIC & Vote-Points proof checked in person', approveFactors: true }) },
        sid,
        sessionToken
      );
      setMsg(`Documents & Vote-Points factors checked (${res.points?.totalPts ?? 0} pts). A different second approver must now activate voter status.`);
      await Promise.all([loadAll(), onRefresh()]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleApproveMember = async (memberId: string) => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await apiFetch(
        `/verifications/${memberId}/approve`,
        { method: 'POST', body: JSON.stringify({ note: 'Two-person verification complete' }) },
        sid,
        sessionToken
      );
      setMsg('Member activated onto whole-village voter roll & SMS confirmation sent!');
      await Promise.all([loadAll(), onRefresh()]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleReverifyFactor = async (memberId: string, factor: 'education' | 'work' | 'exposure', itemKey: string) => {
    setBusy(true);
    setErr(null);
    try {
      const res = await apiFetch<{ breakdown?: { totalPts: number } }>(
        `/points/members/${memberId}/reverify`,
        {
          method: 'POST',
          body: JSON.stringify({ factor, itemKey, status: 'approved', note: 'Updated after document review' }),
        },
        sid,
        sessionToken
      );
      setMsg(`Factor "${factor}" updated to "${itemKey}" (New total: ${res.breakdown?.totalPts ?? 0} pts).`);
      await Promise.all([loadAll(), onRefresh()]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleBreakGlass = async (memberId: string) => {
    setBusy(true);
    setErr(null);
    setBreakGlassResult(null);
    try {
      const coAuth = bootstrap.personas.find((p) => p.id !== bootstrap.sessionUser?.id && p.roles.length > 0)?.id || 'm-fatima';
      const res = await apiFetch<{ fullName: string; cnicDecrypted: string }>(
        `/members/${memberId}/break-glass-cnic`,
        {
          method: 'POST',
          body: JSON.stringify({ coAuthorizerId: coAuth, reason: 'Dual-control audit verification' }),
        },
        sid,
        sessionToken
      );
      setBreakGlassResult(`Break-Glass Logged (NFR-PRV-002): ${res.fullName} CNIC = ${res.cnicDecrypted}`);
      await loadAll();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleAppointTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await apiFetch(
        '/governance/teams',
        {
          method: 'POST',
          body: JSON.stringify({ memberId: appointMemberId, roleCode: appointRole, teamSide: appointSide }),
        },
        sid,
        sessionToken
      );
      setMsg('Team member appointed under Household & Co-President Team rules!');
      await Promise.all([loadAll(), onRefresh()]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleApproveFormula = async () => {
    if (!formulaData) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await apiFetch(
        `/points/formulas/${formulaData.formula.id}/approve`,
        {
          method: 'POST',
          body: JSON.stringify({
            resolutionCode: 'RES-2026-01',
            itemUpdates: [
              { factor: 'education', itemKey: 'no_schooling', valuePoints: noSchoolPts },
              { factor: 'exposure', itemKey: 'no_exposure', valuePoints: noExposurePts },
            ],
          }),
        },
        sid,
        sessionToken
      );
      setMsg('Vote-Points Formula approved with General Body Resolution RES-2026-01 and all member scores recalculated!');
      await Promise.all([loadAll(), onRefresh()]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleSubmitTrialReview = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await apiFetch(
        '/points/trial-reviews',
        {
          method: 'POST',
          body: JSON.stringify({
            periodLabel: '2026-Q4 (Founding Pilot)',
            summaryText: reviewSummary,
            decision: reviewDecision,
          }),
        },
        sid,
        sessionToken
      );
      setMsg('Trial review recorded against current Vote-Points formula.');
      await loadAll();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleFileExpenseClaim = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await apiFetch(
        '/governance/expense-claims',
        {
          method: 'POST',
          body: JSON.stringify({ amountPkr: claimAmount, category: 'Kiosk / Stationary', description: claimDesc }),
        },
        sid,
        sessionToken
      );
      setClaimDesc('');
      setMsg('Executive reimbursement claim recorded as pending_od24 (never touches VF until General Body decides OD-24).');
      await loadAll();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleApproveClaim = async (claimId: string) => {
    setBusy(true);
    setErr(null);
    try {
      await apiFetch(`/governance/expense-claims/${claimId}/approve`, { method: 'POST', body: '{}' }, sid, sessionToken);
      setMsg('Cross-team verification recorded (status: approved_unfunded until OD-24 funding rule is resolved).');
      await loadAll();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleSaveRule = async (ruleKey: string, currentVal: string) => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      let parsed: unknown = ruleEdits[ruleKey] ?? currentVal;
      if (typeof parsed === 'string') {
        try {
          parsed = JSON.parse(parsed);
        } catch {
          // keep string
        }
      }
      await apiFetch(
        '/governance/rules',
        { method: 'PATCH', body: JSON.stringify({ ruleKey, value: parsed, resolutionCode: 'RES-2026-01' }) },
        sid,
        sessionToken
      );
      setMsg(`Governance rule "${ruleKey}" updated and logged.`);
      await loadAll();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleDeclareCoi = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await apiFetch(
        '/governance/conflicts',
        { method: 'POST', body: JSON.stringify({ category: 'business', entityName: coiEntity, description: coiDesc }) },
        sid,
        sessionToken
      );
      setCoiEntity('');
      setCoiDesc('');
      setMsg('Conflict-of-interest declaration recorded.');
      await loadAll();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleLaunchRecall = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await apiFetch(
        '/governance/recall',
        { method: 'POST', body: JSON.stringify({ targetMemberId: recallTarget, reason: recallReason }) },
        sid,
        sessionToken
      );
      setRecallReason('');
      setMsg('Recall petition opened.');
      await loadAll();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleSignRecall = async (petitionId: string) => {
    setBusy(true);
    setErr(null);
    try {
      await apiFetch(`/governance/recall/${petitionId}/sign`, { method: 'POST', body: '{}' }, sid, sessionToken);
      setMsg('Recall signature recorded.');
      await loadAll();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleGenerateMonthly = async () => {
    setBusy(true);
    setErr(null);
    try {
      await apiFetch('/reports/monthly', { method: 'POST', body: JSON.stringify({ monthLabel: '2026-11' }) }, sid, sessionToken);
      setMsg('Monthly public statement for 2026-11 published.');
      await loadAll();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handlePublishAnnualAudit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await apiFetch(
        '/reports/annual',
        {
          method: 'POST',
          body: JSON.stringify({
            fiscalYear: '2026',
            opinion: 'Unqualified / Clean Opinion',
            findingsText: 'All three ledgers reconciled, sealed ballot invariants verified, and SHA-256 audit chain intact.',
          }),
        },
        sid,
        sessionToken
      );
      setMsg('Annual Independent Audit Report published.');
      await loadAll();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleDownloadExport = async () => {
    setBusy(true);
    setErr(null);
    try {
      const data = await apiFetch<Record<string, unknown>>('/audit/export', {}, sid, sessionToken);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cosiety-${sid}-audit-export.json`;
      a.click();
      URL.revokeObjectURL(url);
      setMsg('Audit export downloaded and access logged.');
      await loadAll();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-200 bg-white p-6">
        <h1 className="text-2xl font-extrabold text-slate-900">
          Governance, Verification, Vote-Points &amp; Multi-Village Audit
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Two-person checks, Co-President teams &amp; household rules, Vote-Points formula configuration, OD-01..OD-36 parameters, OD-24 claims, and hash-chained audit logs.
        </p>

        <div className="mt-5 flex flex-wrap gap-1.5 rounded-xl bg-slate-100 p-1">
          {[
            { id: 'members' as const, label: '1. Members, Verification & Points' },
            { id: 'committee' as const, label: '2. Co-Presidents, Formula & OD Rules' },
            { id: 'audit' as const, label: '3. Audit & Monthly Reports' },
            { id: 'villages' as const, label: '4. Multi-Village Registry' },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                setSubTab(tab.id);
                setErr(null);
                setMsg(null);
              }}
              className={`min-h-[40px] flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                subTab === tab.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {err && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{err}</div>}
      {msg && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">{msg}</div>}
      {breakGlassResult && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-mono-num text-amber-950">
          {breakGlassResult}
        </div>
      )}

      {/* TAB 1: MEMBERS, TWO-PERSON VERIFICATION & PRIVATE VOTE-POINTS RE-VERIFICATION */}
      {subTab === 'members' && membersData && (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 space-y-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <UserCheck className="h-5 w-5 text-[#0F766E]" />
              Whole-Village Member Directory &amp; Two-Person Verification
            </h2>
            <p className="text-xs text-slate-500">
              {membersData.publicDirectoryOnly
                ? 'Public view: CNIC, DOB, gender, phone, and private Vote-Points are hidden (AC-AUTH-04). Sign in as Ali Raza (Verification Officer) or Fatima/Sajjad to verify applicants.'
                : 'Officer / Auditor view: Two different officers must complete Step 1 (Verification Officer documents check) and Step 2 (second-person approval). Individual Vote-Points are shown strictly to Verification Officer & Auditor.'}
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 text-slate-500">
                <tr>
                  <th className="py-2.5 pr-3">Name &amp; Household</th>
                  <th className="py-2.5 pr-3">Status &amp; Identity</th>
                  <th className="py-2.5 pr-3">Roles &amp; Team</th>
                  {!membersData.publicDirectoryOnly && <th className="py-2.5 pr-3">Masked CNIC</th>}
                  {!membersData.publicDirectoryOnly && <th className="py-2.5 pr-3">Private Vote-Points</th>}
                  <th className="py-2.5 text-right">Workflow Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {membersData.members.map((m) => (
                  <tr key={m.id}>
                    <td className="py-3 pr-3 font-semibold text-slate-900">
                      {m.full_name}
                      <div className="text-[11px] font-normal text-slate-500">{m.household_name}</div>
                    </td>
                    <td className="py-3 pr-3">
                      <span className={`font-semibold ${m.status === 'active' ? 'text-emerald-700' : 'text-amber-700'}`}>
                        {m.status}
                      </span>{' '}
                      {m.identity_status && <>· <span className="text-slate-600">{m.identity_status}</span></>}
                    </td>
                    <td className="py-3 pr-3 text-slate-600">
                      {m.roles.length > 0 ? m.roles.join(', ') : 'Member'}
                      {m.teamSide && <span className="ml-1 font-semibold uppercase text-[#0F766E]">({m.teamSide})</span>}
                    </td>
                    {!membersData.publicDirectoryOnly && (
                      <td className="py-3 pr-3 font-mono-num text-slate-600">{m.cnic_masked || '—'}</td>
                    )}
                    {!membersData.publicDirectoryOnly && (
                      <td className="py-3 pr-3 font-mono-num">
                        {m.pointsTotal !== null && m.pointsTotal !== undefined ? (
                          <div>
                            <span className="font-bold text-slate-900">{m.pointsTotal} pts</span>
                            {m.pointsPending && <div className="text-[11px] text-amber-700">Pending check (AC-PTS-04)</div>}
                            {m.hasUndecidedFactor && <div className="text-[11px] text-red-700">Undecided tier</div>}
                          </div>
                        ) : (
                          <span className="text-slate-400">Private</span>
                        )}
                      </td>
                    )}
                    <td className="py-3 text-right space-x-2 whitespace-nowrap">
                      {m.identity_status === 'otp_confirmed' && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handleDocumentsCheck(m.id)}
                          className="min-h-[34px] rounded-lg border border-slate-300 bg-white px-2.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 cursor-pointer"
                        >
                          1. Check CNIC &amp; Proof
                        </button>
                      )}
                      {m.identity_status === 'documents_checked' && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handleApproveMember(m.id)}
                          className="min-h-[34px] rounded-lg bg-[#0F766E] px-2.5 text-xs font-semibold text-white cursor-pointer"
                        >
                          2. Approve Voter
                        </button>
                      )}
                      {isVerificationOfficer && m.id !== bootstrap.sessionUser?.id && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handleReverifyFactor(m.id, 'education', 'bachelor_plus')}
                          className="min-h-[34px] rounded-lg border border-indigo-200 px-2.5 text-xs font-semibold text-indigo-800 hover:bg-indigo-50 cursor-pointer"
                        >
                          Verify Edu: Bachelor
                        </button>
                      )}
                      {!membersData.publicDirectoryOnly && m.cnic_masked && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handleBreakGlass(m.id)}
                          className="inline-flex min-h-[34px] items-center gap-1 rounded-lg border border-slate-200 px-2.5 text-xs font-semibold text-slate-600 hover:text-slate-900 cursor-pointer"
                        >
                          <Eye className="h-3 w-3" /> Break-Glass
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 2: CO-PRESIDENTS, TEAMS, FORMULA APPROVAL, OD-24 CLAIMS & OD RULES */}
      {subTab === 'committee' && govData && (
        <div className="space-y-6">
          {/* Two Co-Presidents & Teams + Appointment Tester */}
          <div className="rounded-2xl border border-slate-200 bg-white p-6 space-y-5">
            <div>
              <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                <Users className="h-5 w-5 text-[#0F766E]" />
                Two Co-Presidents &amp; Appointed Teams (AC-EXC-02 &amp; AC-EXC-03)
              </h2>
              <p className="text-xs text-slate-500">
                Both Woman Co-President and Man Co-President appoint a Treasurer and Team Members. At most one executive/team seat per household, and a Co-President&apos;s Treasurer cannot share that Co-President&apos;s household.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {govData.officeHolders.map((h) => {
                const side = h.seat.startsWith('woman') ? 'woman' : 'man';
                const members = govData.teamMembers.filter((tm) => tm.team_side === side);
                return (
                  <div key={h.id} className="rounded-xl border border-slate-200 p-4 space-y-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-bold uppercase text-[#0F766E]">{h.seat.replace(/_/g, ' ')}</span>
                      <span className="font-mono-num text-slate-500">{h.start_date} → {h.end_date}</span>
                    </div>
                    <div className="text-base font-bold text-slate-900">{h.member_name}</div>
                    <div className="text-slate-600">Household: {h.household_name} · Presidency Book: {h.training_passed ? 'Passed' : 'Pending'}</div>
                    <div className="border-t border-slate-100 pt-2 space-y-1">
                      <div className="font-semibold text-slate-700">Appointed Team:</div>
                      {members.map((tm) => (
                        <div key={tm.id} className="flex justify-between text-slate-600">
                          <span>{tm.member_name} ({tm.household_name})</span>
                          <span className="font-semibold uppercase text-slate-800">{tm.role_code}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>

            <form onSubmit={handleAppointTeam} className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2">
              <div className="text-xs font-bold text-slate-800">
                Appoint Team Member / Treasurer (Test Salma Meghwar in Fatima&apos;s hh-02 to verify AC-EXC-02 / AC-EXC-03)
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                <select
                  value={appointMemberId}
                  onChange={(e) => setAppointMemberId(e.target.value)}
                  className="min-h-[38px] rounded-lg border border-slate-300 bg-white px-2.5 text-xs"
                >
                  {bootstrap.personas.map((p) => (
                    <option key={p.id} value={p.id}>{p.fullName}</option>
                  ))}
                </select>
                <select
                  value={appointRole}
                  onChange={(e) => setAppointRole(e.target.value as 'treasurer' | 'team_member')}
                  className="min-h-[38px] rounded-lg border border-slate-300 bg-white px-2.5 text-xs"
                >
                  <option value="treasurer">Treasurer</option>
                  <option value="team_member">Team Member</option>
                </select>
                <select
                  value={appointSide}
                  onChange={(e) => setAppointSide(e.target.value as 'woman' | 'man')}
                  className="min-h-[38px] rounded-lg border border-slate-300 bg-white px-2.5 text-xs"
                >
                  <option value="woman">Woman Co-President Team</option>
                  <option value="man">Man Co-President Team</option>
                </select>
                <button
                  type="submit"
                  disabled={busy}
                  className="min-h-[38px] rounded-lg bg-[#0F766E] px-3 text-xs font-semibold text-white cursor-pointer"
                >
                  Appoint to Team
                </button>
              </div>
            </form>
          </div>

          {/* Vote-Points Formula Configuration & Trial Review (DC-PTS) */}
          {formulaData && (
            <div className="rounded-2xl border border-slate-200 bg-white p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                    <Award className="h-5 w-5 text-[#0F766E]" />
                    Vote-Points Formula Approval &amp; Trial Review ({formulaData.formula.version} · {formulaData.formula.status.toUpperCase()})
                  </h2>
                  <p className="text-xs text-slate-500">
                    General Body must set point values for <code>no_schooling</code> and <code>no_exposure</code> and approve the formula (RES-2026-01) before weighted elections can open (AC-PTS-03).
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end bg-slate-50 p-4 rounded-xl border border-slate-200">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">No Schooling Points (Draft: Undecided)</label>
                  <input
                    type="number"
                    min={0}
                    max={10}
                    value={noSchoolPts}
                    onChange={(e) => setNoSchoolPts(Number(e.target.value))}
                    className="w-full min-h-[38px] rounded-lg border border-slate-300 bg-white px-3 text-xs font-mono-num"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">No Exposure / Village-Only Points</label>
                  <input
                    type="number"
                    min={0}
                    max={10}
                    value={noExposurePts}
                    onChange={(e) => setNoExposurePts(Number(e.target.value))}
                    className="w-full min-h-[38px] rounded-lg border border-slate-300 bg-white px-3 text-xs font-mono-num"
                  />
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleApproveFormula}
                  className="min-h-[38px] rounded-lg bg-[#0F766E] px-4 text-xs font-semibold text-white cursor-pointer"
                >
                  Approve Formula (RES-2026-01)
                </button>
              </div>

              <form onSubmit={handleSubmitTrialReview} className="grid grid-cols-1 sm:grid-cols-4 gap-2 pt-2">
                <input
                  required
                  value={reviewSummary}
                  onChange={(e) => setReviewSummary(e.target.value)}
                  className="sm:col-span-2 min-h-[38px] rounded-lg border border-slate-300 px-3 text-xs"
                />
                <select
                  value={reviewDecision}
                  onChange={(e) => setReviewDecision(e.target.value)}
                  className="min-h-[38px] rounded-lg border border-slate-300 bg-white px-2.5 text-xs"
                >
                  <option value="continue">Continue Weighted Pilot</option>
                  <option value="adjust">Adjust Weights</option>
                  <option value="switch_equal">Switch to Equal 1-Person-1-Vote</option>
                </select>
                <button
                  type="submit"
                  disabled={busy}
                  className="min-h-[38px] rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-800 cursor-pointer"
                >
                  Log 6-Month Trial Review
                </button>
              </form>
            </div>
          )}

          {/* OD-24 Executive Expense Claims (Never posted to VF until OD-24 resolved!) */}
          <div className="rounded-2xl border border-slate-200 bg-white p-6 space-y-4">
            <div>
              <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                <ReceiptText className="h-5 w-5 text-amber-700" />
                Executive Expense Claims Pending OD-24 (Published, Zero VF Cash Impact)
              </h2>
              <p className="text-xs text-slate-500">
                SDS §8.9: Co-President team out-of-pocket expenses are logged &amp; published transparently with status <code>pending_od24</code> / <code>approved_unfunded</code>, never touching Village Fund cash until General Body decides OD-24.
              </p>
            </div>

            <div className="divide-y divide-slate-100 border border-slate-200 rounded-xl">
              {govData.expenseClaims.map((cl) => (
                <div key={cl.id} className="p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs">
                  <div>
                    <div className="font-bold text-slate-900">
                      {cl.claimant_name} ({cl.team_side || 'exec'} team) · <span className="font-mono-num">{formatPkr(cl.amount_pkr)}</span>
                    </div>
                    <div className="text-slate-600">{cl.category}: {cl.description} · Status: <strong className="text-amber-800">{cl.status}</strong></div>
                  </div>
                  {cl.status === 'pending_od24' && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleApproveClaim(cl.id)}
                      className="min-h-[34px] rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-800 cursor-pointer"
                    >
                      Cross-Team Verify (Unfunded)
                    </button>
                  )}
                </div>
              ))}
            </div>

            <form onSubmit={handleFileExpenseClaim} className="grid grid-cols-1 sm:grid-cols-4 gap-2">
              <input
                required
                value={claimDesc}
                onChange={(e) => setClaimDesc(e.target.value)}
                placeholder="Out-of-pocket description..."
                className="sm:col-span-2 min-h-[38px] rounded-lg border border-slate-300 px-3 text-xs"
              />
              <input
                type="number"
                value={claimAmount}
                onChange={(e) => setClaimAmount(Number(e.target.value))}
                className="min-h-[38px] rounded-lg border border-slate-300 px-3 text-xs font-mono-num"
              />
              <button
                type="submit"
                disabled={busy}
                className="min-h-[38px] rounded-lg bg-slate-900 px-3 text-xs font-semibold text-white cursor-pointer"
              >
                File Claim (OD-24)
              </button>
            </form>
          </div>

          {/* Configurable Open Decisions OD-01..OD-36 */}
          <div className="rounded-2xl border border-slate-200 bg-white p-6 space-y-4">
            <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <Sliders className="h-5 w-5 text-[#0F766E]" />
              Configurable Governance Parameters (SRS §13 Open Decisions OD-01..OD-36)
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {govData.rules.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3 text-xs">
                  <div className="min-w-0">
                    <div className="font-bold text-slate-900">
                      {r.od_code} · {r.label}
                    </div>
                    <div className="text-slate-500 font-mono-num">
                      {r.rule_key} · v{r.version}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <input
                      value={ruleEdits[r.rule_key] ?? r.value_json}
                      onChange={(e) => setRuleEdits((p) => ({ ...p, [r.rule_key]: e.target.value }))}
                      className="w-28 min-h-[34px] rounded-lg border border-slate-300 px-2 font-mono-num text-xs"
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleSaveRule(r.rule_key, r.value_json)}
                      className="min-h-[34px] rounded-lg border border-slate-300 bg-white px-2.5 font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
                    >
                      Save
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="rounded-2xl border border-slate-200 bg-white p-6 space-y-4">
              <h3 className="text-base font-bold text-slate-900">Conflict-of-Interest Declarations (BR-19)</h3>
              <div className="divide-y divide-slate-100">
                {govData.conflicts.map((c) => (
                  <div key={c.id} className="py-2.5 text-xs">
                    <div className="font-bold text-slate-900">{c.member_name} — {c.entity_name} ({c.category})</div>
                    <div className="text-slate-600">{c.description}</div>
                  </div>
                ))}
              </div>
              <form onSubmit={handleDeclareCoi} className="space-y-2 border-t border-slate-100 pt-3">
                <input
                  required
                  value={coiEntity}
                  onChange={(e) => setCoiEntity(e.target.value)}
                  placeholder="Declared Family / Business Entity Name"
                  className="w-full min-h-[38px] rounded-lg border border-slate-300 px-3 text-xs"
                />
                <input
                  required
                  value={coiDesc}
                  onChange={(e) => setCoiDesc(e.target.value)}
                  placeholder="Relationship / Scope"
                  className="w-full min-h-[38px] rounded-lg border border-slate-300 px-3 text-xs"
                />
                <button
                  type="submit"
                  disabled={busy}
                  className="min-h-[38px] rounded-lg bg-slate-900 px-3 text-xs font-semibold text-white cursor-pointer"
                >
                  Declare Conflict
                </button>
              </form>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-6 space-y-4">
              <h3 className="text-base font-bold text-slate-900">Recall Petitions</h3>
              {govData.petitions.length === 0 ? (
                <p className="text-xs text-slate-500">No active recall petitions.</p>
              ) : (
                <div className="divide-y divide-slate-100">
                  {govData.petitions.map((p) => (
                    <div key={p.id} className="py-2.5 flex items-center justify-between gap-2 text-xs">
                      <div>
                        <div className="font-bold text-slate-900">Recall: {p.target_name} ({p.target_role_code})</div>
                        <div className="text-slate-600">{p.reason} · <span className="font-mono-num">{p.signatureCount}/{p.required_signatures}</span> signatures · {p.status}</div>
                      </div>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleSignRecall(p.id)}
                        className="min-h-[34px] rounded-lg border border-slate-300 px-2.5 font-semibold cursor-pointer"
                      >
                        Sign
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <form onSubmit={handleLaunchRecall} className="space-y-2 border-t border-slate-100 pt-3">
                <select
                  value={recallTarget}
                  onChange={(e) => setRecallTarget(e.target.value)}
                  className="w-full min-h-[38px] rounded-lg border border-slate-300 bg-white px-3 text-xs"
                >
                  {bootstrap.personas.filter((p) => p.roles.length > 0).map((p) => (
                    <option key={p.id} value={p.id}>{p.fullName} ({p.roles.join(', ')})</option>
                  ))}
                </select>
                <input
                  required
                  value={recallReason}
                  onChange={(e) => setRecallReason(e.target.value)}
                  placeholder="Grounds for recall petition..."
                  className="w-full min-h-[38px] rounded-lg border border-slate-300 px-3 text-xs"
                />
                <button
                  type="submit"
                  disabled={busy}
                  className="min-h-[38px] rounded-lg border border-red-300 bg-red-50 px-3 text-xs font-semibold text-red-800 cursor-pointer"
                >
                  Launch Recall Petition
                </button>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: INDEPENDENT AUDITOR CONSOLE & HASH CHAIN */}
      {subTab === 'audit' && auditEventsData && reportsData && (
        <div className="space-y-6">
          <div className="rounded-2xl border border-slate-200 bg-white p-6 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                  <ShieldCheck className="h-5 w-5 text-emerald-700" />
                  Tamper-Evident SHA-256 Audit Chain
                </h2>
                <p className="text-xs text-slate-500 font-mono-num mt-1">
                  Status: <strong className={auditEventsData.verification.valid ? 'text-emerald-700' : 'text-red-700'}>
                    {auditEventsData.verification.valid ? 'INTACT' : 'BROKEN'}
                  </strong> · Events: {auditEventsData.verification.totalEvents} · Head Hash: {auditEventsData.verification.headHash?.slice(0, 20)}…
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleGenerateMonthly}
                  className="min-h-[40px] rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-800 cursor-pointer"
                >
                  Publish Monthly Report (2026-11)
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={handlePublishAnnualAudit}
                  className="min-h-[40px] rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-800 cursor-pointer"
                >
                  Auditor: Publish Annual Report
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleDownloadExport}
                  className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-[#0F766E] px-4 text-xs font-semibold text-white cursor-pointer"
                >
                  <Download className="h-3.5 w-3.5" /> Export Audit Bundle
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 text-slate-500">
                  <tr>
                    <th className="py-2 pr-3">Seq</th>
                    <th className="py-2 pr-3">Timestamp</th>
                    <th className="py-2 pr-3">Actor</th>
                    <th className="py-2 pr-3">Action</th>
                    <th className="py-2 pr-3">Entity</th>
                    <th className="py-2">SHA-256 Hash</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {auditEventsData.events.slice(0, 15).map((ev) => (
                    <tr key={ev.seq}>
                      <td className="py-2 pr-3 font-mono-num">#{ev.seq}</td>
                      <td className="py-2 pr-3 font-mono-num text-slate-500">{ev.at.slice(0, 19).replace('T', ' ')}</td>
                      <td className="py-2 pr-3 font-mono-num text-slate-700">{ev.actor_id}</td>
                      <td className="py-2 pr-3 font-semibold text-slate-900">{ev.action}</td>
                      <td className="py-2 pr-3 text-slate-600">{ev.entity_type}:{ev.entity_id}</td>
                      <td className="py-2 font-mono-num text-slate-500">{ev.hash.slice(0, 18)}…</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="rounded-2xl border border-slate-200 bg-white p-6 space-y-3">
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <FileCheck2 className="h-4 w-4 text-[#0F766E]" /> Monthly Public Reports
              </h3>
              {reportsData.monthly.map((mr) => (
                <div key={mr.id} className="rounded-xl border border-slate-200 p-4 text-xs space-y-1">
                  <div className="flex justify-between font-bold text-slate-900">
                    <span>Month: {mr.month_label}</span>
                    <span className="font-mono-num text-[#0F766E]">VF Closing: {formatPkr(mr.vf_closing_pkr)}</span>
                  </div>
                  <div className="text-slate-600 font-mono-num">
                    VF In: {formatPkr(mr.vf_in_pkr)} · VF Out: {formatPkr(mr.vf_out_pkr)} · CL Capital: {formatPkr(mr.cl_capital_pkr)}
                  </div>
                  <div className="text-slate-500">Reconciliation Note: {mr.unreconciled_notes}</div>
                </div>
              ))}
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-6 space-y-3">
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <Lock className="h-4 w-4 text-[#0F766E]" /> Annual Independent Audit Reports
              </h3>
              {reportsData.annual.length === 0 ? (
                <p className="text-xs text-slate-500">
                  No annual audit published yet. Sign in as <strong>Zainab Mirza (Auditor)</strong> and click &ldquo;Publish Annual Report&rdquo; above.
                </p>
              ) : (
                reportsData.annual.map((ar) => (
                  <div key={ar.id} className="rounded-xl border border-slate-200 p-4 text-xs space-y-1">
                    <div className="font-bold text-slate-900">FY {ar.fiscal_year} — {ar.auditor_name}</div>
                    <div className="text-emerald-800 font-semibold">{ar.opinion}</div>
                    <div className="text-slate-600">{ar.findings_text}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: MULTI-VILLAGE SOCIETY DIRECTORY & EXPANSION */}
      {subTab === 'villages' && (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                <Building2 className="h-5 w-5 text-[#0F766E]" />
                Multi-Village Society Registry (Autonomous Tenant Isolation)
              </h2>
              <p className="text-xs text-slate-600 mt-1">
                Cosiety launches first in Pabohar and scales to neighbouring villages by provisioning independent society tenants (`society_id`). Each society maintains isolated ledgers, rules, Vote-Points formulas, and whole-village voter registers.
              </p>
            </div>
            <button
              type="button"
              onClick={onOpenOnboardVillage}
              className="min-h-[44px] rounded-xl bg-[#0F766E] px-4 text-xs font-semibold text-white shrink-0 cursor-pointer"
            >
              Onboard New Village
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {societiesList.map((s) => {
              const active = s.id === sid;
              return (
                <div key={s.id} className={`rounded-xl border p-5 space-y-3 ${active ? 'border-[#0F766E] bg-[#0F766E]/5' : 'border-slate-200 bg-white'}`}>
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs text-slate-500">{s.district}, {s.province} · <span className="font-mono-num">{s.registration_no}</span></div>
                      <h3 className="text-lg font-bold text-slate-900 mt-0.5">
                        {pickLang(lang, s.name_en, s.name_sd, s.name_ur)}
                      </h3>
                    </div>
                    {active && (
                      <span className="inline-flex items-center gap-1 text-xs font-bold text-[#0F766E]">
                        <CheckCircle2 className="h-4 w-4" /> Active
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-2 border-t border-slate-100 pt-3 text-xs">
                    <div>
                      <div className="text-slate-500">Active Members</div>
                      <div className="font-mono-num font-bold">{s.activeMembers ?? 0}</div>
                    </div>
                    <div>
                      <div className="text-slate-500">VF Balance</div>
                      <div className="font-mono-num font-bold">{formatPkr(s.vfBalancePkr ?? 0)}</div>
                    </div>
                    <div>
                      <div className="text-slate-500">Package Levy</div>
                      <div className="font-mono-num font-bold">{formatPkr(s.activeLevyPkr ?? 50)}</div>
                    </div>
                  </div>
                  {!active && (
                    <button
                      type="button"
                      onClick={() => onSelectSociety(s.id)}
                      className="min-h-[40px] w-full rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 cursor-pointer"
                    >
                      Switch Portal to {s.name_en}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
