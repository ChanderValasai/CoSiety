import React from 'react';
import { Home, Landmark, Lightbulb, Users, Vote } from 'lucide-react';
import type { LangCode } from '../types';
import { t } from '../i18n/translations';
import type { NavTab } from './TopBar';

interface MobileBottomNavProps {
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  lang: LangCode;
}

export const MobileBottomNav: React.FC<MobileBottomNavProps> = ({
  activeTab,
  onSelectTab,
  lang,
}) => {
  const tabs: Array<{ id: NavTab; label: string; Icon: React.ComponentType<{ className?: string }> }> = [
    { id: 'home', label: t(lang, 'navHome'), Icon: Home },
    { id: 'vote', label: t(lang, 'navVote'), Icon: Vote },
    { id: 'money', label: t(lang, 'navMoney'), Icon: Landmark },
    { id: 'projects', label: t(lang, 'navProjects'), Icon: Lightbulb },
    { id: 'community', label: t(lang, 'navCommunity'), Icon: Users },
  ];

  return (
    <nav
      aria-label="Primary mobile navigation"
      className="fixed bottom-0 left-0 right-0 z-40 border-t border-slate-200 bg-white/95 backdrop-blur-md md:hidden pb-safe"
    >
      <div className="grid h-16 grid-cols-5 items-center">
        {tabs.map(({ id, label, Icon }) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onSelectTab(id)}
              className={`flex h-full min-h-[48px] flex-col items-center justify-center gap-0.5 px-1 transition-colors cursor-pointer ${
                active ? 'text-[#0F766E] font-semibold' : 'text-slate-500 hover:text-slate-900'
              }`}
            >
              <Icon className="h-5 w-5" />
              <span className="text-[11px] leading-tight truncate max-w-full">{label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
};
