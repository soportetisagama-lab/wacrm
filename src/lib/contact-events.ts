/**
 * Window event fired after contact data (notes, tags…) changes
 * server-side from outside the contact sidebar, so the sidebar can
 * refetch instead of showing stale data until a reload.
 */
export const CONTACT_DATA_CHANGED_EVENT = "wacrm:contact-data-changed";

export function announceContactDataChanged(): void {
  window.dispatchEvent(new Event(CONTACT_DATA_CHANGED_EVENT));
}

/**
 * Window event fired after a tag is created or deleted (e.g. from the
 * inbox contact panel's tag picker), so every tag list on the page —
 * the inbox "Etiquetas" filter, other open panels — refetches instead
 * of only showing it after a reload.
 */
export const TAGS_CHANGED_EVENT = "wacrm:tags-changed";

export function announceTagsChanged(): void {
  window.dispatchEvent(new Event(TAGS_CHANGED_EVENT));
}
