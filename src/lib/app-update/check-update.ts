// ============================================================
// In-app native update check — the Android wrapper's own answer to
// "there's no Play Store auto-updating this APK for us". Only
// meaningful inside the wrapper (isEmbeddedApp()); a normal browser
// tab has no APK to update at all.
//
// Deliberately NOT a Capacitor plugin update mechanism — just our own
// tiny version endpoint (/api/app/version) compared against the
// installed build number (@capacitor/app's App.getInfo().build, which
// is the Android versionCode as a string). See that route for where
// the "latest" number and APK URL are set.
// ============================================================

import { App } from "@capacitor/app";
import { isEmbeddedApp } from "@/lib/mobile-app";

export interface UpdateInfo {
  apkUrl: string;
}

/** Null when up to date, unsupported (not embedded), or the check itself fails —
 *  a broken update check must never block using the app. */
export async function getAvailableUpdate(): Promise<UpdateInfo | null> {
  if (!isEmbeddedApp()) return null;

  try {
    const info = await App.getInfo();
    const currentBuild = parseInt(info.build, 10);
    if (Number.isNaN(currentBuild)) return null;

    const res = await fetch("/api/app/version");
    if (!res.ok) return null;
    const data = await res.json();

    if (typeof data.latestVersionCode !== "number" || typeof data.apkUrl !== "string") {
      return null;
    }
    if (data.latestVersionCode <= currentBuild) return null;

    return { apkUrl: data.apkUrl };
  } catch (err) {
    console.error("[check-update] Failed to check for update:", err);
    return null;
  }
}
