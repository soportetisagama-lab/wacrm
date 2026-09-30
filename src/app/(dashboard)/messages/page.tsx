"use client";

import { useEffect, useMemo, useState } from "react";
import {
  addDays,
  endOfMonth,
  format,
  parseISO,
  startOfDay,
  startOfMonth,
  subDays,
  subMonths,
} from "date-fns";
import { useTranslations } from "next-intl";
import { DollarSign, Download, FileText, Loader2, MessageSquare, Send } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { canViewMessageUsage } from "@/lib/auth/roles";
import { MetricCard } from "@/components/dashboard/metric-card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** "Mensajes" — outbound messages per Asesor in a date range, to
 *  estimate Meta's per-message cost. Data comes from the
 *  message_usage() RPC (migrations 075/076), which only answers for
 *  owner / admin / analista. Templates are split by Meta's pricing
 *  category; utility templates sent inside the 24 h window are free. */

const COUNTS = ["marketing", "utility", "utility_free", "authentication", "others"] as const;
type CountKey = (typeof COUNTS)[number];
type Counts = Record<CountKey, number>;

interface UsageRow extends Counts {
  source: "agent" | "bot" | "broadcast";
  user_id: string | null;
}

interface ReportRow extends Counts {
  key: string;
  name: string;
}

type PriceKey = "marketing" | "utility" | "authentication" | "other";
type Prices = Record<PriceKey, string>;

type Preset = "today" | "7d" | "month" | "lastMonth";

const PRICE_KEY = "wacrm.messageUsage.prices.v2";
const ALL = "all";
const NO_ROWS: UsageRow[] = [];
const SPECIAL = ["unassigned", "bot", "broadcast"];
const EMPTY: Counts = { marketing: 0, utility: 0, utility_free: 0, authentication: 0, others: 0 };

function presetRange(p: Preset): { from: string; to: string } {
  const now = new Date();
  const d = (x: Date) => format(x, "yyyy-MM-dd");
  switch (p) {
    case "today":
      return { from: d(now), to: d(now) };
    case "7d":
      return { from: d(subDays(now, 6)), to: d(now) };
    case "month":
      return { from: d(startOfMonth(now)), to: d(now) };
    case "lastMonth": {
      const prev = subMonths(now, 1);
      return { from: d(startOfMonth(prev)), to: d(endOfMonth(prev)) };
    }
  }
}

function toNumber(v: string): number {
  const n = Number(v.replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

const templatesOf = (r: Counts) => r.marketing + r.utility + r.authentication;
const totalOf = (r: Counts) => templatesOf(r) + r.others;

export default function MessageUsagePage() {
  const t = useTranslations("MessageUsage");
  const { accountRole } = useAuth();

  const [preset, setPreset] = useState<Preset | null>("month");
  const [range, setRange] = useState(() => presetRange("month"));
  const [agentFilter, setAgentFilter] = useState<string>(ALL);
  // Result tagged with the range it was fetched for, so a range change
  // shows the spinner without resetting state inside the effect.
  const [result, setResult] = useState<{ key: string; rows: UsageRow[]; error: boolean } | null>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  // The shell only renders pages client-side (after auth resolves), so
  // reading localStorage in the initializer can't cause a hydration mismatch.
  // Normal messages default to 0: Meta doesn't bill them.
  const [prices, setPrices] = useState<Prices>(() => {
    const blank: Prices = { marketing: "", utility: "", authentication: "", other: "0" };
    try {
      const saved = localStorage.getItem(PRICE_KEY);
      if (saved) return { ...blank, ...JSON.parse(saved) };
    } catch {
      // Private window / blocked storage — prices just start empty.
    }
    return blank;
  });

  const updatePrice = (field: PriceKey, value: string) => {
    setPrices((prev) => {
      const next = { ...prev, [field]: value };
      try {
        localStorage.setItem(PRICE_KEY, JSON.stringify(next));
      } catch {
        // Ignore — the value still applies for this session.
      }
      return next;
    });
  };

  useEffect(() => {
    const supabase = createClient();
    void supabase
      .from("profiles")
      .select("user_id, full_name, email")
      .then(({ data }) => {
        setNames(
          new Map(
            (data ?? []).map((p: { user_id: string; full_name: string | null; email: string | null }) => [
              p.user_id,
              p.full_name || p.email || "",
            ]),
          ),
        );
      });
  }, []);

  const rangeKey = `${range.from}|${range.to}`;
  const rangeValid = !!range.from && !!range.to && range.from <= range.to;

  useEffect(() => {
    if (!rangeValid) return;
    let cancelled = false;
    const supabase = createClient();
    void supabase
      .rpc("message_usage", {
        p_from: startOfDay(parseISO(range.from)).toISOString(),
        p_to: addDays(startOfDay(parseISO(range.to)), 1).toISOString(),
      })
      .then(({ data, error: rpcError }) => {
        if (cancelled) return;
        if (rpcError) console.error("[message-usage] rpc failed:", rpcError.message);
        setResult({
          key: `${range.from}|${range.to}`,
          error: !!rpcError,
          rows: ((data ?? []) as UsageRow[]).map((r) => {
            const row = { ...r };
            for (const k of COUNTS) row[k] = Number(r[k] ?? 0);
            return row;
          }),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [range.from, range.to, rangeValid]);

  const rows = !rangeValid ? NO_ROWS : result && result.key === rangeKey ? result.rows : null;
  const error = !!result && result.key === rangeKey && result.error;

  // One row per Asesor, then the unattributed / bot / broadcast buckets.
  const report = useMemo<ReportRow[]>(() => {
    const byKey = new Map<string, ReportRow>();
    for (const r of rows ?? []) {
      const key = r.source === "agent" ? (r.user_id ?? "unassigned") : r.source;
      const name =
        key === "unassigned"
          ? t("unassigned")
          : key === "bot"
            ? t("bot")
            : key === "broadcast"
              ? t("broadcasts")
              : names.get(key) || t("formerMember");
      const row = byKey.get(key) ?? { key, name, ...EMPTY };
      for (const k of COUNTS) row[k] += r[k];
      byKey.set(key, row);
    }
    const agents = [...byKey.values()]
      .filter((r) => !SPECIAL.includes(r.key))
      .sort((a, b) => totalOf(b) - totalOf(a));
    const rest = SPECIAL.map((k) => byKey.get(k)).filter((r): r is ReportRow => !!r);
    return [...agents, ...rest];
  }, [rows, names, t]);

  const agentOptions = useMemo(() => report.filter((r) => !SPECIAL.includes(r.key)), [report]);

  const visible = agentFilter === ALL ? report : report.filter((r) => r.key === agentFilter);

  const p = {
    marketing: toNumber(prices.marketing),
    utility: toNumber(prices.utility),
    authentication: toNumber(prices.authentication),
    other: toNumber(prices.other),
  };
  const cost = (r: Counts) =>
    r.marketing * p.marketing +
    (r.utility - r.utility_free) * p.utility +
    r.authentication * p.authentication +
    r.others * p.other;
  const totals = visible.reduce<Counts>((acc, r) => {
    const next = { ...acc };
    for (const k of COUNTS) next[k] += r[k];
    return next;
  }, EMPTY);
  const money = (n: number) =>
    `$ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;

  const exportCsv = () => {
    const line = (name: string, r: Counts) =>
      [
        `"${name.replace(/"/g, '""')}"`,
        r.marketing,
        r.utility,
        r.utility_free,
        r.authentication,
        r.others,
        totalOf(r),
        cost(r).toFixed(4),
      ].join(",");
    const lines = [
      [
        t("colAgent"),
        t("colMarketing"),
        t("colUtility"),
        t("colUtilityFree"),
        t("colAuthentication"),
        t("colOthers"),
        t("colTotal"),
        t("colCost"),
      ].join(","),
      ...visible.map((r) => line(r.name, r)),
      line(t("total"), totals),
    ];
    const blob = new Blob([`﻿${lines.join("\n")}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mensajes_${range.from}_${range.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (accountRole && !canViewMessageUsage(accountRole)) {
    return <p className="py-12 text-center text-sm text-muted-foreground">{t("noAccess")}</p>;
  }

  const priceFields: { key: PriceKey; label: string }[] = [
    { key: "marketing", label: t("priceMarketing") },
    { key: "utility", label: t("priceUtility") },
    { key: "authentication", label: t("priceAuthentication") },
    { key: "other", label: t("priceOther") },
  ];

  const utilityCell = (r: Counts) => (
    <>
      {r.utility.toLocaleString()}
      {r.utility_free > 0 && (
        <span className="block text-[11px] text-muted-foreground">
          {t("utilityFree", { count: r.utility_free })}
        </span>
      )}
    </>
  );

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t("pageTitle")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("pageDesc")}</p>
      </div>

      {/* Filters */}
      <div className="space-y-4 rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1 sm:w-fit">
          {(["today", "7d", "month", "lastMonth"] as Preset[]).map((pr) => (
            <button
              key={pr}
              type="button"
              onClick={() => {
                setPreset(pr);
                setRange(presetRange(pr));
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
                setPreset(null);
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
                setPreset(null);
                setRange((r) => ({ ...r, to: e.target.value }));
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{t("agent")}</Label>
            <select
              value={agentFilter}
              onChange={(e) => setAgentFilter(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm text-foreground shadow-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <option value={ALL}>{t("allAgents")}</option>
              {agentOptions.map((a) => (
                <option key={a.key} value={a.key}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {priceFields.map((f) => (
            <div key={f.key} className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{f.label}</Label>
              <Input
                inputMode="decimal"
                placeholder="0.00"
                value={prices[f.key]}
                onChange={(e) => updatePrice(f.key, e.target.value)}
              />
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t("priceHint")}</p>
      </div>

      {/* Totals */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard title={t("cardTotal")} value={totalOf(totals).toLocaleString()} icon={Send} accent="chart-1" />
        <MetricCard
          title={t("cardTemplates")}
          value={templatesOf(totals).toLocaleString()}
          icon={FileText}
          accent="chart-2"
          subtitle={t("cardTemplatesSub", {
            marketing: totals.marketing,
            utility: totals.utility,
            authentication: totals.authentication,
          })}
        />
        <MetricCard
          title={t("cardOthers")}
          value={totals.others.toLocaleString()}
          icon={MessageSquare}
          accent="chart-3"
          subtitle={t("cardOthersSub")}
        />
        <MetricCard title={t("cardCost")} value={money(cost(totals))} icon={DollarSign} accent="chart-4" />
      </div>

      {/* Per-agent table */}
      {rows === null ? (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : error ? (
        <p className="py-12 text-center text-sm text-red-500">{t("loadError")}</p>
      ) : visible.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <p className="text-sm font-medium text-foreground">{t("tableTitle")}</p>
            <button
              type="button"
              onClick={exportCsv}
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Download className="h-3.5 w-3.5" />
              {t("exportCsv")}
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">{t("colAgent")}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t("colMarketing")}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t("colUtility")}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t("colAuthentication")}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t("colOthers")}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t("colTotal")}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t("colCost")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visible.map((r) => (
                  <tr key={r.key}>
                    <td className="px-4 py-2.5 text-foreground">{r.name}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{r.marketing.toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{utilityCell(r)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{r.authentication.toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{r.others.toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right font-medium tabular-nums">{totalOf(r).toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{money(cost(r))}</td>
                  </tr>
                ))}
              </tbody>
              {visible.length > 1 && (
                <tfoot>
                  <tr className="border-t border-border bg-muted/40 font-semibold">
                    <td className="px-4 py-2.5">{t("total")}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{totals.marketing.toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{utilityCell(totals)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{totals.authentication.toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{totals.others.toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{totalOf(totals).toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{money(cost(totals))}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground">{t("attributionNote")}</p>
    </div>
  );
}
