"use client";

import { useEffect, useState } from "react";
import { CornerDownLeft, ExternalLink, LayoutTemplate, Phone, Copy } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import type { Message, MessageTemplate } from "@/types";
import type { useTranslations } from "next-intl";

type TemplateView = Pick<
  MessageTemplate,
  "name" | "header_type" | "header_content" | "header_media_url" | "header_handle" | "footer_text" | "buttons"
>;

// One fetch per template name per browser session, shared by every bubble.
const cache = new Map<string, Promise<TemplateView | null>>();

function loadTemplate(name: string): Promise<TemplateView | null> {
  let p = cache.get(name);
  if (!p) {
    // RLS (is_account_member) scopes this to the current account.
    p = Promise.resolve(
      createClient()
        .from("message_templates")
        .select("name, header_type, header_content, header_media_url, header_handle, footer_text, buttons")
        .eq("name", name)
        .limit(1),
    )
      .then(({ data }) => ((data?.[0] as TemplateView | undefined) ?? null))
      .catch(() => null);
    cache.set(name, p);
  }
  return p;
}

/** A synced template's sample media is a Meta URL in header_handle. */
function headerUrl(t: TemplateView): string | null {
  if (t.header_media_url) return t.header_media_url;
  if (t.header_handle && /^https?:\/\//.test(t.header_handle)) return t.header_handle;
  return null;
}

/**
 * Outbound template bubble rendered like WhatsApp: header (image / video /
 * text), body, footer and buttons. Header/footer/buttons come from the
 * synced template definition (`message_templates`); the body is the text
 * stored on the message.
 */
export function TemplateMessage({
  message,
  t,
}: {
  message: Message;
  t: ReturnType<typeof useTranslations>;
}) {
  const [tpl, setTpl] = useState<TemplateView | null>(null);
  const name = message.template_name;

  useEffect(() => {
    if (!name) return;
    let alive = true;
    void loadTemplate(name).then((v) => {
      if (alive) setTpl(v);
    });
    return () => {
      alive = false;
    };
  }, [name]);

  const media = tpl ? headerUrl(tpl) : null;
  const buttons = tpl?.buttons ?? [];

  return (
    <div className="max-w-[320px]">
      <span className="mb-1 inline-flex items-center gap-1 rounded bg-primary-foreground/20 px-1.5 py-0.5 text-[10px] font-medium">
        <LayoutTemplate className="h-3 w-3" />
        {t("template")}
      </span>
      {tpl?.header_type === "image" && media && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={media}
          alt=""
          className="mt-1 max-h-64 w-full rounded-lg object-cover"
          loading="lazy"
        />
      )}
      {tpl?.header_type === "video" && media && (
        <video src={media} controls className="mt-1 max-h-64 w-full rounded-lg" />
      )}
      {tpl?.header_type === "document" && (
        <p className="mt-1 text-xs opacity-80">{t("document")}</p>
      )}
      {tpl?.header_type === "text" && tpl.header_content && (
        <p className="mt-1 text-sm font-semibold">{tpl.header_content}</p>
      )}
      {message.content_text && (
        <p className="mt-1 whitespace-pre-wrap break-words text-sm">{message.content_text}</p>
      )}
      {tpl?.footer_text && <p className="mt-1 text-[11px] opacity-70">{tpl.footer_text}</p>}
      {buttons.length > 0 && (
        <div className="mt-2 divide-y divide-current/20 border-t border-current/20">
          {buttons.map((b, i) => {
            const Icon =
              b.type === "URL"
                ? ExternalLink
                : b.type === "PHONE_NUMBER"
                  ? Phone
                  : b.type === "COPY_CODE"
                    ? Copy
                    : CornerDownLeft;
            const content = (
              <>
                <Icon className="h-3.5 w-3.5" />
                {b.text}
              </>
            );
            const cls = "flex items-center justify-center gap-1.5 py-1.5 text-sm font-medium";
            // Only https links become clickable (no javascript:/http: from a template row).
            return b.type === "URL" && /^https:\/\//i.test(b.url) ? (
              <a key={i} href={b.url} target="_blank" rel="noopener noreferrer" className={cls}>
                {content}
              </a>
            ) : (
              <div key={i} className={cls}>
                {content}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
