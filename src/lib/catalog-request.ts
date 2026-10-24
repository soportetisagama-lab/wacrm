/**
 * Línea Maxi: el catálogo lo envía SIEMPRE un asesor, nunca el bot.
 *
 * - Los menús del bot no muestran ninguna opción "Catálogo"
 *   (`withoutCatalogOptions`, usado al enviar botones/listas).
 * - Si el cliente pide el catálogo (texto o toque de una opción antigua),
 *   el flujo responde `CATALOG_REQUEST_REPLY` y deriva a un asesor con la
 *   nota `CATALOG_REQUEST_NOTE` (engine.ts, `handOffOnCatalogRequest`).
 * - La IA (auto-reply y collect_ai) nunca recibe documentos de catálogo
 *   (`withoutCatalogDocuments`) y su prompt le prohíbe enviarlo
 *   (`CATALOG_PROMPT_RULE`).
 *
 * Exclusivo de la rama xlr9-maxi.
 */

/** Comparación sin tildes ni mayúsculas ("Catálogo" == "catalogo"). */
function fold(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** True si el texto menciona el catálogo ("catálogo", "catalogos", "catalog"…). */
export function mentionsCatalog(text: string | null | undefined): boolean {
  return Boolean(text) && fold(text as string).includes("catalog");
}

/** Respuesta al cliente cuando pide el catálogo (en horario). */
export const CATALOG_REQUEST_REPLY =
  "¡Claro! En unos momentos un asesor te enviará el catálogo.";

/** Igual que la anterior, fuera de horario ({proxima_apertura} se rellena). */
export const CATALOG_REQUEST_REPLY_AFTER_HOURS =
  "¡Claro! Ya registramos tu pedido: un asesor te enviará el catálogo {proxima_apertura}.";

/** Nota/motivo de la derivación, visible para el asesor. */
export const CATALOG_REQUEST_NOTE = "El cliente pidió el catálogo";

/** Regla que se agrega al prompt de la IA (auto-reply y collect_ai). */
export const CATALOG_PROMPT_RULE =
  "Never send the product catalog yourself: no document, no link, no URL, not even from the knowledge base. If the customer asks for the catalog, reply only that an advisor will send it shortly (e.g. \"¡Claro! En unos momentos un asesor te enviará el catálogo.\").";

/** Quita los documentos de catálogo del set que la IA puede enviar. */
export function withoutCatalogDocuments<
  T extends { key?: string | null; label?: string | null; filename?: string | null; media_url?: string | null },
>(documents: T[] | null | undefined): T[] {
  if (!documents) return [];
  return documents.filter(
    (d) =>
      !mentionsCatalog(d.key) &&
      !mentionsCatalog(d.label) &&
      !mentionsCatalog(d.filename) &&
      !mentionsCatalog(d.media_url),
  );
}

/** True si la opción de menú (id o título) es la de catálogo. */
export function isCatalogOption(replyId: string | null | undefined, title: string | null | undefined): boolean {
  return mentionsCatalog(title) || mentionsCatalog(replyId);
}
