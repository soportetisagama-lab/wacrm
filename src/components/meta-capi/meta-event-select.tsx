"use client";

import {
  META_CAPI_EVENT_LABELS,
  META_CAPI_EVENT_NAMES,
  isMetaCapiEventName,
  type MetaCapiEventName,
} from "@/lib/meta-capi/events";
import { cn } from "@/lib/utils";

/**
 * Optional button action "Enviar señal a Meta": which Conversions API
 * event is sent when the customer taps this button / list row. Only
 * contacts that came from a WhatsApp ad produce a signal (lib/meta-capi).
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
  return (
    <label className={cn("flex items-center gap-2 text-xs text-muted-foreground", className)}>
      <span className="shrink-0">Enviar señal a Meta</span>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(isMetaCapiEventName(e.target.value) ? e.target.value : undefined)}
        className="h-8 min-w-0 flex-1 rounded-md border border-input bg-muted px-2 text-xs text-foreground"
        title="Se envía a Meta solo si el cliente llegó desde un anuncio de WhatsApp"
      >
        <option value="">No enviar</option>
        {META_CAPI_EVENT_NAMES.map((name) => (
          <option key={name} value={name}>
            {META_CAPI_EVENT_LABELS[name]}
          </option>
        ))}
      </select>
    </label>
  );
}
