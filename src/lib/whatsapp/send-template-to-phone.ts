import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder'
import type { MessageTemplate } from '@/types'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'

export interface SendTemplateToPhoneArgs {
  phoneNumberId: string
  accessToken: string
  phone: string
  templateName: string
  language: string
  template?: MessageTemplate
  params?: string[]
  messageParams?: SendTimeParams
}

export type SendTemplateToPhoneResult =
  | { status: 'sent'; messageId: string }
  | { status: 'failed'; error: string }

/**
 * One template send to one phone, shared by /api/whatsapp/broadcast and
 * the server-side broadcast worker. Validates E.164 and retries with
 * phone variants on "not in allowed list" so numbers that differ only
 * in a trunk-prefix 0 still reach recipients.
 */
export async function sendTemplateToPhone(
  args: SendTemplateToPhoneArgs,
): Promise<SendTemplateToPhoneResult> {
  const sanitized = sanitizePhoneForMeta(args.phone)
  if (!isValidE164(sanitized)) {
    return { status: 'failed', error: 'Invalid phone number format' }
  }

  let lastError: string | null = null
  for (const variant of phoneVariants(sanitized)) {
    try {
      const result = await sendTemplateMessage({
        phoneNumberId: args.phoneNumberId,
        accessToken: args.accessToken,
        to: variant,
        templateName: args.templateName,
        language: args.language,
        template: args.template,
        messageParams: args.messageParams,
        params: args.params ?? [],
      })
      return { status: 'sent', messageId: result.messageId }
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Unknown error'
      if (!isRecipientNotAllowedError(lastError)) break
      // retry with next variant
    }
  }
  return { status: 'failed', error: lastError || 'Unknown error' }
}
