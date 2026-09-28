"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRightLeft, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { announceContactDataChanged } from "@/lib/contact-events";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Target {
  id: string;
  label: string;
}

/**
 * "Derivar a otra línea" — header button + dialog. Renders nothing
 * unless this deployment has LINE_TRANSFER_CONFIG targets (see
 * src/lib/line-transfer.ts), so lines without it are unaffected.
 */
export function LineTransferButton({
  conversationId,
  open: openProp,
  onOpenChange,
  onAvailableChange,
  triggerClassName,
}: {
  conversationId: string;
  /** Controlled open state — lets the thread's mobile "⋮" menu open the
   *  dialog while the icon trigger itself is hidden on small screens. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Reports whether this line has any transfer targets at all. */
  onAvailableChange?: (available: boolean) => void;
  triggerClassName?: string;
}) {
  const t = useTranslations("Inbox.lineTransfer");
  const [targets, setTargets] = useState<Target[]>([]);
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const [targetId, setTargetId] = useState("");
  const [topic, setTopic] = useState("");
  const [sending, setSending] = useState(false);
  const onAvailableChangeRef = useRef(onAvailableChange);
  useEffect(() => {
    onAvailableChangeRef.current = onAvailableChange;
  });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/line-transfer")
      .then((r) => (r.ok ? r.json() : { targets: [] }))
      .then((d: { targets?: Target[] }) => {
        if (cancelled) return;
        const list = d.targets ?? [];
        setTargets(list);
        if (list.length > 0) setTargetId(list[0].id);
        onAvailableChangeRef.current?.(list.length > 0);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (targets.length === 0) return null;

  const setOpen = (next: boolean) => {
    // Reset on close so the next open (from either trigger) starts fresh.
    if (!next) {
      setTargetId(targets[0].id);
      setTopic("");
    }
    if (openProp === undefined) setOpenState(next);
    onOpenChange?.(next);
  };

  const openDialog = () => setOpen(true);

  const submit = async () => {
    if (!topic.trim() || sending) return;
    setSending(true);
    try {
      const res = await fetch("/api/line-transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, targetId, topic }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        target?: string;
        historySent?: boolean;
        noticeSent?: boolean;
      };
      if (!res.ok) {
        toast.error(data.error || t("failed"));
        return;
      }
      toast.success(t("done", { line: data.target ?? "" }));
      if (data.historySent === false) toast.warning(t("historyFailed"));
      if (data.noticeSent === false) toast.warning(t("noticeFailed"));
      // The handover note was written server-side — refresh the panel.
      announceContactDataChanged();
      setOpen(false);
    } catch {
      toast.error(t("failed"));
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        title={t("button")}
        aria-label={t("button")}
        className={cn(
          "text-muted-foreground hover:bg-muted hover:text-foreground inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors",
          triggerClassName
        )}
      >
        <ArrowRightLeft className="h-3.5 w-3.5" />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <p className="text-muted-foreground">{t("explanation")}</p>
            <label className="block space-y-1">
              <span className="font-medium">{t("targetLabel")}</span>
              <select
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
                className="border-input bg-background h-9 w-full rounded-md border px-2"
              >
                {targets.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="font-medium">{t("topicLabel")}</span>
              <input
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                maxLength={120}
                placeholder={t("topicPlaceholder")}
                className="border-input bg-background h-9 w-full rounded-md border px-2"
              />
              <span className="text-muted-foreground block text-xs">{t("topicHint")}</span>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={sending}>
              {t("cancel")}
            </Button>
            <Button onClick={submit} disabled={sending || !topic.trim()}>
              {sending ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <ArrowRightLeft className="mr-1 h-4 w-4" />
              )}
              {t("confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
