"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { Loader2, Smile } from "lucide-react";
import type { EmojiClickData, EmojiStyle, SuggestionMode } from "emoji-picker-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

// The picker and its Spanish emoji names (~240 KB) only load the first
// time someone opens it — most messages are sent without emojis.
const EmojiPicker = dynamic(
  async () => {
    const [{ default: Picker }, { default: emojiDataEs }] = await Promise.all([
      import("emoji-picker-react"),
      // Explicit .js: the package also ships an emojis-es.ts that the
      // bundler would otherwise pick and fail on.
      import("emoji-picker-react/dist/data/emojis-es.js"),
    ]);
    function SpanishPicker(props: { onPick: (emoji: string) => void }) {
      return (
        <Picker
          emojiData={emojiDataEs}
          // Enum values as literals: importing the enums would pull the
          // whole library into the composer's bundle. Native = the
          // device's own emojis, the same ones WhatsApp shows the
          // customer, and no image downloads from a CDN.
          emojiStyle={"native" as EmojiStyle}
          suggestedEmojisMode={"recent" as SuggestionMode}
          searchPlaceholder="Buscar emoji"
          previewConfig={{ showPreview: false }}
          lazyLoadEmojis
          width={320}
          height={380}
          onEmojiClick={(data: EmojiClickData) => props.onPick(data.emoji)}
        />
      );
    }
    return SpanishPicker;
  },
  {
    ssr: false,
    loading: () => (
      <div className="flex h-[380px] w-[320px] items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    ),
  },
);

interface EmojiButtonProps {
  disabled?: boolean;
  /** Called with the emoji character; the composer inserts it at the cursor. */
  onPick: (emoji: string) => void;
  label: string;
}

/** WhatsApp-style emoji button for the message composer. Stays open
 *  after a pick so several emojis can be added in a row. */
export function EmojiButton({ disabled, onPick, label }: EmojiButtonProps) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        aria-label={label}
        title={label}
        className={cn(
          "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40",
          open && "bg-muted text-foreground",
        )}
      >
        <Smile className="h-5 w-5" />
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-auto p-0">
        {open && <EmojiPicker onPick={onPick} />}
      </PopoverContent>
    </Popover>
  );
}
