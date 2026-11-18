import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { asignarDesdeAlertaAtc, leerAlertaAtc, supabaseAlertaAtcStore } from '@/lib/derivacion-alerta-atc'
import { supabaseAdmin } from '@/lib/flows/admin-client'

// Lo llama XLR8 (alertas_derivacion.php) cuando la ATC deriva una alerta:
// asigna el chat al asesor elegido (lib/derivacion-alerta-atc.ts).
// Auth: header X-Derivar-Secret = DERIVAR_AUTO_SECRET (el mismo secreto
// que XLR9 ya usa para llamar a derivar_auto.php).

function secretoValido(recibido: string | null): boolean {
  const esperado = process.env.DERIVAR_AUTO_SECRET?.trim()
  if (!esperado || !recibido) return false
  const a = Buffer.from(recibido)
  const b = Buffer.from(esperado)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function POST(request: Request) {
  if (!secretoValido(request.headers.get('x-derivar-secret'))) {
    return NextResponse.json({ ok: false, motivo: 'no_autorizado' }, { status: 401 })
  }
  const input = leerAlertaAtc(await request.json().catch(() => null))
  if (!input) {
    return NextResponse.json({ ok: false, motivo: 'datos_invalidos' }, { status: 400 })
  }
  try {
    const resultado = await asignarDesdeAlertaAtc(supabaseAlertaAtcStore(supabaseAdmin()), input)
    return NextResponse.json(resultado, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error('[derivacion-alerta-atc]', err instanceof Error ? err.message : err)
    return NextResponse.json({ ok: false, motivo: 'error' }, { status: 500 })
  }
}
