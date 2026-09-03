// ============================================================
// Admin authorization code — gates /signup (no invite) and
// /forgot-password behind a shared secret set by the operator.
//
// Server-only. The secret lives in `AUTH_ADMIN_CODE` (no
// NEXT_PUBLIC_ prefix — never inlined into the client bundle) and
// is compared with a constant-time check so response timing can't
// be used to narrow down the correct value character-by-character.
//
// Fails CLOSED: if the operator hasn't set `AUTH_ADMIN_CODE` at
// all, every candidate is rejected rather than the check silently
// no-opping. A misconfigured deployment should block signups, not
// quietly accept anyone.
// ============================================================

import { timingSafeEqual } from 'node:crypto';

/**
 * True iff `candidate` matches the configured `AUTH_ADMIN_CODE`.
 * Never throws — always returns a boolean, safe to call with
 * `unknown` request-body input.
 */
export function isValidAdminCode(candidate: unknown): boolean {
  const expected = process.env.AUTH_ADMIN_CODE;
  if (!expected) {
    console.error(
      '[isValidAdminCode] AUTH_ADMIN_CODE is not set — rejecting all codes. Set it in your server environment to enable signup/password-reset.'
    );
    return false;
  }
  if (typeof candidate !== 'string' || candidate.length === 0) return false;

  // timingSafeEqual throws on length mismatch, so pad both sides to
  // the same length first. The length check itself is not constant-
  // time, but leaking the *length* of a secret the attacker could
  // otherwise learn instantly by trying inputs is a non-issue —
  // what matters is that a same-length guess can't be narrowed down
  // byte-by-byte via response timing.
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}
