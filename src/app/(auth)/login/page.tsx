'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight, Eye, EyeOff, Lock, User } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { WelcomeSplash } from '@/components/auth/welcome-splash';
import { LoginBackground } from '@/components/auth/login-background';
import styles from './login.module.css';

// Remembers only the email/username locally, purely for prefilling the
// field on the next visit — the real session persistence is handled by
// Supabase's own auth storage, untouched by this.
const REMEMBER_KEY = 'wacrm.rememberedEmail';

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
      setError(error.message);
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
    <div
      className={cn(
        'relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10',
        styles.pageGradient
      )}
    >
      <LoginBackground />

      <div className="relative z-10 w-full max-w-md">
        <div
          className={cn(
            'border-border/60 bg-card/90 relative overflow-hidden rounded-[32px] border px-8 py-10 shadow-2xl backdrop-blur-xl sm:px-12 sm:py-14',
            styles.cardEntrance,
            shake && styles.shake
          )}
        >
          <div className="mb-8 flex flex-col items-center gap-2 text-center">
            <Image
              src="/branding/BIENVENIDO.png"
              alt="Bienvenido a Sagama Inox"
              width={1251}
              height={191}
              priority
              className="h-auto w-full max-w-[260px]"
            />
            <p className="text-muted-foreground text-sm">
              {inviteToken
                ? 'Iniciá sesión para aceptar la invitación'
                : 'Ingresá a tu cuenta para continuar'}
            </p>
          </div>

          <form onSubmit={handleLogin} className="flex flex-col gap-4">
            {error && (
              <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            )}

            <div className="relative">
              <User className="text-muted-foreground pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2" />
              <Input
                id="email"
                type="email"
                autoComplete="username"
                placeholder="Usuario"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20 h-12 rounded-2xl pl-10"
              />
            </div>

            <div className="relative">
              <Lock className="text-muted-foreground pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2" />
              <Input
                id="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                placeholder="Contraseña"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20 h-12 rounded-2xl pr-10 pl-10"
              />
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
            </div>

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

            <Button
              type="submit"
              disabled={loading}
              className="group/button bg-primary text-primary-foreground shadow-primary/30 hover:bg-primary relative mt-1 h-12 w-full overflow-hidden rounded-2xl text-sm font-semibold tracking-wide uppercase shadow-lg disabled:opacity-60"
            >
              <span className="relative z-10">
                {loading ? 'Verificando...' : 'Iniciar sesión'}
              </span>
              <ArrowRight className="relative z-10 h-4 w-4 transition-transform group-hover/button:translate-x-1" />
              <span className="pointer-events-none absolute inset-y-0 -left-1/2 w-1/2 -skew-x-12 bg-white/25 transition-[left] duration-500 ease-out group-hover/button:left-[150%]" />
            </Button>
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
        </div>
      </div>
    </div>
  );
}
