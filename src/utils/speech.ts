import type { LangCode } from '../types';

let activeUtterance: SpeechSynthesisUtterance | null = null;

export function speakText(
  text: string,
  lang: LangCode,
  onStart?: () => void,
  onEnd?: () => void
): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    onStart?.();
    setTimeout(() => onEnd?.(), 1500);
    return;
  }

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  const targetLang = lang === 'sd' ? 'sd-PK' : lang === 'ur' ? 'ur-PK' : 'en-US';
  utterance.lang = targetLang;
  utterance.rate = 0.92;

  const voices = window.speechSynthesis.getVoices();
  const matched =
    voices.find((v) => v.lang.toLowerCase().startsWith(lang)) ||
    voices.find((v) => v.lang.toLowerCase().startsWith('ur')) ||
    voices.find((v) => v.lang.toLowerCase().startsWith('en'));
  if (matched) utterance.voice = matched;

  utterance.onstart = () => onStart?.();
  utterance.onend = () => {
    activeUtterance = null;
    onEnd?.();
  };
  utterance.onerror = () => {
    activeUtterance = null;
    onEnd?.();
  };

  activeUtterance = utterance;
  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking(): void {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
  activeUtterance = null;
}

export function isSpeakingActive(): boolean {
  return Boolean(activeUtterance);
}
