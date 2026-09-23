import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";

// Saves this device's FCM token so the server can push to it later
// (see src/lib/notifications/push-send.ts). Called by the app right
// after the user grants the native notification permission — see
// src/lib/notifications/native-push.ts.
export async function POST(request: Request) {
  let ctx;
  try {
    ctx = await getCurrentAccount();
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!token) {
    return NextResponse.json({ error: "token is required" }, { status: 400 });
  }

  const admin = supabaseAdmin();
  const { error } = await admin.from("device_push_tokens").upsert(
    {
      account_id: ctx.accountId,
      user_id: ctx.userId,
      token,
      platform: "android",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "token" },
  );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

// Called when the user turns notifications off — stops future pushes
// to this specific device without touching its other devices.
export async function DELETE(request: Request) {
  let ctx;
  try {
    ctx = await getCurrentAccount();
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!token) {
    return NextResponse.json({ error: "token is required" }, { status: 400 });
  }

  const admin = supabaseAdmin();
  const { error } = await admin
    .from("device_push_tokens")
    .delete()
    .eq("user_id", ctx.userId)
    .eq("token", token);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
