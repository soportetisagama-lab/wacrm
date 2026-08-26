'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Eye, EyeOff, Lock, User } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { Checkbox } from '@/components/ui/checkbox';
import { WelcomeSplash } from '@/components/auth/welcome-splash';
import { AuthShell } from '@/components/auth/auth-shell';
import { AuthCard } from '@/components/auth/auth-card';
import { AuthLogoHeader } from '@/components/auth/auth-logo-header';
import { AuthInput } from '@/components/auth/auth-input';
import { AuthSubmitButton } from '@/components/auth/auth-submit-button';
import { AuthError } from '@/components/auth/auth-error';

// Remembers only the email/username locally, purely for prefilling the
// field on the next visit — the real session persistence is handled by
// Supabase's own auth storage, untouched by this.
const REMEMBER_KEY = 'wacrm.rememberedEmail';

// Supabase returns this exact message for both a wrong email and a
// wrong password (it deliberately doesn't say which, to avoid leaking
// which emails are registered). Everything else falls through as-is.
function translateAuthError(message: string): string {
  if (message === 'Invalid login credentials') {
    return 'Correo o contraseña incorrectos';
  }
  return message;
}

// The splash renders here, outside the `Suspense` boundary that guards
// `useSearchParams`, so it appears instantly on every load instead of
// waiting on the query string to resolve.
export default function LoginPage() {
  const [showSplash, setShowSplash] = useState(true);

  return (
    <>
      {showSplash && <WelcomeSplash onFinish={() => setShowSplash(false)} />}
      <Suspense fallback={null}>
        <LoginPageInner />
      </Suspense>
    </>
  );
}

function LoginPageInner() {
  const searchParams = useSearchParams();
  // Forwarded from `/join/<token>` when the visitor already has an
  // account. After a successful sign-in we send them to the join
  // page to accept rather than to /dashboard.
  const inviteToken = searchParams.get('invite');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [shake, setShake] = useState(false);
  const supabase = createClient();

  useEffect(() => {
    try {
      const saved = localStorage.getItem(REMEMBER_KEY);
      if (saved) {
        setEmail(saved);
        setRemember(true);
      }
    } catch {
      // localStorage unavailable (private mode, etc.) — ignore, just skip the prefill.
    }
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      if (remember) localStorage.setItem(REMEMBER_KEY, email);
      else localStorage.removeItem(REMEMBER_KEY);
    } catch {
      // Ignore — remembering the email is a convenience, not a requirement.
    }

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setError(translateAuthError(error.message));
      setLoading(false);
      setShake(true);
      setTimeout(() => setShake(false), 600);
      return;
    }

    // Full-page navigation (not router.push) so the browser issues a
    // fresh top-level request that carries the just-written Supabase
    // auth cookies to the middleware gating /dashboard. A soft
    // client-side navigation can reach the protected route before the
    // server observes the new session, so the middleware bounces it
    // back to /login — which looks like the page "just refreshing"
    // instead of signing in (issue #365). Mirrors the deliberate full
    // reload the invite-accept flow already uses in join/[token].
    const destination = inviteToken
      ? `/join/${encodeURIComponent(inviteToken)}`
      : '/dashboard';
    window.location.href = destination;
  };

  return (
    <AuthShell>
      <AuthCard shake={shake}>
        <AuthLogoHeader
          subtitle={
            inviteToken ? 'Iniciá sesión para aceptar la invitación' : undefined
          }
        />

        <form onSubmit={handleLogin} className="flex flex-col gap-4">
          {error && <AuthError message={error} />}

          <AuthInput
            icon={User}
            id="email"
            type="email"
            autoComplete="username"
            placeholder="Usuario"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />

          <AuthInput
            icon={Lock}
            id="password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            placeholder="Contraseña"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            endAdornment={
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="text-muted-foreground hover:text-primary absolute top-1/2 right-3.5 -translate-y-1/2 transition-colors"
                aria-label={
                  showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'
                }
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            }
          />

          <div className="flex items-center justify-between pt-1 pb-1">
            <label className="text-muted-foreground flex cursor-pointer items-center gap-2 text-sm select-none">
              <Checkbox
                checked={remember}
                onCheckedChange={(checked) => setRemember(checked === true)}
              />
              Recordarme
            </label>
            <Link
              href="/forgot-password"
              className="text-primary hover:text-primary/80 text-sm font-medium"
            >
              ¿Olvidaste tu contraseña?
            </Link>
          </div>

          <AuthSubmitButton loading={loading} loadingLabel="Verificando...">
            Iniciar sesión
          </AuthSubmitButton>
        </form>

        <p className="text-muted-foreground mt-8 text-center text-sm">
          ¿No tienes cuenta?{' '}
          <Link
            href={
              inviteToken
                ? `/signup?invite=${encodeURIComponent(inviteToken)}`
                : '/signup'
            }
            className="text-primary hover:text-primary/80 font-medium"
          >
            Crear cuenta
          </Link>
        </p>
      </AuthCard>
    </AuthShell>
  );
}
