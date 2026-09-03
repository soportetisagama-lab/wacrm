// ============================================================
// POST /api/account/members/[userId]/password
//
// Admin+ sets another member's password. This is the one write in
// the members surface that can't go through a SECURITY DEFINER RPC —
// auth.users is owned by Supabase Auth (GoTrue), not reachable from
// plain SQL — so it uses the service-role client instead, exactly
// like the RPCs: the TS layer here does the *authorization* (caller
// is admin+, target is a non-owner member of the caller's account,
// target isn't the caller), then the service-role call does the
// actual privileged write. The service-role key never reaches the
// browser — this route is the only place it's used for this action.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

const MIN_PASSWORD = 8;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:memberPassword:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;

    if (userId === ctx.userId) {
      return NextResponse.json(
        { error: 'Use Settings → Security to change your own password' },
        { status: 400 }
      );
    }

    const body = (await request.json().catch(() => null)) as {
      password?: unknown;
    } | null;
    const password = body?.password;

    if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
      return NextResponse.json(
        { error: `Password must be at least ${MIN_PASSWORD} characters` },
        { status: 400 }
      );
    }

    // Verify the target before touching auth.users. The RLS-scoped
    // client (ctx.supabase) can only see rows in the caller's own
    // account, so this read is naturally account-isolated; the
    // account_id equality check below is defense in depth against a
    // stale/forged accountId.
    const { data: target, error: targetErr } = await ctx.supabase
      .from('profiles')
      .select('account_id, account_role')
      .eq('user_id', userId)
      .maybeSingle();

    if (targetErr) {
      console.error('[POST members/[userId]/password] target lookup error:', targetErr);
      return NextResponse.json(
        { error: 'Failed to change password' },
        { status: 500 }
      );
    }
    if (!target || target.account_id !== ctx.accountId) {
      return NextResponse.json(
        { error: 'Target user is not a member of your account' },
        { status: 400 }
      );
    }
    if (target.account_role === 'owner') {
      return NextResponse.json(
        { error: "Cannot change the account owner's password" },
        { status: 400 }
      );
    }

    const { error } = await supabaseAdmin().auth.admin.updateUserById(userId, {
      password,
    });

    if (error) {
      console.error('[POST members/[userId]/password] updateUserById error:', error);
      return NextResponse.json(
        { error: 'Failed to change password' },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
