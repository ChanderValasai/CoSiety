import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  BookOpen,
  Calendar,
  FileText,
  Megaphone,
  MessageSquare,
  Play,
  Plus,
} from 'lucide-react';
import type { BootstrapData, LangCode } from '../types';
import { pickLang } from '../i18n/translations';
import { apiFetch } from '../utils/api';
import { ListenButton } from '../components/ListenButton';

interface CommunityViewProps {
  bootstrap: BootstrapData;
  lang: LangCode;
  sessionToken: string | null;
  onRefresh: () => Promise<void>;
  onOpenAuth: () => void;
}

export const CommunityView: React.FC<CommunityViewProps> = ({
  bootstrap,
  lang,
  sessionToken,
  onRefresh,
  onOpenAuth,
}) => {
  const sid = bootstrap.activeSociety.id;
  const [subTab, setSubTab] = useState<'gb' | 'issues' | 'questions' | 'notices'>('gb');

  const [gbData, setGbData] = useState<{
    agendaItems: Array<{ id: string; submitted_by_name: string; title: string; description: string; channel: string; status: string; created_at: string }>;
    meetings: Array<{ id: string; title: string; scheduled_at: string; location: string; agenda: string; status: string }>;
  } | null>(null);

  const [issues, setIssues] = useState<Array<{
    id: string;
    reporter_name: string;
    place_text: string;
    category: string;
    description: string;
    visibility: 'public' | 'executive_only';
    status: string;
    executive_response: string | null;
    created_at: string;
  }>>([]);

  const [questions, setQuestions] = useState<Array<{
    id: string;
    asked_by_name: string;
    question_text: string;
    deadline_at: string;
    answer_text: string | null;
    answered_by_name: string | null;
    isOverdue: boolean;
  }>>([]);

  const [notices, setNotices] = useState<Array<{
    id: string;
    category: string;
    current_version: number;
    versions: Array<{ title_en: string; title_sd: string; title_ur: string; body_en: string; body_sd: string; body_ur: string; published_at: string }>;
  }>>([]);

  const [mediaAssets, setMediaAssets] = useState<Array<{
    id: string;
    category: string;
    title_en: string;
    title_sd: string;
    title_ur: string;
    summary_en: string;
    summary_sd: string;
    summary_ur: string;
    duration_sec: number;
    size_kb_360p: number;
    size_kb_audio: number;
  }>>([]);

  // Forms
  const [agendaTitle, setAgendaTitle] = useState('');
  const [agendaDesc, setAgendaDesc] = useState('');
  const [agendaChannel, setAgendaChannel] = useState<'portal' | 'helper'>('portal');
  const [mtgTitle, setMtgTitle] = useState('');
  const [mtgLocation, setMtgLocation] = useState('Village Primary School Courtyard');
  const [mtgAgenda, setMtgAgenda] = useState('');

  const [issPlace, setIssPlace] = useState('Near Primary School Water Point');
  const [issCat, setIssCat] = useState('Water');
  const [issDesc, setIssDesc] = useState('');
  const [issVis, setIssVis] = useState<'public' | 'executive_only'>('public');

  const [qText, setQText] = useState('');
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});
  const [noticeTitle, setNoticeTitle] = useState('');
  const [noticeBody, setNoticeBody] = useState('');
  const [noticeSms, setNoticeSms] = useState(false);
  const [audioOnlyMode, setAudioOnlyMode] = useState(true);

  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isExecutive = bootstrap.sessionUser?.roles.some((r) =>
    ['woman_co_president', 'man_co_president', 'treasurer', 'team_member', 'portal_admin'].includes(r)
  );

  const loadData = async () => {
    try {
      const [gov, iss, q, ntc, med] = await Promise.all([
        apiFetch<NonNullable<typeof gbData>>('/governance', {}, sid, sessionToken),
        apiFetch<{ issues: typeof issues }>('/issues', {}, sid, sessionToken),
        apiFetch<{ questions: typeof questions }>('/questions', {}, sid, sessionToken),
        apiFetch<{ notices: typeof notices }>('/notices', {}, sid, sessionToken),
        apiFetch<{ media: typeof mediaAssets }>('/media', {}, sid, sessionToken),
      ]);
      setGbData({ agendaItems: gov.agendaItems, meetings: gov.meetings });
      setIssues(iss.issues);
      setQuestions(q.questions);
      setNotices(ntc.notices);
      setMediaAssets(med.media);
    } catch {
      // handled gracefully
    }
  };

  useEffect(() => {
    loadData();
  }, [sid, sessionToken]);

  const handleSubmitAgenda = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bootstrap.sessionUser) {
      onOpenAuth();
      return;
    }
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await apiFetch(
        '/governance/agenda',
        {
          method: 'POST',
          body: JSON.stringify({ title: agendaTitle, description: agendaDesc, channel: agendaChannel }),
        },
        sid,
        sessionToken
      );
      setAgendaTitle('');
      setAgendaDesc('');
      setMsg('Agenda item submitted for the next whole-village General Body meeting.');
      await loadData();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleScheduleMeeting = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await apiFetch(
        '/governance/meetings',
        {
          method: 'POST',
          body: JSON.stringify({ title: mtgTitle, location: mtgLocation, agenda: mtgAgenda }),
        },
        sid,
        sessionToken
      );
      setMtgTitle('');
      setMtgAgenda('');
      setMsg('Whole-village General Body meeting scheduled.');
      await loadData();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleSubmitIssue = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bootstrap.sessionUser) {
      onOpenAuth();
      return;
    }
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await apiFetch(
        '/issues',
        {
          method: 'POST',
          body: JSON.stringify({
            placeText: issPlace,
            category: issCat,
            description: issDesc,
            visibility: issVis,
          }),
        },
        sid,
        sessionToken
      );
      setIssDesc('');
      setMsg(`Issue submitted with visibility "${issVis}".`);
      await loadData();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleConvertIssue = async (issueId: string) => {
    setBusy(true);
    setErr(null);
    try {
      await apiFetch(
        `/issues/${issueId}`,
        { method: 'PATCH', body: JSON.stringify({ convertToProject: true }) },
        sid,
        sessionToken
      );
      setMsg('Issue converted into a formal whole-village Project Proposal.');
      await Promise.all([loadData(), onRefresh()]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleAskQuestion = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bootstrap.sessionUser) {
      onOpenAuth();
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await apiFetch('/questions', { method: 'POST', body: JSON.stringify({ questionText: qText }) }, sid, sessionToken);
      setQText('');
      setMsg('Public question posted with a 7-day Co-President response deadline.');
      await Promise.all([loadData(), onRefresh()]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleAnswerQuestion = async (qId: string) => {
    const answerText = answerDrafts[qId] || '';
    if (!answerText.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await apiFetch(`/questions/${qId}/answer`, { method: 'POST', body: JSON.stringify({ answerText }) }, sid, sessionToken);
      setMsg('Public answer published.');
      await Promise.all([loadData(), onRefresh()]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handlePublishNotice = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await apiFetch(
        '/notices',
        { method: 'POST', body: JSON.stringify({ titleEn: noticeTitle, bodyEn: noticeBody, criticalSms: noticeSms }) },
        sid,
        sessionToken
      );
      setNoticeTitle('');
      setNoticeBody('');
      setMsg('Notice published with immutable version v1.');
      await Promise.all([loadData(), onRefresh()]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-200 bg-white p-6">
        <h1 className="text-2xl font-extrabold text-slate-900">Community Participation &amp; Knowledge Library</h1>
        <p className="mt-1 text-sm text-slate-600">
          Whole-village General Body agenda &amp; meetings (zero Mohalla/Caste subdivisions), issue reporting, public Q&amp;A accountability, notices, and low-bandwidth explainers.
        </p>

        <div className="mt-5 flex flex-wrap gap-1.5 rounded-xl bg-slate-100 p-1">
          {[
            { id: 'gb' as const, label: '1. General Body Agenda & Meetings' },
            { id: 'issues' as const, label: '2. Report a Problem' },
            { id: 'questions' as const, label: '3. Public Questions' },
            { id: 'notices' as const, label: '4. Notices & Media Library' },
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
                subTab === tab.id ? 'bg-white text-[#1B6EB5] ring-1 ring-[#8EC5E8]/60 shadow-sm' : 'text-slate-600 hover:text-[#1B6EB5]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {err && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{err}</div>}
      {msg && <div className="rounded-xl border border-[#6DB33F]/45 bg-[#6DB33F]/10 px-4 py-3 text-sm text-[#2E5E12]">{msg}</div>}

      {/* TAB 1: GENERAL BODY AGENDA & WHOLE-VILLAGE MEETINGS */}
      {subTab === 'gb' && gbData && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="rounded-2xl border border-slate-200 bg-white p-6 space-y-4">
              <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <FileText className="h-4 w-4 text-[#1B6EB5]" />
                Submitted General Body Agenda Items
              </h2>
              {gbData.agendaItems.length === 0 ? (
                <p className="text-xs text-slate-500">No agenda items submitted yet.</p>
              ) : (
                <div className="divide-y divide-slate-100">
                  {gbData.agendaItems.map((ag) => (
                    <div key={ag.id} className="py-3 first:pt-0">
                      <div className="flex items-center justify-between text-xs text-slate-500">
                        <span>By <strong>{ag.submitted_by_name}</strong> ({ag.channel})</span>
                        <span className="font-semibold uppercase text-[#1B6EB5]">{ag.status}</span>
                      </div>
                      <div className="text-sm font-bold text-slate-900 mt-0.5">{ag.title}</div>
                      <p className="text-xs text-slate-600 mt-1">{ag.description}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <form onSubmit={handleSubmitAgenda} className="rounded-2xl border border-slate-200 bg-white p-6 space-y-3 h-fit">
              <h2 className="text-base font-bold text-slate-900">
                Submit Agenda Item (Any Verified Villager)
              </h2>
              <input
                required
                value={agendaTitle}
                onChange={(e) => setAgendaTitle(e.target.value)}
                placeholder="Agenda item headline"
                className="w-full min-h-[40px] rounded-lg border border-slate-300 px-3 text-sm"
              />
              <select
                value={agendaChannel}
                onChange={(e) => setAgendaChannel(e.target.value as 'portal' | 'helper')}
                className="w-full min-h-[40px] rounded-lg border border-slate-300 bg-white px-3 text-sm"
              >
                <option value="portal">Submitted Directly in Portal</option>
                <option value="helper">Submitted via Village Helper</option>
              </select>
              <textarea
                required
                rows={3}
                value={agendaDesc}
                onChange={(e) => setAgendaDesc(e.target.value)}
                placeholder="Describe the whole-village discussion topic or resolution proposal..."
                className="w-full rounded-lg border border-slate-300 p-3 text-sm"
              />
              <button
                type="submit"
                disabled={busy}
                className="min-h-[42px] rounded-lg bg-[#1B6EB5] hover:bg-[#155791] px-4 text-xs font-semibold text-white cursor-pointer"
              >
                Submit to General Body Agenda
              </button>
            </form>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="rounded-2xl border border-slate-200 bg-white p-6 space-y-4">
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <Calendar className="h-4 w-4 text-[#1B6EB5]" />
                General Body Meetings
              </h3>
              <div className="divide-y divide-slate-100">
                {gbData.meetings.map((m) => (
                  <div key={m.id} className="py-3 first:pt-0">
                    <div className="text-xs text-slate-500 font-mono-num">
                      {m.scheduled_at.slice(0, 10)} · {m.location} · {m.status}
                    </div>
                    <div className="text-sm font-bold text-slate-900 mt-0.5">{m.title}</div>
                    <p className="text-xs text-slate-600 mt-1">{m.agenda}</p>
                  </div>
                ))}
              </div>
            </div>

            {isExecutive && (
              <form onSubmit={handleScheduleMeeting} className="rounded-2xl border border-slate-200 bg-white p-6 space-y-3">
                <h3 className="text-base font-bold text-slate-900">Schedule General Body Meeting (Co-Presidents / Team)</h3>
                <input
                  required
                  value={mtgTitle}
                  onChange={(e) => setMtgTitle(e.target.value)}
                  placeholder="Meeting Title"
                  className="w-full min-h-[40px] rounded-lg border border-slate-300 px-3 text-sm"
                />
                <input
                  required
                  value={mtgLocation}
                  onChange={(e) => setMtgLocation(e.target.value)}
                  placeholder="Location in Village"
                  className="w-full min-h-[40px] rounded-lg border border-slate-300 px-3 text-sm"
                />
                <textarea
                  required
                  rows={2}
                  value={mtgAgenda}
                  onChange={(e) => setMtgAgenda(e.target.value)}
                  placeholder="Agenda summary..."
                  className="w-full rounded-lg border border-slate-300 p-3 text-sm"
                />
                <button
                  type="submit"
                  disabled={busy}
                  className="min-h-[42px] rounded-lg bg-slate-900 px-4 text-xs font-semibold text-white cursor-pointer"
                >
                  Publish Meeting Notice
                </button>
              </form>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: ISSUE REPORTING (place_text + public | executive_only) */}
      {subTab === 'issues' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <form onSubmit={handleSubmitIssue} className="rounded-2xl border border-slate-200 bg-white p-6 space-y-3 h-fit">
            <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-[#F28C28]" />
              Report a Village Issue
            </h2>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Place / Landmark (Whole-Village)</label>
              <input
                required
                value={issPlace}
                onChange={(e) => setIssPlace(e.target.value)}
                placeholder="e.g. Near Girls Primary School Gate"
                className="w-full min-h-[40px] rounded-lg border border-slate-300 px-3 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Category</label>
              <select
                value={issCat}
                onChange={(e) => setIssCat(e.target.value)}
                className="w-full min-h-[40px] rounded-lg border border-slate-300 bg-white px-3 text-sm"
              >
                <option>Water</option>
                <option>Connectivity</option>
                <option>Roads &amp; Lighting</option>
                <option>Dispute / Sensitive</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Visibility (AC-ISS-01)</label>
              <select
                value={issVis}
                onChange={(e) => setIssVis(e.target.value as 'public' | 'executive_only')}
                className="w-full min-h-[40px] rounded-lg border border-slate-300 bg-white px-3 text-sm"
              >
                <option value="public">Public (Visible to Whole Village)</option>
                <option value="executive_only">Executive Only (Confidential)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Description</label>
              <textarea
                required
                rows={3}
                value={issDesc}
                onChange={(e) => setIssDesc(e.target.value)}
                placeholder="Describe the problem..."
                className="w-full rounded-lg border border-slate-300 p-3 text-sm"
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="w-full min-h-[44px] rounded-lg bg-[#1B6EB5] hover:bg-[#155791] px-4 text-sm font-semibold text-white cursor-pointer"
            >
              Submit Issue
            </button>
          </form>

          <div className="lg:col-span-2 space-y-4">
            {issues.map((iss) => (
              <div key={iss.id} className="rounded-2xl border border-slate-200 bg-white p-5 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                  <span>
                    <strong className="text-slate-900">{iss.category}</strong> · {iss.place_text} · Visibility: <strong>{iss.visibility}</strong>
                  </span>
                  <span className="font-semibold uppercase text-[#1B6EB5]">{iss.status}</span>
                </div>
                <p className="text-sm text-slate-900">{iss.description}</p>
                {iss.executive_response && (
                  <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-xs text-slate-700">
                    <strong>Executive Response:</strong> {iss.executive_response}
                  </div>
                )}
                {isExecutive && iss.status !== 'converted_to_project' && (
                  <div className="pt-1">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleConvertIssue(iss.id)}
                      className="text-xs font-semibold text-[#1B6EB5] hover:underline cursor-pointer"
                    >
                      Convert Issue into Whole-Village Project Proposal →
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TAB 3: PUBLIC QUESTIONS */}
      {subTab === 'questions' && (
        <div className="space-y-6">
          <form onSubmit={handleAskQuestion} className="rounded-2xl border border-slate-200 bg-white p-6 space-y-3">
            <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-[#1B6EB5]" />
              Ask the Co-Presidents &amp; Team (7-Day Public Response Deadline)
            </h2>
            <div className="flex flex-col sm:flex-row gap-3">
              <input
                required
                value={qText}
                onChange={(e) => setQText(e.target.value)}
                placeholder="Ask about spending, projects, levy, or executive decisions..."
                className="flex-1 min-h-[44px] rounded-lg border border-slate-300 px-3 text-sm"
              />
              <button
                type="submit"
                disabled={busy}
                className="min-h-[44px] rounded-lg bg-[#1B6EB5] hover:bg-[#155791] px-5 text-sm font-semibold text-white cursor-pointer"
              >
                Post Question
              </button>
            </div>
          </form>

          <div className="space-y-4">
            {questions.map((q) => (
              <div key={q.id} className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="text-slate-500">
                    Asked by <strong className="text-slate-800">{q.asked_by_name}</strong> · Deadline {q.deadline_at.slice(0, 10)}
                  </span>
                  {q.isOverdue ? (
                    <span className="font-bold text-red-700">OVERDUE (Publicly Flagged)</span>
                  ) : q.answer_text ? (
                    <span className="font-bold text-[#3A7019]">Answered</span>
                  ) : (
                    <span className="font-semibold text-[#B45309]">Pending</span>
                  )}
                </div>
                <p className="text-sm font-bold text-slate-900">{q.question_text}</p>
                {q.answer_text ? (
                  <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 text-sm text-slate-700">
                    <strong>{q.answered_by_name}:</strong> {q.answer_text}
                  </div>
                ) : isExecutive && (
                  <div className="flex gap-2">
                    <input
                      value={answerDrafts[q.id] || ''}
                      onChange={(e) => setAnswerDrafts((p) => ({ ...p, [q.id]: e.target.value }))}
                      placeholder="Write official Co-President team response..."
                      className="flex-1 min-h-[40px] rounded-lg border border-slate-300 px-3 text-xs"
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleAnswerQuestion(q.id)}
                      className="min-h-[40px] rounded-lg bg-slate-900 px-4 text-xs font-semibold text-white cursor-pointer"
                    >
                      Publish Answer
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TAB 4: NOTICES & VIDEO/AUDIO EXPLAINER LIBRARY */}
      {subTab === 'notices' && (
        <div className="space-y-6">
          {isExecutive && (
            <form onSubmit={handlePublishNotice} className="rounded-2xl border border-slate-200 bg-white p-6 space-y-3">
              <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <Plus className="h-4 w-4 text-[#1B6EB5]" />
                Co-President Team: Publish Immutable Notice
              </h2>
              <input
                required
                value={noticeTitle}
                onChange={(e) => setNoticeTitle(e.target.value)}
                placeholder="Notice Headline"
                className="w-full min-h-[42px] rounded-lg border border-slate-300 px-3 text-sm"
              />
              <textarea
                required
                rows={2}
                value={noticeBody}
                onChange={(e) => setNoticeBody(e.target.value)}
                placeholder="Notice body text..."
                className="w-full rounded-lg border border-slate-300 p-3 text-sm"
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-xs text-slate-700">
                  <input type="checkbox" checked={noticeSms} onChange={(e) => setNoticeSms(e.target.checked)} />
                  Send critical SMS alert to SMS Sandbox
                </label>
                <button
                  type="submit"
                  disabled={busy}
                  className="min-h-[42px] rounded-lg bg-[#1B6EB5] hover:bg-[#155791] px-5 text-xs font-semibold text-white cursor-pointer"
                >
                  Publish Notice v1
                </button>
              </div>
            </form>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="rounded-2xl border border-slate-200 bg-white p-6 space-y-4">
              <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                <Megaphone className="h-4 w-4 text-[#1B6EB5]" />
                Published Notices (Versioned)
              </h2>
              <div className="divide-y divide-slate-100">
                {notices.map((n) => {
                  const v = n.versions[0];
                  if (!v) return null;
                  const title = pickLang(lang, v.title_en, v.title_sd, v.title_ur);
                  const body = pickLang(lang, v.body_en, v.body_sd, v.body_ur);
                  return (
                    <div key={n.id} className="py-3.5 first:pt-0">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="text-xs text-slate-500">
                            {n.category} · Version {n.current_version} · {v.published_at.slice(0, 10)}
                          </div>
                          <h3 className="text-sm font-bold text-slate-900 mt-0.5">{title}</h3>
                          <p className="text-sm text-slate-600 mt-1">{body}</p>
                        </div>
                        <ListenButton text={`${title}. ${body}`} lang={lang} compact />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                  <BookOpen className="h-4 w-4 text-[#1B6EB5]" />
                  Explainer Library (incl. Presidency Book)
                </h2>
                <button
                  type="button"
                  onClick={() => setAudioOnlyMode((v) => !v)}
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 cursor-pointer"
                >
                  Mode: {audioOnlyMode ? 'Audio-Only (Low Bandwidth)' : '360p Video + Text'}
                </button>
              </div>
              <div className="space-y-3">
                {mediaAssets.map((m) => {
                  const title = pickLang(lang, m.title_en, m.title_sd, m.title_ur);
                  const sum = pickLang(lang, m.summary_en, m.summary_sd, m.summary_ur);
                  return (
                    <div key={m.id} className="rounded-xl border border-slate-200 p-4 space-y-2">
                      <div className="flex items-center justify-between text-xs text-slate-500">
                        <span>{m.category}</span>
                        <span className="font-mono-num">
                          {m.duration_sec}s · {audioOnlyMode ? `${m.size_kb_audio} KB audio` : `${m.size_kb_360p} KB 360p`}
                        </span>
                      </div>
                      <h3 className="text-sm font-bold text-slate-900">{title}</h3>
                      <p className="text-xs text-slate-600">{sum}</p>
                      <div className="pt-1 flex items-center gap-2">
                        <ListenButton text={`${title}. ${sum}`} lang={lang} />
                        {!audioOnlyMode && (
                          <span className="inline-flex items-center gap-1 text-xs text-slate-500">
                            <Play className="h-3.5 w-3.5" /> 360p Low-Bitrate Transcript Ready
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
