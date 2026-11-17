import React from 'react';
import {
  ArrowRight,
  Award,
  Building2,
  Landmark,
  Lightbulb,
  Megaphone,
  MessageCircleWarning,
  UserPlus,
  Vote,
} from 'lucide-react';
import type { BootstrapData, Election, LangCode, LedgerSummary } from '../types';
import { formatPkr, pickLang, t } from '../i18n/translations';
import { ListenButton } from '../components/ListenButton';
import type { NavTab } from '../components/TopBar';

interface HomeViewProps {
  bootstrap: BootstrapData;
  ledgerSummary: LedgerSummary | null;
  elections: Election[];
  notices: Array<{
    id: string;
    category: string;
    current_version: number;
    versions: Array<{ title_en: string; title_sd: string; title_ur: string; body_en: string; body_sd: string; body_ur: string; published_at: string }>;
  }>;
  questions: Array<{ id: string; question_text: string; answer_text: string | null; isOverdue: boolean; deadline_at: string }>;
  lang: LangCode;
  onNavigate: (tab: NavTab) => void;
  onOpenRegister: () => void;
  onOpenOnboardVillage: () => void;
}

export const HomeView: React.FC<HomeViewProps> = ({
  bootstrap,
  ledgerSummary,
  elections,
  notices,
  questions,
  lang,
  onNavigate,
  onOpenRegister,
  onOpenOnboardVillage,
}) => {
  const soc = bootstrap.activeSociety;
  const villageTitle = pickLang(lang, soc.name_en, soc.name_sd, soc.name_ur);
  const openElections = elections.filter((e) => e.state === 'open');
  const openContestsCount = openElections.reduce((acc, e) => acc + e.contests.length, 0);
  const overdueQuestions = questions.filter((q) => q.isOverdue);
  const userPts = bootstrap.sessionUser?.pointsSummary;

  const heroSpeech = `${villageTitle} Cooperative Society. ${t(lang, 'heroSubtitle')} ${
    ledgerSummary
      ? `Village Fund confirmed bank balance is ${ledgerSummary.villageFund.bankBalancePkr} rupees.`
      : ''
  }`;

  return (
    <div className="space-y-8">
      {/* Village Hero & Whole-Village Metrics Strip */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 sm:p-8">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
          <div className="space-y-3 max-w-2xl">
            <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-slate-500">
              <span>{soc.district}, {soc.province}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono-num">{soc.registration_no}</span>
              <span aria-hidden="true">·</span>
              <span>{bootstrap.societies.length} {bootstrap.societies.length === 1 ? 'Village Active' : 'Villages Active'}</span>
              <span aria-hidden="true">·</span>
              <span className="font-semibold text-[#1B6EB5]">Whole-Village Society (Zero Subdivisions)</span>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-slate-900">
                {villageTitle} Cooperative Society
              </h1>
              <ListenButton text={heroSpeech} lang={lang} />
            </div>

            <p className="text-base text-slate-600 leading-relaxed">
              {t(lang, 'heroSubtitle')}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={onOpenRegister}
              className="inline-flex min-h-[48px] items-center gap-2 rounded-xl bg-[#1B6EB5] px-5 py-3 text-sm font-semibold text-white hover:bg-[#155791] transition-colors cursor-pointer"
            >
              <UserPlus className="h-4 w-4" />
              {t(lang, 'registerMemberBtn')}
            </button>
            <button
              type="button"
              onClick={onOpenOnboardVillage}
              className="inline-flex min-h-[48px] items-center gap-2 rounded-xl border border-[#8A8D91]/40 bg-white px-4 py-3 text-sm font-semibold text-slate-700 hover:border-[#1B6EB5]/50 hover:bg-[#8EC5E8]/10 transition-colors cursor-pointer"
            >
              <Building2 className="h-4 w-4 text-[#8A8D91]" />
              {t(lang, 'addVillage')}
            </button>
          </div>
        </div>

        {/* Clean Tabular Whole-Village Participation Metrics */}
        <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-4 border-t border-slate-100 pt-6">
          <div>
            <div className="text-xs font-medium text-slate-500">{t(lang, 'verifiedVoters')}</div>
            <div className="mt-1 text-2xl font-bold text-slate-900 font-mono-num">
              {bootstrap.stats.verifiedVoters}
            </div>
          </div>
          <div>
            <div className="text-xs font-medium text-slate-500">{t(lang, 'womenVoters')} / {t(lang, 'menVoters')}</div>
            <div className="mt-1 text-2xl font-bold text-slate-900 font-mono-num">
              {bootstrap.stats.womenVoters} / {bootstrap.stats.menVoters}
            </div>
          </div>
          <div>
            <div className="text-xs font-medium text-slate-500">Vote-Points Formula</div>
            <div className="mt-1 text-base font-bold text-slate-900 font-mono-num">
              {bootstrap.stats.formulaVersion} ({bootstrap.stats.formulaStatus})
            </div>
          </div>
          <div>
            <div className="text-xs font-medium text-slate-500">{t(lang, 'pendingQueue')}</div>
            <div className="mt-1 text-2xl font-bold text-[#B45309] font-mono-num">
              {bootstrap.stats.pendingVerifications}
            </div>
          </div>
        </div>

        {/* Private Signed-in Member Vote-Points Strip */}
        {bootstrap.sessionUser && userPts && (
          <div className="mt-5 rounded-xl border border-[#8EC5E8] bg-[#8EC5E8]/15 px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2 text-slate-900">
              <Award className="h-4 w-4 text-[#1B6EB5] shrink-0" />
              <span>
                <strong>Private Vote-Points Summary ({bootstrap.sessionUser.fullName}):</strong>{' '}
                <span className="font-mono-num font-bold text-[#1B6EB5]">
                  {userPts.totalPts} / {userPts.maxPoints} pts
                </span>{' '}
                (Edu {userPts.educationPts} + Age {userPts.agePts} + Work {userPts.workPts} + Exposure {userPts.exposurePts})
              </span>
            </div>
            <div className="text-slate-600">
              {userPts.pointsPending
                ? 'Pending Verification Officer approval'
                : userPts.hasUndecidedFactor
                ? 'Includes undecided formula tier'
                : 'Verified & active for weighted Co-President elections'}
            </div>
          </div>
        )}
      </section>

      {/* Three Large Accessible Action Tiles (SDS §10.4) */}
      <section aria-label="Primary actions" className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <div className="flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-6">
          <div>
            <div className="flex items-center justify-between">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#1B6EB5]/10 text-[#1B6EB5]">
                <Vote className="h-6 w-6" />
              </div>
              <ListenButton text={`${t(lang, 'tileVoteTitle')}. ${t(lang, 'tileVoteDesc')}`} lang={lang} compact />
            </div>
            <h2 className="mt-4 text-xl font-bold text-slate-900">{t(lang, 'tileVoteTitle')}</h2>
            <p className="mt-1.5 text-sm text-slate-600 leading-relaxed">{t(lang, 'tileVoteDesc')}</p>
            <div className="mt-3 text-xs font-semibold text-[#1B6EB5] font-mono-num">
              {openElections.length} election{openElections.length === 1 ? '' : 's'} · {openContestsCount} open contest{openContestsCount === 1 ? '' : 's'}
            </div>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('vote')}
            className="mt-5 inline-flex min-h-[48px] w-full items-center justify-between rounded-xl bg-[#1B6EB5] px-4 py-3 text-sm font-semibold text-white hover:bg-[#155791] transition-colors cursor-pointer"
          >
            <span>Open Contests &amp; Ballots</span>
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-6">
          <div>
            <div className="flex items-center justify-between">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#8EC5E8]/25 text-[#1B6EB5]">
                <Landmark className="h-6 w-6" />
              </div>
              <ListenButton text={`${t(lang, 'tileMoneyTitle')}. ${t(lang, 'tileMoneyDesc')}`} lang={lang} compact />
            </div>
            <h2 className="mt-4 text-xl font-bold text-slate-900">{t(lang, 'tileMoneyTitle')}</h2>
            <p className="mt-1.5 text-sm text-slate-600 leading-relaxed">{t(lang, 'tileMoneyDesc')}</p>
            <div className="mt-3 text-xs font-semibold text-slate-700 font-mono-num">
              Levy: {formatPkr(ledgerSummary?.villageFund.activeLevyPkr ?? 50)} / package (cap {formatPkr(ledgerSummary?.villageFund.levyCapPkr ?? 100)})
            </div>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('money')}
            className="mt-5 inline-flex min-h-[48px] w-full items-center justify-between rounded-xl border border-[#8A8D91]/45 bg-white px-4 py-3 text-sm font-semibold text-slate-900 hover:border-[#1B6EB5] hover:bg-[#8EC5E8]/10 transition-colors cursor-pointer"
          >
            <span>Inspect 3 Ledgers</span>
            <ArrowRight className="h-4 w-4 text-[#1B6EB5]" />
          </button>
        </div>

        <div className="flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-6">
          <div>
            <div className="flex items-center justify-between">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#F28C28]/15 text-[#C46810]">
                <Lightbulb className="h-6 w-6" />
              </div>
              <ListenButton text={`${t(lang, 'tileIdeasTitle')}. ${t(lang, 'tileIdeasDesc')}`} lang={lang} compact />
            </div>
            <h2 className="mt-4 text-xl font-bold text-slate-900">{t(lang, 'tileIdeasTitle')}</h2>
            <p className="mt-1.5 text-sm text-slate-600 leading-relaxed">{t(lang, 'tileIdeasDesc')}</p>
            <div className="mt-3 text-xs font-semibold text-slate-700">
              Proposal → Explainer → Discussion → Vote → Cross-Team Execution
            </div>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('projects')}
            className="mt-5 inline-flex min-h-[48px] w-full items-center justify-between rounded-xl border border-[#8A8D91]/45 bg-white px-4 py-3 text-sm font-semibold text-slate-900 hover:border-[#1B6EB5] hover:bg-[#8EC5E8]/10 transition-colors cursor-pointer"
          >
            <span>View Projects</span>
            <ArrowRight className="h-4 w-4 text-[#1B6EB5]" />
          </button>
        </div>
      </section>

      {/* Three Separated Money Streams Side-by-Side (NEVER combined into one total!) */}
      {ledgerSummary && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-bold text-slate-900">Three Separated Financial Streams</h2>
            <span className="text-xs text-slate-500">{t(lang, 'streamSeparationBanner')}</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            <div className="rounded-2xl border border-[#1B6EB5]/35 bg-white p-5">
              <div className="text-xs font-bold text-[#1B6EB5]">{t(lang, 'vfTitle')}</div>
              <div className="mt-3 text-xs text-slate-500">{t(lang, 'availableBalance')}</div>
              <div className="mt-0.5 text-2xl font-extrabold text-slate-900 font-mono-num">
                {formatPkr(ledgerSummary.villageFund.bankBalancePkr)}
              </div>
              <div className="mt-3 space-y-1 border-t border-slate-100 pt-3 text-xs text-slate-600">
                <div className="flex justify-between">
                  <span>Unallocated Available</span>
                  <span className="font-mono-num font-semibold">{formatPkr(ledgerSummary.villageFund.unallocatedAvailablePkr)}</span>
                </div>
                <div className="flex justify-between">
                  <span>{t(lang, 'inTransitNote')}</span>
                  <span className="font-mono-num font-semibold text-[#B45309]">{formatPkr(ledgerSummary.villageFund.transfersInFlightPkr)}</span>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-[#8EC5E8] bg-white p-5">
              <div className="text-xs font-bold text-[#155791]">{t(lang, 'clTitle')}</div>
              <div className="mt-3 text-xs text-slate-500">{t(lang, 'totalCapital')}</div>
              <div className="mt-0.5 text-2xl font-extrabold text-slate-900 font-mono-num">
                {formatPkr(ledgerSummary.contributorLedgerAggregate.totalCapitalPkr)}
              </div>
              <div className="mt-3 space-y-1 border-t border-slate-100 pt-3 text-xs text-slate-600">
                <div className="flex justify-between">
                  <span>Equipment Paid to VilloThar</span>
                  <span className="font-mono-num font-semibold">{formatPkr(ledgerSummary.contributorLedgerAggregate.totalInfraPaidPkr)}</span>
                </div>
                <div className="flex justify-between">
                  <span>{t(lang, 'returnsPaid')}</span>
                  <span className="font-mono-num font-semibold">{formatPkr(ledgerSummary.contributorLedgerAggregate.totalReturnsPaidPkr)}</span>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-[#F28C28]/45 bg-white p-5">
              <div className="text-xs font-bold text-[#9A4D06]">{t(lang, 'opsTitle')}</div>
              <div className="mt-3 text-xs text-slate-500">{t(lang, 'reportedRevenue')}</div>
              <div className="mt-0.5 text-2xl font-extrabold text-slate-900 font-mono-num">
                {formatPkr(ledgerSummary.operationsReported.totalPackageRevenuePkr)}
              </div>
              <div className="mt-3 space-y-1 border-t border-slate-100 pt-3 text-xs text-slate-600">
                <div className="flex justify-between">
                  <span>Paid Individual Packages</span>
                  <span className="font-mono-num font-semibold">{ledgerSummary.operationsReported.totalPackagesSold.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span>{t(lang, 'levyReported')}</span>
                  <span className="font-mono-num font-semibold">{formatPkr(ledgerSummary.operationsReported.totalLevyReportedPkr)}</span>
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Notices & Overdue Public Questions */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-2xl border border-slate-200 bg-white p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <Megaphone className="h-4 w-4 text-[#1B6EB5]" />
              {t(lang, 'recentNoticesHeading')}
            </h2>
            <button
              type="button"
              onClick={() => onNavigate('community')}
              className="text-xs font-semibold text-[#1B6EB5] hover:underline cursor-pointer"
            >
              View All
            </button>
          </div>
          {notices.length === 0 ? (
            <p className="text-sm text-slate-500">No published notices yet for {soc.name_en}.</p>
          ) : (
            <div className="divide-y divide-slate-100">
              {notices.slice(0, 3).map((n) => {
                const v = n.versions[0];
                if (!v) return null;
                const title = pickLang(lang, v.title_en, v.title_sd, v.title_ur);
                const body = pickLang(lang, v.body_en, v.body_sd, v.body_ur);
                return (
                  <div key={n.id} className="py-3.5 first:pt-0 last:pb-0">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-xs text-slate-500 mb-1">
                          {n.category} · v{n.current_version} · {v.published_at.slice(0, 10)}
                        </div>
                        <h3 className="text-sm font-bold text-slate-900">{title}</h3>
                        <p className="mt-1 text-sm text-slate-600 leading-relaxed">{body}</p>
                      </div>
                      <ListenButton text={`${title}. ${body}`} lang={lang} compact />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <MessageCircleWarning className="h-4 w-4 text-[#F28C28]" />
              {t(lang, 'publicQuestionsHeading')}
            </h2>
            <button
              type="button"
              onClick={() => onNavigate('community')}
              className="text-xs font-semibold text-[#1B6EB5] hover:underline cursor-pointer"
            >
              Ask / Answer
            </button>
          </div>

          {overdueQuestions.length > 0 && (
            <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs font-semibold text-red-800">
              {overdueQuestions.length} public question(s) passed the Executive response deadline and are flagged publicly (AC-AUD-02).
            </div>
          )}

          {questions.length === 0 ? (
            <p className="text-sm text-slate-500">No public questions submitted yet.</p>
          ) : (
            <div className="divide-y divide-slate-100">
              {questions.slice(0, 3).map((q) => (
                <div key={q.id} className="py-3.5 first:pt-0 last:pb-0">
                  <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
                    <span>Deadline: {q.deadline_at.slice(0, 10)}</span>
                    {q.isOverdue ? (
                      <span className="font-bold text-red-700">{t(lang, 'overdueLabel')}</span>
                    ) : q.answer_text ? (
                      <span className="font-semibold text-[#3A7019]">Answered</span>
                    ) : (
                      <span className="font-semibold text-[#B45309]">Awaiting Answer</span>
                    )}
                  </div>
                  <p className="text-sm font-semibold text-slate-900">{q.question_text}</p>
                  {q.answer_text && (
                    <p className="mt-1 text-sm text-slate-600">{q.answer_text}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
