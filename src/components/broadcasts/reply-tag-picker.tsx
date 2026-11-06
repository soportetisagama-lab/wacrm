'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { classifyReplyTagName } from '@/lib/broadcasts/reply-tag';
import { onlyBroadcastTags } from '@/lib/tags/broadcast-tags';
import { Tag } from '@/types';
import { Input } from '@/components/ui/input';
import { Loader2, Tag as TagIcon, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface ReplyTagPickerProps {
  /** Typed or picked tag name ('' = no tag). Resolved by name on save. */
  value: string;
  onChange: (name: string) => void;
  disabled?: boolean;
}

/**
 * "Etiqueta para quienes respondan": pick an existing Difusiones tag
 * (`is_broadcast`, migration 091) or type a new name. The name is
 * resolved on save — reused when it matches a Difusiones tag ignoring
 * case, created as a new Difusiones tag otherwise (commercial and
 * personal tags are never listed nor reused).
 */
export function ReplyTagPicker({ value, onChange, disabled }: ReplyTagPickerProps) {
  const t = useTranslations('Broadcasts.replyTag');
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function fetchTags() {
      try {
        const { data } = await createClient().from('tags').select('*').order('name');
        // Difusiones tags only — see migration 091.
        if (!cancelled) setTags(onlyBroadcastTags((data ?? []) as Tag[]));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchTags();
    return () => {
      cancelled = true;
    };
  }, []);

  const choice = useMemo(() => classifyReplyTagName(tags, value), [tags, value]);
  const query = value.trim().toLowerCase();
  // While typing, narrow the chips to the matching names.
  const visibleTags = query && choice.kind !== 'existing'
    ? tags.filter((tag) => tag.name.toLowerCase().includes(query))
    : tags;

  return (
    <div className="space-y-2">
      <div className="relative">
        <TagIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t('placeholder')}
          disabled={disabled}
          maxLength={60}
          className="border-border bg-muted pr-9 pl-9 text-foreground placeholder:text-muted-foreground"
        />
        {value && !disabled && (
          <button
            type="button"
            onClick={() => onChange('')}
            aria-label={t('clear')}
            title={t('clear')}
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {choice.kind === 'existing' && (
        <p className="text-xs text-muted-foreground">{t('useExisting', { name: choice.tag.name })}</p>
      )}
      {choice.kind === 'new' && (
        <p className="text-xs text-primary">{t('willCreate', { name: choice.name })}</p>
      )}

      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
      ) : tags.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('noTags')}</p>
      ) : visibleTags.length > 0 ? (
        <div className="flex max-h-32 flex-wrap gap-2 overflow-y-auto">
          {visibleTags.map((tag) => {
            const isSelected = choice.kind === 'existing' && choice.tag.id === tag.id;
            return (
              <button
                key={tag.id}
                type="button"
                disabled={disabled}
                onClick={() => onChange(isSelected ? '' : tag.name)}
                className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition-all disabled:opacity-50 ${
                  isSelected
                    ? 'border-primary/30 bg-primary/10 text-primary'
                    : 'border-border bg-muted text-muted-foreground hover:border-border'
                }`}
              >
                <span className="mr-1.5 h-2 w-2 rounded-full" style={{ backgroundColor: tag.color }} />
                {tag.name}
              </button>
            );
          })}
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground">{t('onlyBroadcastHint')}</p>
    </div>
  );
}
