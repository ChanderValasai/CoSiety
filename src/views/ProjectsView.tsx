import React, { useEffect, useState } from 'react';
import { CheckCircle2, FileText, Lightbulb, Plus, Receipt, ShieldAlert } from 'lucide-react';
import type { BootstrapData, LangCode, ProjectProposal } from '../types';
import { formatPkr, pickLang, t } from '../i18n/translations';
import { apiFetch } from '../utils/api';
import { ListenButton } from '../components/ListenButton';

interface ProjectsViewProps {
  bootstrap: BootstrapData;
  projects: ProjectProposal[];
  lang: LangCode;
  sessionToken: string | null;
  onRefresh: () => Promise<void>;
  onOpenAuth: () => void;
}

const STAGES = ['proposal', 'explainer', 'discussion', 'voting', 'execution', 'reporting', 'closed'] as const;

export const ProjectsView: React.FC<ProjectsViewProps> = ({
  bootstrap,
  projects,
  lang,
  sessionToken,
  onRefresh,
  onOpenAuth,
}) => {
  const sid = bootstrap.activeSociety.id;
  const draftKey = `cosiety:project-draft:${sid}`;

  const [showForm, setShowForm] = useState(false);
  const [titleEn, setTitleEn] = useState('');
  const [descriptionEn, setDescriptionEn] = useState('');
  const [category, setCategory] = useState('Water & Sanitation');
  const [estBudgetPkr, setEstBudgetPkr] = useState(25000);
  const [impactText, setImpactText] = useState('');
  const [levyEffectText, setLevyEffectText] = useState('No increase to Rs. 50 levy');
  const [submissionChannel, setSubmissionChannel] = useState<'portal' | 'helper' | 'general_body'>('portal');

  // Expense request state per project
  const [expVendor, setExpVendor] = useState('Thar Solar & Hardware');
  const [expDesc, setExpDesc] = useState('');
  const [expAmount, setExpAmount] = useState(12000);

  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Restore local draft (NFR-CON-003)
  useEffect(() => {
    try {
      const saved = localStorage.getItem(draftKey);
      if (saved) {
        const d = JSON.parse(saved);
        if (d.titleEn) setTitleEn(d.titleEn);
        if (d.descriptionEn) setDescriptionEn(d.descriptionEn);
        if (d.estBudgetPkr) setEstBudgetPkr(d.estBudgetPkr);
      }
    } catch {
      // ignore
    }
  }, [draftKey]);

  useEffect(() => {
    try {
      localStorage.setItem(draftKey, JSON.stringify({ titleEn, descriptionEn, estBudgetPkr }));
    } catch {
      // ignore
    }
  }, [draftKey, titleEn, descriptionEn, estBudgetPkr]);

  const isExecutive = bootstrap.sessionUser?.roles.some((r) =>
    ['woman_co_president', 'man_co_president', 'treasurer', 'team_member', 'portal_admin'].includes(r)
  );
  const isFinanceMaker = bootstrap.sessionUser?.roles.some((r) =>
    ['woman_co_president', 'man_co_president', 'treasurer', 'portal_admin'].includes(r)
  );

  const handleSubmitProposal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bootstrap.sessionUser) {
      onOpenAuth();
      return;
    }
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await apiFetch<{ referenceNo: string }>(
        '/projects',
        {
          method: 'POST',
          body: JSON.stringify({
            titleEn,
            descriptionEn,
            category,
            estBudgetPkr,
            impactText: impactText || 'Benefits all households in the village.',
            levyEffectText,
            submissionChannel,
          }),
        },
        sid,
        sessionToken
      );
      localStorage.removeItem(draftKey);
      setTitleEn('');
      setDescriptionEn('');
      setImpactText('');
      setShowForm(false);
      setMsg(`Project proposal ${res.referenceNo} submitted! Next step: Executive feasibility review & Sindhi explainer.`);
      await onRefresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleTransition = async (projectId: string, nextState: string) => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await apiFetch(
        `/projects/${projectId}/stage`,
        { method: 'PATCH', body: JSON.stringify({ nextState }) },
        sid,
        sessionToken
      );
      setMsg(`Project advanced to "${nextState}" stage.`);
      await onRefresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleRequestExpense = async (projectId: string, e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await apiFetch<{ requestedTeamSide: string | null }>(
        `/projects/${projectId}/expenses`,
        {
          method: 'POST',
          body: JSON.stringify({
            vendorName: expVendor,
            description: expDesc || 'Project hardware supply',
            amountPkr: expAmount,
            invoiceDocRef: `INV-${Date.now().toString().slice(-4)}.pdf`,
          }),
        },
        sid,
        sessionToken
      );
      setExpDesc('');
      setMsg(
        `Expense request submitted (${res.requestedTeamSide || 'executive'} team). Must be approved by the other Co-President's team without conflict of interest (FR-FIN-012 / AC-PRJ-02).`
      );
      await onRefresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleApproveExpense = async (projectId: string, expId: string) => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await apiFetch<{ vfEntryId: string }>(
        `/projects/${projectId}/expenses/${expId}/approve`,
        { method: 'POST', body: '{}' },
        sid,
        sessionToken
      );
      setMsg(`Expense approved cross-team (COI checked) and posted to Village Fund (${res.vfEntryId})!`);
      await onRefresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-6">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900">Participatory Projects &amp; Cross-Team Execution</h1>
          <p className="mt-1 text-sm text-slate-600">
            Whole-village proposals tracked by Reference ID. Every VF expense enforces cross-team maker–checker (Woman ↔ Man team) and Conflict-of-Interest recusal.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="inline-flex min-h-[48px] items-center gap-2 rounded-xl bg-[#0F766E] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#0D655E] shrink-0 cursor-pointer"
        >
          <Plus className="h-4 w-4" />
          {t(lang, 'proposeProjectBtn')}
        </button>
      </div>

      {err && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{err}</div>}
      {msg && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">{msg}</div>}

      {showForm && (
        <form onSubmit={handleSubmitProposal} className="rounded-2xl border border-slate-200 bg-white p-6 space-y-4">
          <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            <Lightbulb className="h-5 w-5 text-[#0F766E]" />
            New Whole-Village Project Idea (Auto-saved offline draft)
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Project Title</label>
              <input
                required
                value={titleEn}
                onChange={(e) => setTitleEn(e.target.value)}
                placeholder="e.g. Shaded Drinking Water Tank near School"
                className="w-full min-h-[42px] rounded-lg border border-slate-300 px-3 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Estimated Budget (PKR)</label>
              <input
                required
                type="number"
                min={500}
                value={estBudgetPkr}
                onChange={(e) => setEstBudgetPkr(Number(e.target.value))}
                className="w-full min-h-[42px] rounded-lg border border-slate-300 px-3 text-sm font-mono-num"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Category</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full min-h-[42px] rounded-lg border border-slate-300 bg-white px-3 text-sm"
              >
                <option>Water &amp; Sanitation</option>
                <option>Education &amp; Inclusion</option>
                <option>Safety &amp; Infrastructure</option>
                <option>Health &amp; Clinic</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Submission Channel</label>
              <select
                value={submissionChannel}
                onChange={(e) => setSubmissionChannel(e.target.value as typeof submissionChannel)}
                className="w-full min-h-[42px] rounded-lg border border-slate-300 bg-white px-3 text-sm"
              >
                <option value="portal">Online Portal</option>
                <option value="helper">Via Village Helper</option>
                <option value="general_body">General Body Meeting</option>
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-slate-700 mb-1">Levy Impact Statement</label>
              <input
                value={levyEffectText}
                onChange={(e) => setLevyEffectText(e.target.value)}
                className="w-full min-h-[42px] rounded-lg border border-slate-300 px-3 text-sm"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Description &amp; Whole-Village Benefit</label>
            <textarea
              required
              rows={3}
              value={descriptionEn}
              onChange={(e) => setDescriptionEn(e.target.value)}
              placeholder="Explain what the village needs and how households benefit..."
              className="w-full rounded-lg border border-slate-300 p-3 text-sm"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="min-h-[42px] rounded-lg border border-slate-200 px-4 text-sm font-semibold text-slate-700 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="min-h-[42px] rounded-lg bg-[#0F766E] px-5 text-sm font-semibold text-white cursor-pointer"
            >
              Submit Idea
            </button>
          </div>
        </form>
      )}

      {projects.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-600">
          No project proposals yet for {bootstrap.activeSociety.name_en}. Submit the first village idea above!
        </div>
      ) : (
        <div className="space-y-6">
          {projects.map((prj) => {
            const title = pickLang(lang, prj.title_en, prj.title_sd, prj.title_ur);
            const desc = pickLang(lang, prj.description_en, prj.description_sd, prj.description_ur);
            const stageIdx = STAGES.indexOf(prj.state as (typeof STAGES)[number]);
            const nextStage = stageIdx >= 0 && stageIdx < STAGES.length - 1 ? STAGES[stageIdx + 1] : null;
            const pct = prj.allocated_budget_pkr > 0 ? Math.min(100, Math.round((prj.spentPkr / prj.allocated_budget_pkr) * 100)) : 0;

            return (
              <article key={prj.id} className="rounded-2xl border border-slate-200 bg-white p-6 space-y-5">
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span className="font-mono-num font-bold text-slate-900">{prj.reference_no}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-semibold text-slate-800">{prj.category}</span>
                      <span aria-hidden="true">·</span>
                      <span>Channel: {prj.submission_channel.replace('_', ' ')}</span>
                      <span aria-hidden="true">·</span>
                      <span>Proposed by {prj.proposer_name}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono-num font-bold text-[#0F766E]">
                        Budget: {formatPkr(prj.est_budget_pkr)}
                      </span>
                    </div>
                    <h2 className="mt-1 text-xl font-bold text-slate-900">{title}</h2>
                    <p className="mt-1.5 text-sm text-slate-600 leading-relaxed">{desc}</p>
                    {prj.levy_effect_text && (
                      <div className="mt-1 text-xs text-slate-500">Levy Impact: {prj.levy_effect_text}</div>
                    )}
                  </div>
                  <ListenButton text={`${title}. ${desc}`} lang={lang} />
                </div>

                {/* 7-Stage Lifecycle Strip */}
                <div className="grid grid-cols-7 gap-1 pt-1">
                  {STAGES.map((st, idx) => {
                    const done = idx <= stageIdx;
                    return (
                      <div key={st} className="text-center">
                        <div className={`h-2 rounded-full ${done ? 'bg-[#0F766E]' : 'bg-slate-200'}`} />
                        <div className={`mt-1 text-[10px] capitalize truncate ${idx === stageIdx ? 'font-bold text-[#0F766E]' : 'text-slate-500'}`}>
                          {st}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {prj.feasibility_note && (
                  <div className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-3 text-xs text-slate-700 space-y-1">
                    <div><strong>Executive Feasibility Review:</strong> {prj.feasibility_note}</div>
                    {prj.explainer_summary_sd && (
                      <div dir="rtl" className="text-slate-600"><strong>سنڌي وضاحت:</strong> {prj.explainer_summary_sd}</div>
                    )}
                  </div>
                )}

                {prj.final_report_text && (
                  <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-900 flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
                    <div><strong>Final Public Report:</strong> {prj.final_report_text}</div>
                  </div>
                )}

                {/* Execution Budget & Cross-Team + COI Expense Approvals */}
                {prj.allocated_budget_pkr > 0 && (
                  <div className="border-t border-slate-100 pt-4 space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="font-bold text-slate-900">
                        Project Spend vs Allocation: {formatPkr(prj.spentPkr)} / {formatPkr(prj.allocated_budget_pkr)} ({pct}%)
                      </span>
                    </div>
                    <div className="h-2.5 w-full rounded-full bg-slate-100 overflow-hidden">
                      <div className="h-full bg-[#0F766E]" style={{ width: `${pct}%` }} />
                    </div>

                    {prj.expenses.length > 0 && (
                      <div className="divide-y divide-slate-100 border border-slate-200 rounded-xl">
                        {prj.expenses.map((exp) => (
                          <div key={exp.id} className="p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs">
                            <div>
                              <div className="font-bold text-slate-900 flex items-center gap-1.5">
                                <Receipt className="h-3.5 w-3.5 text-slate-400" />
                                {exp.vendor_name} · <span className="font-mono-num">{formatPkr(exp.amount_pkr)}</span>
                              </div>
                              <div className="text-slate-500 mt-0.5">
                                {exp.description} · Receipt: {exp.invoice_doc_ref} · Prepared on{' '}
                                <strong className="uppercase">{exp.requested_team_side || 'exec'} team</strong> · Status:{' '}
                                <strong className={exp.status === 'approved' ? 'text-emerald-700' : 'text-amber-700'}>
                                  {exp.status}
                                </strong>
                              </div>
                            </div>
                            {exp.status === 'pending' && isExecutive && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => handleApproveExpense(prj.id, exp.id)}
                                className="min-h-[36px] rounded-lg bg-slate-900 px-3 text-xs font-semibold text-white hover:bg-slate-800 cursor-pointer shrink-0"
                              >
                                Approve Cross-Team (COI Checked)
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {prj.state === 'execution' && isFinanceMaker && (
                      <form onSubmit={(e) => handleRequestExpense(prj.id, e)} className="grid grid-cols-1 sm:grid-cols-4 gap-2 bg-slate-50 p-3 rounded-xl border border-slate-200">
                        <input
                          value={expVendor}
                          onChange={(e) => setExpVendor(e.target.value)}
                          placeholder="Vendor Name"
                          className="min-h-[38px] rounded-lg border border-slate-300 bg-white px-2.5 text-xs"
                        />
                        <input
                          value={expDesc}
                          onChange={(e) => setExpDesc(e.target.value)}
                          placeholder="Item / Invoice Description"
                          className="min-h-[38px] rounded-lg border border-slate-300 bg-white px-2.5 text-xs"
                        />
                        <input
                          type="number"
                          value={expAmount}
                          onChange={(e) => setExpAmount(Number(e.target.value))}
                          className="min-h-[38px] rounded-lg border border-slate-300 bg-white px-2.5 text-xs font-mono-num"
                        />
                        <button
                          type="submit"
                          disabled={busy}
                          className="min-h-[38px] rounded-lg bg-[#0F766E] px-3 text-xs font-semibold text-white cursor-pointer"
                        >
                          Request Expense
                        </button>
                      </form>
                    )}

                    <div className="flex items-start gap-1.5 text-[11px] text-slate-500">
                      <ShieldAlert className="h-3.5 w-3.5 text-amber-700 shrink-0 mt-0.5" />
                      <span>
                        Cross-Team &amp; COI Demo: Woman-team requests (e.g. Bilawal) cannot be approved by Woman team (Fatima) — only the Man team! And Man-team member <strong>Rehman Samoon</strong> is blocked by Conflict-of-Interest recusal on &ldquo;Thar Solar &amp; Hardware&rdquo;, so <strong>Sajjad / Parveen</strong> must approve.
                      </span>
                    </div>
                  </div>
                )}

                {/* Executive Lifecycle Transition Controls */}
                {isExecutive && nextStage && prj.state !== 'voting' && (
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-4">
                    <span className="text-xs text-slate-500 flex items-center gap-1">
                      <FileText className="h-3.5 w-3.5" /> Co-President Team Workflow Control
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleTransition(prj.id, nextStage)}
                      className="min-h-[40px] rounded-lg border border-[#0F766E]/40 bg-[#0F766E]/5 px-4 text-xs font-semibold text-[#0F766E] hover:bg-[#0F766E]/10 cursor-pointer"
                    >
                      Advance to &ldquo;{nextStage}&rdquo;
                    </button>
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
