import React, { useState } from 'react';
import { Square, Volume2 } from 'lucide-react';
import type { LangCode } from '../types';
import { t } from '../i18n/translations';
import { speakText, stopSpeaking } from '../utils/speech';

interface ListenButtonProps {
  text: string;
  lang: LangCode;
  compact?: boolean;
}

export const ListenButton: React.FC<ListenButtonProps> = ({ text, lang, compact = false }) => {
  const [speaking, setSpeaking] = useState(false);

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (speaking) {
      stopSpeaking();
      setSpeaking(false);
      return;
    }
    speakText(
      text,
      lang,
      () => setSpeaking(true),
      () => setSpeaking(false)
    );
  };

  return (
    <button
      type="button"
      onClick={handleToggle}
      aria-label={speaking ? t(lang, 'stopListening') : t(lang, 'listen')}
      className={`inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
        speaking
          ? 'border-[#0F766E] bg-[#0F766E] text-white'
          : 'border-slate-200 bg-white text-slate-700 hover:border-[#0F766E]/50 hover:text-[#0F766E]'
      }`}
    >
      {speaking ? <Square className="h-3.5 w-3.5 fill-current" /> : <Volume2 className="h-3.5 w-3.5" />}
      {!compact && <span>{speaking ? t(lang, 'stopListening') : t(lang, 'listen')}</span>}
    </button>
  );
};
