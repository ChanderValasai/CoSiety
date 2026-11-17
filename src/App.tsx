/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useState } from 'react';
import type {
  BootstrapData,
  Election,
  LangCode,
  LedgerSummary,
  ProjectProposal,
} from './types';
import { apiFetch } from './utils/api';
import { stopSpeaking } from './utils/speech';
import { TopBar, type NavTab } from './components/TopBar';
import { MobileBottomNav } from './components/MobileBottomNav';
import { OfflineIndicator } from './components/OfflineIndicator';
import { AuthSmsModal } from './components/AuthSmsModal';
import { SocietyOnboardingModal } from './components/SocietyOnboardingModal';
import { HomeView } from './views/HomeView';
import { VoteView } from './views/VoteView';
import { MoneyView } from './views/MoneyView';
import { ProjectsView } from './views/ProjectsView';
import { CommunityView } from './views/CommunityView';
import { GovernanceAdminView } from './views/GovernanceAdminView';

interface NoticeRecord {
  id: string;
  category: string;
  current_version: number;
  versions: Array<{
    title_en: string;
    title_sd: string;
    title_ur: string;
    body_en: string;
    body_sd: string;
    body_ur: string;
    published_at: string;
  }>;
}

interface QuestionRecord {
  id: string;
  question_text: string;
  answer_text: string | null;
  isOverdue: boolean;
  deadline_at: string;
}

function loadStoredString(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

export default function App() {
  const [societyId, setSocietyId] = useState<string>(() =>
    loadStoredString('cosiety:societyId', 'pabohar')
  );
  const [sessionToken, setSessionToken] = useState<string | null>(() => {
    try {
      return localStorage.getItem('cosiety:sessionToken');
    } catch {
      return null;
    }
  });
  const [lang, setLang] = useState<LangCode>(() => {
    const saved = loadStoredString('cosiety:lang', 'en');
    return saved === 'sd' || saved === 'ur' ? saved : 'en';
  });
  const [activeTab, setActiveTab] = useState<NavTab>('home');

  const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null);
  const [ledgerSummary, setLedgerSummary] = useState<LedgerSummary | null>(null);
  const [elections, setElections] = useState<Election[]>([]);
  const [projects, setProjects] = useState<ProjectProposal[]>([]);
  const [notices, setNotices] = useState<NoticeRecord[]>([]);
  const [questions, setQuestions] = useState<QuestionRecord[]>([]);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authModalMode, setAuthModalMode] = useState<'account' | 'register' | 'sms'>('account');
  const [onboardModalOpen, setOnboardModalOpen] = useState(false);

  // Sync HTML lang and RTL/LTR direction dynamically
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'en' ? 'ltr' : 'rtl';
    try {
      localStorage.setItem('cosiety:lang', lang);
    } catch {
      // ignore
    }
    return () => {
      stopSpeaking();
    };
  }, [lang]);

  const handleSessionChange = useCallback((token: string | null) => {
    setSessionToken(token);
    try {
      if (token) {
        localStorage.setItem('cosiety:sessionToken', token);
      } else {
        localStorage.removeItem('cosiety:sessionToken');
      }
    } catch {
      // ignore
    }
  }, []);

  const handleSelectSociety = useCallback((nextId: string) => {
    stopSpeaking();
    setSocietyId(nextId);
    setSessionToken(null);
    try {
      localStorage.setItem('cosiety:societyId', nextId);
      localStorage.removeItem('cosiety:sessionToken');
    } catch {
      // ignore
    }
  }, []);

  const loadAll = useCallback(async () => {
    setLoadError(null);
    try {
      const [boot, summary, elecRes, prjRes, noticeRes, qRes] = await Promise.all([
        apiFetch<BootstrapData>('/bootstrap', {}, societyId, sessionToken),
        apiFetch<LedgerSummary>('/public/ledger/summary', {}, societyId, sessionToken),
        apiFetch<{ elections: Election[] }>('/elections', {}, societyId, sessionToken),
        apiFetch<{ projects: ProjectProposal[] }>('/projects', {}, societyId, sessionToken),
        apiFetch<{ notices: NoticeRecord[] }>('/notices', {}, societyId, sessionToken),
        apiFetch<{ questions: QuestionRecord[] }>('/questions', {}, societyId, sessionToken),
      ]);

      // If stored societyId does not exist anymore, fall back to activeSociety returned by server
      if (boot.activeSociety && boot.activeSociety.id !== societyId) {
        setSocietyId(boot.activeSociety.id);
      }

      setBootstrap(boot);
      setLedgerSummary(summary);
      setElections(elecRes.elections);
      setProjects(prjRes.projects);
      setNotices(noticeRes.notices);
      setQuestions(qRes.questions);
    } catch (err) {
      setLoadError((err as Error).message || 'Unable to connect to CoSiety server.');
    } finally {
      setLoading(false);
    }
  }, [societyId, sessionToken]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const openAuthModal = (mode: 'account' | 'register' | 'sms' = 'account') => {
    setAuthModalMode(mode);
    setAuthModalOpen(true);
  };

  if (loading && !bootstrap) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] flex items-center justify-center p-6">
        <div className="text-center space-y-3">
          <img
            src="/assets/aistudio/Gemini_Generated_Image_gkw9vzgkw9vzgkw9_016a5295.jfif"
            alt="CoSiety"
            className="mx-auto h-16 w-16 rounded-2xl object-cover border border-slate-200 bg-white shadow-sm"
          />
          <div className="text-xl font-extrabold text-slate-900">
            <span className="text-[#EA580C]">Co</span>
            <span className="text-[#1D68A7]">Siety</span>
          </div>
          <p className="text-sm text-slate-500">Loading Village Cooperative Portal...</p>
        </div>
      </div>
    );
  }

  if (!bootstrap) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] flex items-center justify-center p-6">
        <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-center space-y-4">
          <h1 className="text-lg font-bold text-slate-900">Connection Notice</h1>
          <p className="text-sm text-slate-600">{loadError || 'Unable to load cooperative data.'}</p>
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              loadAll();
            }}
            className="min-h-[44px] rounded-xl bg-[#0F766E] px-5 text-sm font-semibold text-white cursor-pointer"
          >
            Retry Connection
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#0F172A] flex flex-col pb-20 md:pb-8">
      <TopBar
        activeTab={activeTab}
        onSelectTab={(tab) => {
          stopSpeaking();
          setActiveTab(tab);
        }}
        lang={lang}
        onChangeLang={setLang}
        societies={bootstrap.societies}
        activeSociety={bootstrap.activeSociety}
        onSelectSociety={handleSelectSociety}
        onOpenOnboardVillage={() => setOnboardModalOpen(true)}
        sessionUser={bootstrap.sessionUser}
        onOpenAuthModal={() => openAuthModal('account')}
        onOpenSmsInbox={() => openAuthModal('sms')}
      />

      <OfflineIndicator lang={lang} />

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        {loadError && (
          <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 flex items-center justify-between gap-3">
            <span>{loadError}</span>
            <button
              type="button"
              onClick={loadAll}
              className="text-xs font-semibold text-amber-950 underline cursor-pointer"
            >
              Refresh
            </button>
          </div>
        )}

        {activeTab === 'home' && (
          <HomeView
            bootstrap={bootstrap}
            ledgerSummary={ledgerSummary}
            elections={elections}
            notices={notices}
            questions={questions}
            lang={lang}
            onNavigate={setActiveTab}
            onOpenRegister={() => openAuthModal('register')}
            onOpenOnboardVillage={() => setOnboardModalOpen(true)}
          />
        )}

        {activeTab === 'vote' && (
          <VoteView
            bootstrap={bootstrap}
            elections={elections}
            lang={lang}
            sessionToken={sessionToken}
            onRefresh={loadAll}
            onOpenAuth={() => openAuthModal('account')}
          />
        )}

        {activeTab === 'money' && (
          <MoneyView
            bootstrap={bootstrap}
            ledgerSummary={ledgerSummary}
            lang={lang}
            sessionToken={sessionToken}
            onRefresh={loadAll}
            onOpenAuth={() => openAuthModal('account')}
          />
        )}

        {activeTab === 'projects' && (
          <ProjectsView
            bootstrap={bootstrap}
            projects={projects}
            lang={lang}
            sessionToken={sessionToken}
            onRefresh={loadAll}
            onOpenAuth={() => openAuthModal('account')}
          />
        )}

        {activeTab === 'community' && (
          <CommunityView
            bootstrap={bootstrap}
            lang={lang}
            sessionToken={sessionToken}
            onRefresh={loadAll}
            onOpenAuth={() => openAuthModal('account')}
          />
        )}

        {activeTab === 'governance' && (
          <GovernanceAdminView
            bootstrap={bootstrap}
            lang={lang}
            sessionToken={sessionToken}
            onRefresh={loadAll}
            onSelectSociety={handleSelectSociety}
            onOpenOnboardVillage={() => setOnboardModalOpen(true)}
          />
        )}
      </main>

      <footer className="mx-auto w-full max-w-6xl px-4 sm:px-6 pt-4 pb-6 border-t border-slate-200 text-xs text-slate-500 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          CoSiety · {bootstrap.activeSociety.name_en} ({bootstrap.activeSociety.registration_no}) · Woman &amp; Man Co-Presidents · Vote-Points Trial · Three Separated Ledgers
        </div>
        <div>
          Active Societies: <span className="font-mono-num font-semibold text-slate-700">{bootstrap.societies.length}</span> · Multi-Village Autonomous Architecture
        </div>
      </footer>

      <MobileBottomNav
        activeTab={activeTab}
        onSelectTab={(tab) => {
          stopSpeaking();
          setActiveTab(tab);
        }}
        lang={lang}
      />

      <AuthSmsModal
        open={authModalOpen}
        initialMode={authModalMode}
        onClose={() => setAuthModalOpen(false)}
        bootstrap={bootstrap}
        lang={lang}
        sessionToken={sessionToken}
        onSessionChange={handleSessionChange}
        onRefresh={loadAll}
      />

      <SocietyOnboardingModal
        open={onboardModalOpen}
        onClose={() => setOnboardModalOpen(false)}
        onCreated={async (newId) => {
          handleSelectSociety(newId);
        }}
      />
    </div>
  );
}
