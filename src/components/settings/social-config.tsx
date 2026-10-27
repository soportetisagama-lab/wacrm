'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2, Copy, Loader2, Unplug } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { ChannelIcon } from '@/components/channels/channel-badge';
import { CHANNEL_LABEL, type SocialChannel } from '@/lib/channels/types';
import { SettingsPanelHead } from './settings-panel-head';

interface ChannelView {
  channel: SocialChannel;
  external_id: string;
  page_id: string;
  display_name: string | null;
  username: string | null;
  enabled: boolean;
}

interface SocialStatus {
  instagram: ChannelView | null;
  messenger: ChannelView | null;
  show_to_agents: boolean;
  comment_replies?: {
    available: boolean;
    enabled: boolean;
    public_text: string;
    private_text: string;
  };
  env: { verify_token_set: boolean; app_secret_set: boolean };
  webhook_path: string;
  error?: string;
  migration_missing?: boolean;
}

/**
 * Settings → Instagram y Messenger. Owner/admin only: the section is
 * hidden for every other role (settings-sections.ts) and the API +
 * RLS refuse them anyway.
 */
export function SocialConfig() {
  const t = useTranslations('Settings.social');
  const [status, setStatus] = useState<SocialStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [togglingAgents, setTogglingAgents] = useState(false);
  const [pageId, setPageId] = useState('');
  const [token, setToken] = useState('');
  const [wantMessenger, setWantMessenger] = useState(true);
  const [wantInstagram, setWantInstagram] = useState(true);
  const [togglingComments, setTogglingComments] = useState(false);
  const [savingTexts, setSavingTexts] = useState(false);
  const [publicText, setPublicText] = useState('');
  const [privateText, setPrivateText] = useState('');

  // Fetch + apply in the promise callbacks (never synchronously inside
  // the effect), so the effect below only subscribes to the result.
  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/social/config', { cache: 'no-store' });
      const data = (await res.json()) as SocialStatus;
      setStatus(data);
      if (data.comment_replies) {
        setPublicText(data.comment_replies.public_text);
        setPrivateText(data.comment_replies.private_text);
      }
      const saved = data.messenger ?? data.instagram;
      if (saved) {
        setPageId((prev) => prev || saved.page_id);
        setWantMessenger(!!data.messenger);
        setWantInstagram(!!data.instagram);
      }
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) void load();
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const webhookUrl =
    typeof window !== 'undefined' && status
      ? `${window.location.origin}${status.webhook_path}`
      : '';

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/social/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page_id: pageId,
          access_token: token,
          messenger: wantMessenger,
          instagram: wantInstagram,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('saveFailed'));
        return;
      }
      toast.success(t('saved'));
      if (data.warning) toast.warning(data.warning);
      setToken('');
      await load();
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleToggleAgents = async (checked: boolean) => {
    setTogglingAgents(true);
    try {
      const res = await fetch('/api/social/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ show_to_agents: checked }),
      });
      if (!res.ok) {
        toast.error(t('saveFailed'));
        return;
      }
      setStatus((s) => (s ? { ...s, show_to_agents: checked } : s));
    } finally {
      setTogglingAgents(false);
    }
  };

  const patchComments = async (comment_replies: Record<string, unknown>): Promise<boolean> => {
    const res = await fetch('/api/social/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment_replies }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(data?.error ?? t('saveFailed'));
      return false;
    }
    return true;
  };

  const handleToggleComments = async (checked: boolean) => {
    setTogglingComments(true);
    try {
      if (await patchComments({ enabled: checked })) {
        setStatus((s) =>
          s?.comment_replies ? { ...s, comment_replies: { ...s.comment_replies, enabled: checked } } : s,
        );
      }
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setTogglingComments(false);
    }
  };

  const handleSaveTexts = async () => {
    setSavingTexts(true);
    try {
      if (await patchComments({ public_text: publicText, private_text: privateText })) {
        toast.success(t('saved'));
        setStatus((s) =>
          s?.comment_replies
            ? { ...s, comment_replies: { ...s.comment_replies, public_text: publicText, private_text: privateText } }
            : s,
        );
      }
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSavingTexts(false);
    }
  };

  const handleDisconnect = async (channel: SocialChannel) => {
    if (!window.confirm(t('disconnectConfirm'))) return;
    const res = await fetch(`/api/social/config?channel=${channel}`, { method: 'DELETE' });
    if (!res.ok) {
      toast.error(t('saveFailed'));
      return;
    }
    toast.success(t('disconnected'));
    await load();
  };

  if (loading && !status) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('loading')}
      </div>
    );
  }

  const connected = [status?.messenger, status?.instagram].filter(Boolean) as ChannelView[];

  return (
    <div className="space-y-6">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {status?.migration_missing && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{t('migrationMissingTitle')}</AlertTitle>
          <AlertDescription>{t('migrationMissingDesc')}</AlertDescription>
        </Alert>
      )}

      {status && (!status.env.verify_token_set || !status.env.app_secret_set) && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{t('envMissingTitle')}</AlertTitle>
          <AlertDescription>
            {t('envMissingDesc')}
            {!status.env.verify_token_set && <code className="ml-1">META_SOCIAL_VERIFY_TOKEN</code>}
            {!status.env.app_secret_set && <code className="ml-1">META_SOCIAL_APP_SECRET</code>}
          </AlertDescription>
        </Alert>
      )}

      {connected.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t('connectedTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {connected.map((c) => (
              <div key={c.channel} className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
                <div className="flex min-w-0 items-center gap-3">
                  <ChannelIcon channel={c.channel} size={28} />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {CHANNEL_LABEL[c.channel]} ·{' '}
                      {c.username ? `@${c.username}` : (c.display_name ?? c.external_id)}
                    </p>
                    <p className="flex items-center gap-1 text-xs text-muted-foreground">
                      <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                      {t('connectedHint')}
                    </p>
                  </div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => void handleDisconnect(c.channel)}>
                  <Unplug className="mr-1 h-4 w-4" />
                  {t('disconnect')}
                </Button>
              </div>
            ))}

            <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">{t('showToAgentsLabel')}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t('showToAgentsHint')}</p>
              </div>
              <Switch
                checked={status?.show_to_agents ?? false}
                onCheckedChange={(checked) => void handleToggleAgents(checked)}
                disabled={togglingAgents}
                aria-label={t('showToAgentsLabel')}
              />
            </div>
          </CardContent>
        </Card>
      )}

      {connected.length > 0 && status?.comment_replies && (
        <Card>
          <CardHeader>
            <CardTitle>{t('commentsTitle')}</CardTitle>
            <CardDescription>{t('commentsDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!status.comment_replies.available && (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>{t('commentsMigrationMissing')}</AlertDescription>
              </Alert>
            )}
            <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">{t('commentsEnabledLabel')}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t('commentsEnabledHint')}</p>
              </div>
              <Switch
                checked={status.comment_replies.enabled}
                onCheckedChange={(checked) => void handleToggleComments(checked)}
                disabled={togglingComments || !status.comment_replies.available}
                aria-label={t('commentsEnabledLabel')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="social-comment-public">{t('commentsPublicLabel')}</Label>
              <Textarea
                id="social-comment-public"
                name="social-comment-public"
                rows={2}
                maxLength={900}
                value={publicText}
                onChange={(e) => setPublicText(e.target.value)}
                disabled={!status.comment_replies.available}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="social-comment-private">{t('commentsPrivateLabel')}</Label>
              <Textarea
                id="social-comment-private"
                name="social-comment-private"
                rows={3}
                maxLength={900}
                value={privateText}
                onChange={(e) => setPrivateText(e.target.value)}
                disabled={!status.comment_replies.available}
              />
              <p className="text-xs text-muted-foreground">{t('commentsPrivateHint')}</p>
            </div>
            <Button
              variant="outline"
              onClick={() => void handleSaveTexts()}
              disabled={
                savingTexts ||
                !status.comment_replies.available ||
                !publicText.trim() ||
                !privateText.trim()
              }
            >
              {savingTexts && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('commentsSave')}
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{connected.length > 0 ? t('updateTitle') : t('connectTitle')}</CardTitle>
          <CardDescription>{t('connectDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="social-page-id">{t('pageIdLabel')}</Label>
            <Input
              id="social-page-id"
              name="social-page-id"
              inputMode="numeric"
              autoComplete="off"
              value={pageId}
              onChange={(e) => setPageId(e.target.value.trim())}
              placeholder="123456789012345"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="social-token">{t('tokenLabel')}</Label>
            <Input
              id="social-token"
              name="social-token"
              type="password"
              // "new-password": Chrome ignores "off" on password fields and
              // would autofill the admin's login password here.
              autoComplete="new-password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={connected.length > 0 ? t('tokenKeepPlaceholder') : 'EAAG…'}
            />
            <p className="text-xs text-muted-foreground">{t('tokenHint')}</p>
          </div>
          <div className="flex flex-wrap gap-6">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={wantMessenger} onCheckedChange={(v) => setWantMessenger(v === true)} />
              <ChannelIcon channel="messenger" size={18} />
              Messenger
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={wantInstagram} onCheckedChange={(v) => setWantInstagram(v === true)} />
              <ChannelIcon channel="instagram" size={18} />
              Instagram
            </label>
          </div>
          <Button onClick={() => void handleSave()} disabled={saving || !pageId}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('save')}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('webhookTitle')}</CardTitle>
          <CardDescription>{t('webhookDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-center gap-2">
            <Input readOnly value={webhookUrl} className="font-mono text-xs" />
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(webhookUrl);
                toast.success(t('copied'));
              }}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('webhookFields')}</p>
        </CardContent>
      </Card>
    </div>
  );
}
