import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Award,
  BookOpenCheck,
  CheckCircle2,
  Droplet,
  GraduationCap,
  Lock,
  MinusCircle,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sun,
  UserCheck,
  Users,
  Wheat,
  XCircle,
} from 'lucide-react';
import type {
  BootstrapData,
  Contest,
  Election,
  LangCode,
  PointsFormula,
  PointsFormulaItem,
} from '../types';
import { pickLang, t } from '../i18n/translations';
import { apiFetch } from '../utils/api';
import { ListenButton } from '../components/ListenButton';

interface VoteViewProps {
  bootstrap: BootstrapData;
  elections: Election[];
  lang: LangCode;
  sessionToken: string | null;
  onRefresh: () => Promise<void>;
  onOpenAuth: () => void;
}

function BallotSymbol({ symbol }: { symbol: string }) {
  if (symbol === 'check') return <CheckCircle2 className="h-7 w-7 text-emerald-700" />;
  if (symbol === 'x') return <XCircle className="h-7 w-7 text-red-700" />;
  if (symbol === 'minus') return <MinusCircle className="h-7 w-7 text-slate-500" />;
  if (symbol === 'sun') return <Sun className="h-7 w-7 text-amber-600" />;
  if (symbol === 'wheat') return <Wheat className="h-7 w-7 text-amber-700" />;
  if (symbol === 'droplet') return <Droplet className="h-7 w-7 text-sky-700" />;
  return <Users className="h-7 w-7 text-[#0F766E]" />;
}

export const VoteView: React.FC<VoteViewProps> = ({
  bootstrap,
  elections,
  lang,
  sessionToken,
  onRefresh,
  onOpenAuth,
}) => {
  const sid = bootstrap.activeSociety.id;
  const [selectedChoice, setSelectedChoice] = useState<Record<string, string>>({});
  const [stepUpOtp, setStepUpOtp] = useState<Record<string, string>>({});
  const [otpIssuedFor, setOtpIssuedFor] = useState<Record<string, string>>({});
  const [kioskMode, setKioskMode] = useState(false);
  const [kioskVoterId, setKioskVoterId] = useState(
    bootstrap.personas.find((p) => p.isVerifiedVoter)?.id || ''
  );
  const [formulaData, setFormulaData] = useState<{
    formula: PointsFormula;
    items: PointsFormulaItem[];
    aggregateStats: {
      scoredMembers: number;
      avgPoints: number;
      minPoints: number;
      maxPoints: number;
      undecidedMembersCount: number;
      pendingMembersCount: number;
    };
  } | null>(null);
  const [showFormulaTable, setShowFormulaTable] = useState(false);
  const [qualKind, setQualKind] = useState<'bachelor_degree' | 'intermediate_plus'>('bachelor_degree');
  const [symbolKey, setSymbolKey] = useState('sun');
  const [syncedStatus, setSyncedStatus] = useState<Record<string, string>>({});
  const [receiptMsg, setReceiptMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isHelper = bootstrap.sessionUser?.roles.includes('village_helper');
  const isElectionAdmin = bootstrap.sessionUser?.roles.some((r) =>
    ['election_admin', 'portal_admin'].includes(r)
  );
  const isVerificationOfficer = bootstrap.sessionUser?.roles.includes('verification_officer');
  const canCertify = bootstrap.sessionUser?.roles.some((r) =>
    ['election_admin', 'verification_officer', 'portal_admin'].includes(r)
  );
  const userPts = bootstrap.sessionUser?.pointsSummary;

  useEffect(() => {
    apiFetch<NonNullable<typeof formulaData>>('/public/points-formula', {}, sid, sessionToken)
      .then(setFormulaData)
      .catch(() => {});
  }, [sid, sessionToken, elections]);

  const requestVoteOtp = async (contestId: string) => {
    setErrorMsg(null);
    const voterId = kioskMode ? kioskVoterId : bootstrap.sessionUser?.id;
    if (!voterId) {
      onOpenAuth();
      return;
    }
    try {
      const res = await apiFetch<{ demoCode: string; mobileMasked: string }>(
        '/auth/request-vote-otp',
        {
          method: 'POST',
          body: JSON.stringify({ memberId: voterId }),
        },
        sid,
        sessionToken
      );
      setOtpIssuedFor((prev) => ({
        ...prev,
        [contestId]: `OTP sent to ${res.mobileMasked} (SMS Sandbox code: ${res.demoCode})`,
      }));
    } catch (err) {
      setErrorMsg((err as Error).message);
    }
  };

  const castBallot = async (electionId: string, contest: Contest) => {
    const choiceCode = selectedChoice[contest.id];
    const otpCode = stepUpOtp[contest.id] || '';
    const voterId = kioskMode ? kioskVoterId : bootstrap.sessionUser?.id;

    if (!voterId) {
      onOpenAuth();
      return;
    }
    if (!choiceCode) {
      setErrorMsg('Please select an option card before confirming.');
      return;
    }
    if (!otpCode.trim()) {
      setErrorMsg('Request and enter the 6-digit confirmation OTP first.');
      return;
    }

    setBusy(true);
    setErrorMsg(null);
    setReceiptMsg(null);
    try {
      const idempotencyKey = crypto.randomUUID();
      const res = await apiFetch<{ pointsUsed: number; sealedUnitsRecorded: number }>(
        `/elections/${electionId}/votes`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey },
          body: JSON.stringify({
            contestId: contest.id,
            choiceCode,
            otpCode,
            channel: kioskMode ? 'assisted_kiosk' : 'self',
            voterMemberId: voterId,
          }),
        },
        sid,
        sessionToken
      );

      // Wipe kiosk selection immediately after commit (BR-24 / NFR-USE-005)
      setSelectedChoice((prev) => {
        const next = { ...prev };
        delete next[contest.id];
        return next;
      });
      setStepUpOtp((prev) => {
        const next = { ...prev };
        delete next[contest.id];
        return next;
      });
      setOtpIssuedFor((prev) => {
        const next = { ...prev };
        delete next[contest.id];
        return next;
      });

      setReceiptMsg(
        `Ballot recorded secretly: 1 participation record + ${res.sealedUnitsRecorded} identical encrypted sealed ballot unit(s) stored with zero link to your identity.`
      );
      await onRefresh();
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const checkSyncedStatus = async (contestId: string) => {
    if (!bootstrap.sessionUser) {
      onOpenAuth();
      return;
    }
    setErrorMsg(null);
    try {
      const st = await apiFetch<{
        eligible: boolean;
        voted: boolean;
        pointsAtSnapshot: number | null;
        castAt: string | null;
        channel: string | null;
      }>(`/contests/${contestId}/vote-status`, {}, sid, sessionToken);
      setSyncedStatus((p) => ({
        ...p,
        [contestId]: st.voted
          ? `Server Confirmed: Ballot recorded (${st.pointsAtSnapshot} snapshot pts via ${st.channel}) at ${st.castAt?.slice(0, 19).replace('T', ' ')} — choice remains secret.`
          : st.eligible
          ? `Server Confirmed: Not yet voted (eligible with ${st.pointsAtSnapshot} snapshot pts).`
          : 'Server Confirmed: Not in eligible snapshot for this contest.',
      }));
    } catch (err) {
      setErrorMsg((err as Error).message);
    }
  };

  const handleNominate = async (contestId: string) => {
    if (!bootstrap.sessionUser) {
      onOpenAuth();
      return;
    }
    setBusy(true);
    setErrorMsg(null);
    setReceiptMsg(null);
    try {
      await apiFetch(
        `/contests/${contestId}/candidates`,
        {
          method: 'POST',
          body: JSON.stringify({ qualificationKind: qualKind, symbolKey }),
        },
        sid,
        sessionToken
      );
      setReceiptMsg('Candidate nomination filed! Awaiting Verification Officer qualification check and Presidency Book test.');
      await onRefresh();
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleVerifyQualification = async (candidateId: string, status: 'approved' | 'rejected') => {
    setBusy(true);
    setErrorMsg(null);
    try {
      await apiFetch(
        `/candidates/${candidateId}/qualification`,
        { method: 'POST', body: JSON.stringify({ status, note: 'Degree certificate verified in person' }) },
        sid,
        sessionToken
      );
      setReceiptMsg(`Candidate qualification marked "${status}".`);
      await onRefresh();
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleRecordTraining = async (candidateId: string, score: number) => {
    setBusy(true);
    setErrorMsg(null);
    try {
      const res = await apiFetch<{ passed: boolean; passMark: number }>(
        `/candidates/${candidateId}/training`,
        { method: 'POST', body: JSON.stringify({ score }) },
        sid,
        sessionToken
      );
      setReceiptMsg(
        res.passed
          ? `CoSiety Presidency Book test PASSED (${score} >= ${res.passMark}).`
          : `Score recorded (${score} < ${res.passMark} pass mark).`
      );
      await onRefresh();
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleOpenElection = async (electionId: string) => {
    setBusy(true);
    setErrorMsg(null);
    setReceiptMsg(null);
    try {
      await apiFetch(`/elections/${electionId}/open`, { method: 'POST', body: '{}' }, sid, sessionToken);
      setReceiptMsg('Election opened and eligible voter snapshots frozen!');
      await onRefresh();
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleCloseElection = async (electionId: string) => {
    setBusy(true);
    setErrorMsg(null);
    try {
      await apiFetch(`/elections/${electionId}/close`, { method: 'POST', body: '{}' }, sid, sessionToken);
      setReceiptMsg('Election closed, sealed ballot unit invariants verified, and shuffled tally computed.');
      await onRefresh();
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleCertifyElection = async (electionId: string) => {
    setBusy(true);
    setErrorMsg(null);
    try {
      await apiFetch(`/elections/${electionId}/certify`, { method: 'POST', body: '{}' }, sid, sessionToken);
      setReceiptMsg('Election certified with two-officer sign-off!');
      await onRefresh();
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-6">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900">{t(lang, 'openVotesHeading')}</h1>
          <p className="mt-1 text-sm text-slate-600">{t(lang, 'secretBallotNote')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setShowFormulaTable((v) => !v)}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 cursor-pointer"
          >
            <Award className="h-4 w-4 text-[#0F766E]" />
            {showFormulaTable ? 'Hide Formula & Stats' : 'Public Formula & Stats'}
          </button>
          <button
            type="button"
            onClick={() => setKioskMode((v) => !v)}
            className={`inline-flex min-h-[44px] items-center gap-2 rounded-xl border px-4 py-2 text-xs font-semibold transition-colors cursor-pointer ${
              kioskMode
                ? 'border-[#0F766E] bg-[#0F766E] text-white'
                : 'border-slate-300 bg-white text-slate-800 hover:bg-slate-50'
            }`}
          >
            <UserCheck className="h-4 w-4" />
            {t(lang, 'helperKioskTitle')}: {kioskMode ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>

      {/* Signed-in Private Points Breakdown Banner */}
      {bootstrap.sessionUser && userPts && (
        <div className="rounded-2xl border border-[#0F766E]/30 bg-white p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <div className="text-xs font-bold uppercase text-[#0F766E]">
              Your Private Vote-Points ({bootstrap.sessionUser.fullName}) — Formula {userPts.formulaVersion} ({userPts.formulaStatus})
            </div>
            <div className="mt-1 text-sm text-slate-800">
              Total: <strong className="font-mono-num text-lg text-slate-900">{userPts.totalPts} / {userPts.maxPoints} pts</strong>{' '}
              · Education <span className="font-mono-num font-semibold">{userPts.educationPts}</span> + Age{' '}
              <span className="font-mono-num font-semibold">{userPts.agePts}</span> + Work{' '}
              <span className="font-mono-num font-semibold">{userPts.workPts}</span> + Exposure{' '}
              <span className="font-mono-num font-semibold">{userPts.exposurePts}</span>
            </div>
            {(userPts.pointsPending || userPts.hasUndecidedFactor) && (
              <div className="mt-1 text-xs text-amber-800 font-medium">
                {userPts.pointsPending
                  ? 'AC-PTS-04: Submitted proof factors are awaiting Verification Officer check (0 points granted for pending items).'
                  : userPts.undecidedNote || 'Includes an undecided formula option awaiting General Body decision.'}
              </div>
            )}
          </div>
          <div className="text-xs text-slate-500">
            Visible only to you, Verification Officer, and Auditor (FR-PTS-07).
          </div>
        </div>
      )}

      {/* Collapsible Public Vote-Points Formula & Aggregate Distribution */}
      {showFormulaTable && formulaData && (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-bold text-slate-900">
                Public Vote-Points Formula ({formulaData.formula.version} · Status: {formulaData.formula.status.toUpperCase()})
              </h2>
              <p className="text-xs text-slate-500">
                Max {formulaData.formula.max_points} pts · Individual scores remain private; only aggregate village distribution is published below.
              </p>
            </div>
            <div className="flex flex-wrap gap-4 text-xs font-mono-num">
              <span>Scored: <strong>{formulaData.aggregateStats.scoredMembers}</strong></span>
              <span>Avg: <strong>{formulaData.aggregateStats.avgPoints} pts</strong></span>
              <span>Range: <strong>{formulaData.aggregateStats.minPoints}–{formulaData.aggregateStats.maxPoints}</strong></span>
              <span>Undecided: <strong className="text-amber-700">{formulaData.aggregateStats.undecidedMembersCount}</strong></span>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
            {(['education', 'age', 'work', 'exposure'] as const).map((factor) => (
              <div key={factor} className="rounded-xl border border-slate-200 p-3 space-y-1.5">
                <div className="font-bold uppercase text-slate-800 border-b border-slate-100 pb-1">{factor}</div>
                {formulaData.items
                  .filter((it) => it.factor === factor)
                  .map((it) => (
                    <div key={it.id} className="flex items-center justify-between gap-2">
                      <span className="text-slate-700">{pickLang(lang, it.label_en, it.label_sd, it.label_ur)}</span>
                      <span className={`font-mono-num font-semibold shrink-0 ${it.value_points === null ? 'text-amber-700' : 'text-slate-900'}`}>
                        {it.value_points === null ? 'OD Pending' : `${it.value_points} pts`}
                      </span>
                    </div>
                  ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {kioskMode && (
        <div className="rounded-2xl border border-[#0F766E]/40 bg-[#0F766E]/5 p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-bold text-slate-900">
                Assisted Kiosk Mode Active {isHelper ? '(Village Helper Session)' : '(Sign in as Village Helper to commit)'}
              </h2>
              <p className="text-xs text-slate-600">
                The villager authenticates with their own step-up OTP and selects their candidate symbol. Selection wipes immediately after submission (NFR-USE-005).
              </p>
            </div>
            <select
              value={kioskVoterId}
              onChange={(e) => setKioskVoterId(e.target.value)}
              className="min-h-[42px] rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold"
            >
              {bootstrap.personas
                .filter((p) => p.isVerifiedVoter)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    Voter: {p.fullName}
                  </option>
                ))}
            </select>
          </div>
        </div>
      )}

      {errorMsg && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {errorMsg}
        </div>
      )}
      {receiptMsg && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-900">
          {receiptMsg}
        </div>
      )}

      {elections.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center">
          <p className="text-sm text-slate-600">
            No elections or referenda have been created yet for {bootstrap.activeSociety.name_en}.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {elections.map((elec) => {
            const title = pickLang(lang, elec.title_en, elec.title_sd, elec.title_ur);
            const desc = pickLang(lang, elec.description_en, elec.description_sd, elec.description_ur);
            const isOpen = elec.state === 'open';
            const isNomination = elec.state === 'nomination' || elec.state === 'draft';

            return (
              <article key={elec.id} className="rounded-2xl border border-slate-200 bg-white p-6 space-y-5">
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span className="font-semibold text-slate-800 uppercase">{elec.type.replace('_', ' ')}</span>
                      <span aria-hidden="true">·</span>
                      <span>
                        State: <strong className="text-slate-900 uppercase">{elec.state}</strong>
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="inline-flex items-center gap-1">
                        <Lock className="h-3 w-3" /> {elec.ballot_mode === 'secret' ? 'Secret Ballot' : 'Open Ballot'}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>Min Turnout: <strong className="font-mono-num">{Math.round(elec.min_turnout_fraction * 100)}%</strong></span>
                      <span aria-hidden="true">·</span>
                      <span>Quorum: <strong className="font-mono-num">{Math.round(elec.quorum_fraction * 100)}%</strong></span>
                    </div>
                    <h2 className="text-xl font-bold text-slate-900">{title}</h2>
                    <p className="text-sm text-slate-600 leading-relaxed">{desc}</p>
                  </div>
                  <ListenButton text={`${title}. ${desc}`} lang={lang} />
                </div>

                {/* Election Opening Gate Blockers (AC-PTS-03 & AC-EXC-01) */}
                {isNomination && elec.openingGate && !elec.openingGate.ready && (
                  <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 space-y-2 text-xs text-amber-950">
                    <div className="font-bold flex items-center gap-1.5">
                      <AlertTriangle className="h-4 w-4 text-amber-700 shrink-0" />
                      Election Opening Gate Blocked (AC-PTS-03 / AC-EXC-01):
                    </div>
                    <ul className="list-disc pl-5 space-y-1">
                      {elec.openingGate.blockers.map((b, i) => (
                        <li key={i}>{b}</li>
                      ))}
                    </ul>
                    {elec.openingGate.undecidedVoters.length > 0 && (
                      <div className="pt-1 text-amber-900">
                        Affected voters:{' '}
                        <strong>{elec.openingGate.undecidedVoters.map((u) => u.fullName).join(', ')}</strong> — Approve draft formula under Governance &amp; Audit → Formula &amp; OD Rules to resolve.
                      </div>
                    )}
                  </div>
                )}

                {/* Contests inside this Election */}
                <div className="space-y-5">
                  {elec.contests.map((contest) => {
                    const cTitle = pickLang(lang, contest.name_en, contest.name_sd, contest.name_ur);
                    const cPrompt = pickLang(lang, contest.prompt_en, contest.prompt_sd, contest.prompt_ur);
                    const canVoteSelf = !kioskMode && isOpen && contest.userEligible && !contest.hasVoted;
                    const canVoteKiosk = kioskMode && isOpen;

                    return (
                      <div key={contest.id} className="rounded-xl border border-slate-200 p-5 space-y-4">
                        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-slate-100 pb-3">
                          <div>
                            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                              <span className="font-semibold text-[#0F766E]">
                                {contest.weighting === 'points' ? 'Weighted by Vote-Points' : 'Equal Weight (1 pt · OD-02)'}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span>
                                Eligible Voters:{' '}
                                <strong className="text-slate-800 uppercase">{contest.eligible_gender_rule}</strong>
                              </span>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono-num">
                                Turnout: {contest.participationCount} / {contest.snapshot_count} ({contest.totalPointsUsed} / {contest.snapshot_total_points} pts)
                              </span>
                            </div>
                            <h3 className="mt-1 text-base font-bold text-slate-900">{cTitle}</h3>
                            <p className="text-xs text-slate-600">{cPrompt}</p>
                          </div>

                          <div className="flex items-center gap-2">
                            <div className="inline-flex items-center gap-1 rounded-lg bg-slate-50 border border-slate-200 px-2.5 py-1.5 text-[11px] font-mono-num text-slate-700">
                              <ShieldCheck className="h-3.5 w-3.5 text-emerald-700" />
                              Units {contest.sealedBallotCount} = Pts {contest.totalPointsUsed}:{' '}
                              <strong className={contest.integrityCountsMatch ? 'text-emerald-700' : 'text-red-700'}>
                                {contest.integrityCountsMatch ? 'OK' : 'ERR'}
                              </strong>
                            </div>
                            {isOpen && bootstrap.sessionUser && (
                              <button
                                type="button"
                                onClick={() => checkSyncedStatus(contest.id)}
                                className="inline-flex min-h-[34px] items-center gap-1 rounded-lg border border-slate-200 px-2.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
                              >
                                <RefreshCw className="h-3 w-3" /> Sync Status
                              </button>
                            )}
                          </div>
                        </div>

                        {syncedStatus[contest.id] && (
                          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-800">
                            {syncedStatus[contest.id]}
                          </div>
                        )}

                        {/* Candidate Qualification & Presidency Book Training List */}
                        {contest.candidates.length > 0 && (
                          <div className="space-y-2">
                            <div className="text-xs font-bold text-slate-700">
                              Candidates (Qualification + CoSiety Presidency Book Gate · AC-EXC-01)
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                              {contest.candidates.map((cand) => (
                                <div key={cand.id} className="rounded-lg border border-slate-200 bg-slate-50/70 p-3 text-xs space-y-2">
                                  <div className="flex items-center justify-between">
                                    <span className="font-bold text-slate-900">{cand.member_name}</span>
                                    <span className={`font-semibold uppercase ${cand.status === 'qualified' ? 'text-emerald-700' : 'text-amber-700'}`}>
                                      {cand.status}
                                    </span>
                                  </div>
                                  <div className="flex flex-wrap items-center gap-2 text-slate-600">
                                    <span className="inline-flex items-center gap-1">
                                      <GraduationCap className="h-3.5 w-3.5" />
                                      {cand.qualification_kind.replace('_', ' ')} ({cand.qualification_status})
                                    </span>
                                    <span>·</span>
                                    <span className="inline-flex items-center gap-1">
                                      <BookOpenCheck className="h-3.5 w-3.5" />
                                      Presidency Book: {cand.training_passed ? `Passed (${cand.training_score}%)` : 'Not passed'}
                                    </span>
                                  </div>
                                  {(isVerificationOfficer || isElectionAdmin) && isNomination && (
                                    <div className="flex flex-wrap gap-1.5 pt-1">
                                      {isVerificationOfficer && cand.qualification_status === 'pending' && (
                                        <button
                                          type="button"
                                          disabled={busy}
                                          onClick={() => handleVerifyQualification(cand.id, 'approved')}
                                          className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-800 cursor-pointer"
                                        >
                                          Verify Degree
                                        </button>
                                      )}
                                      {!cand.training_passed && (
                                        <button
                                          type="button"
                                          disabled={busy}
                                          onClick={() => handleRecordTraining(cand.id, 84)}
                                          className="rounded bg-[#0F766E] px-2 py-1 text-[11px] font-semibold text-white cursor-pointer"
                                        >
                                          Pass Presidency Book (84%)
                                        </button>
                                      )}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Self-nomination form during nomination phase */}
                        {isNomination && elec.type === 'co_president' && (
                          <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
                            <select
                              value={qualKind}
                              onChange={(e) => setQualKind(e.target.value as typeof qualKind)}
                              className="min-h-[38px] rounded-lg border border-slate-300 bg-white px-2.5 text-xs"
                            >
                              <option value="bachelor_degree">Bachelor Degree</option>
                              <option value="intermediate_plus">Intermediate + Experience</option>
                            </select>
                            <select
                              value={symbolKey}
                              onChange={(e) => setSymbolKey(e.target.value)}
                              className="min-h-[38px] rounded-lg border border-slate-300 bg-white px-2.5 text-xs"
                            >
                              <option value="sun">Sun</option>
                              <option value="wheat">Wheat</option>
                              <option value="droplet">Water Drop</option>
                            </select>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => handleNominate(contest.id)}
                              className="min-h-[38px] rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-800 hover:bg-slate-50 cursor-pointer"
                            >
                              File My Nomination
                            </button>
                          </div>
                        )}

                        {/* Open Voting Section */}
                        {isOpen && (
                          <div className="space-y-3 border-t border-slate-100 pt-3">
                            {!kioskMode && contest.hasVoted ? (
                              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-semibold text-emerald-900 flex items-center gap-2">
                                <CheckCircle2 className="h-5 w-5 text-emerald-700 shrink-0" />
                                <span>
                                  {t(lang, 'alreadyVoted')} · Snapshot weight: {contest.userPointsAtSnapshot} unit(s)
                                </span>
                              </div>
                            ) : !kioskMode && !bootstrap.sessionUser ? (
                              <button
                                type="button"
                                onClick={onOpenAuth}
                                className="min-h-[44px] rounded-xl bg-[#0F766E] px-5 py-2 text-sm font-semibold text-white cursor-pointer"
                              >
                                Sign In as Verified Voter to Cast Ballot
                              </button>
                            ) : !kioskMode && !contest.userEligible ? (
                              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-xs font-medium text-amber-900">
                                {contest.eligibilityReason || 'Not eligible for this contest.'}
                              </div>
                            ) : (canVoteSelf || canVoteKiosk) && (
                              <div className="space-y-4">
                                <div className="text-xs text-slate-600">
                                  {kioskMode
                                    ? 'Kiosk Ballot: voter uses their frozen snapshot points automatically.'
                                    : `Your frozen ballot weight: ${contest.userPointsAtSnapshot} identical sealed unit(s).`}
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                  {contest.options.map((opt) => {
                                    const optLabel = pickLang(lang, opt.labelEn, opt.labelSd, opt.labelUr);
                                    const chosen = selectedChoice[contest.id] === opt.code;
                                    return (
                                      <button
                                        key={opt.code}
                                        type="button"
                                        onClick={() =>
                                          setSelectedChoice((p) => ({ ...p, [contest.id]: opt.code }))
                                        }
                                        className={`flex min-h-[72px] items-center gap-3 rounded-xl border-2 p-4 text-left transition-colors cursor-pointer ${
                                          chosen
                                            ? 'border-[#0F766E] bg-[#0F766E]/5'
                                            : 'border-slate-200 bg-white hover:border-slate-300'
                                        }`}
                                      >
                                        <BallotSymbol symbol={opt.symbol} />
                                        <div className="min-w-0 flex-1">
                                          <div className="text-sm font-bold text-slate-900">{optLabel}</div>
                                        </div>
                                      </button>
                                    );
                                  })}
                                </div>

                                <div className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3.5">
                                  <button
                                    type="button"
                                    onClick={() => requestVoteOtp(contest.id)}
                                    className="min-h-[42px] rounded-lg border border-slate-300 bg-white px-4 text-xs font-semibold text-slate-800 hover:bg-slate-100 whitespace-nowrap cursor-pointer"
                                  >
                                    1. Send Step-Up OTP
                                  </button>
                                  <input
                                    type="text"
                                    value={stepUpOtp[contest.id] || ''}
                                    onChange={(e) =>
                                      setStepUpOtp((p) => ({ ...p, [contest.id]: e.target.value }))
                                    }
                                    placeholder="2. Enter 6-digit OTP"
                                    className="min-h-[42px] rounded-lg border border-slate-300 bg-white px-3 text-sm font-mono-num"
                                  />
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => castBallot(elec.id, contest)}
                                    className="min-h-[44px] flex-1 rounded-xl bg-[#0F766E] px-5 text-sm font-semibold text-white hover:bg-[#0D655E] disabled:opacity-50 cursor-pointer"
                                  >
                                    3. {t(lang, 'castVoteBtn')}
                                  </button>
                                </div>

                                {otpIssuedFor[contest.id] && (
                                  <div className="text-xs font-semibold text-[#0F766E]">
                                    {otpIssuedFor[contest.id]}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Contest Results & Tally */}
                        {contest.result && (
                          <div className="border-t border-slate-100 pt-3 space-y-3">
                            <div className="flex flex-wrap items-center gap-3 text-xs">
                              <span className="font-bold text-slate-900 uppercase">
                                Result: {contest.result.resultStatus}
                              </span>
                              {contest.result.winnerName && (
                                <>
                                  <span className="text-slate-400">·</span>
                                  <span className="font-bold text-[#0F766E]">
                                    Winner: {contest.result.winnerName}
                                  </span>
                                </>
                              )}
                              <span className="text-slate-400">·</span>
                              <span className="font-mono-num text-slate-700">
                                Turnout {contest.result.tallies.turnoutVoters} / {contest.result.tallies.eligibleVoters} ({contest.result.tallies.totalPointsCast} total pts)
                              </span>
                              <span className="text-slate-400">·</span>
                              <span>
                                Sealed Units Verified:{' '}
                                <strong className="font-mono-num">{contest.result.tallies.sealedBallotUnitsVerified}</strong>
                              </span>
                            </div>

                            {contest.result.anonymityWarning && (
                              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 flex items-center gap-2">
                                <ShieldAlert className="h-4 w-4 text-amber-700 shrink-0" />
                                <span>{contest.result.anonymityWarning}</span>
                              </div>
                            )}

                            {contest.result.tallies.counts && contest.result.tallies.counts.length > 0 && (
                              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                {contest.result.tallies.counts.map((cnt) => (
                                  <div key={cnt.choice_code} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                                    <div className="text-xs font-semibold text-slate-600">{cnt.label || cnt.choice_code}</div>
                                    <div className="mt-1 text-xl font-bold text-slate-900 font-mono-num">{cnt.points} pts</div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Election Admin & Dual-Certifier Controls */}
                {(isElectionAdmin || canCertify) && (
                  <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-4">
                    {isElectionAdmin && isNomination && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleOpenElection(elec.id)}
                        className="min-h-[40px] rounded-lg bg-[#0F766E] px-4 text-xs font-semibold text-white cursor-pointer"
                      >
                        Check Gate &amp; Open Election
                      </button>
                    )}
                    {isElectionAdmin && isOpen && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleCloseElection(elec.id)}
                        className="min-h-[40px] rounded-lg border border-slate-300 bg-white px-4 text-xs font-semibold text-slate-800 hover:bg-slate-50 cursor-pointer"
                      >
                        Close Window &amp; Tally Sealed Units
                      </button>
                    )}
                    {canCertify && elec.state === 'tallied' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleCertifyElection(elec.id)}
                        className="min-h-[40px] rounded-lg bg-slate-900 px-4 text-xs font-semibold text-white cursor-pointer"
                      >
                        Second Officer: Certify &amp; Seat Winner
                      </button>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
};
