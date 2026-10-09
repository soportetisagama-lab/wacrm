// ============================================================
// POST /api/account/members/[userId]/avatar
//
// Admin+ replaces another member's profile photo straight from the
// Members list, instead of logging in as each person. Body is
// multipart/form-data with a single `file` field.
//
// Same shape as the sibling /password route: the avatars bucket's
// RLS (migration 008) only lets a user write under their own
// `{auth.uid()}/` folder, so the upload + profiles.avatar_url write
// go through the service-role client, and this route does the
// authorization first (caller is admin+, target is a non-owner
// member of the caller's account, target isn't the caller — own
// photo goes through Settings → Profile).
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

// Mirrors the limits enforced by the Profile form.
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:memberAvatar:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;

    if (userId === ctx.userId) {
      return NextResponse.json(
        { error: 'Use Settings → Profile to change your own photo' },
        { status: 400 }
      );
    }

    const form = await request.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "'file' is required" }, { status: 400 });
    }
    const ext = EXT_BY_TYPE[file.type];
    if (!ext) {
      return NextResponse.json(
        { error: 'File must be PNG, JPG, WebP or GIF' },
        { status: 400 }
      );
    }
    if (file.size > MAX_AVATAR_BYTES) {
      return NextResponse.json(
        { error: 'File must be 2 MB or smaller' },
        { status: 400 }
      );
    }

    // RLS-scoped read → naturally limited to the caller's account; the
    // account_id equality check is defense in depth.
    const { data: target, error: targetErr } = await ctx.supabase
      .from('profiles')
      .select('account_id, account_role')
      .eq('user_id', userId)
      .maybeSingle();

    if (targetErr) {
      console.error('[POST members/[userId]/avatar] target lookup error:', targetErr);
      return NextResponse.json(
        { error: 'Failed to update photo' },
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
        { error: "Cannot change the account owner's photo" },
        { status: 400 }
      );
    }

    const admin = supabaseAdmin();
    const path = `${userId}/avatar-${Date.now()}.${ext}`;
    const { error: uploadError } = await admin.storage
      .from('avatars')
      .upload(path, file, {
        cacheControl: '3600',
        upsert: true,
        contentType: file.type,
      });
    if (uploadError) {
      console.error('[POST members/[userId]/avatar] upload error:', uploadError);
      return NextResponse.json(
        { error: 'Failed to update photo' },
        { status: 500 }
      );
    }

    const {
      data: { publicUrl },
    } = admin.storage.from('avatars').getPublicUrl(path);

    const { error: updateError } = await admin
      .from('profiles')
      .update({ avatar_url: publicUrl })
      .eq('user_id', userId);
    if (updateError) {
      console.error('[POST members/[userId]/avatar] profile update error:', updateError);
      return NextResponse.json(
        { error: 'Failed to update photo' },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, avatar_url: publicUrl });
  } catch (err) {
    return toErrorResponse(err);
  }
}
