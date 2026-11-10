import { NextResponse } from "next/server";
import { ForbiddenError, getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { canViewMarketing } from "@/lib/auth/roles";
import { limaDayRange, resumirHorarios, type MarcacionRow } from "@/lib/marketing/horarios";

// GET /api/marketing/horarios?from=YYYY-MM-DD&to=YYYY-MM-DD&asesor=<name>
// "Horarios de contacto": marcaciones_estado (migration 094) of the
// caller's account in a Lima date range, aggregated by Lima hour ×
// weekday. Owner / admin / analista only (RLS enforces it too).

const PAGE_SIZE = 1000;
/** Safety cap so a huge custom range can't hang the request. */
const MAX_ROWS = 200_000;

export async function GET(request: Request) {
  let ctx;
  try {
    ctx = await getCurrentAccount();
    if (!canViewMarketing(ctx.role)) throw new ForbiddenError();
  } catch (err) {
    return toErrorResponse(err);
  }

  const params = new URL(request.url).searchParams;
  const range = limaDayRange(params.get("from") ?? "", params.get("to") ?? "");
  if (!range) return NextResponse.json({ error: "Rango de fechas inválido" }, { status: 400 });
  const asesor = params.get("asesor")?.trim() || null;

  const rows: MarcacionRow[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
    const { data, error } = await ctx.supabase
      .from("marcaciones_estado")
      .select("estado_inicial, tiempo_estado, asesor, aproximado")
      .eq("account_id", ctx.accountId)
      .gte("tiempo_estado", range.gte)
      .lt("tiempo_estado", range.lt)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      console.error("[marketing/horarios] select failed:", error.message);
      return NextResponse.json({ error: "No se pudieron cargar los datos" }, { status: 500 });
    }
    const page = (data ?? []) as MarcacionRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  // The asesor list comes from the whole range, so picking one doesn't
  // shrink the dropdown.
  const asesores = [...new Set(rows.map((r) => r.asesor).filter((a): a is string => !!a))].sort(
    (a, b) => a.localeCompare(b, "es"),
  );
  const resumen = resumirHorarios(asesor ? rows.filter((r) => r.asesor === asesor) : rows);

  // When xlr9 started registering marcaciones live: everything before
  // came from the historical load and is approximate.
  let activacion: string | null = null;
  if (resumen.hayAproximados) {
    const { data } = await ctx.supabase
      .from("marcaciones_estado")
      .select("created_at")
      .eq("account_id", ctx.accountId)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    activacion = (data as { created_at?: string } | null)?.created_at ?? null;
  }

  return NextResponse.json({ ...resumen, asesores, activacion });
}
