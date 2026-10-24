import { cn } from '@/lib/utils';
import { CHANNEL_LABEL, channelOf, type Channel } from '@/lib/channels/types';

// Network marks for WhatsApp / Instagram / Messenger. The colours are the
// networks' own (not the line's brand), so they read the same on every
// line. Simplified glyphs drawn here — lucide-react ships no brand icons.

const CHANNEL_BG: Record<Channel, string> = {
  whatsapp: '#25D366',
  instagram: 'linear-gradient(45deg, #F58529 0%, #DD2A7B 50%, #8134AF 100%)',
  messenger: '#0084FF',
  tiktok: '#000000',
};

const CHANNEL_TITLE: Record<Channel, string> = {
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  messenger: 'Facebook Messenger',
  tiktok: 'TikTok',
};

function Glyph({ channel }: { channel: Channel }) {
  switch (channel) {
    case 'instagram':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
          <rect x="3.5" y="3.5" width="17" height="17" rx="5" />
          <circle cx="12" cy="12" r="4" />
          <circle cx="17.3" cy="6.7" r="1" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'messenger':
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 2.5C6.5 2.5 2.5 6.5 2.5 11.6c0 2.7 1.1 5 3 6.6v3.3l3-1.7c1.1.3 2.2.5 3.5.5 5.5 0 9.5-4 9.5-9.1S17.5 2.5 12 2.5Zm1 12.1-2.4-2.6-4.7 2.6 5.2-5.5 2.5 2.6 4.6-2.6-5.2 5.5Z" />
        </svg>
      );
    case 'whatsapp':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M4 20l1.2-3.6A8.5 8.5 0 1 1 8 19.1L4 20Z" strokeLinejoin="round" />
          <path
            d="M9 8.6c.2-.5.6-.6.9-.6h.4l.9 2-.6.8c.5 1.1 1.4 2 2.5 2.5l.8-.6 2 .9v.4c0 .3-.1.7-.6.9-.7.4-1.7.4-3-.3-1.3-.7-2.6-2-3.3-3.3-.4-1.2-.4-2.1 0-2.7Z"
            fill="currentColor"
            stroke="none"
          />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="12" r="5" />
        </svg>
      );
  }
}

/** Round network mark. `size` in px. */
export function ChannelIcon({
  channel,
  size = 16,
  className,
}: {
  channel: Channel;
  size?: number;
  className?: string;
}) {
  return (
    <span
      role="img"
      aria-label={CHANNEL_TITLE[channel]}
      title={CHANNEL_TITLE[channel]}
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full text-white', className)}
      style={{ width: size, height: size, background: CHANNEL_BG[channel], padding: Math.max(2, size * 0.16) }}
    >
      <Glyph channel={channel} />
    </span>
  );
}

/** Icon + network name, as a small pill. */
export function ChannelBadge({
  channel,
  className,
}: {
  channel: Channel;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-muted/60 py-0.5 pr-2 pl-0.5 text-[11px] font-medium text-foreground',
        className,
      )}
      title={CHANNEL_TITLE[channel]}
    >
      <ChannelIcon channel={channel} size={16} />
      {CHANNEL_LABEL[channel]}
    </span>
  );
}

/** Channel of a contact/conversation row, for callers that hold the raw row. */
export function rowChannel(row: { channel?: string | null } | null | undefined): Channel {
  return channelOf(row);
}

/** What identifies a contact when it has no phone: @username or the network id. */
export function socialIdentity(contact: {
  channel?: string | null;
  channel_username?: string | null;
  channel_user_id?: string | null;
}): string | null {
  if (contact.channel_username) return `@${contact.channel_username}`;
  if (contact.channel_user_id) return `ID ${contact.channel_user_id}`;
  return null;
}
