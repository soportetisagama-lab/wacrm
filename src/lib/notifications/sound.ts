/**
 * Short chime played with every in-app notification banner — the OS
 * banner alone is easy to miss with the tab in the background.
 *
 * Plays `/sounds/notification.mp3` when the line ships one (drop the
 * file into `public/sounds/` to change the sound); otherwise a built-in
 * two-tone chime synthesized with Web Audio. Browsers only allow audio
 * after the user has interacted with the page — before that it no-ops.
 */

const SOUND_URL = "/sounds/notification.mp3";
// A burst of notifications (several chats at once) chimes once.
const MIN_GAP_MS = 1500;

let lastPlayedAt = 0;
let fileMissing = false;

export function playNotificationSound(): void {
  if (typeof window === "undefined") return;
  const now = Date.now();
  if (now - lastPlayedAt < MIN_GAP_MS) return;
  lastPlayedAt = now;

  if (fileMissing) {
    playChime();
    return;
  }
  try {
    const audio = new Audio(SOUND_URL);
    audio.volume = 0.6;
    audio.addEventListener("error", () => {
      // No custom file on this line — remember it and use the chime.
      fileMissing = true;
      playChime();
    });
    audio.play().catch(() => {
      // Autoplay blocked (no interaction yet) — the error listener
      // above covers a missing file.
    });
  } catch {
    playChime();
  }
}

function playChime(): void {
  try {
    const ctx = new AudioContext();
    const start = ctx.currentTime;
    for (const [offset, freq] of [
      [0, 880],
      [0.14, 1320],
    ] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.15, start + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start + offset);
      osc.stop(start + offset + 0.36);
    }
    setTimeout(() => void ctx.close(), 800);
  } catch {
    // No Web Audio — the banner still shows.
  }
}
