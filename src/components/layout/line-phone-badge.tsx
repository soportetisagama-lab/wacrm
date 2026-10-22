"use client";

import { useEffect, useState } from "react";
import { Phone } from "lucide-react";
import { useTranslations } from "next-intl";
import { formatLinePhone } from "@/lib/whatsapp/format-line-phone";

const STORAGE_KEY = "wacrm:line-phone";

/**
 * Discreet "Número de celular: 933 862 062" pill for the header.
 * Reads the connected line's number once per session (cached in
 * sessionStorage) and renders nothing when the account has no line.
 */
export function LinePhoneBadge() {
  const t = useTranslations("Header");
  const [phone, setPhone] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    try {
      const cached = sessionStorage.getItem(STORAGE_KEY);
      if (cached !== null) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one-off hydration from sessionStorage
        setPhone(cached || null);
        return;
      }
    } catch {
      // sessionStorage unavailable (private mode) — fall through to fetch
    }
    fetch("/api/whatsapp/line-phone")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { display_phone_number?: string | null } | null) => {
        if (cancelled || !data) return;
        const formatted = formatLinePhone(data.display_phone_number);
        setPhone(formatted);
        try {
          sessionStorage.setItem(STORAGE_KEY, formatted ?? "");
        } catch {
          // ignore
        }
      })
      .catch(() => {
        // network error — keep the badge hidden
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!phone) return null;

  return (
    <div
      title={`${t("linePhone")}: ${phone}`}
      className="hidden h-8 shrink-0 items-center gap-1.5 rounded-full bg-white/15 px-2.5 text-xs font-medium whitespace-nowrap text-white/90 min-[420px]:flex sm:h-9 sm:px-3 sm:text-sm"
    >
      <Phone className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="hidden md:inline">{t("linePhone")}:</span>
      <span className="tabular-nums">{phone}</span>
    </div>
  );
}
