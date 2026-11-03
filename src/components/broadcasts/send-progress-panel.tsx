'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { BroadcastSendStats } from '@/hooks/use-broadcast-sending';
import { sendEtaMinutes, sendLooksWrong } from '@/lib/broadcasts/send-progress';

interface SendProgressPanelProps {
  isProcessing: boolean;
  progress: number;
  stats?: BroadcastSendStats;
}

/**
 * Live progress of a broadcast send running in this tab: bar, X of Y,
 * sent / failed, time left, failure alert. While active it also warns
 * before closing the tab (the send runs here; closing it stops it).
 * Used by the wizard (step 4) and by "Resume sending" on the detail page.
 */
export function SendProgressPanel({ isProcessing, progress, stats }: SendProgressPanelProps) {
  const t = useTranslations('Broadcasts.wizard');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isProcessing) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      clearInterval(timer);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [isProcessing]);

  if (!isProcessing) return null;

  const eta = stats ? sendEtaMinutes(stats, now) : null;

  return (
    <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <p className="text-sm font-medium text-foreground">{t('scheduleSend.sending')}</p>
        </div>
        <span className="text-xs font-medium text-primary">{progress}%</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-muted">
        <div
          className="h-1.5 rounded-full bg-primary transition-all duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>
      {stats && stats.total > 0 && (
        <div className="mt-3 space-y-1.5 text-xs">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
            <span>
              {t('scheduleSend.statsProcessed', {
                done: stats.sent + stats.failed,
                total: stats.total,
                pct: Math.round(((stats.sent + stats.failed) / stats.total) * 100),
              })}
            </span>
            <span className="text-emerald-600 dark:text-emerald-400">
              {t('scheduleSend.statsSent', { count: stats.sent })}
            </span>
            <span className={stats.failed > 0 ? 'text-red-500' : undefined}>
              {t('scheduleSend.statsFailed', { count: stats.failed })}
            </span>
            {eta !== null && (
              <span>{eta < 1 ? t('scheduleSend.etaUnderMinute') : t('scheduleSend.eta', { min: eta })}</span>
            )}
          </div>
          {sendLooksWrong(stats) ? (
            <p className="font-medium text-red-500">{t('scheduleSend.manyFailed')}</p>
          ) : (
            <p className="text-muted-foreground">{t('scheduleSend.allGood')}</p>
          )}
          <p className="font-medium text-foreground">{t('scheduleSend.keepTabOpen')}</p>
        </div>
      )}
    </div>
  );
}
