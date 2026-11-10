"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Clock, Loader2, PhoneCall, TrendingDown, TrendingUp } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { canViewMarketing } from "@/lib/auth/roles";
import {
  HORARIOS_TIME_ZONE,
  MIN_MARCACIONES_RANKING,
  pctContestados,
  type HorariosResumen,
} from "@/lib/marketing/horarios";
import { MetricCard } from "@/components/dashboard/metric-card";
import { BarChart } from "@/components/tremor/bar-chart";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** "Horarios de contacto" (Marketing) — at which Lima hours / weekdays
 *  leads get marked CONTESTADO vs NO CONTESTADO in xlr8. Data comes from
 *  GET /api/marketing/horarios (marcaciones_estado, migration 094). */

type Preset = "7d" | "30d" | "90d" | "custom";
const PRESET_DAYS: Record<Exclude<Preset, "custom">, number> = { "7d": 7, "30d": 30, "90d": 90 };
const ALL = "";
const DAYS = [0, 1, 2, 3, 4, 5, 6] as const;

interface ApiResponse extends HorariosResumen {
  asesores: string[];
  activacion: string | null;
}

const limaDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: HORARIOS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const limaFecha = new Intl.DateTimeFormat("es-PE", { timeZone: HORARIOS_TIME_ZONE, dateStyle: "long" });

/** Last `days` Lima calendar days, today included. */
function presetRange(days: number): { from: string; to: string } {
  const to = limaDay.format(new Date());
  const start = new Date(`${to}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { from: start.toISOString().slice(0, 10), to };
}

const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;
const pctLabel = (n: number) => Math.round(n).toLocaleString("es-PE");

export default function HorariosContactoPage() {
  const t = useTranslations("ContactHours");
  const { accountRole } = useAuth();

  const [preset, setPreset] = useState<Preset>("30d");
  const [range, setRange] = useState(() => presetRange(30));
  const [asesor, setAsesor] = useState<string>(ALL);
  const [selected, setSelected] = useState<{ dia: number; hora: number } | null>(null);
  // Result tagged with the query it answers, so a filter change shows
  // the spinner without resetting state inside the effect.
  const [result, setResult] = useState<{ key: string; data: ApiResponse | null } | null>(null);

  const rangeValid = !!range.from && !!range.to && range.from <= range.to;
  const queryKey = `${range.from}|${range.to}|${asesor}`;
  const allowed = !accountRole || canViewMarketing(accountRole);

  useEffect(() => {
    if (!rangeValid || !allowed) return;
    let cancelled = false;
    const qs = new URLSearchParams({ from: range.from, to: range.to });
    if (asesor) qs.set("asesor", asesor);
    const key = `${range.from}|${range.to}|${asesor}`;
    fetch(`/api/marketing/horarios?${qs.toString()}`, { cache: "no-store" })
      .then(async (res) => (res.ok ? ((await res.json()) as ApiResponse) : null))
      .catch(() => null)
      .then((data) => {
        if (!cancelled) setResult({ key, data });
      });
    return () => {
      cancelled = true;
    };
  }, [range.from, range.to, asesor, rangeValid, allowed]);

  const loading = rangeValid && (!result || result.key !== queryKey);
  const data = !loading && result ? result.data : null;

  const cells = useMemo(() => {
    const map = new Map<number, { contestados: number; noContestados: number }>();
    for (const c of data?.celdas ?? []) map.set(c.dia * 24 + c.hora, c);
    return map;
  }, [data]);
  const hoursWithData = useMemo(
    () => (data?.horas ?? []).filter((h) => h.contestados + h.noContestados > 0).map((h) => h.hora),
    [data],
  );

  const answered = t("seriesAnswered");
  const notAnswered = t("seriesNotAnswered");
  const chartData = useMemo(
    () =>
      (data?.horas ?? [])
        .filter((h) => hoursWithData.includes(h.hora))
        .map((h) => ({ hora: hourLabel(h.hora), [answered]: h.contestados, [notAnswered]: h.noContestados })),
    [data, hoursWithData, answered, notAnswered],
  );

  if (!allowed) {
    return <p className="py-12 text-center text-sm text-muted-foreground">{t("noAccess")}</p>;
  }

  // Keep the last list while a new query loads.
  const asesores = data?.asesores ?? result?.data?.asesores ?? [];
  const dayName = (d: number) => t(`day_${d}`);
  const cellText = (dia: number, hora: number) => {
    const c = cells.get(dia * 24 + hora);
    const total = c ? c.contestados + c.noContestados : 0;
    if (!c || total === 0) return t("heatmapEmptyCell", { day: dayName(dia), hour: hourLabel(hora) });
    return t("heatmapCell", {
      day: dayName(dia),
      hour: hourLabel(hora),
      pct: pctLabel(pctContestados(c)),
      answered: c.contestados,
      total,
    });
  };
  const rankSub = (r: HorariosResumen["mejor"]) =>
    r ? t("rankSub", { pct: pctLabel(r.pct), count: r.total }) : t("rankEmpty");

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t("pageTitle")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("pageDesc")}</p>
      </div>

      {/* Filters */}
      <div className="space-y-4 rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1 sm:w-fit">
          {(["7d", "30d", "90d", "custom"] as Preset[]).map((pr) => (
            <button
              key={pr}
              type="button"
              onClick={() => {
                setPreset(pr);
                if (pr !== "custom") setRange(presetRange(PRESET_DAYS[pr]));
              }}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                preset === pr ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(`preset_${pr}`)}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{t("from")}</Label>
            <Input
              type="date"
              value={range.from}
              max={range.to}
              onChange={(e) => {
                setPreset("custom");
                setRange((r) => ({ ...r, from: e.target.value }));
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{t("to")}</Label>
            <Input
              type="date"
              value={range.to}
              min={range.from}
              onChange={(e) => {
                setPreset("custom");
                setRange((r) => ({ ...r, to: e.target.value }));
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{t("agent")}</Label>
            <select
              value={asesor}
              onChange={(e) => setAsesor(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm text-foreground shadow-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <option value={ALL}>{t("allAgents")}</option>
              {asesor && !asesores.includes(asesor) && <option value={asesor}>{asesor}</option>}
              {asesores.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : !rangeValid ? (
        <p className="py-12 text-center text-sm text-muted-foreground">{t("empty")}</p>
      ) : !data ? (
        <p className="py-12 text-center text-sm text-red-500">{t("loadError")}</p>
      ) : (
        <>
          {/* Totals */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard
              title={t("cardTotal")}
              value={data.total.toLocaleString("es-PE")}
              icon={PhoneCall}
              accent="chart-1"
              subtitle={t("cardTotalSub", { answered: data.contestados, notAnswered: data.noContestados })}
            />
            <MetricCard
              title={t("cardRate")}
              value={`${pctLabel(pctContestados(data))} %`}
              icon={Clock}
              accent="chart-2"
              subtitle={t("cardRateSub")}
            />
            <MetricCard
              title={t("cardBest")}
              value={data.mejor ? hourLabel(data.mejor.hora) : "—"}
              icon={TrendingUp}
              accent="chart-3"
              subtitle={rankSub(data.mejor)}
            />
            <MetricCard
              title={t("cardWorst")}
              value={data.peor ? hourLabel(data.peor.hora) : "—"}
              icon={TrendingDown}
              accent="chart-4"
              subtitle={rankSub(data.peor)}
            />
          </div>

          {data.total === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            <>
              {/* Heat map: hour rows × weekday columns */}
              <section className="rounded-xl border border-border bg-card shadow-sm">
                <header className="border-b border-border px-5 py-4">
                  <h2 className="text-sm font-semibold tracking-tight text-foreground">{t("heatmapTitle")}</h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">{t("heatmapDesc")}</p>
                </header>
                <div className="overflow-x-auto p-4">
                  <table className="w-full min-w-[420px] border-separate border-spacing-1 text-xs">
                    <thead>
                      <tr className="text-muted-foreground">
                        <th className="w-14 text-left font-medium">{t("colHour")}</th>
                        {DAYS.map((d) => (
                          <th key={d} className="font-medium">
                            {dayName(d)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {hoursWithData.map((hora) => (
                        <tr key={hora}>
                          <td className="pr-2 text-muted-foreground tabular-nums">{hourLabel(hora)}</td>
                          {DAYS.map((dia) => {
                            const c = cells.get(dia * 24 + hora);
                            const total = c ? c.contestados + c.noContestados : 0;
                            const pct = c && total > 0 ? pctContestados(c) : null;
                            const isSelected = selected?.dia === dia && selected.hora === hora;
                            return (
                              <td key={dia} className="p-0">
                                <button
                                  type="button"
                                  title={cellText(dia, hora)}
                                  aria-label={cellText(dia, hora)}
                                  onClick={() => setSelected(isSelected ? null : { dia, hora })}
                                  className={cn(
                                    "flex h-8 w-full items-center justify-center rounded-md tabular-nums transition-shadow",
                                    pct === null ? "bg-muted/40 text-muted-foreground/60" : "text-foreground",
                                    isSelected && "ring-2 ring-ring",
                                  )}
                                  style={
                                    pct === null
                                      ? undefined
                                      : {
                                          backgroundColor: `color-mix(in oklch, var(--primary) ${Math.round(
                                            10 + pct * 0.8,
                                          )}%, transparent)`,
                                        }
                                  }
                                >
                                  {pct === null ? "" : `${pctLabel(pct)}%`}
                                </button>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
                    <span className="min-h-4">{selected ? cellText(selected.dia, selected.hora) : ""}</span>
                    <span className="flex items-center gap-2">
                      {t("legendLow")}
                      <span
                        className="h-2.5 w-24 rounded-full"
                        style={{
                          background:
                            "linear-gradient(90deg, color-mix(in oklch, var(--primary) 10%, transparent), var(--primary))",
                        }}
                      />
                      {t("legendHigh")}
                    </span>
                  </div>
                </div>
              </section>

              {/* Bars per hour */}
              <section className="rounded-xl border border-border bg-card shadow-sm">
                <header className="border-b border-border px-5 py-4">
                  <h2 className="text-sm font-semibold tracking-tight text-foreground">{t("barsTitle")}</h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">{t("barsDesc")}</p>
                </header>
                <div className="p-4">
                  <BarChart
                    data={chartData}
                    index="hora"
                    categories={[answered, notAnswered]}
                    colors={["primary", "gray"]}
                    valueFormatter={(v) => v.toLocaleString("es-PE")}
                    allowDecimals={false}
                    yAxisWidth={40}
                    legendPosition="center"
                    className="h-[280px]"
                  />
                </div>
              </section>
            </>
          )}

          <p className="text-xs text-muted-foreground">
            {t("rankHint", { min: MIN_MARCACIONES_RANKING })}
            {data.hayAproximados && data.activacion && (
              <>
                {" "}
                {t("approxNote", { date: limaFecha.format(new Date(data.activacion)) })}
              </>
            )}
          </p>
        </>
      )}
    </div>
  );
}
