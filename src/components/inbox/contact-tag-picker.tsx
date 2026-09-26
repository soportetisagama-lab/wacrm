"use client";

import { useMemo, useState } from "react";
import { Check, Loader2, Plus, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { canCreateSharedTags } from "@/lib/auth/roles";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Tag } from "@/types";

// Assigned round-robin by name so a new tag gets a stable, varied color
// without asking the advisor to pick one.
const TAG_COLORS = [
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f97316",
];

function colorFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TAG_COLORS[h % TAG_COLORS.length];
}

function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

interface ContactTagPickerProps {
  /** Every tag this user can see — shared ones plus their own personal
   *  ones (admins: all), already scoped by RLS (migration 069). */
  allTags: Tag[];
  selectedIds: Set<string>;
  onToggle: (tag: Tag) => void;
  /** A tag was just created here — the parent adds it to `allTags`
   *  and applies it to the contact. */
  onCreated: (tag: Tag) => void;
  /** A tag was deleted here (it cascades off every contact). */
  onDeleted: (tagId: string) => void;
}

/**
 * The "+" next to ETIQUETAS in the inbox contact panel: search the
 * tags this user can use and toggle them on the contact, or type a
 * new name and create it. What an advisor creates is personal (only
 * they see it); what an admin creates is shared with the team. Only
 * one's own personal tags (or, for an admin, any tag) can be deleted.
 */
export function ContactTagPicker({
  allTags,
  selectedIds,
  onToggle,
  onCreated,
  onDeleted,
}: ContactTagPickerProps) {
  const t = useTranslations("Inbox.sidebar");
  const { user, accountId, accountRole } = useAuth();
  const isAdmin = accountRole ? canCreateSharedTags(accountRole) : false;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);

  const q = fold(query);
  const visible = useMemo(
    () => (q ? allTags.filter((tag) => fold(tag.name).includes(q)) : allTags),
    [allTags, q],
  );
  const exactExists = q !== "" && allTags.some((tag) => fold(tag.name) === q);

  const isMine = (tag: Tag) => tag.is_shared === false && tag.user_id === user?.id;
  const canDelete = (tag: Tag) => isAdmin || isMine(tag);

  const create = async () => {
    const name = query.trim();
    if (!name || !accountId || !user) return;
    setCreating(true);
    try {
      const { data, error } = await createClient()
        .from("tags")
        .insert({
          account_id: accountId,
          user_id: user.id,
          name,
          color: colorFor(name),
          // Admin-created tags are the team's (column default true);
          // everyone else's are their own.
          ...(isAdmin ? {} : { is_shared: false }),
        })
        .select("*")
        .single();
      if (error || !data) {
        toast.error(t("tagCreateError"));
        return;
      }
      setQuery("");
      onCreated(data as Tag);
    } finally {
      setCreating(false);
    }
  };

  const remove = async (tag: Tag) => {
    if (!window.confirm(t("tagDeleteConfirm", { name: tag.name }))) return;
    const { error } = await createClient().from("tags").delete().eq("id", tag.id);
    if (error) {
      toast.error(t("tagDeleteError"));
      return;
    }
    onDeleted(tag.id);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger
        className="rounded-md p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label={t("tagAdd")}
      >
        <Plus className="h-3.5 w-3.5" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 gap-2 p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && q && !exactExists) {
                e.preventDefault();
                void create();
              }
            }}
            placeholder={t("tagSearch")}
            autoFocus
            className="w-full rounded-md border border-border bg-muted py-1.5 pl-7 pr-2 text-sm text-foreground outline-none focus:border-primary/50"
          />
        </div>

        <ul className="max-h-60 overflow-y-auto">
          {visible.map((tag) => {
            const checked = selectedIds.has(tag.id);
            return (
              <li key={tag.id} className="group flex items-center gap-1 rounded-md hover:bg-muted">
                <button
                  type="button"
                  onClick={() => onToggle(tag)}
                  className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm"
                >
                  <span
                    className={cn(
                      "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border",
                      checked ? "border-primary bg-primary text-primary-foreground" : "border-border",
                    )}
                  >
                    {checked && <Check className="h-2.5 w-2.5" />}
                  </span>
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} />
                  <span className="truncate">{tag.name}</span>
                  {tag.is_shared === false && (
                    <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground group-hover:bg-background">
                      {isMine(tag) ? t("tagMine") : t("tagPersonal")}
                    </span>
                  )}
                </button>
                {canDelete(tag) && (
                  <button
                    type="button"
                    onClick={() => void remove(tag)}
                    aria-label={t("tagDelete")}
                    className="mr-1 rounded p-1 text-muted-foreground opacity-0 hover:text-red-400 group-hover:opacity-100 focus:opacity-100"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            );
          })}
          {visible.length === 0 && !q && (
            <li className="px-2 py-2 text-xs text-muted-foreground">{t("tagEmpty")}</li>
          )}
        </ul>

        {q && !exactExists && (
          <button
            type="button"
            onClick={() => void create()}
            disabled={creating}
            className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-primary hover:bg-muted disabled:opacity-50"
          >
            {creating ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="truncate">{t("tagCreate", { name: query.trim() })}</span>
          </button>
        )}

        <p className="border-t border-border px-1 pt-1.5 text-[11px] text-muted-foreground">
          {isAdmin ? t("tagHintAdmin") : t("tagHintMine")}
        </p>
      </PopoverContent>
    </Popover>
  );
}
