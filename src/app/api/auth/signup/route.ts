// ============================================================
// POST /api/auth/signup
//
// Server-side gate in front of Supabase's own `auth.signUp`. Moving
// this off the client is the whole point: `AUTH_ADMIN_CODE` is a
// server-only secret, so the check that gates account creation must
// also run server-side — a client-side `if (code !== X)` can always
// be skipped from DevTools since the browser already holds a fully
// usable Supabase client (anon key).
//
// Authorization — exactly one of these must hold, checked in order:
//
//   1. A *currently valid* invite token (?invite=<token> on the
//      signup page) — the invite itself is the authorization, so no
//      admin code is asked for or required. "Currently valid" is
//      re-checked here via the same `peek_invitation` RPC the
//      /join/<token> page uses (expiry + existence; peek has no side
//      effects, so calling it again here doesn't consume the invite
//      — actual redemption still happens later via
//      /api/invitations/[token]/redeem after email verification).
//      A stale `?invite=` query param alone is NOT sufficient — it
//      must independently validate, otherwise anyone could bypass
//      the admin-code gate with `?invite=anything`.
//   2. A valid `AUTH_ADMIN_CODE` — the "free" signup path.
//
// If neither holds, the request is rejected before Supabase Auth is
// ever touched. When an invite token was supplied but didn't
// validate, the response carries `reason: 'invite_invalid'` so the
// signup page can reveal the admin-code field instead of leaving the
// visitor stuck with no way to retry.
// ============================================================

import { NextResponse } from 'next/server';

import { createClient } from '@/lib/supabase/server';
import { isValidAdminCode } from '@/lib/auth/admin-code';
import { hashInviteToken } from '@/lib/auth/invitations';
import { getBaseUrl } from '@/lib/http/base-url';
import { getClientIp } from '@/lib/http/client-ip';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

interface PeekResult {
  ok: boolean;
  reason?: string;
}

async function inviteIsCurrentlyValid(
  supabase: Awaited<ReturnType<typeof createClient>>,
  inviteToken: string
): Promise<boolean> {
  const { data, error } = await supabase.rpc('peek_invitation', {
    p_token_hash: hashInviteToken(inviteToken),
  });
  if (error) {
    console.error('[POST /api/auth/signup] invite peek error:', error);
    return false;
  }
  return (data as PeekResult | null)?.ok === true;
}

export async function POST(request: Request) {
  // Rate-limit by IP before anything else — including before parsing
  // the body — so a serial guesser against AUTH_ADMIN_CODE gets
  // slowed down at the cheapest possible point.
  const ip = getClientIp(request);
  const limit = checkRateLimit(`authGate:signup:${ip}`, RATE_LIMITS.authGate);
  if (!limit.success) return rateLimitResponse(limit);

  const body = (await request.json().catch(() => null)) as {
    fullName?: unknown;
    email?: unknown;
    password?: unknown;
    adminCode?: unknown;
    inviteToken?: unknown;
  } | null;

  const fullName = typeof body?.fullName === 'string' ? body.fullName : '';
  const email = typeof body?.email === 'string' ? body.email : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  const inviteToken =
    typeof body?.inviteToken === 'string' && body.inviteToken.trim()
      ? body.inviteToken.trim()
      : null;

  if (!email || !password) {
    return NextResponse.json(
      { error: 'Email and password are required' },
      { status: 400 }
    );
  }

  const supabase = await createClient();

  const hasValidInvite = inviteToken
    ? await inviteIsCurrentlyValid(supabase, inviteToken)
    : false;

  if (!hasValidInvite && !isValidAdminCode(body?.adminCode)) {
    return NextResponse.json(
      {
        error: inviteToken
          ? 'Este enlace de invitación no es válido o venció. Si tenés un código de administrador, ingresalo para continuar.'
          : 'Código incorrecto',
        ...(inviteToken ? { reason: 'invite_invalid' } : {}),
      },
      { status: 401 }
    );
  }

  // Mirrors the client's previous emailRedirectTo logic exactly, just
  // computed server-side (no `window.location.origin` available here).
  const emailRedirectTo = inviteToken
    ? `${getBaseUrl(request)}/join/${encodeURIComponent(inviteToken)}`
    : undefined;

  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: fullName },
      ...(emailRedirectTo ? { emailRedirectTo } : {}),
    },
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
