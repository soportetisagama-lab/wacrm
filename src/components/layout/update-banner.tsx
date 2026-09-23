"use client";

import { useEffect, useState } from "react";
import { Browser } from "@capacitor/browser";
import { Download, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { getAvailableUpdate } from "@/lib/app-update/check-update";
import { Button } from "@/components/ui/button";

/**
 * Persistent "there's a new version" strip for the Android wrapper —
 * see check-update.ts for why this exists instead of relying on a
 * store. Dismissible per-session (not permanently — a user closing it
 * today shouldn't mean they never hear about it again tomorrow).
 */
export function UpdateBanner() {
  const t = useTranslations("Common");
  const [apkUrl, setApkUrl] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    getAvailableUpdate().then((update) => {
      if (update) setApkUrl(update.apkUrl);
    });
  }, []);

  if (!apkUrl || dismissed) return null;

  const handleUpdate = () => {
    const absoluteUrl = new URL(apkUrl, window.location.origin).toString();
    Browser.open({ url: absoluteUrl });
  };

  return (
    <div className="flex shrink-0 items-center justify-between gap-2 bg-primary px-4 py-2 text-primary-foreground">
      <div className="flex items-center gap-2 text-xs font-medium">
        <Download className="size-4 shrink-0" />
        {t("updateAvailable")}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          size="sm"
          variant="secondary"
          className="h-7 px-2.5 text-xs"
          onClick={handleUpdate}
        >
          {t("updateNow")}
        </Button>
        <button
          type="button"
          aria-label={t("dismiss")}
          onClick={() => setDismissed(true)}
          className="rounded-full p-1 text-primary-foreground/80 hover:bg-white/15 hover:text-primary-foreground"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}
