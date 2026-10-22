import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { verifyPhoneNumber } from '@/lib/whatsapp/meta-api'

/**
 * GET /api/whatsapp/line-phone
 *
 * Returns the display phone number of the account's connected
 * WhatsApp line so the header can show it to every member (agents
 * included). whatsapp_config does not store the human-readable number,
 * so we ask Meta once per phone_number_id and keep it in memory —
 * the number of a line practically never changes.
 *
 * Response: { display_phone_number: string | null }
 * `null` when the account has no line connected or Meta can't be
 * reached; the UI simply hides the badge in that case.
 */

const CACHE_TTL_MS = 12 * 60 * 60 * 1000
const cache = new Map<string, { value: string | null; expires: number }>()

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const { data: config } = await supabase
      .from('whatsapp_config')
      .select('phone_number_id, access_token')
      .eq('account_id', accountId)
      .maybeSingle()

    if (!config?.phone_number_id || !config.access_token) {
      return json(null)
    }

    const cached = cache.get(config.phone_number_id)
    if (cached && cached.expires > Date.now()) {
      return json(cached.value)
    }

    let value: string | null = null
    try {
      const info = await verifyPhoneNumber({
        phoneNumberId: config.phone_number_id,
        accessToken: decrypt(config.access_token),
      })
      value = info.display_phone_number || null
    } catch (err) {
      console.warn(
        '[whatsapp/line-phone] could not resolve display number:',
        err instanceof Error ? err.message : err,
      )
      // Short negative cache so a broken token doesn't hammer Meta.
      cache.set(config.phone_number_id, {
        value: null,
        expires: Date.now() + 5 * 60 * 1000,
      })
      return json(null)
    }

    cache.set(config.phone_number_id, {
      value,
      expires: Date.now() + CACHE_TTL_MS,
    })
    return json(value)
  } catch (err) {
    return toErrorResponse(err)
  }
}

function json(value: string | null) {
  return NextResponse.json(
    { display_phone_number: value },
    { headers: { 'Cache-Control': 'private, max-age=3600' } },
  )
}
