'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { toast } from 'sonner';
import { MessageTemplate } from '@/types';
import { Step1ChooseTemplate } from '@/components/broadcasts/step1-choose-template';
import { Step2SelectAudience } from '@/components/broadcasts/step2-select-audience';
import { Step3Personalize } from '@/components/broadcasts/step3-personalize';
import { Step4ScheduleSend } from '@/components/broadcasts/step4-schedule-send';
import { useBroadcastSending } from '@/hooks/use-broadcast-sending';
import { Check, FileText, Megaphone, Send, SlidersHorizontal, Users } from 'lucide-react';
import { useTranslations } from 'next-intl';

const steps = [
  { label: 'template', key: 'template' },
  { label: 'audience', key: 'audience' },
  { label: 'personalize', key: 'personalize' },
  { label: 'send', key: 'send' },
] as const;

const STEP_ICONS = {
  template: FileText,
  audience: Users,
  personalize: SlidersHorizontal,
  send: Send,
} as const;

export default function NewBroadcastPage() {
  const router = useRouter();
  const t = useTranslations('Broadcasts.new');
  const { accountId } = useAuth();
  const { createAndSendBroadcast, isProcessing, progress } = useBroadcastSending();

  const [currentStep, setCurrentStep] = useState(0);
  const [template, setTemplate] = useState<MessageTemplate | null>(null);
  const [audience, setAudience] = useState<{
    type: 'all' | 'tags' | 'custom_field' | 'csv';
    tagIds?: string[];
    customField?: {
      fieldId: string;
      operator: 'is' | 'is_not' | 'contains';
      value: string;
    };
    csvContacts?: { phone: string; name?: string }[];
    excludeTagIds?: string[];
  }>({ type: 'all' });
  const [variables, setVariables] = useState<
    Record<string, { type: 'static' | 'field' | 'custom_field'; value: string }>
  >({});
  const [headerMediaUrl, setHeaderMediaUrl] = useState('');
  const [name, setName] = useState('');

  async function handleSend() {
    if (!template) return;

    try {
      const broadcastId = await createAndSendBroadcast({
        name,
        template,
        audience: {
          type: audience.type,
          tagIds: audience.tagIds,
          customField: audience.customField,
          csvContacts: audience.csvContacts,
          excludeTagIds: audience.excludeTagIds,
        },
        variables,
        headerMediaUrl,
      });
      router.push(`/broadcasts/${broadcastId}`);
    } catch (err) {
      // Previously swallowed with console.error — the wizard would
      // just no-op, leaving the user confused. Surface the reason.
      const message = err instanceof Error ? err.message : 'No se pudo enviar la difusión';
      console.error('Broadcast failed:', err);
      toast.error(message);
    }
  }

  /**
   * Writes a draft broadcast row — no recipients, no sending. The user
   * can revisit it via the list page to finish the flow later. We
   * don't persist the in-progress audience/variable config here
   * because the current schema doesn't carry it past `audience_filter`
   * and `template_variables`; those are enough for the user to
   * recognize the draft but not to exactly round-trip into the wizard.
   * A full resume-draft UX is a future polish.
   */
  async function handleSaveDraft() {
    if (!template || !name.trim()) {
      toast.error(t('toastGiveName'));
      return;
    }
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      toast.error(t('toastNotSignedIn'));
      return;
    }
    if (!accountId) {
      toast.error(t('toastNotLinked'));
      return;
    }

    const { error } = await supabase.from('broadcasts').insert({
      user_id: user.id,
      account_id: accountId,
      name: name.trim(),
      template_name: template.name,
      template_language: template.language ?? 'en_US',
      template_variables: variables,
      audience_filter: {
        type: audience.type,
        tagIds: audience.tagIds,
      },
      status: 'draft',
      total_recipients: 0,
      sent_count: 0,
      delivered_count: 0,
      read_count: 0,
      replied_count: 0,
      failed_count: 0,
    });

    if (error) {
      toast.error(t('toastFailedDraft', { error: error.message }));
      return;
    }
    toast.success(t('toastDraftSaved'));
    router.push('/broadcasts');
  }

  return (
    <div className="flex w-full flex-col gap-6">
      {/* Header — same card + faint brand wash as the Panel hero */}
      <section className="relative isolate overflow-hidden rounded-3xl border border-border bg-card px-5 pt-6 pb-5 shadow-sm sm:px-8">
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-32"
          style={{ background: 'radial-gradient(60% 100% at 50% 0%, color-mix(in oklab, var(--primary) 14%, transparent), transparent 75%)' }}
        />
        <div className="flex items-center gap-4">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary/12 text-primary ring-4 ring-primary/10">
            <Megaphone className="h-6 w-6" />
          </span>
          <div className="min-w-0">
            <h1 className="text-2xl leading-tight font-extrabold tracking-tight text-foreground sm:text-[26px]">{t('title')}</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {t('subtitle')}
            </p>
          </div>
        </div>

        {/* Step Indicator */}
        <ol className="mt-6 grid grid-cols-4 gap-2 sm:gap-3">
          {steps.map((step, index) => {
            const isActive = index === currentStep;
            const isCompleted = index < currentStep;
            const StepIcon = STEP_ICONS[step.key];

            return (
              <li
                key={step.key}
                aria-current={isActive ? 'step' : undefined}
                className={`flex min-w-0 flex-col gap-2 rounded-2xl border p-2.5 transition-colors sm:p-3 ${
                  isActive
                    ? 'border-primary/40 bg-primary/8 shadow-sm'
                    : isCompleted
                      ? 'border-transparent bg-primary/5'
                      : 'border-transparent bg-muted/50'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <span
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-xs font-bold transition-all sm:h-9 sm:w-9 ${
                      isCompleted
                        ? 'bg-primary text-primary-foreground'
                        : isActive
                          ? 'bg-primary text-primary-foreground shadow-md shadow-primary/30'
                          : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {isCompleted ? <Check className="h-4 w-4" /> : <StepIcon className="h-4 w-4" />}
                  </span>
                  <span className="hidden min-w-0 sm:block">
                    <span className="block text-[10px] font-bold tracking-wider text-muted-foreground uppercase tabular-nums">
                      {index + 1} / {steps.length}
                    </span>
                    <span
                      className={`block truncate text-sm font-semibold ${
                        isActive ? 'text-foreground' : isCompleted ? 'text-primary' : 'text-muted-foreground'
                      }`}
                    >
                      {t(`steps.${step.label}`)}
                    </span>
                  </span>
                </div>
                <span className="h-1 overflow-hidden rounded-full bg-muted">
                  <span
                    className={`block h-full rounded-full bg-primary transition-[width] duration-300 ${
                      isCompleted ? 'w-full' : isActive ? 'w-1/2' : 'w-0'
                    }`}
                  />
                </span>
              </li>
            );
          })}
        </ol>
        <p className="mt-3 text-center text-sm font-semibold text-foreground sm:hidden">
          {t(`steps.${steps[currentStep].label}`)}
        </p>
      </section>

      {/* Step Content */}
      <div className="relative min-h-[400px] rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
        <div
          className="transition-all duration-300 ease-in-out"
          style={{
            opacity: isProcessing ? 0.6 : 1,
            pointerEvents: isProcessing ? 'none' : 'auto',
          }}
        >
          {currentStep === 0 && (
            <Step1ChooseTemplate
              selectedTemplate={template}
              onSelect={setTemplate}
              onNext={() => setCurrentStep(1)}
              onBack={() => router.push('/broadcasts')}
            />
          )}
          {currentStep === 1 && (
            <Step2SelectAudience
              audience={audience}
              onUpdate={setAudience}
              onNext={() => setCurrentStep(2)}
              onBack={() => setCurrentStep(0)}
            />
          )}
          {currentStep === 2 && template && (
            <Step3Personalize
              template={template}
              variables={variables}
              onUpdate={setVariables}
              headerMediaUrl={headerMediaUrl}
              onHeaderMediaUrlChange={setHeaderMediaUrl}
              onNext={() => setCurrentStep(3)}
              onBack={() => setCurrentStep(1)}
            />
          )}
          {currentStep === 3 && template && (
            <Step4ScheduleSend
              name={name}
              onNameChange={setName}
              template={template}
              audience={audience}
              onSend={handleSend}
              onSaveDraft={handleSaveDraft}
              onBack={() => setCurrentStep(2)}
              isProcessing={isProcessing}
              progress={progress}
            />
          )}
        </div>
      </div>
    </div>
  );
}
