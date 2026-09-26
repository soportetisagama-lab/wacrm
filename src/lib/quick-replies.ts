import { hasMinRole, type AccountRole } from '@/lib/auth/roles'

// Personal vs shared quick replies (migration 067). Admin/owner create
// shared replies and see everyone's; every other role only creates
// personal ones and sees shared + their own. Mirrors the RLS policies
// so the API guards and the database agree.

export function isQuickReplyAdmin(role: AccountRole): boolean {
  return hasMinRole(role, 'admin')
}

export function canSeeQuickReply(
  viewer: { userId: string; role: AccountRole },
  row: { user_id: string; is_shared?: boolean | null },
): boolean {
  return row.is_shared !== false || row.user_id === viewer.userId || isQuickReplyAdmin(viewer.role)
}

export function canManageQuickReply(
  viewer: { userId: string; role: AccountRole },
  row: { user_id: string; is_shared?: boolean | null },
): boolean {
  if (isQuickReplyAdmin(viewer.role)) return true
  return row.is_shared === false && row.user_id === viewer.userId
}
