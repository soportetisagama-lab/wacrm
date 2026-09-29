"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Phone, PhoneOff, Mic, MicOff, MessageSquare, Loader2 } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { showBrowserNotification } from "@/lib/notifications/browser-push";
import { cn } from "@/lib/utils";

/**
 * IncomingCallManager — WhatsApp voice calls (migration 071), headless
 * until a call rings. Mount ONCE per shell (desktop and the Android
 * wrapper alike).
 *
 * Who rings: the conversation's Asesor (whatsapp_calls.ring_user_id).
 * Unassigned calls ring ATC right away; an assigned call its Asesor
 * doesn't pick up escalates to ATC after ESCALATE_AFTER_MS. Admins /
 * gerencia never ring. RLS already hides other Asesores' calls.
 *
 * Answering: the customer's SDP offer came in on the webhook; we answer
 * it with a local RTCPeerConnection and hand the SDP answer to
 * /api/whatsapp/calls/[id], which forwards it to Meta — the audio then
 * flows straight between this browser and WhatsApp.
 */

interface CallRow {
  id: string;
  conversation_id: string | null;
  contact_id: string | null;
  status: string;
  offer_sdp: string | null;
  ring_user_id: string | null;
  answered_by: string | null;
  created_at: string;
}

/** Meta gives ~30–60 s to answer; older "ringing" rows are stale. */
const RING_WINDOW_MS = 60_000;
/** Assigned Asesor didn't pick up → ATC starts ringing too. */
const ESCALATE_AFTER_MS = 15_000;

type Phase = "ringing" | "connecting" | "active";

export function IncomingCallManager() {
  const { user, accountRole } = useAuth();
  const isAtc = accountRole === "atc";
  const userId = user?.id;
  const canAct = useCan("send-messages");
  const router = useRouter();
  const t = useTranslations("Calls");

  const [call, setCall] = useState<CallRow | null>(null);
  const [phase, setPhase] = useState<Phase>("ringing");
  const [contactName, setContactName] = useState<string>("");
  const [muted, setMuted] = useState(false);
  const [seconds, setSeconds] = useState(0);

  const callRef = useRef<CallRow | null>(null);
  const phaseRef = useRef<Phase>("ringing");
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const escalationTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const setPhaseBoth = (p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  };

  const cleanup = useCallback(() => {
    pcRef.current?.close();
    pcRef.current = null;
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
    if (audioRef.current) audioRef.current.srcObject = null;
    callRef.current = null;
    setCall(null);
    setMuted(false);
    setSeconds(0);
    setPhaseBoth("ringing");
  }, []);

  // Start ringing a call (if we're not already busy with one).
  const ring = useCallback(
    async (row: CallRow) => {
      if (callRef.current) return;
      if (Date.now() - new Date(row.created_at).getTime() > RING_WINDOW_MS) return;
      callRef.current = row;
      setCall(row);
      setPhaseBoth("ringing");
      let name = "";
      if (row.contact_id) {
        const { data } = await createClient()
          .from("contacts")
          .select("name, phone")
          .eq("id", row.contact_id)
          .maybeSingle();
        name = data?.name || data?.phone || "";
      }
      setContactName(name);
      showBrowserNotification(t("incoming"), {
        body: name || t("whatsappCall"),
        tag: `call-${row.id}`,
      });
    },
    [t],
  );

  // Should this viewer ring for this call — now, later, or never?
  const consider = useCallback(
    (row: CallRow) => {
      if (!userId || !canAct || row.status !== "ringing" || !row.offer_sdp) return;
      if (row.ring_user_id === userId || (!row.ring_user_id && isAtc)) {
        void ring(row);
        return;
      }
      if (!isAtc || escalationTimers.current.has(row.id)) return;
      const age = Date.now() - new Date(row.created_at).getTime();
      const timer = setTimeout(async () => {
        escalationTimers.current.delete(row.id);
        const { data } = await createClient()
          .from("whatsapp_calls")
          .select("*")
          .eq("id", row.id)
          .maybeSingle();
        if (data?.status === "ringing") void ring(data as CallRow);
      }, Math.max(0, ESCALATE_AFTER_MS - age));
      escalationTimers.current.set(row.id, timer);
    },
    [userId, canAct, isAtc, ring],
  );

  useEffect(() => {
    if (!userId) return;
    const supabase = createClient();
    const timers = escalationTimers.current;

    // Opened the app from the push notification while it still rings.
    (async () => {
      const { data } = await supabase
        .from("whatsapp_calls")
        .select("*")
        .eq("status", "ringing")
        .gte("created_at", new Date(Date.now() - RING_WINDOW_MS).toISOString())
        .order("created_at", { ascending: false });
      for (const row of (data as CallRow[]) ?? []) consider(row);
    })();

    const channel = supabase
      .channel("incoming-calls")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "whatsapp_calls" },
        (payload) => consider(payload.new as CallRow),
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "whatsapp_calls" },
        (payload) => {
          const row = payload.new as CallRow;
          const current = callRef.current;
          if (!current || current.id !== row.id) return;
          if (phaseRef.current === "ringing" && row.status !== "ringing") {
            // Picked up by a teammate, rejected, or the customer hung up.
            cleanup();
            return;
          }
          if (phaseRef.current === "active" && row.status !== "accepted") {
            toast(t("ended"));
            cleanup();
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, [userId, consider, cleanup, t]);

  // Ringtone while ringing — two short tones every 2 s, WebAudio so no
  // asset. Browsers may keep it silent until the page had a user gesture.
  useEffect(() => {
    if (!call || phase !== "ringing") return;
    let ctx: AudioContext | null = null;
    try {
      ctx = new AudioContext();
    } catch {
      return;
    }
    const beep = () => {
      if (!ctx) return;
      for (const offset of [0, 0.35]) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 440;
        gain.gain.value = 0.08;
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime + offset);
        osc.stop(ctx.currentTime + offset + 0.25);
      }
    };
    beep();
    const id = setInterval(beep, 2000);
    // Give up ringing once Meta's answer window has certainly passed.
    const stale = setTimeout(
      cleanup,
      Math.max(0, RING_WINDOW_MS - (Date.now() - new Date(call.created_at).getTime())),
    );
    return () => {
      clearInterval(id);
      clearTimeout(stale);
      void ctx?.close();
    };
  }, [call, phase, cleanup]);

  // Call timer.
  useEffect(() => {
    if (phase !== "active") return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [phase]);

  const post = (id: string, body: Record<string, unknown>) =>
    fetch(`/api/whatsapp/calls/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const accept = async () => {
    const current = callRef.current;
    if (!current?.offer_sdp) return;
    setPhaseBoth("connecting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      pcRef.current = pc;
      stream.getTracks().forEach((tr) => pc.addTrack(tr, stream));
      pc.ontrack = (e) => {
        if (audioRef.current) {
          audioRef.current.srcObject = e.streams[0];
          void audioRef.current.play().catch(() => {});
        }
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" && callRef.current) {
          toast.error(t("connectionLost"));
          void hangUp();
        }
      };
      await pc.setRemoteDescription({ type: "offer", sdp: current.offer_sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      // No trickle ICE with Meta: send the answer once candidates are in.
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === "complete") return resolve();
        const done = () => {
          if (pc.iceGatheringState === "complete") resolve();
        };
        pc.addEventListener("icegatheringstatechange", done);
        setTimeout(resolve, 2500);
      });
      const res = await post(current.id, {
        action: "accept",
        sdp: pc.localDescription?.sdp,
      });
      if (res.status === 409) {
        toast(t("answeredElsewhere"));
        cleanup();
        return;
      }
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error);
      setPhaseBoth("active");
    } catch (err) {
      // getUserMedia's DOMException name says why the mic failed — tell
      // the agent how to fix it instead of the browser's raw English text.
      // The call keeps ringing for teammates (we never claimed it).
      const name = err instanceof DOMException ? err.name : "";
      toast.error(
        name === "NotAllowedError" || name === "SecurityError"
          ? t("micBlocked")
          : name === "NotFoundError" || name === "OverconstrainedError"
            ? t("micNotFound")
            : name === "NotReadableError" || name === "AbortError"
              ? t("micBusy")
              : err instanceof Error && err.message
                ? err.message
                : t("failed"),
      );
      cleanup();
    }
  };

  const reject = async () => {
    const current = callRef.current;
    if (!current) return;
    cleanup();
    await post(current.id, { action: "reject" }).catch(() => {});
  };

  const hangUp = async () => {
    const current = callRef.current;
    if (!current) return;
    cleanup();
    await post(current.id, { action: "terminate" }).catch(() => {});
    toast(t("ended"));
  };

  const toggleMute = () => {
    const next = !muted;
    streamRef.current?.getAudioTracks().forEach((tr) => (tr.enabled = !next));
    setMuted(next);
  };

  const openChat = () => {
    if (call?.conversation_id) router.push(`/inbox?c=${call.conversation_id}`);
  };

  const mm = String(Math.floor(seconds / 60));
  const ss = String(seconds % 60).padStart(2, "0");

  return (
    <>
      <audio ref={audioRef} autoPlay className="hidden" />
      {call && (
        <div
          role="dialog"
          aria-label={t("incoming")}
          className="fixed inset-x-3 top-3 z-[100] rounded-2xl border border-border bg-popover p-4 text-popover-foreground shadow-2xl sm:inset-x-auto sm:bottom-6 sm:right-6 sm:top-auto sm:w-80"
        >
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-green-600 text-white",
                phase === "ringing" && "animate-pulse",
              )}
            >
              <Phone className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{contactName || t("unknownCaller")}</p>
              <p className="text-xs text-muted-foreground">
                {phase === "ringing"
                  ? t("incoming")
                  : phase === "connecting"
                    ? t("connecting")
                    : `${mm}:${ss}`}
              </p>
            </div>
            {call.conversation_id && (
              <button
                type="button"
                onClick={openChat}
                title={t("openChat")}
                aria-label={t("openChat")}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <MessageSquare className="h-4 w-4" />
              </button>
            )}
          </div>

          <div className="mt-4 flex items-center justify-center gap-6">
            {phase === "ringing" ? (
              <>
                <RoundButton label={t("decline")} onClick={reject} className="bg-red-600 hover:bg-red-700">
                  <PhoneOff className="h-5 w-5" />
                </RoundButton>
                <RoundButton label={t("accept")} onClick={accept} className="bg-green-600 hover:bg-green-700">
                  <Phone className="h-5 w-5" />
                </RoundButton>
              </>
            ) : phase === "connecting" ? (
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            ) : (
              <>
                <RoundButton
                  label={muted ? t("unmute") : t("mute")}
                  onClick={toggleMute}
                  className={muted ? "bg-foreground text-background" : "bg-muted text-foreground hover:bg-muted/80"}
                >
                  {muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
                </RoundButton>
                <RoundButton label={t("hangUp")} onClick={hangUp} className="bg-red-600 hover:bg-red-700">
                  <PhoneOff className="h-5 w-5" />
                </RoundButton>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function RoundButton({
  label,
  onClick,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        className={cn(
          "inline-flex h-12 w-12 items-center justify-center rounded-full text-white shadow transition-colors",
          className,
        )}
      >
        {children}
      </button>
      <span className="text-[11px] text-muted-foreground">{label}</span>
    </div>
  );
}
