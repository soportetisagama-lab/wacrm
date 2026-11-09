"use client";

import { useTranslations } from "next-intl";

import {
  META_CAPI_EVENT_NAMES,
  isMetaCapiEventName,
  type MetaCapiEventName,
} from "@/lib/meta-capi/events";
import { cn } from "@/lib/utils";

/**
 * Optional button action "Enviar señal a Meta": which Conversions API
 * event is sent when the customer taps this button / list row. Only
 * contacts that came from a WhatsApp ad produce a signal (lib/meta-capi).
 * Purchase is only sent when XLR8 has an amount (Meta requires value).
 */
export function MetaEventSelect({
  value,
  onChange,
  className,
}: {
  value: MetaCapiEventName | undefined;
  onChange: (v: MetaCapiEventName | undefined) => void;
  className?: string;
}) {
  const t = useTranslations("MetaCapi");
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="shrink-0">{t("sendSignal")}</span>
        <select
          value={value ?? ""}
          onChange={(e) => onChange(isMetaCapiEventName(e.target.value) ? e.target.value : undefined)}
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-muted px-2 text-xs text-foreground"
          title={t("hint")}
        >
          <option value="">{t("none")}</option>
          {META_CAPI_EVENT_NAMES.map((name) => (
            <option key={name} value={name}>
              {t(`events.${name}`)}
            </option>
          ))}
        </select>
      </label>
      {value === "Purchase" && (
        <p className="text-[11px] text-muted-foreground">{t("purchaseNote")}</p>
      )}
    </div>
  );
}
