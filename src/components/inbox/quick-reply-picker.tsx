"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  Search,
  Trash2,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { QuickReply } from "@/types";
import { interactivePayloadPreviewText } from "@/lib/whatsapp/interactive";

interface QuickReplyPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (qr: QuickReply) => void;
}

interface Viewer {
  user_id: string;
  is_admin: boolean;
}

interface Draft {
  id?: string;
  title: string;
  content_text: string;
}

/**
 * Lists the quick replies this user can use — shared ones plus their
 * own personal ones (admins: everyone's) — for insertion into the
 * composer. Text snippets fill the textarea; interactive snippets open
 * the builder pre-filled (handled by the caller's `onPick`).
 *
 * Advisors create, edit and delete their own text replies right here
 * (Configuración is admin-only); what an admin creates here is shared
 * with the whole account.
 */
export function QuickReplyPicker({
  open,
  onOpenChange,
  onPick,
}: QuickReplyPickerProps) {
  const t = useTranslations("Inbox.composer");
  const [items, setItems] = useState<QuickReply[]>([]);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/quick-replies", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setItems((data.quick_replies as QuickReply[]) ?? []);
        setViewer((data.viewer as Viewer) ?? null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // Every open starts on a clean list — reset on the way out rather
  // than in the effect above.
  const close = (next: boolean) => {
    if (!next) {
      setQuery("");
      setDraft(null);
    }
    onOpenChange(next);
  };
  const pick = (qr: QuickReply) => {
    setQuery("");
    setDraft(null);
    onPick(qr);
  };

  // Own replies first, then the team's; within each, newest first
  // (the API's order).
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = q
      ? items.filter(
          (qr) =>
            qr.title.toLowerCase().includes(q) ||
            (qr.content_text ?? "").toLowerCase().includes(q),
        )
      : items;
    const mine = (qr: QuickReply) => !qr.is_shared && qr.user_id === viewer?.user_id;
    return [...matches.filter(mine), ...matches.filter((qr) => !mine(qr))];
  }, [items, query, viewer]);

  const canManage = (qr: QuickReply) =>
    Boolean(viewer?.is_admin) || (!qr.is_shared && qr.user_id === viewer?.user_id);

  const save = async () => {
    if (!draft) return;
    if (!draft.title.trim()) {
      toast.error(t("quickReplyNameRequired"));
      return;
    }
    if (!draft.content_text.trim()) {
      toast.error(t("quickReplyTextRequired"));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(
        draft.id ? `/api/quick-replies/${draft.id}` : "/api/quick-replies",
        {
          method: draft.id ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: draft.title,
            kind: "text",
            content_text: draft.content_text,
          }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t("quickReplySaveError"));
        return;
      }
      toast.success(t("quickReplySaved"));
      setDraft(null);
      setQuery("");
      await load();
    } catch {
      toast.error(t("quickReplySaveError"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (qr: QuickReply) => {
    if (!window.confirm(t("quickReplyDeleteConfirm", { title: qr.title }))) return;
    const res = await fetch(`/api/quick-replies/${qr.id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast.error(data.error ?? t("quickReplyDeleteError"));
      return;
    }
    await load();
  };

  const badge = (qr: QuickReply) => {
    if (qr.is_shared) return t("quickReplyTeam");
    if (qr.user_id === viewer?.user_id) return t("quickReplyMine");
    return qr.author_name ?? t("quickReplyPersonal");
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {draft && (
              <button
                type="button"
                onClick={() => setDraft(null)}
                className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                aria-label={t("quickReplyBack")}
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            {draft
              ? draft.id
                ? t("quickReplyEdit")
                : t("quickReplyNew")
              : t("quickReplies")}
          </DialogTitle>
        </DialogHeader>

        {draft ? (
          <div className="space-y-3">
            <Input
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              placeholder={t("quickReplyNamePlaceholder")}
              className="bg-muted text-foreground"
              autoFocus
            />
            <Textarea
              value={draft.content_text}
              onChange={(e) => setDraft({ ...draft, content_text: e.target.value })}
              placeholder={t("quickReplyTextPlaceholder")}
              className="min-h-28 bg-muted text-foreground"
            />
            <p className="text-xs text-muted-foreground">
              {viewer?.is_admin ? t("quickReplyVisibleTeam") : t("quickReplyVisibleMine")}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDraft(null)} disabled={saving}>
                {t("quickReplyCancel")}
              </Button>
              <Button onClick={save} disabled={saving}>
                {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                {t("quickReplySave")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("quickReplySearch")}
                  className="bg-muted pl-8 text-foreground"
                />
              </div>
              <Button
                onClick={() => setDraft({ title: query.trim(), content_text: "" })}
                className="shrink-0"
              >
                <Plus className="mr-1 h-4 w-4" />
                {t("quickReplyCreate")}
              </Button>
            </div>

            <div className="max-h-[60vh] overflow-y-auto">
              {loading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : visible.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {query.trim() ? t("quickReplyNoMatch") : t("quickRepliesEmpty")}
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {visible.map((qr) => (
                    <li
                      key={qr.id}
                      className="group flex items-start gap-1 rounded-md border border-border bg-muted/40 hover:border-primary/50 hover:bg-muted"
                    >
                      <button
                        type="button"
                        onClick={() => pick(qr)}
                        className="flex min-w-0 flex-1 items-start gap-2 p-2.5 text-left"
                      >
                        {qr.kind === "interactive" ? (
                          <Zap className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                        ) : (
                          <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-medium text-foreground">
                              {qr.title}
                            </span>
                            <span
                              className={
                                qr.is_shared
                                  ? "shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
                                  : "shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                              }
                            >
                              {badge(qr)}
                            </span>
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {qr.kind === "interactive" && qr.interactive_payload
                              ? interactivePayloadPreviewText(qr.interactive_payload)
                              : qr.content_text}
                          </span>
                        </span>
                      </button>
                      {canManage(qr) && (
                        <div className="flex shrink-0 gap-0.5 p-1.5">
                          {qr.kind === "text" && (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={t("quickReplyEdit")}
                              onClick={() =>
                                setDraft({
                                  id: qr.id,
                                  title: qr.title,
                                  content_text: qr.content_text ?? "",
                                })
                              }
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t("quickReplyDelete")}
                            onClick={() => remove(qr)}
                            className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
