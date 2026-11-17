import React from 'react';
import { Globe, MessageSquare, Plus, ShieldCheck } from 'lucide-react';
import type { LangCode, SessionUser, Society } from '../types';
import { pickLang, t } from '../i18n/translations';
import { PWAInstallButton } from './PWAInstallButton';

export type NavTab = 'home' | 'vote' | 'money' | 'projects' | 'community' | 'governance';

interface TopBarProps {
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  lang: LangCode;
  onChangeLang: (lang: LangCode) => void;
  societies: Society[];
  activeSociety: Society;
  onSelectSociety: (societyId: string) => void;
  onOpenOnboardVillage: () => void;
  sessionUser: SessionUser | null;
  onOpenAuthModal: () => void;
  onOpenSmsInbox: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  activeTab,
  onSelectTab,
  lang,
  onChangeLang,
  societies,
  activeSociety,
  onSelectSociety,
  onOpenOnboardVillage,
  sessionUser,
  onOpenAuthModal,
  onOpenSmsInbox,
}) => {
  const navItems: Array<{ id: NavTab; label: string }> = [
    { id: 'home', label: t(lang, 'navHome') },
    { id: 'vote', label: t(lang, 'navVote') },
    { id: 'money', label: t(lang, 'navMoney') },
    { id: 'projects', label: t(lang, 'navProjects') },
    { id: 'community', label: t(lang, 'navCommunity') },
  ];

  return (
    <div className="bg-white border-b border-slate-200">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="mx-auto flex max-w-6xl items-center justify-between gap-8 px-4 py-3 sm:px-6">
        <button
          type="button"
          onClick={() => onSelectTab('home')}
          className="text-xl font-extrabold tracking-tight text-[#0F172A] whitespace-nowrap shrink-0 cursor-pointer"
        >
          {t(lang, 'brand')}
        </button>

        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectTab(item.id)}
              className={`py-1.5 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === item.id
                  ? 'border-[#0F766E] text-[#0F766E] font-semibold'
                  : 'border-transparent hover:text-slate-900'
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={onOpenAuthModal}
            className="min-h-[42px] rounded-lg bg-[#0F766E] px-4 py-2 text-sm font-semibold text-white hover:bg-[#0D655E] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {sessionUser ? sessionUser.fullName : t(lang, 'signIn')}
          </button>
        </div>
      </header>

      {/* Workspace Sub-Bar: Village Switcher, Language Switcher, Governance/Audit & SMS Sandbox */}
      <div className="border-t border-slate-100 bg-[#F8FAFC]">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-2 sm:px-6">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="village-select" className="text-xs font-semibold text-slate-500 whitespace-nowrap">
              {t(lang, 'activeVillage')}:
            </label>
            <select
              id="village-select"
              value={activeSociety.id}
              onChange={(e) => onSelectSociety(e.target.value)}
              className="min-h-[38px] rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-800 focus:border-[#0F766E] focus:outline-none cursor-pointer"
            >
              {societies.map((s) => (
                <option key={s.id} value={s.id}>
                  {pickLang(lang, s.name_en, s.name_sd, s.name_ur)} ({s.district})
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={onOpenOnboardVillage}
              className="inline-flex min-h-[38px] items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:border-[#0F766E]/50 hover:text-[#0F766E] whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Plus className="h-3.5 w-3.5" />
              {t(lang, 'addVillage')}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onSelectTab('governance')}
              className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border px-3 py-1 text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === 'governance'
                  ? 'border-[#0F766E] bg-[#0F766E]/10 text-[#0F766E]'
                  : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              {t(lang, 'navGovernance')}
            </button>

            <button
              type="button"
              onClick={onOpenSmsInbox}
              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <MessageSquare className="h-3.5 w-3.5" />
              {t(lang, 'smsInbox')}
            </button>

            <div className="inline-flex items-center rounded-lg border border-slate-200 bg-white p-0.5">
              <Globe className="mx-1.5 h-3.5 w-3.5 text-slate-400" />
              {(['en', 'sd', 'ur'] as const).map((code) => (
                <button
                  key={code}
                  type="button"
                  onClick={() => onChangeLang(code)}
                  className={`min-h-[32px] rounded-md px-2.5 py-1 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    lang === code
                      ? 'bg-[#0F766E] text-white'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {code === 'en' ? 'EN' : code === 'sd' ? 'سنڌي' : 'اردو'}
                </button>
              ))}
            </div>

            <PWAInstallButton />
          </div>
        </div>
      </div>
    </div>
  );
};
