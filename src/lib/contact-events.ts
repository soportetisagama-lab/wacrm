/**
 * Window event fired after contact data (notes, tags…) changes
 * server-side from outside the contact sidebar, so the sidebar can
 * refetch instead of showing stale data until a reload.
 */
export const CONTACT_DATA_CHANGED_EVENT = "wacrm:contact-data-changed";

export function announceContactDataChanged(): void {
  window.dispatchEvent(new Event(CONTACT_DATA_CHANGED_EVENT));
}
