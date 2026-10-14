"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { createClient } from "@/lib/supabase/client";
import { TAGS_CHANGED_EVENT } from "@/lib/contact-events";
import { CONTACT_TAGS_CHANGED_EVENT } from "@/lib/inbox/conversations";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Tag } from "@/types";
import { TagPickerPanel } from "./contact-tag-picker";

interface ConversationTagsDialogProps {
  contactId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Opened from the right-click / long-press menu of a conversation row:
 * toggle the contact's tags or create a new one without opening the
 * chat. Same writes as the contact panel and MobileThreadTags, and it
 * announces changes through CONTACT_TAGS_CHANGED_EVENT so the rows and
 * any open panel stay in sync. Only mounted content loads data, so
 * closed rows cost nothing.
 */
export function ConversationTagsDialog({
  contactId,
  open,
  onOpenChange,
}: ConversationTagsDialogProps) {
  const t = useTranslations("Inbox.sidebar");
  const [tags, setTags] = useState<Tag[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);

  useEffect(() => {
    if (!open) return;
    const supabase = createClient();
    let cancelled = false;
    const load = async () => {
      const { data } = await supabase.from("tags").select("*").order("name");
      if (!cancelled && data) setAllTags(data as Tag[]);
    };
    void load();
    void supabase
      .from("contact_tags")
      .select("tags(*)")
      .eq("contact_id", contactId)
      .then(({ data }) => {
        if (cancelled || !data) return;
        setTags(
          (data as { tags: Tag | Tag[] | null }[]).flatMap((row) =>
            Array.isArray(row.tags) ? row.tags : row.tags ? [row.tags] : [],
          ),
        );
      });
    window.addEventListener(TAGS_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(TAGS_CHANGED_EVENT, load);
    };
  }, [open, contactId]);

  const publish = useCallback(
    (next: Tag[]) => {
      window.dispatchEvent(
        new CustomEvent(CONTACT_TAGS_CHANGED_EVENT, { detail: { contactId, tags: next } }),
      );
    },
    [contactId],
  );

  const handleToggle = useCallback(
    async (tag: Tag) => {
      const supabase = createClient();
      const has = tags.some((x) => x.id === tag.id);
      const next = has ? tags.filter((x) => x.id !== tag.id) : [...tags, tag];
      // Optimistic; roll back on failure.
      setTags(next);
      publish(next);
      const { error } = has
        ? await supabase.from("contact_tags").delete().eq("contact_id", contactId).eq("tag_id", tag.id)
        : await supabase.from("contact_tags").insert({ contact_id: contactId, tag_id: tag.id });
      if (error) {
        console.error("[ConversationTagsDialog] toggle failed:", error);
        toast.error(t("tagUpdateFailed"));
        setTags(tags);
        publish(tags);
      }
    },
    [contactId, tags, publish, t],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm gap-2">
        <DialogHeader>
          <DialogTitle>{t("tagAdd")}</DialogTitle>
        </DialogHeader>
        <TagPickerPanel
          allTags={allTags}
          selectedIds={new Set(tags.map((x) => x.id))}
          onToggle={handleToggle}
          onCreated={(tag) => {
            setAllTags((prev) => [...prev, tag].sort((a, b) => a.name.localeCompare(b.name)));
            void handleToggle(tag);
          }}
          onDeleted={(tagId) => {
            setAllTags((prev) => prev.filter((x) => x.id !== tagId));
            setTags((prev) => prev.filter((x) => x.id !== tagId));
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
