'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, ClipboardList, GraduationCap, Lightbulb, RotateCcw, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { format, parseISO } from 'date-fns';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/dashboard/skeleton';

type Kind = 'example' | 'rule';

interface LearnedItem {
  id: string;
  kind: Kind;
  title: string;
  content: string;
  created_at: string;
}

interface PendingItem {
  id: string;
  kind: Kind;
  question: string;
  proposal: string;
  score: number | null;
  support: number;
  created_at: string;
}

interface Report {
  report_date: string;
  learned_count: number;
  discarded_count: number;
  memory_count: number;
  eval_before: number | null;
  eval_after: number | null;
  rolled_back: boolean;
  learned: string[];
  discarded: { text: string; reason: string }[];
  note: string | null;
}

interface Overview {
  ready: boolean;
  learned: LearnedItem[];
  pending: PendingItem[];
  lastExam: { score: number; cases_total: number; cases_passed: number; created_at: string } | null;
  reports: Report[];
}

function fmtDate(iso: string): string {
  return format(parseISO(iso), 'dd/MM/yyyy HH:mm');
}

function fmtScore(n: number | null): string {
  return n === null ? '—' : n.toFixed(1);
}

/**
 * Admin-only panel of what the AI learned on its own: last exam score,
 * active knowledge and rules (Borrar), pending proposals (optional
 * "Aprobar ya" / Borrar) and the daily reports. Everything works
 * without anyone opening this; it's only for checking.
 */
export function AiLearningOverview() {
  const t = useTranslations('Agents.learning');
  const [data, setData] = useState<Overview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/ai/learning/overview');
        const json = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !json) {
          toast.error(t('overviewFailed'));
          setData({ ready: true, learned: [], pending: [], lastExam: null, reports: [] });
          return;
        }
        setData(json as Overview);
      } catch {
        if (cancelled) return;
        toast.error(t('overviewFailed'));
        setData({ ready: true, learned: [], pending: [], lastExam: null, reports: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t]);

  async function act(key: string, url: string, method: 'DELETE' | 'POST', confirmText: string, done: () => void) {
    if (!window.confirm(confirmText)) return;
    setBusy(key);
    try {
      const res = await fetch(url, { method });
      if (!res.ok) {
        toast.error(res.status === 422 ? t('blockedByFilter') : t('actionFailed'));
        return;
      }
      done();
      toast.success(t('actionDone'));
    } catch {
      toast.error(t('actionFailed'));
    } finally {
      setBusy(null);
    }
  }

  if (!data) return <Skeleton className="h-[220px] w-full" />;

  const removeLearned = (id: string) =>
    setData((d) => (d ? { ...d, learned: d.learned.filter((i) => i.id !== id) } : d));
  const removePending = (id: string) =>
    setData((d) => (d ? { ...d, pending: d.pending.filter((i) => i.id !== id) } : d));

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <GraduationCap className="h-4 w-4 text-primary" /> {t('examTitle')}
          </CardTitle>
          <CardDescription>{t('examDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          {data.lastExam ? (
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
              <p className="text-3xl font-semibold text-foreground">
                {fmtScore(data.lastExam.score)}
                <span className="ml-1 text-sm font-normal text-muted-foreground">/ 100</span>
              </p>
              <p className="text-sm text-muted-foreground">
                {t('examCases', { passed: data.lastExam.cases_passed, total: data.lastExam.cases_total })}
              </p>
              <p className="text-xs text-muted-foreground">{fmtDate(data.lastExam.created_at)}</p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('examEmpty')}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Lightbulb className="h-4 w-4 text-primary" /> {t('learnedTitle')}
          </CardTitle>
          <CardDescription>{t('learnedDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          {data.learned.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('learnedEmpty')}</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {data.learned.map((item) => (
                <li key={item.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">{t(item.kind === 'rule' ? 'kindRule' : 'kindExample')}</Badge>
                      <span className="text-xs text-muted-foreground">{fmtDate(item.created_at)}</span>
                    </div>
                    <p className="whitespace-pre-line break-words text-sm text-foreground">{item.content}</p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-shrink-0"
                    disabled={busy === item.id}
                    onClick={() =>
                      void act(item.id, `/api/ai/learning/items/${item.id}`, 'DELETE', t('confirmDelete'), () =>
                        removeLearned(item.id),
                      )
                    }
                  >
                    <Trash2 className="mr-1.5 h-4 w-4" /> {t('delete')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardList className="h-4 w-4 text-primary" /> {t('pendingTitle')}
          </CardTitle>
          <CardDescription>{t('pendingDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          {data.pending.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('pendingEmpty')}</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {data.pending.map((item) => (
                <li key={item.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">{t(item.kind === 'rule' ? 'kindRule' : 'kindExample')}</Badge>
                      {item.score !== null && (
                        <span className="text-xs text-muted-foreground">
                          {t('judgeScore', { score: item.score.toFixed(2) })}
                        </span>
                      )}
                      {item.support > 0 && (
                        <span className="text-xs text-muted-foreground">{t('support', { count: item.support })}</span>
                      )}
                    </div>
                    {item.question && <p className="text-sm text-muted-foreground">{item.question}</p>}
                    <p className="break-words text-sm text-foreground">{item.proposal}</p>
                  </div>
                  <div className="flex flex-shrink-0 gap-2">
                    <Button
                      size="sm"
                      disabled={busy === item.id}
                      onClick={() =>
                        void act(item.id, `/api/ai/learning/candidates/${item.id}/approve`, 'POST', t('confirmApprove'), () =>
                          removePending(item.id),
                        )
                      }
                    >
                      <CheckCircle2 className="mr-1.5 h-4 w-4" /> {t('approveNow')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy === item.id}
                      onClick={() =>
                        void act(item.id, `/api/ai/learning/candidates/${item.id}`, 'DELETE', t('confirmDiscard'), () =>
                          removePending(item.id),
                        )
                      }
                    >
                      <Trash2 className="mr-1.5 h-4 w-4" /> {t('delete')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardList className="h-4 w-4 text-primary" /> {t('reportsTitle')}
          </CardTitle>
          <CardDescription>{t('reportsDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          {data.reports.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('reportsEmpty')}</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {data.reports.map((r) => (
                <li key={r.report_date} className="space-y-1 p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <span className="font-medium text-foreground">{format(parseISO(r.report_date), 'dd/MM/yyyy')}</span>
                    <span className="text-muted-foreground">
                      {t('reportExam', { before: fmtScore(r.eval_before), after: fmtScore(r.eval_after) })}
                    </span>
                    <span className="text-muted-foreground">{t('reportLearned', { count: r.learned_count })}</span>
                    <span className="text-muted-foreground">{t('reportDiscarded', { count: r.discarded_count })}</span>
                    <span className="text-muted-foreground">{t('reportMemory', { count: r.memory_count })}</span>
                    {r.rolled_back && (
                      <Badge variant="destructive" className="gap-1">
                        <RotateCcw className="h-3 w-3" /> {t('rolledBack')}
                      </Badge>
                    )}
                  </div>
                  {r.note && <p className="text-xs text-muted-foreground">{r.note}</p>}
                  {r.learned.length > 0 && (
                    <p className="text-xs text-foreground">
                      {t('learnedList')}: {r.learned.join(' · ')}
                    </p>
                  )}
                  {r.discarded.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {t('discardedList')}: {r.discarded.map((d) => `${d.text} (${d.reason})`).join(' · ')}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
