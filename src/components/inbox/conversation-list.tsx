"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  CONVERSATION_SELECT,
  matchesContactFilters,
  normalizeConversations,
} from "@/lib/inbox/conversations";
import { cn } from "@/lib/utils";
import type { Conversation, ConversationStatus, Tag } from "@/types";
import { Search, ChevronDown, X } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { isEmbeddedApp } from "@/lib/mobile-app";

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  /**
   * Increment to force the fetch effect below to refire. The parent
   * bumps this on realtime reconnect / tab visibility → visible so the
   * list catches up on any events sent while the WS was disconnected
   * or the tab was throttled. Optional so existing callers keep working.
   */
  resyncToken?: number;
}

const STATUS_COLORS: Record<ConversationStatus, string> = {
  open: "bg-primary",
  pending: "bg-amber-500",
  closed: "bg-muted-foreground",
};



type InboxFilter = ConversationStatus | "all" | "unread";

/**
 * WhatsApp-style ultra-short relative time ("ahora", "5 min", "2 h",
 * "ayer", "3 d") — embedded only. The full date-fns sentence
 * ("hace alrededor de 6 horas") was long enough to push the row wider
 * than the phone screen, clipping the text at the device edge instead
 * of wrapping or truncating cleanly. Short, fixed-width-ish tokens
 * like this sidestep that regardless of the exact flex behavior.
 */
function formatShortTimeAgo(date: Date): string {
  const diffMin = Math.floor((Date.now() - date.getTime()) / 60000);
  if (diffMin < 1) return "ahora";
  if (diffMin < 60) return `${diffMin} min`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours} h`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return "ayer";
  if (diffDays < 7) return `${diffDays} d`;
  return new Intl.DateTimeFormat("es", { day: "2-digit", month: "2-digit" }).format(date);
}

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
}: ConversationListProps) {
  const t = useTranslations("Inbox.conversationList");
  
  const FILTER_OPTIONS: { label: string; value: InboxFilter }[] = useMemo(() => [
    { label: t("filterAll"), value: "all" },
    { label: t("filterUnread"), value: "unread" },
    { label: t("filterOpen"), value: "open" },
    { label: t("filterPending"), value: "pending" },
    { label: t("filterClosed"), value: "closed" },
  ], [t]);

  // Counts for the embedded filter chips — always computed from the
  // full, unfiltered list so a chip's number doesn't shift or disappear
  // depending on which OTHER chip happens to be active right now.
  const filterCounts: Record<InboxFilter, number> = useMemo(() => ({
    all: conversations.length,
    unread: conversations.filter((c) => c.unread_count > 0).length,
    open: conversations.filter((c) => c.status === "open").length,
    pending: conversations.filter((c) => c.status === "pending").length,
    closed: conversations.filter((c) => c.status === "closed").length,
  }), [conversations]);

  // Only ever true inside the Android wrapper (see message-composer.tsx
  // for the same pattern) — gives the list a more phone-native, card-y
  // look there without changing anything on the real website.
  const [embedded, setEmbedded] = useState(false);
  useEffect(() => {
    setEmbedded(isEmbeddedApp());
  }, []);

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [loading, setLoading] = useState(true);
  // Contact-based filters (issue #272). Tags use OR logic (a conversation
  // matches if its contact carries any selected tag), consistent with
  // Broadcast audience filtering. Company is an exact match on the field.
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);

  // Keep the latest callback in a ref so the fetch effect below can
  // have a stable, empty-dep identity. Previously the fetch useCallback
  // depended on `onConversationsLoaded`, which depends on the parent's
  // `deepLinkConvId` — so every URL change (including one the parent
  // triggered via router.replace after a click) caused a fresh
  // conversations fetch. That extra refetch was the trigger for the
  // deep-link auto-select running a second time and wiping the active
  // thread's messages.
  // Mutation lives in an effect (not render) per React 19's refs rule;
  // the fetch runs once on mount so it's fine to read the slightly
  // older value — the very next render updates the ref for any
  // subsequent async completion.
  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
  });

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select(CONVERSATION_SELECT)
        .order("last_message_at", { ascending: false });

      if (cancelled) return;

      if (error) {
        // Supabase errors have non-enumerable properties — log fields explicitly
        console.error("Failed to fetch conversations:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        setLoading(false);
        return;
      }

      onConversationsLoadedRef.current(normalizeConversations(data ?? []));
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus — catches
    // up on any events sent while the WS was disconnected or throttled.
  }, [resyncToken]);

  // Tag definitions for the filter picker — loaded once so labels/colours
  // stay stable regardless of which conversations happen to be loaded.
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("tags").select("*").order("name");
      if (!cancelled && data) setTags(data as Tag[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Company options are derived from the loaded conversations — there's no
  // separate companies table, and only companies with a live conversation
  // are worth offering as an inbox filter.
  const companies = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) {
      const co = c.contact?.company?.trim();
      if (co) set.add(co);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [conversations]);

  const tagsById = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const t of tags) m.set(t.id, t);
    return m;
  }, [tags]);

  const filtered = useMemo(() => {
    let result = conversations;

    if (filter === "unread") {
      result = result.filter((c) => c.unread_count > 0);
    } else if (filter !== "all") {
      result = result.filter((c) => c.status === filter);
    }

    // Contact-based filters (tags via OR logic, exact company match).
    if (selectedTagIds.length > 0 || selectedCompany !== null) {
      result = result.filter((c) =>
        matchesContactFilters(c, {
          tagIds: selectedTagIds,
          company: selectedCompany,
        })
      );
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? "";
        const phone = c.contact?.phone?.toLowerCase() ?? "";
        const lastMsg = c.last_message_text?.toLowerCase() ?? "";
        return name.includes(q) || phone.includes(q) || lastMsg.includes(q);
      });
    }

    return result;
  }, [conversations, filter, search, selectedTagIds, selectedCompany]);

  const toggleTag = useCallback((id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }, []);

  const clearContactFilters = useCallback(() => {
    setSelectedTagIds([]);
    setSelectedCompany(null);
  }, []);

  const hasContactFilters = selectedTagIds.length > 0 || selectedCompany !== null;

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    []
  );

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
    },
    [onSelect]
  );

  const activeFilter = FILTER_OPTIONS.find((o) => o.value === filter);

  return (
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed 320px on desktop where it shares the
    // row with the thread + contact sidebar.
    <div
      className={cn(
        "flex h-full w-full min-w-0 flex-col border-r border-border lg:w-80",
        // The card rows below are bg-card on an otherwise near-identical
        // bg-background (both ~white in light mode) — with no canvas
        // behind them a "card" has nothing to contrast against and reads
        // as flat/unstyled. A visibly darker muted canvas here is what
        // makes the elevated white cards actually look elevated.
        embedded ? "bg-muted/60" : "bg-card"
      )}
    >
      {/* Search + Filter */}
      <div
        className={cn(
          "space-y-2 border-b border-border p-3",
          embedded && "space-y-3 bg-card pb-3 pt-5"
        )}
      >
        <div className="relative">
          <Search
            className={cn(
              "absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground",
              embedded && "left-4 h-[18px] w-[18px]"
            )}
          />
          <Input
            value={search}
            onChange={handleSearchChange}
            placeholder={t("searchPlaceholder")}
            className={cn(
              "border-border bg-muted pl-9 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50",
              embedded && "h-12 rounded-full bg-muted/80 pl-11 text-[15px]"
            )}
          />
        </div>

        {/* WhatsApp-style scrollable filter chips — embedded only. The
            desktop dropdown below stays untouched for the website. */}
        {embedded && (
          <div className="-mx-3 flex gap-2 overflow-x-auto px-3 pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {FILTER_OPTIONS.map((opt) => {
              const isActiveFilter = filter === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setFilter(opt.value)}
                  className={cn(
                    "shrink-0 whitespace-nowrap rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors",
                    isActiveFilter
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "bg-muted text-muted-foreground active:bg-muted/70"
                  )}
                >
                  {opt.label}
                  <span
                    className={cn(
                      "ml-1.5 tabular-nums",
                      isActiveFilter ? "text-primary-foreground/80" : "text-muted-foreground/70"
                    )}
                  >
                    {filterCounts[opt.value]}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1">
          {/* Replaced by the chip row above when embedded — the tags/
              company filters just below stay available either way. */}
          <DropdownMenu>
            <DropdownMenuTrigger className={cn("inline-flex items-center justify-center h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-muted", embedded && "hidden")}>
                {activeFilter?.label ?? t("filterAll")}
                <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="border-border bg-popover"
            >
              {FILTER_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => setFilter(opt.value)}
                  className={cn(
                    "text-sm",
                    filter === opt.value
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {opt.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {tags.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedTagIds.length > 0
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t("tags")}
                {selectedTagIds.length > 0 && (
                  <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                    {selectedTagIds.length}
                  </span>
                )}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                {tags.map((t) => (
                  <DropdownMenuCheckboxItem
                    key={t.id}
                    checked={selectedTagIds.includes(t.id)}
                    onCheckedChange={() => toggleTag(t.id)}
                    className="text-sm text-popover-foreground"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: t.color }}
                      />
                      <span className="truncate">{t.name}</span>
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {companies.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex max-w-40 items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedCompany
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <span className="truncate">{selectedCompany ?? t("company")}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedCompany(null)}
                  className={cn(
                    "text-sm",
                    selectedCompany === null
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {t("allCompanies")}
                </DropdownMenuItem>
                {companies.map((co) => (
                  <DropdownMenuItem
                    key={co}
                    onClick={() => setSelectedCompany(co)}
                    className={cn(
                      "text-sm",
                      selectedCompany === co
                        ? "text-primary"
                        : "text-popover-foreground"
                    )}
                  >
                    <span className="truncate">{co}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {hasContactFilters && (
          <div className="flex flex-wrap items-center gap-1">
            {selectedTagIds.map((id) => {
              const tag = tagsById.get(id);
              return (
                <button
                  key={id}
                  onClick={() => toggleTag(id)}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: tag?.color ?? "var(--muted-foreground)" }}
                  />
                  <span className="max-w-24 truncate">{tag?.name ?? t("tags")}</span>
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            {selectedCompany && (
              <button
                onClick={() => setSelectedCompany(null)}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
              >
                <span className="max-w-24 truncate">{selectedCompany}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={clearContactFilters}
              className="px-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              {t("clearAll")}
            </button>
          </div>
        )}
      </div>

      {/* Conversation Items.
          `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this ScrollArea grows to fit
          every conversation instead of shrinking to the remaining
          space — the list then overflows and gets clipped by the
          parent's overflow-hidden with no scrollbar (issue #229). */}
      <ScrollArea
        className={cn(
          // The real root cause: as a flex item, ScrollArea's Root
          // defaults to min-width:auto, refusing to shrink below its
          // content's natural width — that demand pushed the whole
          // list wider than the screen (search bar and chips included,
          // since they share this same flex-col parent). min-w-0 lets
          // it actually shrink to the space it's given, which is what
          // keeps both side margins intact like Notificaciones already
          // has.
          "min-h-0 min-w-0 flex-1",
          // @base-ui/react's ScrollArea Viewport hardcodes
          // `style={{ overflow: 'scroll' }}` on BOTH axes as a library
          // default (it's not something our own className controls) —
          // if a row ever computes even a hair wider than the screen,
          // instead of clipping it just becomes reachable by swiping
          // right, which nobody does on a chat list, so it looks like
          // missing/cut-off text. `!` (important) is required to beat
          // that inline style's specificity; targeted at the Viewport
          // via its own data-slot so this can't affect anything else.
          embedded && "[&_[data-slot=scroll-area-viewport]]:overflow-x-hidden!"
        )}
      >
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm text-muted-foreground">{t("noConversations")}</p>
          </div>
        ) : (
          <div className={cn("flex flex-col", embedded && "gap-2 p-3")}>
            {filtered.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                isActive={conv.id === activeConversationId}
                onSelect={handleSelect}
                t={t}
                embedded={embedded}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
  t: ReturnType<typeof useTranslations>;
  embedded?: boolean;
}

function ConversationItem({
  conversation,
  isActive,
  onSelect,
  t,
  embedded = false,
}: ConversationItemProps) {
  const contact = conversation.contact;
  const displayName =
    contact?.name || contact?.phone || contact?.whatsapp_user_id || t("unknown");
  const initials = displayName.charAt(0).toUpperCase();

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

  // date-fns defaults to English with no locale option — fine for the
  // website (untouched here). Inside the app it used the full Spanish
  // sentence, which was long enough to overflow the row — see
  // formatShortTimeAgo above.
  const timeAgo = conversation.last_message_at
    ? embedded
      ? formatShortTimeAgo(new Date(conversation.last_message_at))
      : formatDistanceToNow(new Date(conversation.last_message_at), {
          addSuffix: false,
        })
    : "";

  const avatarSize = embedded ? "h-12 w-12" : "h-10 w-10";
  const hasUnread = conversation.unread_count > 0;

  return (
    <button
      onClick={handleClick}
      className={cn(
        "flex w-full min-w-0 items-start gap-3 text-left transition-colors",
        embedded
          ? cn(
              "min-h-[68px] rounded-2xl border p-3.5 shadow-md active:shadow-sm",
              isActive
                ? "border-primary/40 bg-primary/5"
                : hasUnread
                  // Same accent as the unread badge/dot below, just at a
                  // much lower opacity — makes an unread row readable at
                  // a glance instead of only via the small dot.
                  ? "border-primary/20 bg-primary/[0.06] active:bg-muted/40"
                  : "border-border/40 bg-card active:bg-muted/40"
            )
          : cn(
              "px-3 py-3 hover:bg-muted/50",
              isActive && "border-l-2 border-primary bg-muted/70"
            )
      )}
    >
      {/* Avatar */}
      <div
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full text-sm font-medium",
          avatarSize,
          embedded ? "bg-primary/15 text-primary" : "bg-muted text-foreground"
        )}
      >
        {contact?.avatar_url ? (
          <img
            src={contact.avatar_url}
            alt={displayName}
            className={cn("rounded-full object-cover", avatarSize)}
          />
        ) : (
          initials
        )}
      </div>

      {/* Content — overflow-hidden on this and both inner rows is a
          hard backstop: min-w-0/truncate on the individual name and
          message spans should already be enough, but this guarantees
          neither row can ever force its own box wider than what the
          flex layout allocated it, whatever the exact cause was. */}
      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="flex items-center justify-between gap-2 overflow-hidden">
          <span
            className={cn(
              "min-w-0 truncate text-foreground",
              embedded ? "text-[15px] font-semibold" : "text-sm font-medium"
            )}
          >
            {displayName}
          </span>
          <span
            className={cn(
              "shrink-0 whitespace-nowrap leading-none text-muted-foreground",
              embedded ? "text-[11px] text-muted-foreground/70" : "text-[10px]"
            )}
          >
            {timeAgo}
          </span>
        </div>
        <div className={cn("flex items-center justify-between gap-2 overflow-hidden", embedded ? "mt-1" : "mt-0.5")}>
          <p
            className={cn(
              "min-w-0 truncate text-muted-foreground",
              embedded ? "text-[13px] text-muted-foreground/80" : "text-xs"
            )}
          >
            {conversation.last_message_text || t("noMessagesYet")}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {hasUnread && (
              <span
                className={cn(
                  "flex items-center justify-center rounded-full bg-primary font-bold text-primary-foreground",
                  // A touch bigger and a light ring (matching the card
                  // background) so it reads as a distinct badge instead
                  // of blending into the timestamp/status-dot cluster —
                  // it was barely legible at the old 18px/no-border size.
                  embedded
                    ? "h-5 min-w-5 px-1.5 text-xs shadow-sm ring-2 ring-card"
                    : "h-4 min-w-4 px-1 text-[10px]"
                )}
              >
                {conversation.unread_count}
              </span>
            )}
            <span
              className={cn(
                "shrink-0 rounded-full",
                embedded ? "h-2.5 w-2.5" : "h-2 w-2",
                STATUS_COLORS[conversation.status]
              )}
              title={conversation.status}
            />
          </div>
        </div>
      </div>
    </button>
  );
}
