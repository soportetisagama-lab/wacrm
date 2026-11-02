import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { consultarAsesoresDisponibles, puedeVerAsesoresDisponibles } from '@/lib/asesores-disponibles'

// Indicador de la barra superior (junto al número de la línea): asesores a quienes la derivación
// automática XLR8 podría pasar un lead ahora (lib/asesores-disponibles.ts).
// Solo Administrador (owner / admin) y ATC; cualquier otro rol recibe 403.
export async function GET() {
  let role
  try {
    ;({ role } = await getCurrentAccount())
  } catch (err) {
    return toErrorResponse(err)
  }
  if (!puedeVerAsesoresDisponibles(role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const resultado = await consultarAsesoresDisponibles()
  return NextResponse.json(resultado, { headers: { 'Cache-Control': 'private, no-store' } })
}
