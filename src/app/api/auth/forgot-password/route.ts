// ============================================================
// POST /api/auth/forgot-password
//
// Server-side gate in front of Supabase's own
// `auth.resetPasswordForEmail`, for the same reason as
// /api/auth/signup: `AUTH_ADMIN_CODE` is a server-only secret, and a
// client-side-only check can always be skipped from DevTools.
//
// No invite exception here — unlike signup, password reset has no
// "the invite already authorized this" escape hatch, so the admin
// code is required unconditionally.
// ============================================================

import { NextResponse } from 'next/server';

import { createClient } from '@/lib/supabase/server';
import { isValidAdminCode } from '@/lib/auth/admin-code';
import { getBaseUrl } from '@/lib/http/base-url';
import { getClientIp } from '@/lib/http/client-ip';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

export async function POST(request: Request) {
  const ip = getClientIp(request);
  const limit = checkRateLimit(
    `authGate:forgotPassword:${ip}`,
    RATE_LIMITS.authGate
  );
  if (!limit.success) return rateLimitResponse(limit);

  const body = (await request.json().catch(() => null)) as {
    email?: unknown;
    adminCode?: unknown;
  } | null;

  const email = typeof body?.email === 'string' ? body.email : '';

  if (!email) {
    return NextResponse.json({ error: 'Email is required' }, { status: 400 });
  }

  if (!isValidAdminCode(body?.adminCode)) {
    return NextResponse.json({ error: 'Código incorrecto' }, { status: 401 });
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${getBaseUrl(request)}/auth/callback?next=/reset-password`,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
