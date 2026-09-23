import { NextResponse } from "next/server";

// Bumped by hand every time a new native APK ships (new Capacitor
// plugin, permission, or config change — anything that needs a real
// reinstall, unlike a plain web-layer change which every open app
// picks up for free). See src/lib/app-update/check-update.ts for the
// client side of this, and public/downloads/ for the file this
// points at (named after the brand, not "app-debug" — that's just
// this file's local build output name before it gets copied here).
const LATEST_VERSION_CODE = 5;
const APK_URL = "/downloads/SagamaRetail.apk";

export async function GET() {
  return NextResponse.json({
    latestVersionCode: LATEST_VERSION_CODE,
    apkUrl: APK_URL,
  });
}
