"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { CONTACT_DATA_CHANGED_EVENT, TAGS_CHANGED_EVENT } from "@/lib/contact-events";
import type { Contact, Deal, ContactNote, Tag, ConversationReferral } from "@/types";
import {
  Phone,
  Mail,
  Copy,
  Check,
  User,
  Tag as TagIcon,
  DollarSign,
  StickyNote,
  Plus,
  Megaphone,
  X,
  ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { format } from "date-fns";
import { ContactTagPicker } from "./contact-tag-picker";
import { useTranslations } from "next-intl";

interface ContactSidebarProps {
  contact: Contact | null;
  /** Referrals are per-conversation (a contact can have several
   *  conversations, e.g. across numbers), so this drives the ad-source
   *  lookup separately from `contact`. */
  conversationId?: string | null;
}

export function ContactSidebar({ contact, conversationId }: ContactSidebarProps) {
  const tSidebar = useTranslations("Inbox.sidebar");
  const tThread = useTranslations("Inbox.messageThread");

  const { accountId } = useAuth();
  const [copied, setCopied] = useState(false);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [tags, setTags] = useState<(Tag & { contact_tag_id: string })[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [referrals, setReferrals] = useState<ConversationReferral[]>([]);
  // Collapses only the ad's own headline/body per referral card — the
  // ad id and date/time below stay visible either way (see the JSX).
  const [collapsedReferralIds, setCollapsedReferralIds] = useState<Set<string>>(new Set());
  const [newNote, setNewNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);

  // Every tag defined for the account — powers the "add tag" picker below
  // (issue: agents previously had to leave the conversation and go to
  // Contacts to tag someone). Loaded once; doesn't depend on `contact`.
  // Reloaded on TAGS_CHANGED_EVENT so a tag created/deleted in another
  // open panel (e.g. the phone slide-over) shows up here too.
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

  const fetchContactData = useCallback(async () => {
    if (!contact) return;

    const supabase = createClient();

    // Fetch deals, notes, and tags in parallel
    const [dealsRes, notesRes, tagsRes] = await Promise.all([
      supabase
        .from("deals")
        .select("*, stage:pipeline_stages(*)")
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("contact_notes")
        .select("*")
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("contact_tags")
        .select("id, tag_id, tags(*)")
        .eq("contact_id", contact.id),
    ]);

    if (dealsRes.data) setDeals(dealsRes.data);
    if (notesRes.data) setNotes(notesRes.data);
    if (tagsRes.data) {
      const mapped = tagsRes.data
        .filter((ct: Record<string, unknown>) => ct.tags)
        .map((ct: Record<string, unknown>) => ({
          ...(ct.tags as Tag),
          contact_tag_id: ct.id as string,
        }));
      setTags(mapped);
    }
  }, [contact]);

  // Load on contact change. setContactData/setTags run inside async
  // Supabase callbacks, not synchronously in the effect body.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchContactData();
  }, [fetchContactData]);

  // Actions elsewhere in the thread that write contact data server-side
  // (e.g. "Derivar a otra línea" leaving a note) announce it so the
  // panel refreshes without a page reload.
  useEffect(() => {
    const refresh = () => void fetchContactData();
    window.addEventListener(CONTACT_DATA_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(CONTACT_DATA_CHANGED_EVENT, refresh);
  }, [fetchContactData]);

  // Ad attribution is keyed by conversation, not contact — separate
  // effect so switching conversations for the same contact re-fetches.
  useEffect(() => {
    if (!conversationId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setReferrals([]);
      return;
    }
    const supabase = createClient();
    supabase
      .from("conversation_referrals")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .then(({ data }) => setReferrals(data ?? []));
  }, [conversationId]);

  const toggleReferralCollapsed = useCallback((referralId: string) => {
    setCollapsedReferralIds((prev) => {
      const next = new Set(prev);
      if (next.has(referralId)) next.delete(referralId);
      else next.add(referralId);
      return next;
    });
  }, []);

  const handleCopyPhone = useCallback(async () => {
    if (!contact?.phone) return;
    // Copy just the 9-digit local number, without Peru's "51" country
    // code — agents/ATC paste this into systems that expect the bare
    // number. The displayed text above is untouched; only the
    // clipboard value changes. Only strips it for the exact
    // "51" + 9-digit shape so a differently-formatted number (a
    // landline, or some future non-Peru contact) is copied as-is.
    const toCopy =
      contact.phone.startsWith('51') && contact.phone.length === 11
        ? contact.phone.slice(2)
        : contact.phone;
    await navigator.clipboard.writeText(toCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    // Dep is the whole `contact` object (not `contact?.phone`) so the
    // React Compiler's inference agrees with the manual dep list —
    // fixes the `preserve-manual-memoization` lint error.
  }, [contact]);

  const handleAddNote = useCallback(async () => {
    if (!contact || !newNote.trim()) return;
    if (!accountId) return;
    setAddingNote(true);

    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;

    const { data, error } = await supabase
      .from("contact_notes")
      .insert({
        contact_id: contact.id,
        account_id: accountId,
        user_id: user?.id,
        note_text: newNote.trim(),
      })
      .select()
      .single();

    if (!error && data) {
      setNotes((prev) => [data, ...prev]);
      setNewNote("");
    }
    setAddingNote(false);
  }, [contact, newNote, accountId]);

  // Toggle a tag on the currently-open contact, right from the inbox —
  // no more leaving the conversation to go tag someone in Contacts.
  // `contact_tags` has no account/user column (migration 001), so the
  // insert/delete only need contact_id + tag_id.
  const handleToggleTag = useCallback(
    async (tag: Tag) => {
      if (!contact) return;
      const supabase = createClient();
      const existing = tags.find((t) => t.id === tag.id);

      if (existing) {
        // Optimistic remove, roll back on failure.
        setTags((prev) => prev.filter((t) => t.id !== tag.id));
        const { error } = await supabase
          .from("contact_tags")
          .delete()
          .eq("id", existing.contact_tag_id);
        if (error) {
          console.error("Failed to remove tag:", error);
          setTags((prev) => [...prev, existing]);
        }
        return;
      }

      const { data, error } = await supabase
        .from("contact_tags")
        .insert({ contact_id: contact.id, tag_id: tag.id })
        .select("id")
        .single();
      if (error) {
        console.error("Failed to add tag:", error);
        return;
      }
      setTags((prev) => [...prev, { ...tag, contact_tag_id: data.id as string }]);
    },
    [contact, tags]
  );

  if (!contact) {
    return (
      <div className="flex h-full w-70 items-center justify-center border-l border-border bg-card">
        <p className="text-sm text-muted-foreground">{tThread("selectConversation")}</p>
      </div>
    );
  }

  const displayName =
    contact.name || contact.phone || contact.whatsapp_user_id || 'Unknown';
  const initials = displayName.charAt(0).toUpperCase();

  return (
    <div className="flex h-full w-70 flex-col border-l border-border bg-card">
      {/* min-h-0: without it the flex child grows to fit its content, so
          a long note pushed the panel past the screen with no scrollbar. */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-4">
          {/* Contact Info */}
          <div className="flex flex-col items-center text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted text-lg font-semibold text-foreground">
              {contact.avatar_url ? (
                <img
                  src={contact.avatar_url}
                  alt={displayName}
                  className="h-16 w-16 rounded-full object-cover"
                />
              ) : (
                initials
              )}
            </div>
            <h3 className="mt-3 text-sm font-semibold text-foreground">
              {displayName}
            </h3>
            {contact.company && (
              <p className="text-xs text-muted-foreground">{contact.company}</p>
            )}
          </div>

          {/* Phone */}
          <div className="mt-4 space-y-2">
            {contact.phone ? (
              <button
                onClick={handleCopyPhone}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted"
              >
                <Phone className="h-4 w-4 text-muted-foreground" />
                <span className="flex-1 text-left">{contact.phone}</span>
                {copied ? (
                  <Check className="h-3 w-3 text-primary" />
                ) : (
                  <Copy className="h-3 w-3 text-muted-foreground" />
                )}
              </button>
            ) : (
              // BSUID-only contact (migration 042) — no phone on file yet.
              // Not clickable: there's nothing to copy.
              <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground">
                <Phone className="h-4 w-4 text-muted-foreground" />
                <span className="flex-1 text-left italic">
                  {contact.whatsapp_username
                    ? `@${contact.whatsapp_username}`
                    : tSidebar("noPhoneNumber")}
                </span>
              </div>
            )}

            {contact.email && (
              <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <span className="truncate">{contact.email}</span>
              </div>
            )}
          </div>

          {/* Ad attribution (CTWA referral) */}
          {referrals.length > 0 && (
            <>
              <div className="my-4 border-t border-border" />
              <div>
                <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  <Megaphone className="h-3 w-3" />
                  {tSidebar("adSource")}
                </div>
                <div className="mt-2 space-y-2">
                  {referrals.map((referral) => {
                    const hasAdContent = Boolean(referral.headline || referral.body);
                    const isCollapsed = collapsedReferralIds.has(referral.id);
                    return (
                      <div key={referral.id} className="rounded-lg bg-muted px-3 py-2">
                        {hasAdContent && (
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              {!isCollapsed && referral.headline && (
                                <p className="text-sm font-medium text-foreground">
                                  {referral.headline}
                                </p>
                              )}
                              {!isCollapsed && referral.body && (
                                <p className="mt-0.5 text-xs text-muted-foreground">
                                  {referral.body}
                                </p>
                              )}
                            </div>
                            <button
                              type="button"
                              onClick={() => toggleReferralCollapsed(referral.id)}
                              aria-label={isCollapsed ? tSidebar("expandAd") : tSidebar("collapseAd")}
                              className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-black/10 hover:text-foreground"
                            >
                              <ChevronDown
                                className={cn(
                                  "h-3.5 w-3.5 transition-transform",
                                  isCollapsed && "-rotate-90"
                                )}
                              />
                            </button>
                          </div>
                        )}
                        {/* Ad id and date/time stay visible regardless of
                            the collapse state above — only the headline/
                            body (the ad's own text) collapses. */}
                        {referral.source_id && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {tSidebar("adId")}: {referral.source_id}
                          </p>
                        )}
                        <div className="mt-1 flex items-center justify-between gap-2">
                          <p className="text-xs text-muted-foreground">
                            {format(new Date(referral.created_at), "MMM d, yyyy HH:mm")}
                          </p>
                          {referral.source_url && (
                            <a
                              href={referral.source_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs font-medium text-primary hover:underline"
                            >
                              {tSidebar("viewAd")}
                            </a>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Tags */}
          <div>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <TagIcon className="h-3 w-3" />
                {tSidebar("tags")}
              </div>
              <ContactTagPicker
                allTags={allTags}
                selectedIds={new Set(tags.map((t) => t.id))}
                onToggle={handleToggleTag}
                onCreated={(tag) => {
                  setAllTags((prev) =>
                    [...prev, tag].sort((a, b) => a.name.localeCompare(b.name)),
                  );
                  void handleToggleTag(tag);
                }}
                onDeleted={(tagId) => {
                  setAllTags((prev) => prev.filter((t) => t.id !== tagId));
                  setTags((prev) => prev.filter((t) => t.id !== tagId));
                }}
              />
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {tags.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">{tSidebar("noTags")}</p>
              ) : (
                tags.map((tag) => (
                  <span
                    key={tag.contact_tag_id}
                    className="inline-flex items-center gap-1 rounded-full py-0.5 pl-2 pr-1 text-[10px] font-medium"
                    style={{
                      backgroundColor: `${tag.color}20`,
                      color: tag.color,
                    }}
                  >
                    {tag.name}
                    <button
                      onClick={() => handleToggleTag(tag)}
                      aria-label={tSidebar("removeTag")}
                      className="rounded-full p-0.5 hover:bg-black/10"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </span>
                ))
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Active Deals */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <DollarSign className="h-3 w-3" />
              {tSidebar("deals")}
            </div>
            <div className="mt-2 space-y-2">
              {deals.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">{tSidebar("noDeals")}</p>
              ) : (
                deals.map((deal) => (
                  <div
                    key={deal.id}
                    className="rounded-lg bg-muted px-3 py-2"
                  >
                    <p className="text-sm font-medium text-foreground">
                      {deal.title}
                    </p>
                    <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        {deal.currency ?? "$"}
                        {deal.value.toLocaleString()}
                      </span>
                      {deal.stage && (
                        <span
                          className="rounded-full px-1.5 py-0.5 text-[10px]"
                          style={{
                            backgroundColor: `${deal.stage.color}20`,
                            color: deal.stage.color,
                          }}
                        >
                          {deal.stage.name}
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Notes */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <StickyNote className="h-3 w-3" />
              {tSidebar("notes")}
            </div>
            <div className="mt-2">
              <div className="flex gap-2">
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder={tSidebar("addNotePlaceholder")}
                  rows={2}
                  className="flex-1 resize-none rounded-lg border border-border bg-muted px-3 py-2 text-xs text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
                />
                <Button
                  size="sm"
                  className="h-auto bg-primary px-2 hover:bg-primary/90"
                  onClick={handleAddNote}
                  disabled={!newNote.trim() || addingNote}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>

              <div className="mt-2 space-y-2">
                {notes.map((note) => (
                  <NoteItem key={note.id} note={note} />
                ))}
              </div>
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

/**
 * One contact note. Multi-line notes (e.g. a line transfer's handover
 * with the whole chat history) start collapsed to their first line —
 * "🔀 Derivado desde … — tema: …" — and expand on click.
 */
function NoteItem({ note }: { note: ContactNote }) {
  const [expanded, setExpanded] = useState(false);
  const [firstLine, ...rest] = note.note_text.split("\n");
  const collapsible = rest.some((line) => line.trim());
  const body = (
    <>
      <p className="whitespace-pre-wrap text-xs text-muted-foreground">
        {collapsible && !expanded ? firstLine : note.note_text}
      </p>
      <p className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
        {format(new Date(note.created_at), "MMM d, yyyy HH:mm")}
        {collapsible && (
          <span className="ml-auto inline-flex items-center gap-0.5 font-medium text-primary">
            {expanded ? "Ocultar" : "Ver historial"}
            <ChevronDown className={cn("h-3 w-3 transition-transform", expanded && "rotate-180")} />
          </span>
        )}
      </p>
    </>
  );
  if (!collapsible) {
    return <div className="rounded-lg bg-muted px-3 py-2">{body}</div>;
  }
  return (
    <button
      type="button"
      onClick={() => setExpanded((v) => !v)}
      aria-expanded={expanded}
      className="block w-full rounded-lg bg-muted px-3 py-2 text-left transition-colors hover:bg-muted/70"
    >
      {body}
    </button>
  );
}
