"use client";

import { Phone } from "lucide-react";
import { useTranslations } from "next-intl";

import { useCan } from "@/hooks/use-can";
import { cn } from "@/lib/utils";
import { CALL_CONTACT_EVENT, type CallContactDetail } from "./incoming-call-manager";

/** Ask the (always-mounted) IncomingCallManager to call this contact —
 *  it runs the permission check, cost warning and the call itself. */
export function callContact(contactId: string, name: string) {
  window.dispatchEvent(
    new CustomEvent<CallContactDetail>(CALL_CONTACT_EVENT, { detail: { contactId, name } }),
  );
}

/** Phone icon button that starts an outbound WhatsApp call. Hidden for
 *  read-only viewers. `withLabel` renders "Llamar" next to the icon. */
export function CallContactButton({
  contactId,
  name,
  withLabel = false,
  className,
}: {
  contactId: string;
  name: string;
  withLabel?: boolean;
  className?: string;
}) {
  const t = useTranslations("Calls");
  const canAct = useCan("send-messages");
  if (!canAct) return null;
  return (
    <button
      type="button"
      onClick={() => callContact(contactId, name)}
      title={t("callNow")}
      aria-label={t("callNow")}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        withLabel ? "h-8 px-2.5 text-xs" : "h-7 w-7",
        className,
      )}
    >
      <Phone className={withLabel ? "h-3.5 w-3.5" : "h-3.5 w-3.5"} />
      {withLabel && t("callNow")}
    </button>
  );
}
