'use client';

import { ImageIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { headerMediaProblem } from '@/lib/broadcasts/send-loop';
import type { MessageTemplate } from '@/types';

interface HeaderMediaInputProps {
  /** image / video / document — the caller only renders this for media headers. */
  mediaHeaderType: NonNullable<MessageTemplate['header_type']>;
  value: string;
  onChange: (url: string) => void;
}

/**
 * Media URL for an IMAGE/VIDEO/DOCUMENT template header, with image
 * preview and validation message. Shared by the wizard (step 3) and
 * the "Resume sending" dialog.
 */
export function HeaderMediaInput({ mediaHeaderType, value, onChange }: HeaderMediaInputProps) {
  const t = useTranslations('Broadcasts.wizard');
  const problem = headerMediaProblem(true, value);

  return (
    <div className="rounded-xl border border-border bg-muted/30 p-4">
      <div className="mb-3 flex items-center gap-2">
        <ImageIcon className="h-4 w-4 text-primary" />
        <p className="text-sm font-medium text-foreground">{t('personalize.headerImage')}</p>
        <span className="inline-flex items-center rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium uppercase text-primary">
          {mediaHeaderType}
        </span>
      </div>
      <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
        {t('personalize.imageUrl')}
      </label>
      <Input
        type="url"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('personalize.imageUrlPlaceholder')}
        className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
      />
      <p className="mt-1.5 text-xs text-muted-foreground">
        {t('personalize.headerImageDesc')}
      </p>
      {mediaHeaderType === 'image' && problem === null && value.trim() && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={value.trim()}
          alt={t('personalize.headerPreviewAlt')}
          className="mt-3 max-h-40 rounded-lg border border-border object-contain"
        />
      )}
      {problem && (
        <p className="mt-1.5 text-xs text-amber-300">
          {problem === 'missing' ? t('personalize.mediaMissing') : t('personalize.mediaInvalid')}
        </p>
      )}
    </div>
  );
}
