// ============================================================
// Meta delivery errors in plain neutral Spanish for the UI.
// The DB keeps Meta's original text (diagnosable); this only maps
// it for display. Unknown errors are shown as they came.
// ============================================================

const META_ERRORS: ReadonlyArray<{ re: RegExp; texto: string }> = [
  {
    // 131049: per-user marketing frequency cap.
    re: /healthy ecosystem engagement|\b131049\b/i,
    texto:
      'Meta no lo entregó: este número llegó al límite de mensajes de marketing. Reintenta en 24 h o más.',
  },
  {
    // 131050: the user stopped marketing messages from this business.
    re: /stopped? (?:receiving )?marketing|\b131050\b/i,
    texto: 'El contacto desactivó los mensajes de marketing de esta empresa.',
  },
  {
    // 131047: outside the 24 h customer service window.
    re: /re-?engagement message|more than 24 hours|\b131047\b/i,
    texto: 'Pasaron más de 24 h desde el último mensaje del contacto: envía una plantilla.',
  },
  {
    // 131026: not on WhatsApp or an old app version.
    re: /message undeliverable|\b131026\b/i,
    texto: 'No se pudo entregar: el número no usa WhatsApp o su aplicación está desactualizada.',
  },
  {
    // 131056: too many messages to the same number in a short time.
    re: /pair rate limit|\b131056\b/i,
    texto: 'Demasiados mensajes seguidos a este número. Espera unos minutos y vuelve a intentar.',
  },
  {
    // 131042: payment problem on the Meta account.
    re: /business eligibility payment|payment issue|\b131042\b/i,
    texto: 'Hay un problema de pago en la cuenta de Meta. Revisa el método de pago en WhatsApp Manager.',
  },
  {
    // 132001: template name/language not found.
    re: /template name does not exist|\b132001\b/i,
    texto: 'La plantilla no existe en ese idioma o no está aprobada en Meta.',
  },
]

/** Spanish text for a Meta delivery error; the original when unknown. */
export function metaErrorText(raw: string | null | undefined): string | null {
  const text = raw?.trim()
  if (!text) return null
  return META_ERRORS.find((e) => e.re.test(text))?.texto ?? text
}
