import React, { useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';
import type { LangCode } from '../types';
import { t } from '../i18n/translations';

export const OfflineIndicator: React.FC<{ lang: LangCode }> = ({ lang }) => {
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  if (isOnline) return null;

  return (
    <div
      role="status"
      className="mx-auto max-w-6xl px-4 pt-3"
    >
      <div className="flex items-center gap-2.5 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm font-medium text-amber-900">
        <WifiOff className="h-4 w-4 shrink-0 text-amber-700" />
        <span>{t(lang, 'offlineBanner')}</span>
      </div>
    </div>
  );
};
