"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { createClient } from "@/lib/supabase/client";
import { TAGS_CHANGED_EVENT } from "@/lib/contact-events";
import { CONTACT_TAGS_CHANGED_EVENT } from "@/lib/inbox/conversations";
import type { Tag } from "@/types";
import { ContactTagPicker } from "./contact-tag-picker";

/**
 * Phone app (Android wrapper) chat header: the contact's tags as one
 * horizontally scrolling row + a "+ Etiqueta" pill to add or create one
 * — in place of the status dropdown, which advisors on the phone never
 * used. Same writes as the contact panel's tag section
 * (contact-sidebar.tsx), and both stay in sync through
 * CONTACT_TAGS_CHANGED_EVENT.
 *
 * Kept light for low-end phones: two small queries per contact, no
 * realtime channel, no blur/shadows.
 */
export function MobileThreadTags({ contactId }: { contactId: string }) {
  const t = useTranslations("Inbox.sidebar");
  const [tags, setTags] = useState<Tag[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    const load = async () => {
      const { data } = await supabase.from("tags").select("*").order("name");
      if (!cancelled && data) setAllTags(data as Tag[]);
    };
    void load();
    window.addEventListener(TAGS_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(TAGS_CHANGED_EVENT, load);
    };
  }, []);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    void supabase
      .from("contact_tags")
      .select("tags(*)")
      .eq("contact_id", contactId)
      .then(({ data }) => {
        if (cancelled || !data) return;
        setTags(
          (data as { tags: Tag | Tag[] | null }[])
            .flatMap((row) => (Array.isArray(row.tags) ? row.tags : row.tags ? [row.tags] : []))
            .sort((a, b) => a.name.localeCompare(b.name)),
        );
      });
    // The contact panel (or another surface) changed this contact's tags.
    const onChanged = (e: Event) => {
      const detail = (e as CustomEvent<{ contactId: string; tags: Tag[] }>).detail;
      if (detail?.contactId === contactId) setTags(detail.tags);
    };
    window.addEventListener(CONTACT_TAGS_CHANGED_EVENT, onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(CONTACT_TAGS_CHANGED_EVENT, onChanged);
    };
  }, [contactId]);

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
        console.error("[MobileThreadTags] toggle failed:", error);
        toast.error(t("tagUpdateFailed"));
        setTags(tags);
        publish(tags);
      }
    },
    [contactId, tags, publish, t],
  );

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <ContactTagPicker
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
        align="start"
        triggerClassName="inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-white px-2.5 text-[11px] font-bold text-[var(--header-bg)]"
        triggerContent={
          <>
            <Plus className="h-3.5 w-3.5" />
            {t("tagShort")}
          </>
        }
      />
      {/* One row that scrolls sideways — never wraps, never truncates. */}
      <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tags.map((tag) => (
          <span
            key={tag.id}
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-white/20 px-2.5 text-[11px] font-semibold whitespace-nowrap text-white"
          >
            <span className="size-2 shrink-0 rounded-full" style={{ background: tag.color }} />
            {tag.name}
          </span>
        ))}
      </div>
    </div>
  );
}
