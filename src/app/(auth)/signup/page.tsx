'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { CheckCircle, Eye, EyeOff, Lock, Mail, User } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { AuthShell } from '@/components/auth/auth-shell';
import { AuthCard } from '@/components/auth/auth-card';
import { AuthLogoHeader } from '@/components/auth/auth-logo-header';
import { AuthIconBadge } from '@/components/auth/auth-icon-badge';
import { AuthInput } from '@/components/auth/auth-input';
import { AuthSubmitButton } from '@/components/auth/auth-submit-button';
import { AuthError } from '@/components/auth/auth-error';

// `useSearchParams` opts the component out of static prerendering
// unless wrapped in Suspense — same pattern as /login.
export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupPageInner />
    </Suspense>
  );
}

function SignupPageInner() {
  const searchParams = useSearchParams();
  // When the user lands here from `/join/<token>` we carry the
  // invite token in the query so it survives the signup → email
  // verification → redirect round-trip. `emailRedirectTo` below
  // points back at /join/<token> so the user lands on the redeem
  // step after verifying instead of being dropped on /dashboard.
  const inviteToken = searchParams.get('invite');

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const supabase = createClient();

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError('Las contraseñas no coinciden');
      return;
    }

    if (password.length < 6) {
      setError('La contraseña debe tener al menos 6 caracteres');
      return;
    }

    setLoading(true);

    // If we have an invite token, point Supabase's verification
    // email back at the join page so the user can accept after
    // verifying. Without a token, Supabase uses its default
    // redirect (the app root).
    const emailRedirectTo = inviteToken
      ? `${window.location.origin}/join/${encodeURIComponent(inviteToken)}`
      : undefined;

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName,
        },
        ...(emailRedirectTo ? { emailRedirectTo } : {}),
      },
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    setSuccess(true);
    setLoading(false);
  };

  if (success) {
    return (
      <AuthShell>
        <AuthCard className="items-center text-center">
          <div className="flex flex-col items-center">
            <AuthIconBadge icon={CheckCircle} />
            <h1 className="text-foreground mb-2 text-lg font-semibold">
              Revisa tu email
            </h1>
            <p className="text-muted-foreground mb-8 text-sm">
              Te enviamos un link de confirmación a{' '}
              <span className="text-foreground">{email}</span>. Revisá tu
              bandeja de entrada y hacé clic en el link para verificar tu
              cuenta.
            </p>
          </div>
          <Link
            href={
              inviteToken
                ? `/login?invite=${encodeURIComponent(inviteToken)}`
                : '/login'
            }
            className="block"
          >
            <Button
              variant="outline"
              className="border-border text-muted-foreground hover:bg-muted hover:text-foreground h-12 w-full rounded-2xl"
            >
              Volver a iniciar sesión
            </Button>
          </Link>
        </AuthCard>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <AuthCard>
        <AuthLogoHeader
          title={inviteToken ? 'Crear cuenta y unirte' : 'Crear cuenta'}
          subtitle={
            inviteToken
              ? 'Verifica tu email y luego acepta la invitación para unirte a tu equipo.'
              : 'Completa tus datos para comenzar con Sagama Inox CRM'
          }
        />

        <form onSubmit={handleSignup} className="flex flex-col gap-4">
          {error && <AuthError message={error} />}

          <AuthInput
            icon={User}
            id="fullName"
            type="text"
            autoComplete="name"
            placeholder="Nombre completo"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            required
          />

          <AuthInput
            icon={Mail}
            id="email"
            type="email"
            autoComplete="email"
            placeholder="tu@ejemplo.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />

          <AuthInput
            icon={Lock}
            id="password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            placeholder="Mínimo 6 caracteres"
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

          <AuthInput
            icon={Lock}
            id="confirmPassword"
            type={showConfirmPassword ? 'text' : 'password'}
            autoComplete="new-password"
            placeholder="Confirmar contraseña"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            endAdornment={
              <button
                type="button"
                onClick={() => setShowConfirmPassword((v) => !v)}
                className="text-muted-foreground hover:text-primary absolute top-1/2 right-3.5 -translate-y-1/2 transition-colors"
                aria-label={
                  showConfirmPassword
                    ? 'Ocultar contraseña'
                    : 'Mostrar contraseña'
                }
              >
                {showConfirmPassword ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            }
          />

          <AuthSubmitButton loading={loading} loadingLabel="Creando cuenta...">
            Crear cuenta
          </AuthSubmitButton>
        </form>

        <p className="text-muted-foreground mt-8 text-center text-sm">
          ¿Ya tienes cuenta?{' '}
          <Link
            href={
              inviteToken
                ? `/login?invite=${encodeURIComponent(inviteToken)}`
                : '/login'
            }
            className="text-primary hover:text-primary/80 font-medium"
          >
            Iniciar sesión
          </Link>
        </p>
      </AuthCard>
    </AuthShell>
  );
}
