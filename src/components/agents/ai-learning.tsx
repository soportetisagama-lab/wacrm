'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Brain, Search, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { format, parseISO } from 'date-fns';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/dashboard/skeleton';
import { AiLearningOverview } from './ai-learning-overview';

const FIELDS = ['busca', 'medidas', 'tipo_negocio', 'enviado', 'tono', 'notas'] as const;
type Field = (typeof FIELDS)[number];

interface MemoryItem {
  contact_id: string;
  contact_name: string | null;
  memory: Partial<Record<Field, string>>;
  updated_at: string;
}

/**
 * "Aprendizaje" tab of Agentes IA (admin only): read-only view of what
 * the bot remembers about each customer, with a "Borrar memoria"
 * button. Never rendered anywhere else (inbox, chat, contact panel).
 */
export function AiLearning() {
  const t = useTranslations('Agents.learning');
  const [items, setItems] = useState<MemoryItem[] | null>(null);
  const [ready, setReady] = useState(true);
  const [query, setQuery] = useState('');
  const [clearing, setClearing] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/ai/learning/memory');
        const json = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok) {
          toast.error(t('loadFailed'));
          setItems([]);
          return;
        }
        setItems(json?.items ?? []);
        setReady(json?.ready !== false);
      } catch {
        if (cancelled) return;
        toast.error(t('loadFailed'));
        setItems([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t]);

  const filtered = useMemo(() => {
    if (!items) return null;
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) =>
      [i.contact_name ?? '', ...Object.values(i.memory)].join(' ').toLowerCase().includes(q),
    );
  }, [items, query]);

  async function clearMemory(contactId: string) {
    if (!window.confirm(t('confirmClear'))) return;
    setClearing(contactId);
    try {
      const res = await fetch(`/api/ai/learning/memory/${contactId}`, { method: 'DELETE' });
      if (!res.ok) {
        toast.error(t('clearFailed'));
        return;
      }
      setItems((prev) => prev?.filter((i) => i.contact_id !== contactId) ?? prev);
      toast.success(t('cleared'));
    } catch {
      toast.error(t('clearFailed'));
    } finally {
      setClearing(null);
    }
  }

  return (
    <div className="space-y-4">
      <AiLearningOverview />
      <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Brain className="h-4 w-4 text-primary" /> {t('memoryTitle')}
        </CardTitle>
        <CardDescription>{t('memoryDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!ready && (
          <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            {t('notReady')}
          </p>
        )}
        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="pl-8"
          />
        </div>

        {filtered === null ? (
          <Skeleton className="h-[160px] w-full" />
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-center text-sm text-muted-foreground">
            <Brain className="h-8 w-8 opacity-40" />
            <p>{t('empty')}</p>
            <p className="text-xs">{t('emptyHint')}</p>
          </div>
        ) : (
          <ul className="divide-y rounded-md border">
            {filtered.map((item) => (
              <li key={item.contact_id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-medium text-foreground">
                    {item.contact_name ?? t('noName')}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {t('updatedAt', { date: format(parseISO(item.updated_at), 'dd/MM/yyyy HH:mm') })}
                    </span>
                  </p>
                  <dl className="grid gap-x-3 gap-y-0.5 text-sm sm:grid-cols-[max-content_1fr]">
                    {FIELDS.filter((f) => item.memory[f]).map((f) => (
                      <div key={f} className="contents">
                        <dt className="text-muted-foreground">{t(`fields.${f}`)}</dt>
                        <dd className="break-words text-foreground">{item.memory[f]}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-shrink-0"
                  disabled={clearing === item.contact_id}
                  onClick={() => void clearMemory(item.contact_id)}
                >
                  <Trash2 className="mr-1.5 h-4 w-4" /> {t('clear')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
    </div>
  );
}
