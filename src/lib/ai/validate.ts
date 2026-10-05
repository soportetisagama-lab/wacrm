import { generateReply } from './generate'
import { resumeAiKey } from './availability'
import type { AiConfig } from './types'

/**
 * Cheap liveness + auth check: one tiny generation against the
 * configured provider/model with the caller's key. Throws `AiError`
 * (invalid_key / rate_limited / network / timeout) on failure, resolves
 * on success. Used by the settings "Test key" button and before
 * persisting a config — the same "verify before save" discipline the
 * WhatsApp config uses with Meta.
 */
export async function validateAiCredentials(config: AiConfig): Promise<void> {
  // A manual test always makes a real call — after recharging the
  // account it's the quickest way to bring a paused AI back.
  resumeAiKey(config.apiKey)
  await generateReply({
    config,
    systemPrompt: 'You are a connectivity check. Reply with the single word: OK.',
    messages: [{ role: 'user', content: 'ping' }],
  })
}
