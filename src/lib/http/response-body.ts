/**
 * The JSON body of an API response, for the inbox's send calls. When the
 * body isn't JSON (a proxy error page — the request never reached the
 * app, or the app didn't answer), a failed response still comes back
 * with a readable `error` instead of a bare "HTTP 502".
 */
export type JsonBody = { error?: string } & Record<string, unknown>

export async function readJsonBody(res: Response): Promise<JsonBody> {
  const raw = await res.text().catch(() => '')
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      const body = parsed as Record<string, unknown>
      const error = typeof body.error === 'string' && body.error ? body.error : undefined
      return { ...body, error: error ?? (res.ok ? undefined : httpFailureText(res.status)) }
    }
  } catch {
    // Not JSON — fall through.
  }
  if (res.ok) return {}
  return { error: httpFailureText(res.status) }
}

export function httpFailureText(status: number): string {
  if (status === 502 || status === 503 || status === 504) {
    return `el servidor no respondió (HTTP ${status}). Puede estar reiniciándose: intenta de nuevo en un momento.`
  }
  return `HTTP ${status}`
}
