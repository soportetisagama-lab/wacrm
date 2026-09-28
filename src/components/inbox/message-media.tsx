"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  FileText,
  ImageOff,
  Loader2,
  Maximize2,
  Pause,
  Play,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import type { Message } from "@/types";
import { downloadMediaMessage } from "@/lib/media/download";
import { useMediaBlobUrl } from "@/hooks/use-media-blob-url";

/**
 * The media renderers behind `<MessageBubble>`'s image / video / audio /
 * document cases. Split out of message-bubble.tsx so that file stays a
 * thin content switch — everything here is about the two affordances
 * issue #373 asked for: open it full-size, and save it.
 *
 * Both are less trivial than they look, because the two flavours of
 * `media_url` behave differently in the browser. See
 * `@/lib/media/blob-cache` for the proxy-vs-bucket split and
 * `@/lib/media/download` for why `<a download>` alone isn't enough.
 */

type Translator = ReturnType<typeof useTranslations>;

/** Inline media size cap, shared so the four bubbles can't drift apart. */
const MEDIA_BOX = "max-h-64 max-w-60";

export function MediaUnavailable({
  label,
  t,
}: {
  label: string;
  t: Translator;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <ImageOff className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span>{t("unavailable", { label })}</span>
    </div>
  );
}

/**
 * Kicks off a download and reports failure as a toast. Kept as a hook so
 * each bubble owns its own in-flight state — a slow 16 MB video shouldn't
 * put a spinner on every other attachment in the thread.
 */
function useMediaDownload(message: Message, t: Translator) {
  const [downloading, setDownloading] = useState(false);

  const download = useCallback(async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      await downloadMediaMessage(message);
    } catch {
      toast.error(t("downloadFailed"));
    } finally {
      setDownloading(false);
    }
  }, [downloading, message, t]);

  return { downloading, download };
}

function MediaActionButton({
  icon: Icon,
  label,
  onClick,
  busy = false,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label={label}
      title={label}
      // Own surface rather than inheriting the bubble's, so the same button
      // reads on the muted inbound fill, the primary outbound fill, and on
      // top of an arbitrary photo.
      className="flex h-7 w-7 items-center justify-center rounded-full border border-border/60 bg-background/85 text-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-background disabled:opacity-60"
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Icon className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

function MediaPlaceholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-40 w-60 items-center justify-center rounded-lg bg-muted">
      {children}
    </div>
  );
}

export function MediaImageBubble({
  message,
  onOpen,
  t,
}: {
  message: Message;
  /** Opens the thread's lightbox on this message. Omitted ⇒ not clickable. */
  onOpen?: () => void;
  t: Translator;
}) {
  const { src, status } = useMediaBlobUrl(message.media_url);
  // The fetch can succeed and the bytes still not be a decodable image.
  const [broken, setBroken] = useState(false);
  const { downloading, download } = useMediaDownload(message, t);

  if (status === "error" || broken) {
    return (
      <MediaPlaceholder>
        <ImageOff className="h-8 w-8 text-muted-foreground" />
      </MediaPlaceholder>
    );
  }

  if (status !== "ready" || !src) {
    return (
      <MediaPlaceholder>
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </MediaPlaceholder>
    );
  }

  const image = (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={t("imageAlt")}
      className={cn(MEDIA_BOX, "rounded-lg object-contain")}
      onError={() => setBroken(true)}
    />
  );

  return (
    <div className="group/media relative w-fit">
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={t("viewImage")}
          className="block cursor-zoom-in rounded-lg outline-none ring-offset-2 ring-offset-transparent focus-visible:ring-2 focus-visible:ring-ring"
        >
          {image}
        </button>
      ) : (
        image
      )}
      {/* Hover-only: on touch there is no hover, but tapping the image opens
          the viewer, which carries a full-size Download button. */}
      <div className="absolute bottom-2 right-2 opacity-0 transition-opacity group-hover/media:opacity-100 group-focus-within/media:opacity-100">
        <MediaActionButton
          icon={Download}
          label={t("download")}
          onClick={download}
          busy={downloading}
        />
      </div>
    </div>
  );
}

export function MediaVideoBubble({
  message,
  onOpen,
  t,
}: {
  message: Message;
  onOpen?: () => void;
  t: Translator;
}) {
  const { downloading, download } = useMediaDownload(message, t);

  return (
    <div className="relative w-fit">
      {/* Plain URL, not a blob: the element should stream rather than wait
          for up to 16 MB to land. */}
      <video
        src={message.media_url}
        controls
        preload="metadata"
        className={cn(MEDIA_BOX, "rounded-lg")}
      />
      {/* Top-right, clear of the native controls — and always visible, since
          expanding is the only way to watch a clip capped at 15rem wide and
          a touch device gets no hover. */}
      <div className="absolute right-2 top-2 flex gap-1">
        {onOpen && (
          <MediaActionButton
            icon={Maximize2}
            label={t("expandVideo")}
            onClick={onOpen}
          />
        )}
        <MediaActionButton
          icon={Download}
          label={t("download")}
          onClick={download}
          busy={downloading}
        />
      </div>
    </div>
  );
}

/** Only one voice note plays at a time, like WhatsApp. */
let activeVoiceNote: HTMLAudioElement | null = null;

const WAVE_BARS = 36;
const PLAYBACK_RATES = [1, 1.5, 2] as const;

/** Stable pseudo-waveform per message — we don't decode the audio just
 *  to draw it; seeding from the id keeps each note's shape consistent. */
function waveformFor(seed: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const bars: number[] = [];
  for (let i = 0; i < WAVE_BARS; i++) {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    const r = ((h >>> 0) % 1000) / 1000;
    // Softer at the edges, like speech trailing in and out.
    const envelope = Math.sin((Math.PI * (i + 0.5)) / WAVE_BARS) * 0.5 + 0.5;
    bars.push(Math.max(0.15, Math.min(1, r * envelope + 0.12)));
  }
  return bars;
}

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

export function MediaAudioBubble({
  message,
  t,
}: {
  message: Message;
  t: Translator;
}) {
  const { downloading, download } = useMediaDownload(message, t);
  const outbound = message.sender_type !== "customer";
  const audioRef = useRef<HTMLAudioElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [rateIndex, setRateIndex] = useState(0);
  const [failed, setFailed] = useState(false);
  // Chrome reports `Infinity` for Ogg/Opus files without a duration
  // header (our own recordings) until it has seeked to the end once.
  const probingRef = useRef(false);
  const bars = useMemo(() => waveformFor(message.id), [message.id]);

  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      if (audio && activeVoiceNote === audio) activeVoiceNote = null;
    };
  }, []);

  const onLoadedMetadata = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (Number.isFinite(audio.duration)) {
      setDuration(audio.duration);
    } else {
      probingRef.current = true;
      audio.currentTime = 1e101;
    }
  };

  const onTimeUpdate = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (probingRef.current) {
      if (Number.isFinite(audio.duration)) {
        probingRef.current = false;
        setDuration(audio.duration);
        audio.currentTime = 0;
      }
      return;
    }
    setCurrent(audio.currentTime);
  };

  const togglePlay = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    if (activeVoiceNote && activeVoiceNote !== audio) activeVoiceNote.pause();
    activeVoiceNote = audio;
    try {
      await audio.play();
    } catch {
      setFailed(true);
    }
  };

  const cycleRate = () => {
    const next = (rateIndex + 1) % PLAYBACK_RATES.length;
    setRateIndex(next);
    if (audioRef.current) audioRef.current.playbackRate = PLAYBACK_RATES[next];
  };

  const seekTo = (clientX: number) => {
    const audio = audioRef.current;
    const track = trackRef.current;
    if (!audio || !track || !duration) return;
    const rect = track.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    audio.currentTime = ratio * duration;
    setCurrent(audio.currentTime);
  };

  const progress = duration ? Math.min(1, current / duration) : 0;
  const shown = playing || current > 0 ? current : duration;

  return (
    <div className="flex w-64 max-w-full items-center gap-2.5 py-0.5">
      {/* Plain URL, not a blob: stream instead of waiting for the file. */}
      <audio
        ref={audioRef}
        src={message.media_url ?? undefined}
        preload="metadata"
        onLoadedMetadata={onLoadedMetadata}
        onDurationChange={() => {
          const d = audioRef.current?.duration;
          if (d && Number.isFinite(d) && !probingRef.current) setDuration(d);
        }}
        onTimeUpdate={onTimeUpdate}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrent(0);
          if (audioRef.current) audioRef.current.currentTime = 0;
        }}
        onError={() => setFailed(true)}
        className="hidden"
      />
      <button
        type="button"
        onClick={() => void togglePlay()}
        disabled={failed}
        aria-label={playing ? t("pauseAudio") : t("playAudio")}
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-full shadow-sm transition-transform active:scale-95 disabled:opacity-50",
          outbound
            ? "bg-primary-foreground text-primary"
            : "bg-primary text-primary-foreground"
        )}
      >
        {playing ? (
          <Pause className="h-4 w-4 fill-current" />
        ) : (
          <Play className="ml-0.5 h-4 w-4 fill-current" />
        )}
      </button>

      <div className="min-w-0 flex-1">
        <div
          ref={trackRef}
          role="slider"
          tabIndex={0}
          aria-label={t("audio")}
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(current)}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            seekTo(e.clientX);
          }}
          onPointerMove={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) seekTo(e.clientX);
          }}
          onKeyDown={(e) => {
            const audio = audioRef.current;
            if (!audio || !duration) return;
            if (e.key === "ArrowRight") audio.currentTime = Math.min(duration, audio.currentTime + 5);
            if (e.key === "ArrowLeft") audio.currentTime = Math.max(0, audio.currentTime - 5);
          }}
          className="relative flex h-7 cursor-pointer touch-none items-center gap-[2px]"
        >
          {bars.map((height, i) => {
            const played = (i + 0.5) / bars.length <= progress;
            return (
              <span
                key={i}
                className={cn(
                  "w-[3px] flex-1 rounded-full transition-colors",
                  outbound
                    ? played
                      ? "bg-primary-foreground"
                      : "bg-primary-foreground/40"
                    : played
                      ? "bg-primary"
                      : "bg-muted-foreground/35"
                )}
                style={{ height: `${Math.round(height * 100)}%` }}
              />
            );
          })}
          {/* Scrub knob */}
          <span
            className={cn(
              "pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full shadow",
              outbound ? "bg-primary-foreground" : "bg-primary"
            )}
            style={{ left: `${progress * 100}%` }}
          />
        </div>
        <div
          className={cn(
            "mt-0.5 flex items-center justify-between text-[11px] tabular-nums",
            outbound ? "text-primary-foreground/80" : "text-muted-foreground"
          )}
        >
          <span>{failed ? t("audioUnavailable") : formatClock(shown)}</span>
          <button
            type="button"
            onClick={cycleRate}
            aria-label={t("playbackSpeed")}
            className={cn(
              "rounded-full px-1.5 py-px text-[10px] font-semibold",
              outbound
                ? "bg-primary-foreground/20 hover:bg-primary-foreground/30"
                : "bg-muted hover:bg-muted-foreground/20"
            )}
          >
            {PLAYBACK_RATES[rateIndex]}x
          </button>
        </div>
      </div>

      <MediaActionButton
        icon={Download}
        label={t("download")}
        onClick={download}
        busy={downloading}
      />
    </div>
  );
}

export function MediaDocumentBubble({
  message,
  t,
}: {
  message: Message;
  t: Translator;
}) {
  const { downloading, download } = useMediaDownload(message, t);
  const label = message.filename || message.content_text || t("document");
  // Only show the caption separately when we ALSO have a distinct
  // filename — otherwise content_text IS the label already (legacy
  // messages sent before the filename column existed, or an inbound
  // document with no filename captured), and showing it twice would
  // be redundant.
  const caption = message.filename ? message.content_text : null;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <a
          href={message.media_url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm hover:bg-muted"
        >
          <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{label}</span>
        </a>
        <MediaActionButton
          icon={Download}
          label={t("download")}
          onClick={download}
          busy={downloading}
        />
      </div>
      {caption && (
        <p className="whitespace-pre-wrap break-words text-sm">{caption}</p>
      )}
    </div>
  );
}
