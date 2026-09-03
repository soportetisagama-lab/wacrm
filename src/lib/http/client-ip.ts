/**
 * Best-effort client IP. The `x-forwarded-for` header is what every
 * reverse proxy (Vercel, Hostinger, Cloudflare) sets when forwarding
 * a request; we take the leftmost entry, which is the original
 * client.
 *
 * Falls back to a constant when no proxy is in front (e.g.
 * `localhost` during development) so rate-limit keys still exist —
 * the limit then effectively applies "globally," which is fine for
 * dev.
 */
export function getClientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  const xri = request.headers.get('x-real-ip');
  if (xri) return xri.trim();
  return 'unknown';
}
