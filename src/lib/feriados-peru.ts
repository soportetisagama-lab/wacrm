// ============================================================
// Feriados nacionales de Perú (Ley 31788 y anteriores).
//
// Fijos cada año, más Jueves y Viernes Santo (se calculan con la fecha
// de Pascua). Los días no laborables que decrete el Gobierno se agregan
// sin tocar el código con FERIADOS_EXTRA ("2026-12-24,2026-12-31").
//
// La derivación los trata como un domingo solo si
// FERIADOS_PAUSAN_DERIVACION=1 (apagado por defecto).
// ============================================================

/** Feriados de fecha fija, "MM-DD". */
export const FERIADOS_FIJOS: readonly { fecha: string; nombre: string }[] = [
  { fecha: '01-01', nombre: 'Año Nuevo' },
  { fecha: '05-01', nombre: 'Día del Trabajo' },
  { fecha: '06-07', nombre: 'Batalla de Arica y Día de la Bandera' },
  { fecha: '06-29', nombre: 'San Pedro y San Pablo' },
  { fecha: '07-23', nombre: 'Día de la Fuerza Aérea del Perú' },
  { fecha: '07-28', nombre: 'Fiestas Patrias' },
  { fecha: '07-29', nombre: 'Fiestas Patrias' },
  { fecha: '08-06', nombre: 'Batalla de Junín' },
  { fecha: '08-30', nombre: 'Santa Rosa de Lima' },
  { fecha: '10-08', nombre: 'Combate de Angamos' },
  { fecha: '11-01', nombre: 'Todos los Santos' },
  { fecha: '12-08', nombre: 'Inmaculada Concepción' },
  { fecha: '12-09', nombre: 'Batalla de Ayacucho' },
  { fecha: '12-25', nombre: 'Navidad' },
]

function iso(anio: number, mes: number, dia: number): string {
  return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`
}

/** Domingo de Pascua (calendario gregoriano), "AAAA-MM-DD". */
export function domingoDePascua(anio: number): string {
  const a = anio % 19
  const b = Math.floor(anio / 100)
  const c = anio % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const mes = Math.floor((h + l - 7 * m + 114) / 31)
  const dia = ((h + l - 7 * m + 114) % 31) + 1
  return iso(anio, mes, dia)
}

function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + dias)
  return d.toISOString().slice(0, 10)
}

/** Todos los feriados del año: fecha "AAAA-MM-DD" => nombre. */
export function feriadosDelAnio(anio: number): Map<string, string> {
  const out = new Map<string, string>()
  for (const f of FERIADOS_FIJOS) out.set(`${anio}-${f.fecha}`, f.nombre)
  const pascua = domingoDePascua(anio)
  out.set(sumarDias(pascua, -3), 'Jueves Santo')
  out.set(sumarDias(pascua, -2), 'Viernes Santo')
  return out
}

/** Fechas de FERIADOS_EXTRA válidas ("AAAA-MM-DD", separadas por coma o espacio). */
export function feriadosExtra(env: Record<string, string | undefined> = process.env): Set<string> {
  return new Set(
    (env.FERIADOS_EXTRA ?? '')
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)),
  )
}

/** True si la fecha (Lima, "AAAA-MM-DD") es feriado nacional o está en FERIADOS_EXTRA. */
export function esFeriado(fecha: string, env: Record<string, string | undefined> = process.env): boolean {
  const anio = Number(fecha.slice(0, 4))
  if (!Number.isInteger(anio)) return false
  return feriadosDelAnio(anio).has(fecha) || feriadosExtra(env).has(fecha)
}

/** Interruptor: los feriados pausan la derivación solo con FERIADOS_PAUSAN_DERIVACION=1. */
export function feriadosPausanDerivacion(env: Record<string, string | undefined> = process.env): boolean {
  return env.FERIADOS_PAUSAN_DERIVACION?.trim() === '1'
}

const LIMA_OFFSET_MS = -5 * 60 * 60_000 // Perú no tiene horario de verano

/** Fecha de Lima "AAAA-MM-DD" de un instante. */
export function fechaLima(date: Date): string {
  return new Date(date.getTime() + LIMA_OFFSET_MS).toISOString().slice(0, 10)
}

/** Día anterior, "AAAA-MM-DD". */
export function diaAnterior(fecha: string): string {
  return sumarDias(fecha, -1)
}
