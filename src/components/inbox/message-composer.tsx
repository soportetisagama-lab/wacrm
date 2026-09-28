"use client";

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  KeyboardEvent,
  type ClipboardEvent,
  type PointerEvent as ReactPointerEvent,
  type Ref,
} from "react";
import {
  Send,
  LayoutTemplate,
  Paperclip,
  Image as ImageIcon,
  Video,
  FileText,
  Mic,
  Trash2,
  ChevronLeft,
  X,
  Loader2,
  Sparkles,
  Plus,
  MessageSquareDashed,
  MessageSquare,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { GatedButton } from "@/components/ui/gated-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCan } from "@/hooks/use-can";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  uploadAccountMedia,
  deleteAccountMedia,
  MEDIA_MAX_BYTES_BY_KIND,
} from "@/lib/storage/upload-media";
import { ReplyQuote } from "./reply-quote";
import { useTranslations } from "next-intl";
import {
  InteractiveBuilder,
  blankButtonsPayload,
} from "@/components/interactive/interactive-builder";
import {
  interactivePayloadPreviewText,
  validateInteractivePayload,
} from "@/lib/whatsapp/interactive";
import {
  findSlashToken,
  matchSlashQuickReplies,
  replaceSlashToken,
  type SlashToken,
} from "@/lib/inbox/slash-quick-replies";
import type { InteractiveMessagePayload, QuickReply } from "@/types";
import { QuickReplyPicker } from "./quick-reply-picker";
import { isEmbeddedApp } from "@/lib/mobile-app";

/** Media content types an agent can send from the composer. */
export type ComposerMediaKind = "image" | "video" | "document" | "audio";

/** Supabase Storage bucket holding agent-sent chat attachments (migration 023). */
export const CHAT_MEDIA_BUCKET = "chat-media";

/** Meta caps media captions at 1024 chars. Enforced here and in the send route. */
export const MEDIA_CAPTION_MAX = 1024;

/** Hard cap on a single voice recording so it can't blow the upload/
 *  transcode limits — auto-stops the recorder when reached. */
const MAX_RECORDING_SECONDS = 5 * 60;

/** Press-and-hold (touch): how far left the finger slides to cancel. */
const CANCEL_SLIDE_PX = 110;

/** Press-and-hold (touch): a tap shorter than this isn't a voice note —
 *  it's discarded with a "hold to record" hint, like WhatsApp. */
const MIN_HOLD_MS = 600;

/** How the current recording was started. `toggle` = mouse (click to
 *  start, click the send button to finish); `hold` = touch (record while
 *  pressed, release to send, slide left to cancel). */
type RecordMode = "toggle" | "hold";

export interface SendMediaPayload {
  kind: ComposerMediaKind;
  /** Public chat-media URL Meta fetches at send time. */
  mediaUrl: string;
  /** Storage object path — lets the caller GC the object if the send fails. */
  path: string;
  /** Optional caption (image/video/document only). */
  caption?: string;
  /** Original file name — surfaced to the recipient for documents. */
  filename?: string;
  replyToId?: string;
}

interface ReplyDraft {
  /** Internal UUID of the message being replied to — sent back through onSend. */
  id: string;
  authorLabel: string;
  preview: string;
}

// Mirrors the chat-media bucket's allowed_mime_types (migration 023) for
// the file picker so unsupported files are rejected before upload rather
// than failing with a confusing Storage error. Audio has no picker — it's
// captured via the recorder.
const PICKER_ACCEPT: Record<"image" | "video" | "document", string> = {
  image: "image/png,image/jpeg,image/webp",
  video: "video/mp4,video/3gpp",
  document:
    "application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain",
};

// Extension fallback for dropped/pasted files whose MIME type the OS
// left blank (common for Office files on some Windows setups).
const DOCUMENT_MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
};

/** Map a dropped/pasted file onto a composer media kind, or null when
 *  the chat-media bucket wouldn't accept it. */
function kindForFile(file: File): "image" | "video" | "document" | null {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const type = file.type || DOCUMENT_MIME_BY_EXT[ext] || "";
  if (!type) return null;
  for (const kind of ["image", "video", "document"] as const) {
    if (PICKER_ACCEPT[kind].split(",").includes(type)) return kind;
  }
  return null;
}

/** Imperative handle so the thread can hand the composer a file dropped
 *  anywhere on the conversation, not just on the composer itself. */
export interface MessageComposerHandle {
  attachFile: (file: File) => void;
}

interface MediaDraft {
  kind: ComposerMediaKind;
  mediaUrl: string;
  /** Storage path — used to GC the object if the draft is discarded. */
  path: string;
  filename: string;
  caption: string;
}

interface MessageComposerProps {
  conversationId: string;
  sessionExpired: boolean;
  /** No customer message yet (we opened with a template) — shown
   *  instead of the "session expired" wording; sending stays limited to
   *  templates either way. */
  awaitingCustomer?: boolean;
  onSend: (text: string, replyToId?: string) => void;
  onSendMedia: (payload: SendMediaPayload) => void;
  onSendInteractive: (payload: InteractiveMessagePayload, replyToId?: string) => void;
  onOpenTemplates: () => void;
  replyTo?: ReplyDraft | null;
  onClearReply?: () => void;
  ref?: Ref<MessageComposerHandle>;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Worker that encodes mic input to Ogg/Opus entirely in the browser
 *  (vendored from opus-recorder into /public). Recording client-side in a
 *  Meta-accepted format means no server ffmpeg / transcode step. */
const OPUS_ENCODER_PATH = "/opus/encoderWorker.min.js";

export function MessageComposer({
  conversationId,
  sessionExpired,
  awaitingCustomer = false,
  onSend,
  onSendMedia,
  onSendInteractive,
  onOpenTemplates,
  replyTo,
  onClearReply,
  ref,
}: MessageComposerProps) {
  const t = useTranslations("Inbox.composer");

  // Collapses the 4 action buttons into 1 and hides the Shift+Enter
  // hint — but ONLY inside our own Android WebView wrapper, never for
  // a real browser at a narrow width. Deliberately not a `sm:` CSS
  // breakpoint: this composer is also reachable from a phone's actual
  // mobile browser, and that experience must stay exactly as it was
  // — the collapse is an app-specific choice, not a "phone" one. Set
  // once on mount, same SSR-safe pattern as dashboard-shell.tsx.
  const [embedded, setEmbedded] = useState(false);
  useEffect(() => {
    setEmbedded(isEmbeddedApp());
  }, []);

  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Interactive-message builder dialog + quick-reply picker.
  const [interactiveOpen, setInteractiveOpen] = useState(false);
  const [interactivePayload, setInteractivePayload] =
    useState<InteractiveMessagePayload>(blankButtonsPayload);
  const [savingQuickReply, setSavingQuickReply] = useState(false);
  const [quickReplyOpen, setQuickReplyOpen] = useState(false);
  // Remounts the picker on each open so `initialCreateTitle` (the "/"
  // shortcut's "Crear «…»") is read fresh.
  const [pickerKey, setPickerKey] = useState(0);
  const [pickerCreateTitle, setPickerCreateTitle] = useState<string | null>(null);

  // "/" shortcut — "/nombre" at the caret lists matching quick replies
  // right above the composer (see lib/inbox/slash-quick-replies).
  // Replies are fetched on the first "/" and refetched after the
  // picker closes, since it may have created or edited some.
  const [slashToken, setSlashToken] = useState<SlashToken | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashReplies, setSlashReplies] = useState<QuickReply[] | null>(null);
  const slashLoadingRef = useRef(false);

  // Media attachment state. `draft` holds an uploaded-but-not-yet-sent
  // attachment; `busy` covers the upload/transcode window.
  const [draft, setDraft] = useState<MediaDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);
  // Mirror of `draft` for the unmount cleanup, which can't read render
  // state. Kept in sync below so navigating away with a staged-but-unsent
  // attachment GCs the orphaned object.
  const draftRef = useRef<MediaDraft | null>(null);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  // Best-effort GC of a staged object the user never sent. Fire-and-forget.
  const removeStaged = useCallback((path: string | undefined) => {
    if (!path) return;
    void deleteAccountMedia(CHAT_MEDIA_BUCKET, path).catch(() => {});
  }, []);

  // Voice recording state. The recorder encodes Ogg/Opus in-browser
  // (opus-recorder) so there's no server-side transcode.
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recorderRef = useRef<import("opus-recorder").default | null>(null);
  const cancelledRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // WhatsApp-style mic button: see RecordMode. The ref mirrors are read
  // from pointer handlers that can fire before React re-renders.
  const [recordMode, setRecordMode] = useState<RecordMode | null>(null);
  const recordModeRef = useRef<RecordMode | null>(null);
  const recordingRef = useRef(false);
  const recordStartedAtRef = useRef(0);
  // Finger lifted while the mic was still starting (permission prompt,
  // encoder load) — the start is aborted as soon as it resolves.
  const releasedEarlyRef = useRef(false);
  const holdStartXRef = useRef(0);
  const [slideX, setSlideX] = useState(0);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);

  // Viewers (read-only role) can browse the inbox but never send.
  // For solo users this is always true — single-owner accounts pass
  // every capability — so the disabled branch is a no-op there.
  const canSend = useCan("send-messages");
  const readOnly = !canSend;
  // Templates (the only way back in after the 24h window) are ATC and
  // above — an agent (asesor) never sees the template buttons.
  const canTemplates = useCan("send-templates");
  // Media (like free-form text) is only allowed inside the 24h window.
  const inputsDisabled = readOnly || sessionExpired;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Tear down any live recording + timer on unmount so a mid-record
  // navigation doesn't leak the mic, and GC a staged-but-unsent
  // attachment so it doesn't orphan in the bucket.
  useEffect(() => {
    return () => {
      clearTimer();
      cancelledRef.current = true;
      // stop() releases the mic stream + audio context inside opus-recorder.
      void recorderRef.current?.stop().catch(() => {});
      removeStaged(draftRef.current?.path);
    };
  }, [clearTimer, removeStaged]);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    // Max 4 lines (~96px)
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending || sessionExpired) return;

    setSending(true);
    try {
      onSend(trimmed, replyTo?.id);
      setText("");
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    } finally {
      setSending(false);
    }
  }, [text, sending, sessionExpired, onSend, replyTo?.id]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const loadSlashReplies = useCallback(async () => {
    if (slashLoadingRef.current) return;
    slashLoadingRef.current = true;
    try {
      const res = await fetch("/api/quick-replies", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      setSlashReplies(res.ok ? ((data.quick_replies as QuickReply[]) ?? []) : []);
    } catch {
      setSlashReplies([]);
    } finally {
      slashLoadingRef.current = false;
    }
  }, []);

  // Re-derive the "/…" token from the text + caret. Keeps the same
  // object when nothing changed so the highlighted row stays put.
  const syncSlashToken = useCallback(
    (value: string, caret: number) => {
      const token = findSlashToken(value, caret);
      setSlashToken((prev) =>
        prev && token && prev.start === token.start && prev.end === token.end
          ? prev
          : token,
      );
      if (token && slashReplies === null) void loadSlashReplies();
    },
    [slashReplies, loadSlashReplies],
  );

  const slashMatches = useMemo(
    () =>
      slashToken && slashReplies
        ? matchSlashQuickReplies(slashReplies, slashToken.query)
        : [],
    [slashToken, slashReplies],
  );
  const slashOpen = slashToken !== null && !readOnly && !sessionExpired;

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setText(e.target.value);
      adjustHeight();
      setSlashIndex(0);
      syncSlashToken(e.target.value, e.target.selectionStart ?? e.target.value.length);
    },
    [adjustHeight, syncSlashToken]
  );

  // Ask the AI assistant for a suggested reply and drop it into the
  // composer for the agent to edit + send. Read-only server-side —
  // nothing is sent until the agent hits Send.
  const handleDraft = useCallback(async () => {
    if (drafting) return;
    setDrafting(true);
    try {
      const res = await fetch("/api/ai/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: conversationId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.code === "ai_not_configured") {
          toast.error(t("aiNotConfigured"));
        } else {
          toast.error(data.error ?? t("draftFailedGeneric"));
        }
        return;
      }
      const draftText = typeof data.draft === "string" ? data.draft.trim() : "";
      if (!draftText) {
        toast.error(t("draftEmpty"));
        return;
      }
      setText(draftText);
      // Let the textarea grow to fit and drop the cursor at the end so
      // the agent can tweak immediately.
      requestAnimationFrame(() => {
        adjustHeight();
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
    } catch {
      toast.error(t("aiUnreachable"));
    } finally {
      setDrafting(false);
    }
  }, [drafting, conversationId, adjustHeight, t]);

  // ---- Interactive message + quick replies --------------------------

  const openInteractiveBuilder = useCallback(
    (seed?: InteractiveMessagePayload) => {
      setInteractivePayload(seed ?? blankButtonsPayload());
      setInteractiveOpen(true);
    },
    [],
  );

  const sendInteractive = useCallback(() => {
    const result = validateInteractivePayload(interactivePayload);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    onSendInteractive(interactivePayload, replyTo?.id);
    setInteractiveOpen(false);
    onClearReply?.();
  }, [interactivePayload, onSendInteractive, replyTo?.id, onClearReply]);

  // Persist the current builder payload as a reusable interactive snippet.
  const saveAsQuickReply = useCallback(async () => {
    const result = validateInteractivePayload(interactivePayload);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    const title = window
      .prompt(t("quickReplyNamePrompt"))
      ?.trim();
    if (!title) return;
    setSavingQuickReply(true);
    try {
      const res = await fetch("/api/quick-replies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          kind: "interactive",
          interactive_payload: interactivePayload,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t("quickReplySaveError"));
        return;
      }
      toast.success(t("quickReplySaved"));
    } catch {
      toast.error(t("quickReplySaveError"));
    } finally {
      setSavingQuickReply(false);
    }
  }, [interactivePayload, t]);

  // A picked quick reply: text fills the composer; interactive opens the
  // builder pre-filled so the agent can tweak before sending.
  const handlePickQuickReply = useCallback(
    (qr: QuickReply) => {
      setQuickReplyOpen(false);
      setSlashReplies(null);
      if (qr.kind === "interactive" && qr.interactive_payload) {
        openInteractiveBuilder(qr.interactive_payload);
        return;
      }
      const body = qr.content_text ?? "";
      // Separate the snippet from any existing draft with a newline so the
      // words don't run together ("Thanks" + "we'll…" → "Thankswe'll…").
      setText((prev) =>
        prev && !/\s$/.test(prev) ? `${prev}\n${body}` : `${prev}${body}`,
      );
      requestAnimationFrame(() => {
        adjustHeight();
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
    },
    [openInteractiveBuilder, adjustHeight],
  );

  const openQuickReplyPicker = useCallback((createTitle: string | null = null) => {
    setPickerCreateTitle(createTitle);
    setPickerKey((k) => k + 1);
    setQuickReplyOpen(true);
  }, []);

  const handleQuickReplyOpenChange = useCallback((open: boolean) => {
    setQuickReplyOpen(open);
    if (!open) setSlashReplies(null);
  }, []);

  // "/nombre" + Enter (or a click): swap the token for the reply's
  // text; an interactive reply opens the builder instead.
  const applySlashPick = useCallback(
    (qr: QuickReply) => {
      const token = slashToken;
      if (!token) return;
      setSlashToken(null);
      if (qr.kind === "interactive" && qr.interactive_payload) {
        setText((prev) => replaceSlashToken(prev, token, "").text);
        openInteractiveBuilder(qr.interactive_payload);
        return;
      }
      const next = replaceSlashToken(text, token, qr.content_text ?? "");
      setText(next.text);
      requestAnimationFrame(() => {
        adjustHeight();
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(next.caret, next.caret);
        }
      });
    },
    [slashToken, text, openInteractiveBuilder, adjustHeight],
  );

  // "Crear «nombre»" — the typed name wasn't found; open the picker's
  // create form with it prefilled and drop the "/…" from the draft.
  const openSlashCreate = useCallback(() => {
    const token = slashToken;
    setSlashToken(null);
    if (token) setText((prev) => replaceSlashToken(prev, token, "").text);
    openQuickReplyPicker(token?.query ?? "");
  }, [slashToken, openQuickReplyPicker]);

  const handleComposerKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (slashOpen) {
        // Matches plus the trailing "Crear…" row.
        const count = slashMatches.length + 1;
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashIndex((i) => (i + 1) % count);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashIndex((i) => (i - 1 + count) % count);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSlashToken(null);
          return;
        }
        if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
          e.preventDefault();
          if (slashReplies === null) return; // still loading
          if (slashIndex < slashMatches.length) applySlashPick(slashMatches[slashIndex]);
          else openSlashCreate();
          return;
        }
      }
      handleKeyDown(e);
    },
    [slashOpen, slashMatches, slashReplies, slashIndex, applySlashPick, openSlashCreate, handleKeyDown],
  );

  // Upload a captured file to chat-media and stage it as a draft.
  const stageUpload = useCallback(
    async (kind: ComposerMediaKind, file: File) => {
      // Per-kind ceiling mirrors Meta's caps (image 5 MB, etc.) so we
      // reject before upload rather than orphaning an object that Meta
      // would then refuse at send.
      const max = MEDIA_MAX_BYTES_BY_KIND[kind];
      if (file.size > max) {
        const kindLabel =
          kind === "image" ? t("photo")
          : kind === "video" ? t("video")
          : kind === "audio" ? t("audio")
          : t("document");
        toast.error(
          t("uploadTooLarge", {
            sizeMb: (file.size / 1024 / 1024).toFixed(1),
            kind: kindLabel,
            maxMb: Math.round(max / 1024 / 1024),
          }),
        );
        return;
      }
      setBusy(true);
      try {
        const { publicUrl, path } = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);
        // Replacing an existing draft? GC the previous object first.
        removeStaged(draftRef.current?.path);
        setDraft({ kind, mediaUrl: publicUrl, path, filename: file.name, caption: "" });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("uploadFailed"));
      } finally {
        setBusy(false);
      }
    },
    [removeStaged, t],
  );

  const handlePicked = useCallback(
    (kind: "image" | "video" | "document", file: File | undefined) => {
      if (file) void stageUpload(kind, file);
    },
    [stageUpload],
  );

  // Drag-and-drop / paste entry point: same checks as the picker, but the
  // kind is inferred from the file instead of the menu item clicked.
  const attachFile = useCallback(
    (file: File) => {
      if (inputsDisabled || busy || recording) return;
      const kind = kindForFile(file);
      if (!kind) {
        toast.error(t("unsupportedFile", { name: file.name }));
        return;
      }
      void stageUpload(kind, file);
    },
    [inputsDisabled, busy, recording, stageUpload, t],
  );

  useImperativeHandle(ref, () => ({ attachFile }), [attachFile]);

  // Ctrl+V of a screenshot or a copied file attaches it; plain-text
  // pastes fall through to the textarea untouched.
  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const file = e.clipboardData.files[0];
      if (!file) return;
      e.preventDefault();
      attachFile(file);
    },
    [attachFile],
  );

  // ---- Voice recording (client-side Ogg/Opus, no server transcode) ---

  // The encoded Ogg/Opus file from opus-recorder → upload and send it
  // straight away as a voice note, like WhatsApp (no preview step).
  // Latest props via refs: the recorder's callback outlives the render
  // that started it.
  const onSendMediaRef = useRef(onSendMedia);
  const replyToRef = useRef(replyTo);
  const onClearReplyRef = useRef(onClearReply);
  useEffect(() => {
    onSendMediaRef.current = onSendMedia;
    replyToRef.current = replyTo;
    onClearReplyRef.current = onClearReply;
  });

  const finalizeRecording = useCallback(
    async (bytes: Uint8Array) => {
      // Uint8Array is a valid BlobPart at runtime; the cast sidesteps the
      // lib.dom ArrayBufferLike-vs-ArrayBuffer generic mismatch.
      const file = new File([bytes as unknown as BlobPart], `voice-${Date.now()}.ogg`, {
        type: "audio/ogg",
      });
      if (file.size === 0) return; // cancelled / empty take
      if (file.size > MEDIA_MAX_BYTES_BY_KIND.audio) {
        toast.error(t("recordingTooLong"));
        return;
      }
      setBusy(true);
      try {
        const { publicUrl, path } = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);
        onSendMediaRef.current({
          kind: "audio",
          mediaUrl: publicUrl,
          path,
          replyToId: replyToRef.current?.id,
        });
        onClearReplyRef.current?.();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("uploadFailed"));
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  const endRecording = useCallback(
    (send: boolean) => {
      if (!send) cancelledRef.current = true;
      clearTimer();
      recordingRef.current = false;
      recordModeRef.current = null;
      setRecording(false);
      setRecordMode(null);
      setSlideX(0);
      setAnalyser(null);
      void recorderRef.current?.stop().catch(() => {});
    },
    [clearTimer],
  );

  const stopRecording = useCallback(() => endRecording(true), [endRecording]);
  const cancelRecording = useCallback(() => endRecording(false), [endRecording]);

  const startRecording = useCallback(
    async (mode: RecordMode) => {
      if (inputsDisabled || busy || recordingRef.current) return;
      if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") {
        toast.error(t("voiceNotSupported"));
        return;
      }
      recordModeRef.current = mode;
      releasedEarlyRef.current = false;
      try {
        // Lazy-load the encoder (≈400 KB worker) only when the user records,
        // keeping it out of the main bundle.
        const { default: Recorder } = await import("opus-recorder");
        const recorder = new Recorder({
          encoderPath: OPUS_ENCODER_PATH,
          numberOfChannels: 1,
          encoderApplication: 2048, // VOIP — tuned for speech
          encoderSampleRate: 48000,
          streamPages: false, // one callback with the complete file on stop
        });
        cancelledRef.current = false;
        recorder.ondataavailable = (bytes) => {
          if (cancelledRef.current) return;
          void finalizeRecording(bytes);
        };
        recorderRef.current = recorder;
        await recorder.start();
        if (releasedEarlyRef.current || recordModeRef.current !== mode) {
          // Let go (or cancelled) before the mic was even live.
          cancelledRef.current = true;
          recordModeRef.current = null;
          void recorder.stop().catch(() => {});
          return;
        }
        // Level meter: tap the recorder's own mic graph (read-only).
        if (recorder.audioContext && recorder.sourceNode) {
          const node = recorder.audioContext.createAnalyser();
          node.fftSize = 256;
          recorder.sourceNode.connect(node);
          setAnalyser(node);
        }
        recordingRef.current = true;
        recordStartedAtRef.current = Date.now();
        setRecordMode(mode);
        setRecording(true);
        setRecordSeconds(0);
        let elapsed = 0;
        timerRef.current = setInterval(() => {
          elapsed += 1;
          setRecordSeconds(elapsed);
          // Auto-stop at the cap so a forgotten recording can't blow the
          // upload size limit — sends what was recorded.
          if (elapsed >= MAX_RECORDING_SECONDS) stopRecording();
        }, 1000);
      } catch (err) {
        recordModeRef.current = null;
        void recorderRef.current?.stop().catch(() => {});
        recorderRef.current = null;
        // getUserMedia's DOMException name says why — tell the agent how
        // to fix it instead of one generic "denied or unavailable".
        const name = err instanceof DOMException ? err.name : "";
        if (name === "NotAllowedError" || name === "SecurityError") {
          toast.error(t("micBlocked"));
        } else if (name === "NotFoundError" || name === "OverconstrainedError") {
          toast.error(t("micNotFound"));
        } else if (name === "NotReadableError" || name === "AbortError") {
          toast.error(t("micBusy"));
        } else {
          toast.error(t("micDenied"));
        }
      }
    },
    [inputsDisabled, busy, finalizeRecording, stopRecording, t],
  );

  // ---- Mic button (WhatsApp-style) -----------------------------------
  // Mouse: click to start, click again (now a send button) to send.
  // Touch: hold to record, release to send, slide left to cancel.

  const handleMicPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return;
      if (recordingRef.current) {
        if (recordModeRef.current === "toggle") {
          e.preventDefault();
          stopRecording();
        }
        return;
      }
      if (recordModeRef.current) return; // a start is already pending
      e.preventDefault();
      if (e.pointerType === "mouse") {
        void startRecording("toggle");
      } else {
        // Keep receiving move/up even when the finger leaves the button.
        e.currentTarget.setPointerCapture(e.pointerId);
        holdStartXRef.current = e.clientX;
        setSlideX(0);
        void startRecording("hold");
      }
    },
    [startRecording, stopRecording],
  );

  const handleMicPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      if (recordModeRef.current !== "hold" || !recordingRef.current) return;
      const dx = Math.max(0, holdStartXRef.current - e.clientX);
      if (dx >= CANCEL_SLIDE_PX) {
        cancelRecording();
      } else {
        setSlideX(dx);
      }
    },
    [cancelRecording],
  );

  const handleMicPointerUp = useCallback(() => {
    if (recordModeRef.current !== "hold") return;
    if (!recordingRef.current) {
      // Still starting — abort it once it resolves.
      releasedEarlyRef.current = true;
      return;
    }
    if (Date.now() - recordStartedAtRef.current < MIN_HOLD_MS) {
      cancelRecording();
      toast(t("holdToRecord"));
      return;
    }
    stopRecording();
  }, [cancelRecording, stopRecording, t]);

  // Escape cancels a click-started recording on desktop.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") cancelRecording();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [recording, cancelRecording]);

  // ---- Draft send / discard -----------------------------------------

  const sendDraft = useCallback(() => {
    if (!draft || busy) return;
    onSendMedia({
      kind: draft.kind,
      mediaUrl: draft.mediaUrl,
      path: draft.path,
      // Audio takes no caption (Meta rejects it). Everything else: the
      // trimmed caption, or undefined when blank.
      caption:
        draft.kind === "audio" ? undefined : draft.caption.trim() || undefined,
      filename: draft.kind === "document" ? draft.filename : undefined,
      replyToId: replyTo?.id,
    });
    // The object is now owned by the sent message — clear without GC.
    setDraft(null);
    onClearReply?.();
  }, [draft, busy, onSendMedia, replyTo?.id, onClearReply]);

  // Discard GCs the staged object — it was uploaded but never sent.
  const discardDraft = useCallback(() => {
    removeStaged(draft?.path);
    setDraft(null);
  }, [draft?.path, removeStaged]);

  const setCaption = useCallback((caption: string) => {
    setDraft((d) => (d ? { ...d, caption } : d));
  }, []);

  // ---- Render --------------------------------------------------------

  return (
    <div
      className={cn(
        "border-t border-border bg-card p-3",
        // The fixed-width send button was sitting flush against the
        // screen edge on devices with a rounded corner / camera cutout
        // on that side — safe-area-inset makes sure it isn't, and the
        // slightly larger base padding matches the rest of the app's
        // more generous embedded spacing.
        embedded &&
          "pr-[max(1rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))]"
      )}
    >
      {replyTo && (
        <div className="mb-2">
          <ReplyQuote
            authorLabel={replyTo.authorLabel}
            preview={replyTo.preview}
            onDismiss={onClearReply}
          />
        </div>
      )}
      {sessionExpired && (
        <div className="mb-2 flex items-center justify-between rounded-lg bg-amber-500/10 px-3 py-2">
          <p className="text-xs text-amber-400">
            {awaitingCustomer
              ? canTemplates
                ? t("awaitingCustomerHint")
                : t("awaitingCustomerHintNoTemplates")
              : canTemplates
                ? t("sessionExpiredHint")
                : t("sessionExpiredHintNoTemplates")}
          </p>
          {canTemplates && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-amber-400 hover:text-amber-300"
              onClick={onOpenTemplates}
            >
              <LayoutTemplate className="mr-1 h-3 w-3" />
              {t("templates")}
            </Button>
          )}
        </div>
      )}

      {/* Hidden file inputs driven by the attach menu. */}
      <input
        ref={imageInputRef}
        type="file"
        accept={PICKER_ACCEPT.image}
        className="hidden"
        onChange={(e) => {
          handlePicked("image", e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <input
        ref={videoInputRef}
        type="file"
        accept={PICKER_ACCEPT.video}
        className="hidden"
        onChange={(e) => {
          handlePicked("video", e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <input
        ref={documentInputRef}
        type="file"
        accept={PICKER_ACCEPT.document}
        className="hidden"
        onChange={(e) => {
          handlePicked("document", e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      {draft ? (
        <MediaDraftPreview
          draft={draft}
          busy={busy}
          readOnly={readOnly}
          onCaptionChange={setCaption}
          onDiscard={discardDraft}
          onSend={sendDraft}
          t={t}
        />
      ) : (
        <div className="flex items-end gap-2">
          {recording ? (
            <RecordingStrip
              mode={recordMode ?? "toggle"}
              seconds={recordSeconds}
              slideX={slideX}
              analyser={analyser}
              onCancel={cancelRecording}
              t={t}
            />
          ) : (
          <>
          {/* Everywhere except our own Android wrapper: four separate
              action buttons, exactly as before this existed — including
              a real phone's own mobile browser. Only inside the wrapper
              do they crowd out the textarea enough to matter, so only
              there do they collapse into the single "more actions"
              button below instead — same actions, WhatsApp-style. */}
          <div className={cn("items-end gap-2", embedded ? "hidden" : "flex")}>
            {/* Attach menu — photo / video / document / voice. */}
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={inputsDisabled || busy}
                title={
                  readOnly
                    ? t("readOnlyTitle")
                    : inputsDisabled
                      ? undefined
                      : t("attachMedia")
                }
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md p-0 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Paperclip className="h-4 w-4" />
                )}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="border-border bg-popover">
                <DropdownMenuItem onClick={() => imageInputRef.current?.click()}>
                  <ImageIcon className="mr-2 h-4 w-4" />
                  {t("photo")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => videoInputRef.current?.click()}>
                  <Video className="mr-2 h-4 w-4" />
                  {t("video")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => documentInputRef.current?.click()}>
                  <FileText className="mr-2 h-4 w-4" />
                  {t("document")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* + menu — interactive messages + quick replies. Gated on the
                24h window like free-form text (interactive requires it). */}
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={inputsDisabled}
                title={
                  readOnly
                    ? t("readOnlyTitle")
                    : inputsDisabled
                      ? undefined
                      : t("moreActions")
                }
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md p-0 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Plus className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="border-border bg-popover">
                <DropdownMenuItem onClick={() => openInteractiveBuilder()}>
                  <MessageSquareDashed className="mr-2 h-4 w-4" />
                  {t("interactiveMessage")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => openQuickReplyPicker()}>
                  <Zap className="mr-2 h-4 w-4" />
                  {t("quickReplies")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {canTemplates && (
              <GatedButton
                variant="ghost"
                size="sm"
                canAct={!readOnly}
                gateReason="send messages"
                title={readOnly ? undefined : t("sendTemplate")}
                className="h-9 w-9 shrink-0 p-0 text-muted-foreground hover:text-foreground"
                onClick={onOpenTemplates}
              >
                <LayoutTemplate className="h-4 w-4" />
              </GatedButton>
            )}

            <GatedButton
              variant="ghost"
              size="sm"
              canAct={!readOnly}
              gateReason="send messages"
              disabled={drafting}
              title={readOnly ? undefined : t("draftWithAI")}
              className="h-9 w-9 shrink-0 p-0 text-muted-foreground hover:text-primary"
              onClick={handleDraft}
            >
              {drafting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
            </GatedButton>
          </div>

          {/* Inside our own Android wrapper only: the four buttons above
              collapse into this one — same eight actions, one tap away,
              so the textarea + send button actually have room to
              breathe. Never shown in a real browser, phone or not. */}
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={inputsDisabled || busy}
              title={readOnly ? t("readOnlyTitle") : undefined}
              className={cn(
                "h-9 w-9 shrink-0 items-center justify-center rounded-md p-0 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50",
                embedded ? "inline-flex" : "hidden"
              )}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="border-border bg-popover">
              <DropdownMenuItem onClick={() => imageInputRef.current?.click()}>
                <ImageIcon className="mr-2 h-4 w-4" />
                {t("photo")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => videoInputRef.current?.click()}>
                <Video className="mr-2 h-4 w-4" />
                {t("video")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => documentInputRef.current?.click()}>
                <FileText className="mr-2 h-4 w-4" />
                {t("document")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => openInteractiveBuilder()}>
                <MessageSquareDashed className="mr-2 h-4 w-4" />
                {t("interactiveMessage")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => openQuickReplyPicker()}>
                <Zap className="mr-2 h-4 w-4" />
                {t("quickReplies")}
              </DropdownMenuItem>
              {canTemplates && (
                <DropdownMenuItem onClick={onOpenTemplates}>
                  <LayoutTemplate className="mr-2 h-4 w-4" />
                  {t("sendTemplate")}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => void handleDraft()} disabled={drafting}>
                {drafting ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="mr-2 h-4 w-4" />
                )}
                {t("draftWithAI")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="relative flex min-w-0 flex-1">
          {slashOpen && (
            <div className="absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg">
              <div className="border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">
                {t("slashHeader")}
              </div>
              {slashReplies === null ? (
                <div className="flex justify-center py-3">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <ul className="max-h-64 overflow-y-auto py-1">
                  {slashMatches.map((qr, i) => (
                    <li key={qr.id}>
                      <button
                        type="button"
                        // Keep focus in the textarea so the caret/token survive the click.
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseEnter={() => setSlashIndex(i)}
                        onClick={() => applySlashPick(qr)}
                        className={cn(
                          "flex w-full min-w-0 items-start gap-2 px-3 py-1.5 text-left",
                          i === slashIndex && "bg-muted",
                        )}
                      >
                        {qr.kind === "interactive" ? (
                          <Zap className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                        ) : (
                          <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-foreground">
                            /{qr.title}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {qr.kind === "interactive" && qr.interactive_payload
                              ? interactivePayloadPreviewText(qr.interactive_payload)
                              : qr.content_text}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                  {slashMatches.length === 0 && (
                    <li className="px-3 py-1.5 text-xs text-muted-foreground">
                      {t("slashNoMatch")}
                    </li>
                  )}
                  <li>
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setSlashIndex(slashMatches.length)}
                      onClick={openSlashCreate}
                      className={cn(
                        "flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-sm text-primary",
                        slashIndex === slashMatches.length && "bg-muted",
                      )}
                    >
                      <Plus className="h-4 w-4 shrink-0" />
                      <span className="truncate">
                        {slashToken?.query
                          ? t("slashCreateNamed", { title: slashToken.query })
                          : t("slashCreate")}
                      </span>
                    </button>
                  </li>
                </ul>
              )}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleChange}
            onKeyDown={handleComposerKeyDown}
            onSelect={(e) =>
              syncSlashToken(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)
            }
            onBlur={() => setSlashToken(null)}
            onPaste={handlePaste}
            placeholder={
              readOnly
                ? t("readOnlyPlaceholder")
                : sessionExpired
                  ? awaitingCustomer
                    ? canTemplates
                      ? t("awaitingCustomerPlaceholder")
                      : t("awaitingCustomerPlaceholderNoTemplates")
                    : canTemplates
                      ? t("sessionExpiredPlaceholder")
                      : t("sessionExpiredPlaceholderNoTemplates")
                  : embedded
                    ? t("typeMessagePlaceholderApp")
                    : t("typeMessagePlaceholder")
            }
            disabled={sessionExpired || readOnly}
            rows={1}
            // Textarea keeps its own inline title — the GatedButton
            // wrapping pattern doesn't apply to non-button inputs.
            // The placeholder text also surfaces the read-only state.
            title={readOnly ? t("readOnlyTitle") : undefined}
            className={cn(
              "w-full resize-none rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-primary/50",
              (sessionExpired || readOnly) && "cursor-not-allowed opacity-50"
            )}
          />
          </div>
          </>
          )}

          {/* WhatsApp-style: empty composer → mic, typed text → send. */}
          {readOnly || text.trim() ? (
            <GatedButton
              size="sm"
              canAct={!readOnly}
              gateReason="send messages"
              disabled={!text.trim() || sessionExpired || sending}
              onClick={handleSend}
              aria-label={t("send")}
              className="h-10 w-10 shrink-0 rounded-full bg-primary p-0 hover:bg-primary/90 disabled:opacity-40"
            >
              <Send className="h-4 w-4" />
            </GatedButton>
          ) : (
            <button
              type="button"
              disabled={inputsDisabled || (busy && !recording)}
              onPointerDown={handleMicPointerDown}
              onPointerMove={handleMicPointerMove}
              onPointerUp={handleMicPointerUp}
              onPointerCancel={handleMicPointerUp}
              // Long-press would otherwise pop the WebView's context menu.
              onContextMenu={(e) => e.preventDefault()}
              aria-label={
                recording && recordMode === "toggle" ? t("sendVoiceNote") : t("recordVoiceNote")
              }
              title={
                recording && recordMode === "toggle"
                  ? t("sendVoiceNote")
                  : embedded
                    ? t("holdToRecord")
                    : t("recordVoiceNote")
              }
              className={cn(
                "inline-flex h-10 w-10 shrink-0 touch-none select-none items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm transition-transform duration-150 hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40",
                recording && recordMode === "hold" && "scale-[1.35] shadow-lg"
              )}
            >
              {busy && !recording ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : recording && recordMode === "toggle" ? (
                <Send className="h-4 w-4" />
              ) : (
                <Mic className="h-5 w-5" />
              )}
            </button>
          )}
        </div>
      )}

      {/* Hint sits outside the flex row so its height doesn't push
          `items-end` buttons below the textarea. Indented to line up
          under the textarea left edge. Hidden only in our own Android
          wrapper: it mentions Shift+Enter, a physical-keyboard shortcut
          that means nothing there, and the indent assumes the
          four-button layout that only collapses inside the wrapper.
          Unchanged in any real browser, phone or not. */}
      {!draft && !recording && (
        <p
          className={cn(
            "mt-1 pl-[5.5rem] text-[10px] text-muted-foreground",
            embedded && "hidden"
          )}
        >
          {t("draftHint")}
        </p>
      )}

      {/* Interactive-message builder dialog. */}
      <Dialog open={interactiveOpen} onOpenChange={setInteractiveOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("interactiveMessage")}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[70vh] overflow-y-auto">
            <InteractiveBuilder
              value={interactivePayload}
              onChange={setInteractivePayload}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={savingQuickReply}
              onClick={saveAsQuickReply}
            >
              {savingQuickReply ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Zap className="mr-1 h-4 w-4" />
              )}
              {t("saveAsQuickReply")}
            </Button>
            <Button onClick={sendInteractive}>
              <Send className="mr-1 h-4 w-4" />
              {t("send")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Quick-reply picker. */}
      <QuickReplyPicker
        key={pickerKey}
        open={quickReplyOpen}
        onOpenChange={handleQuickReplyOpenChange}
        onPick={handlePickQuickReply}
        initialCreateTitle={pickerCreateTitle}
      />
    </div>
  );
}

/**
 * Staged-attachment preview with caption + send/discard. Declared at
 * module scope (not nested in MessageComposer) so React keeps it mounted
 * across the parent's re-renders — a nested component would remount the
 * caption input on every keystroke and drop focus.
 */
function MediaDraftPreview({
  draft,
  busy,
  readOnly,
  onCaptionChange,
  onDiscard,
  onSend,
  t,
}: {
  draft: MediaDraft;
  busy: boolean;
  readOnly: boolean;
  onCaptionChange: (caption: string) => void;
  onDiscard: () => void;
  onSend: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="rounded-xl border border-border bg-muted/40 p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {draft.kind === "image" && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={draft.mediaUrl}
              alt={draft.filename}
              className="max-h-40 rounded-lg object-cover"
            />
          )}
          {draft.kind === "video" && (
            <video src={draft.mediaUrl} controls className="max-h-40 rounded-lg" />
          )}
          {draft.kind === "audio" && (
            <audio src={draft.mediaUrl} controls className="w-full" />
          )}
          {draft.kind === "document" && (
            <div className="flex items-center gap-2 text-sm text-foreground">
              <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
              <span className="truncate">{draft.filename}</span>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onDiscard}
          aria-label={t("removeAttachment")}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-2 flex items-end gap-2">
        {draft.kind !== "audio" && (
          <input
            value={draft.caption}
            maxLength={MEDIA_CAPTION_MAX}
            onChange={(e) => onCaptionChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            placeholder={t("addCaption")}
            className="flex-1 rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-primary/50"
          />
        )}
        <GatedButton
          size="sm"
          canAct={!readOnly}
          gateReason="send messages"
          disabled={busy}
          onClick={onSend}
          className={cn(
            "h-9 w-9 shrink-0 bg-primary p-0 hover:bg-primary/90 disabled:opacity-40",
            draft.kind === "audio" && "ml-auto",
          )}
        >
          <Send className="h-4 w-4" />
        </GatedButton>
      </div>
    </div>
  );
}

/** Replaces the attach buttons + textarea while the mic is live. The mic
 *  button itself stays mounted next to it (it owns the pointer capture of
 *  a press-and-hold), so this only covers the left side of the row. */
function RecordingStrip({
  mode,
  seconds,
  slideX,
  analyser,
  onCancel,
  t,
}: {
  mode: RecordMode;
  seconds: number;
  slideX: number;
  analyser: AnalyserNode | null;
  onCancel: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="flex h-10 min-w-0 flex-1 items-center gap-3 rounded-full border border-border bg-muted px-3">
      {mode === "toggle" && (
        <button
          type="button"
          onClick={onCancel}
          aria-label={t("cancelRecording")}
          title={t("cancelRecording")}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-card hover:text-red-500"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      )}
      <span className="flex h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-red-500" />
      <span className="shrink-0 text-sm tabular-nums text-foreground">
        {formatDuration(seconds)}
      </span>
      {mode === "hold" ? (
        <span
          className="ml-auto flex min-w-0 items-center gap-1 truncate text-xs text-muted-foreground"
          style={{
            transform: `translateX(${-slideX}px)`,
            opacity: Math.max(0.25, 1 - slideX / CANCEL_SLIDE_PX),
          }}
        >
          <ChevronLeft className="h-4 w-4 shrink-0" />
          {t("slideToCancel")}
        </span>
      ) : (
        <VoiceLevelBars analyser={analyser} />
      )}
    </div>
  );
}

/** Scrolling mic-level bars, WhatsApp-style. Falls back to a gentle
 *  pulse when the recorder exposed no audio graph to tap. */
function VoiceLevelBars({ analyser }: { analyser: AnalyserNode | null }) {
  const [levels, setLevels] = useState<number[]>(() => Array(32).fill(0.08));

  useEffect(() => {
    if (!analyser) return;
    const data = new Uint8Array(analyser.fftSize);
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < 90) return;
      last = now;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) {
        const x = (v - 128) / 128;
        sum += x * x;
      }
      const rms = Math.sqrt(sum / data.length);
      const level = Math.min(1, Math.max(0.08, rms * 4));
      setLevels((prev) => [...prev.slice(1), level]);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [analyser]);

  return (
    <div
      className={cn(
        "flex h-6 min-w-0 flex-1 items-center justify-end gap-[2px] overflow-hidden",
        !analyser && "animate-pulse"
      )}
      aria-hidden
    >
      {levels.map((level, i) => (
        <span
          key={i}
          className="w-[3px] shrink-0 rounded-full bg-primary/70"
          style={{ height: `${Math.round(level * 100)}%` }}
        />
      ))}
    </div>
  );
}
