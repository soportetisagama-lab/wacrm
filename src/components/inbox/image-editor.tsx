"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  Check,
  Crop,
  Eraser,
  Loader2,
  Pencil,
  RotateCw,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

/**
 * WhatsApp-style "edit before sending" for a staged image: crop (free or
 * fixed ratio), rotate 90°, and freehand drawing with a few colours, with
 * undo. Plain <canvas>, no dependencies.
 *
 * Model: the original (downscaled) image plus a list of operations. Two
 * stacked canvases show the result of replaying them: the image (rotated
 * / cropped) and, on top, a transparent drawing layer. Strokes go on the
 * layer, so the eraser (destination-out) removes only what was drawn and
 * reveals the untouched photo underneath. A new stroke is painted
 * straight onto the layer while the finger moves; undo / rotate / crop /
 * clear replay the list. Coordinates are stored normalised (0..1) so they
 * survive any display size.
 */

type Op =
  | { type: "rotate" }
  | { type: "crop"; x: number; y: number; w: number; h: number }
  | { type: "stroke"; color: string; size: number; points: number[]; erase?: boolean }
  | { type: "clear" };

type StrokeOp = Extract<Op, { type: "stroke" }>;

type Mode = "draw" | "erase" | "crop";

interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Longest side the editor works at — keeps memory sane on modest phones
 *  and the output well under Meta's 5 MB image cap. */
const MAX_SIDE = 2048;
/** Stroke width relative to the longest side of the image. */
const STROKE_SIZE = 0.012;
/** Eraser width, same unit — thicker so it's easy to hit a line. */
const ERASE_SIZE = 0.05;
const MIN_CROP = 0.06;
const COLORS = ["#ffffff", "#000000", "#ef4444", "#facc15", "#22c55e", "#3b82f6", "#ec4899"];
const RATIOS: { key: string; value: number | null }[] = [
  { key: "free", value: null },
  { key: "1:1", value: 1 },
  { key: "4:3", value: 4 / 3 },
  { key: "3:4", value: 3 / 4 },
  { key: "16:9", value: 16 / 9 },
];

function makeCanvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function drawStroke(ctx: CanvasRenderingContext2D, op: StrokeOp, w: number, h: number) {
  const pts = op.points;
  if (pts.length < 2) return;
  ctx.save();
  if (op.erase) ctx.globalCompositeOperation = "destination-out";
  ctx.strokeStyle = op.color;
  ctx.fillStyle = op.color;
  ctx.lineWidth = op.size * Math.max(w, h);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (pts.length === 2) {
    ctx.beginPath();
    ctx.arc(pts[0] * w, pts[1] * h, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(pts[0] * w, pts[1] * h);
    for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i] * w, pts[i + 1] * h);
    ctx.stroke();
  }
  ctx.restore();
}

interface Rendered {
  image: HTMLCanvasElement;
  layer: HTMLCanvasElement;
}

function rotateCanvas(src: HTMLCanvasElement) {
  const c = makeCanvas(src.height, src.width);
  const ctx = c.getContext("2d")!;
  ctx.translate(c.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(src, 0, 0);
  return c;
}

function cropCanvas(src: HTMLCanvasElement, op: Extract<Op, { type: "crop" }>) {
  const sx = op.x * src.width;
  const sy = op.y * src.height;
  const sw = op.w * src.width;
  const sh = op.h * src.height;
  const c = makeCanvas(sw, sh);
  c.getContext("2d")!.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

/** Replay the ops: image + drawing layer, transformed together. */
function replay(source: HTMLCanvasElement, ops: Op[]): Rendered {
  let image = source;
  let layer = makeCanvas(source.width, source.height);
  for (const op of ops) {
    if (op.type === "rotate") {
      image = rotateCanvas(image);
      layer = rotateCanvas(layer);
    } else if (op.type === "crop") {
      image = cropCanvas(image, op);
      layer = cropCanvas(layer, op);
    } else if (op.type === "clear") {
      layer.getContext("2d")!.clearRect(0, 0, layer.width, layer.height);
    } else {
      drawStroke(layer.getContext("2d")!, op, layer.width, layer.height);
    }
  }
  return { image, layer };
}

/** True when the drawing layer currently has something to erase/clear. */
function hasDrawing(ops: Op[]): boolean {
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i];
    if (op.type === "clear") return false;
    if (op.type === "stroke" && !op.erase) return true;
  }
  return false;
}

function loadSource(file: File): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const c = makeCanvas(img.naturalWidth * scale, img.naturalHeight * scale);
      const ctx = c.getContext("2d")!;
      // JPEG output has no alpha — give transparent PNGs a white page.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      resolve(c);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image load failed"));
    };
    img.src = url;
  });
}

/** Largest centred rect with the given pixel ratio (null = whole image). */
function fitCrop(ratio: number | null, w: number, h: number): CropRect {
  if (!ratio) return { x: 0, y: 0, w: 1, h: 1 };
  let cw = 1;
  let ch = (w / ratio) / h;
  if (ch > 1) {
    ch = 1;
    cw = (h * ratio) / w;
  }
  return { x: (1 - cw) / 2, y: (1 - ch) / 2, w: cw, h: ch };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function ImageEditor({
  file,
  onCancel,
  onSave,
}: {
  file: File;
  onCancel: () => void;
  onSave: (file: File) => void | Promise<void>;
}) {
  const t = useTranslations("Inbox.imageEditor");
  const viewRef = useRef<HTMLCanvasElement>(null);
  const layerRef = useRef<HTMLCanvasElement>(null);
  const eraserCursorRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<HTMLCanvasElement | null>(null);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ops, setOps] = useState<Op[]>([]);
  const [mode, setMode] = useState<Mode>("draw");
  const [color, setColor] = useState(COLORS[2]);
  const [ratio, setRatio] = useState<number | null>(null);
  const [crop, setCrop] = useState<CropRect>({ x: 0, y: 0, w: 1, h: 1 });

  const paint = useCallback((list: Op[]) => {
    const view = viewRef.current;
    const layer = layerRef.current;
    const source = sourceRef.current;
    if (!view || !layer || !source) return;
    const { image, layer: drawn } = replay(source, list);
    view.width = image.width;
    view.height = image.height;
    view.getContext("2d")!.drawImage(image, 0, 0);
    layer.width = drawn.width;
    layer.height = drawn.height;
    layer.getContext("2d")!.drawImage(drawn, 0, 0);
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadSource(file)
      .then((c) => {
        if (cancelled) return;
        sourceRef.current = c;
        paint([]);
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) onCancel();
      });
    return () => {
      cancelled = true;
    };
  }, [file, paint, onCancel]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // Mirror of `ops` so handlers can repaint synchronously without doing
  // side effects inside a state updater.
  const opsRef = useRef<Op[]>([]);

  const pushOp = useCallback(
    (op: Op, repaint: boolean) => {
      const next = [...opsRef.current, op];
      opsRef.current = next;
      setOps(next);
      if (repaint) paint(next);
    },
    [paint],
  );

  const undo = useCallback(() => {
    if (opsRef.current.length === 0) return;
    const next = opsRef.current.slice(0, -1);
    opsRef.current = next;
    setOps(next);
    paint(next);
    setCrop({ x: 0, y: 0, w: 1, h: 1 });
    setRatio(null);
  }, [paint]);

  const rotate = useCallback(() => {
    pushOp({ type: "rotate" }, true);
    setCrop({ x: 0, y: 0, w: 1, h: 1 });
    setRatio(null);
  }, [pushOp]);

  const enterCrop = useCallback(() => {
    setMode("crop");
    setRatio(null);
    setCrop({ x: 0, y: 0, w: 1, h: 1 });
  }, []);

  const pickRatio = useCallback((value: number | null) => {
    const view = viewRef.current;
    setRatio(value);
    if (view) setCrop(fitCrop(value, view.width, view.height));
  }, []);

  const clearDrawing = useCallback(() => {
    if (hasDrawing(opsRef.current)) pushOp({ type: "clear" }, true);
  }, [pushOp]);

  const applyCrop = useCallback(() => {
    const full = crop.x <= 0.001 && crop.y <= 0.001 && crop.w >= 0.999 && crop.h >= 0.999;
    if (!full) pushOp({ type: "crop", ...crop }, true);
    setCrop({ x: 0, y: 0, w: 1, h: 1 });
    setRatio(null);
    setMode("draw");
  }, [crop, pushOp]);

  // ---- Freehand drawing ------------------------------------------------
  const strokeRef = useRef<{ points: number[]; id: number } | null>(null);

  const toNorm = (e: ReactPointerEvent<HTMLElement>) => {
    const r = viewRef.current!.getBoundingClientRect();
    return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1)] as const;
  };

  const liveStroke = (points: number[]): StrokeOp => ({
    type: "stroke",
    color,
    size: mode === "erase" ? ERASE_SIZE : STROKE_SIZE,
    points,
    erase: mode === "erase" || undefined,
  });

  // Eraser ring: follows the pointer at the eraser's on-screen size.
  // Written straight to the DOM — no re-render per move.
  const moveEraserCursor = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const ring = eraserCursorRef.current;
    if (!ring) return;
    if (mode !== "erase") {
      ring.style.display = "none";
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    const size = ERASE_SIZE * Math.max(r.width, r.height);
    ring.style.display = "block";
    ring.style.width = `${size}px`;
    ring.style.height = `${size}px`;
    ring.style.transform = `translate(${e.clientX - r.left - size / 2}px, ${e.clientY - r.top - size / 2}px)`;
  };

  const hideEraserCursor = () => {
    if (eraserCursorRef.current) eraserCursorRef.current.style.display = "none";
  };

  const onDrawDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if ((mode !== "draw" && mode !== "erase") || !ready || strokeRef.current) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    moveEraserCursor(e);
    const [x, y] = toNorm(e);
    strokeRef.current = { points: [x, y], id: e.pointerId };
    const layer = layerRef.current!;
    drawStroke(layer.getContext("2d")!, liveStroke([x, y]), layer.width, layer.height);
  };

  const onDrawMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    moveEraserCursor(e);
    const s = strokeRef.current;
    if (!s || s.id !== e.pointerId) return;
    const layer = layerRef.current!;
    const n = s.points.length;
    const [x, y] = toNorm(e);
    drawStroke(
      layer.getContext("2d")!,
      liveStroke([s.points[n - 2], s.points[n - 1], x, y]),
      layer.width,
      layer.height,
    );
    s.points.push(x, y);
  };

  const onDrawUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType !== "mouse") hideEraserCursor();
    const s = strokeRef.current;
    if (!s || s.id !== e.pointerId) return;
    strokeRef.current = null;
    pushOp(liveStroke(s.points), false);
  };

  // ---- Crop box dragging ----------------------------------------------
  const dragRef = useRef<{
    handle: string;
    x0: number;
    y0: number;
    start: CropRect;
    id: number;
  } | null>(null);

  const onCropDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const handle = (e.target as HTMLElement).dataset.handle;
    if (!handle) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const [x, y] = toNorm(e);
    dragRef.current = { handle, x0: x, y0: y, start: crop, id: e.pointerId };
  };

  const onCropMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    const view = viewRef.current;
    if (!d || d.id !== e.pointerId || !view) return;
    const [x, y] = toNorm(e);
    const dx = x - d.x0;
    const dy = y - d.y0;
    const s = d.start;
    if (d.handle === "move") {
      setCrop({ ...s, x: clamp(s.x + dx, 0, 1 - s.w), y: clamp(s.y + dy, 0, 1 - s.h) });
      return;
    }
    const west = d.handle.includes("w");
    const north = d.handle.includes("n");
    // Anchor = the opposite corner, which stays put.
    const ax = west ? s.x + s.w : s.x;
    const ay = north ? s.y + s.h : s.y;
    const maxW = west ? ax : 1 - ax;
    const maxH = north ? ay : 1 - ay;
    let w = clamp(s.w + (west ? -dx : dx), MIN_CROP, maxW);
    let h = clamp(s.h + (north ? -dy : dy), MIN_CROP, maxH);
    if (ratio) {
      // Keep the pixel ratio: h_n = w_n * W / (ratio * H).
      const k = view.width / (ratio * view.height);
      h = w * k;
      if (h > maxH) {
        h = maxH;
        w = h / k;
      }
      if (h < MIN_CROP) {
        h = MIN_CROP;
        w = Math.min(maxW, h / k);
      }
    }
    setCrop({ x: west ? ax - w : ax, y: north ? ay - h : ay, w, h });
  };

  const onCropUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.id === e.pointerId) dragRef.current = null;
  };

  const save = useCallback(async () => {
    const view = viewRef.current;
    if (!view) return;
    if (ops.length === 0) {
      onCancel();
      return;
    }
    setSaving(true);
    const out = makeCanvas(view.width, view.height);
    const octx = out.getContext("2d")!;
    octx.drawImage(view, 0, 0);
    if (layerRef.current) octx.drawImage(layerRef.current, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, "image/jpeg", 0.9));
    if (!blob) {
      setSaving(false);
      onCancel();
      return;
    }
    const base = file.name.replace(/\.[^.]+$/, "") || "imagen";
    await onSave(new File([blob], `${base}-editada.jpg`, { type: "image/jpeg" }));
    setSaving(false);
  }, [ops.length, file.name, onCancel, onSave]);

  if (typeof document === "undefined") return null;

  const toolBtn =
    "flex h-11 min-w-11 flex-col items-center justify-center gap-0.5 rounded-xl px-2 text-[11px] text-white/85 transition-colors hover:bg-white/10 disabled:opacity-40";

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-black/95 text-white select-none"
      role="dialog"
      aria-modal="true"
      aria-label={t("title")}
    >
      {/* Top bar */}
      <div className="flex h-14 shrink-0 items-center justify-between gap-2 px-3 pt-[env(safe-area-inset-top)]">
        <button
          type="button"
          onClick={onCancel}
          aria-label={t("cancel")}
          title={t("cancel")}
          className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-white/10"
        >
          <X className="h-5 w-5" />
        </button>
        <span className="truncate text-sm font-medium">{t("title")}</span>
        <button
          type="button"
          onClick={save}
          disabled={!ready || saving || mode === "crop"}
          className="flex h-10 items-center gap-1.5 rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-40"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          {t("done")}
        </button>
      </div>

      {/* Canvas */}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-3">
        {!ready && <Loader2 className="h-6 w-6 animate-spin text-white/70" />}
        <div className={cn("relative", !ready && "hidden")}>
          <canvas
            ref={viewRef}
            className="block max-h-[calc(100dvh-13rem)] max-w-[calc(100vw-1.5rem)]"
          />
          {/* Drawing layer — same pixel size as the image, stretched over it. */}
          <canvas
            ref={layerRef}
            onPointerDown={onDrawDown}
            onPointerMove={onDrawMove}
            onPointerUp={onDrawUp}
            onPointerCancel={onDrawUp}
            onPointerLeave={hideEraserCursor}
            className={cn(
              "absolute inset-0 h-full w-full touch-none",
              mode === "draw" && "cursor-crosshair",
              mode === "erase" && "cursor-none",
            )}
          />
          <div
            ref={eraserCursorRef}
            aria-hidden
            className="pointer-events-none absolute top-0 left-0 hidden rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
          />
          {mode === "crop" && (
            <div
              className="absolute inset-0 touch-none overflow-hidden"
              onPointerDown={onCropDown}
              onPointerMove={onCropMove}
              onPointerUp={onCropUp}
              onPointerCancel={onCropUp}
            >
              <div
                data-handle="move"
                className="absolute cursor-move border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]"
                style={{
                  left: `${crop.x * 100}%`,
                  top: `${crop.y * 100}%`,
                  width: `${crop.w * 100}%`,
                  height: `${crop.h * 100}%`,
                }}
              >
                {(["nw", "ne", "sw", "se"] as const).map((h) => (
                  <span
                    key={h}
                    data-handle={h}
                    className={cn(
                      "absolute h-8 w-8",
                      h.includes("n") ? "-top-4" : "-bottom-4",
                      h.includes("w") ? "-left-4" : "-right-4",
                      h === "nw" || h === "se" ? "cursor-nwse-resize" : "cursor-nesw-resize",
                    )}
                  >
                    <span
                      data-handle={h}
                      className="absolute top-1/2 left-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-sm border-2 border-white bg-black/40"
                    />
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Mode options */}
      <div className="flex h-12 shrink-0 items-center justify-center gap-2 overflow-x-auto px-3">
        {mode === "erase" ? (
          <button
            type="button"
            onClick={clearDrawing}
            disabled={!hasDrawing(ops)}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-white/10 px-3 text-xs text-white disabled:opacity-40"
          >
            <Trash2 className="h-4 w-4" />
            {t("clearAll")}
          </button>
        ) : mode === "draw" ? (
          COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              aria-label={c}
              className={cn(
                "h-7 w-7 shrink-0 rounded-full border-2 transition-transform",
                color === c ? "scale-115 border-white" : "border-white/40",
              )}
              style={{ backgroundColor: c }}
            />
          ))
        ) : (
          <>
            {RATIOS.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => pickRatio(r.value)}
                className={cn(
                  "h-8 shrink-0 rounded-full px-3 text-xs",
                  ratio === r.value ? "bg-white text-black" : "bg-white/10 text-white",
                )}
              >
                {r.value === null ? t("ratioFree") : r.key}
              </button>
            ))}
            <button
              type="button"
              onClick={applyCrop}
              className="h-8 shrink-0 rounded-full bg-primary px-3 text-xs font-semibold text-primary-foreground"
            >
              {t("applyCrop")}
            </button>
          </>
        )}
      </div>

      {/* Tools */}
      <div className="flex shrink-0 items-center justify-center gap-3 px-3 pt-1 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <button type="button" onClick={rotate} disabled={!ready || mode === "crop"} className={toolBtn}>
          <RotateCw className="h-5 w-5" />
          {t("rotate")}
        </button>
        <button
          type="button"
          onClick={mode === "crop" ? () => setMode("draw") : enterCrop}
          disabled={!ready}
          className={cn(toolBtn, mode === "crop" && "bg-white/15 text-white")}
        >
          <Crop className="h-5 w-5" />
          {t("crop")}
        </button>
        <button
          type="button"
          onClick={() => setMode("draw")}
          disabled={!ready}
          className={cn(toolBtn, mode === "draw" && "bg-white/15 text-white")}
        >
          <Pencil className="h-5 w-5" />
          {t("draw")}
        </button>
        <button
          type="button"
          onClick={() => setMode("erase")}
          disabled={!ready}
          className={cn(toolBtn, mode === "erase" && "bg-white/15 text-white")}
        >
          <Eraser className="h-5 w-5" />
          {t("erase")}
        </button>
        <button type="button" onClick={undo} disabled={!ready || ops.length === 0} className={toolBtn}>
          <Undo2 className="h-5 w-5" />
          {t("undo")}
        </button>
      </div>
    </div>,
    document.body,
  );
}
