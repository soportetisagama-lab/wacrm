// ============================================================
// Detects whether the app is running inside our own Android WebView
// wrapper (Capacitor) instead of a normal browser — used to swap the
// full desktop shell (Sidebar + Header) for a stripped, WhatsApp-style
// single-screen layout, and to send a fresh login straight to the
// inbox instead of the full /dashboard.
//
// Detection is a custom User-Agent suffix the wrapper app appends to
// its WebView (see capacitor.config.ts `appendUserAgent` in the
// mobile-wrapper project) — never present in a real browser, so this
// can never misfire for an actual desktop/mobile web visitor.
// ============================================================

export const MOBILE_APP_UA_MARKER = "WacrmMobileApp";

/** SSR-safe: `navigator` doesn't exist during server rendering. */
export function isEmbeddedApp(): boolean {
  if (typeof navigator === "undefined") return false;
  return navigator.userAgent.includes(MOBILE_APP_UA_MARKER);
}
