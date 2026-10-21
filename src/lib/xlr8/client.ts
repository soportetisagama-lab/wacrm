/**
 * Browser helper: asks the server to sync xlr8 statuses now. Resolves to
 * true when tags were added/removed (so the caller can refresh), false
 * otherwise — including on any error; it's best-effort background work.
 */
export async function triggerXlr8Sync(): Promise<boolean> {
  try {
    const res = await fetch("/api/xlr8/sync", { method: "POST", cache: "no-store" });
    if (!res.ok) return false;
    const body = (await res.json()) as { changed?: boolean };
    return body.changed === true;
  } catch {
    return false;
  }
}
