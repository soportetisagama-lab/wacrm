'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, CheckCircle, Mail } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { AuthShell } from '@/components/auth/auth-shell';
import { AuthCard } from '@/components/auth/auth-card';
import { AuthLogoHeader } from '@/components/auth/auth-logo-header';
import { AuthIconBadge } from '@/components/auth/auth-icon-badge';
import { AuthInput } from '@/components/auth/auth-input';
import { AuthSubmitButton } from '@/components/auth/auth-submit-button';
import { AuthError } from '@/components/auth/auth-error';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const supabase = createClient();

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
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
              Te enviamos un link para restablecer tu contraseña a{' '}
              <span className="text-foreground">{email}</span>. Revisá tu
              bandeja de entrada.
            </p>
          </div>
          <Link href="/login" className="block">
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
          title="Restablecer contraseña"
          subtitle="Ingresa tu email y te enviaremos un link de restablecimiento"
        />

        <form onSubmit={handleReset} className="flex flex-col gap-4">
          {error && <AuthError message={error} />}

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

          <AuthSubmitButton loading={loading} loadingLabel="Enviando...">
            Enviar link de restablecimiento
          </AuthSubmitButton>
        </form>

        <Link
          href="/login"
          className="text-muted-foreground hover:text-foreground mt-8 flex items-center justify-center gap-2 text-sm"
        >
          <ArrowLeft className="h-4 w-4" />
          Volver a iniciar sesión
        </Link>
      </AuthCard>
    </AuthShell>
  );
}
