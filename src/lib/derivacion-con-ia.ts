/**
 * Interruptor `DERIVACION_CON_IA` (variable de entorno de la línea).
 * Encendido solo con "true" o "1"; si falta o vale otra cosa, apagado.
 *
 * Encendido:
 *   - Un chat de WhatsApp sin número de teléfono se asigna al perfil "@"
 *     (lib/conversations/perfil-sin-numero.ts), si además la derivación
 *     automática está configurada y el perfil existe. "@" cuenta como
 *     "sin asesor" en la derivación, los traspasos y los flujos.
 *   - La IA sigue atendiendo un chat asignado hasta que el asesor
 *     asignado escriba (lib/ai/auto-reply.ts advisorOwnsThread).
 * Apagado: un chat con asesor (cualquiera, también "@") es del asesor y
 * la IA no lo atiende, como antes.
 */
export function derivacionConIaActiva(valor: string | undefined = process.env.DERIVACION_CON_IA): boolean {
  const v = valor?.trim()
  return v === 'true' || v === '1'
}
