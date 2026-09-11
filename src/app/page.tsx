import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { MOBILE_APP_UA_MARKER } from '@/lib/mobile-app'

export default async function RootPage() {
  // The Android wrapper's `server.url` points straight at this root
  // path — for an already-logged-in relaunch (the whole point of
  // persisting the session) this redirect fires before the client-side
  // isEmbeddedApp() checks elsewhere ever get a chance to run, so it
  // needs its own server-side User-Agent check or every cold start
  // lands on the desktop Panel instead of Bandeja.
  const headersList = await headers()
  const isEmbedded = headersList.get('user-agent')?.includes(MOBILE_APP_UA_MARKER) ?? false
  redirect(isEmbedded ? '/inbox' : '/dashboard')
}
