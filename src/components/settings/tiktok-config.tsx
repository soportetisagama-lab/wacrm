'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2, Clock, Copy, Loader2, Unplug } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Switch } from '@/components/ui/switch';
import { ChannelIcon } from '@/components/channels/channel-badge';

interface TikTokStatus {
  connection: {
    external_id: string;
    display_name: string | null;
    username: string | null;
    enabled: boolean;
    show_to_agents: boolean;
    refresh_expires_at: string | null;
    updated_at: string;
  } | null;
  migration_missing: boolean;
  env: { app_set: boolean };
  callback_path: string;
  webhook_path: string;
}

/** ?tiktok=<result> set by /api/tiktok/callback → message key. */
const RESULT_KEYS = {
  connected: 'resultConnected',
  not_configured: 'resultNotConfigured',
  forbidden: 'resultForbidden',
  denied: 'resultDenied',
  state: 'resultState',
  token: 'resultToken',
  taken: 'resultTaken',
  save: 'resultSave',
} as const;

/**
 * Settings → Redes sociales → TikTok. Owner/admin only (the section is
 * hidden for other roles; the API and RLS refuse them anyway). Inert —
 * "Pendiente de conectar" — until TIKTOK_APP_ID / TIKTOK_APP_SECRET are set
 * and an admin goes through "Conectar con TikTok".
 */
export function TikTokConfig() {
  const t = useTranslations('Settings.tiktok');
  const [status, setStatus] = useState<TikTokStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/tiktok/config', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      setStatus((await res.json()) as TikTokStatus);
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      // Result of the OAuth round trip, shown once and dropped from the URL.
      const url = new URL(window.location.href);
      const result = url.searchParams.get('tiktok');
      if (result) {
        const key = RESULT_KEYS[result as keyof typeof RESULT_KEYS];
        if (result === 'connected') toast.success(t(key));
        else toast.error(key ? t(key) : t('resultSave'));
        url.searchParams.delete('tiktok');
        window.history.replaceState(null, '', url.toString());
      }
      void load();
    });
    return () => {
      cancelled = true;
    };
  }, [load, t]);

  const patch = async (body: Record<string, boolean>) => {
    setBusy(true);
    try {
      const res = await fetch('/api/tiktok/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        toast.error(t('saveFailed'));
        return;
      }
      setStatus((s) => (s?.connection ? { ...s, connection: { ...s.connection, ...body } } : s));
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    if (!window.confirm(t('disconnectConfirm'))) return;
    setBusy(true);
    try {
      const res = await fetch('/api/tiktok/config', { method: 'DELETE' });
      if (!res.ok) {
        toast.error(t('saveFailed'));
        return;
      }
      toast.success(t('disconnected'));
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (loading && !status) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('loading')}
      </div>
    );
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const conn = status?.connection ?? null;
  const canConnect = !!status?.env.app_set && !status?.migration_missing;
  const copy = (value: string) => {
    void navigator.clipboard.writeText(value);
    toast.success(t('copied'));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ChannelIcon channel="tiktok" size={22} />
          TikTok
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {status && !status.env.app_set && (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>{t('envMissingTitle')}</AlertTitle>
            <AlertDescription>
              {t('envMissingDesc')}
              <code className="ml-1">TIKTOK_APP_ID</code>
              <code className="ml-1">TIKTOK_APP_SECRET</code>
            </AlertDescription>
          </Alert>
        )}

        {status?.migration_missing && (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>{t('migrationMissingTitle')}</AlertTitle>
            <AlertDescription>{t('migrationMissingDesc')}</AlertDescription>
          </Alert>
        )}

        {conn ? (
          <>
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">
                  TikTok · {conn.username ? `@${conn.username}` : (conn.display_name ?? conn.external_id)}
                </p>
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                  {conn.enabled ? t('connectedHint') : t('pausedHint')}
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => void handleDisconnect()} disabled={busy}>
                <Unplug className="mr-1 h-4 w-4" />
                {t('disconnect')}
              </Button>
            </div>
            <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">{t('enabledLabel')}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t('enabledHint')}</p>
              </div>
              <Switch
                checked={conn.enabled}
                onCheckedChange={(checked) => void patch({ enabled: checked })}
                disabled={busy}
                aria-label={t('enabledLabel')}
              />
            </div>
            <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">{t('showToAgentsLabel')}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t('showToAgentsHint')}</p>
              </div>
              <Switch
                checked={conn.show_to_agents}
                onCheckedChange={(checked) => void patch({ show_to_agents: checked })}
                disabled={busy}
                aria-label={t('showToAgentsLabel')}
              />
            </div>
          </>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Clock className="h-4 w-4" />
            {t('pending')}
          </p>
        )}

        <div className="space-y-2">
          {canConnect ? (
            // Full navigation (not fetch): the OAuth round trip leaves the app.
            <a href="/api/tiktok/connect" className={buttonVariants()}>
              {conn ? t('reconnect') : t('connect')}
            </a>
          ) : (
            <Button disabled>{t('connect')}</Button>
          )}
          <p className="text-xs text-muted-foreground">{t('connectHint')}</p>
        </div>

        {status && (
          <div className="space-y-3 border-t border-border pt-4">
            <p className="text-sm font-medium text-foreground">{t('portalTitle')}</p>
            {[
              { label: t('callbackLabel'), value: `${origin}${status.callback_path}` },
              { label: t('webhookLabel'), value: `${origin}${status.webhook_path}` },
            ].map((row) => (
              <div key={row.label} className="space-y-1">
                <p className="text-xs text-muted-foreground">{row.label}</p>
                <div className="flex items-center gap-2">
                  <Input readOnly value={row.value} className="font-mono text-xs" />
                  <Button variant="outline" size="sm" onClick={() => copy(row.value)} aria-label={t('copy')}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
