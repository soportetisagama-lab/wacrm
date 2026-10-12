"use client";

import { MapPin, ExternalLink } from "lucide-react";
import type { useTranslations } from "next-intl";

// The webhook stores a location as "name - address - lat,lng" (name and
// address optional), so the coordinates are always the last segment.
const COORDS_RE = /(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

const ZOOM = 16;
const TILE = 256;
const WIDTH = 260;
const HEIGHT = 150;

export function parseLocation(text: string | null | undefined) {
  if (!text) return null;
  const match = text.match(COORDS_RE);
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 85 || Math.abs(lng) > 180) return null;
  const label = text
    .slice(0, match.index)
    .replace(/\s*-\s*$/, "")
    .trim();
  return { lat, lng, label };
}

/** World pixel position of a coordinate at ZOOM (Web Mercator). */
function toPixel(lat: number, lng: number) {
  const scale = TILE * 2 ** ZOOM;
  const x = ((lng + 180) / 360) * scale;
  const rad = (lat * Math.PI) / 180;
  const y =
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * scale;
  return { x, y };
}

export function LocationBubble({
  text,
  t,
}: {
  text: string | null | undefined;
  t: ReturnType<typeof useTranslations>;
}) {
  const loc = parseLocation(text);
  if (!loc) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span>{text || t("locationShared")}</span>
      </div>
    );
  }

  const href = `https://www.google.com/maps?q=${loc.lat},${loc.lng}`;
  const { x, y } = toPixel(loc.lat, loc.lng);
  // Top-left world pixel of the visible window, centred on the point.
  const left = x - WIDTH / 2;
  const top = y - HEIGHT / 2;
  const firstTileX = Math.floor(left / TILE);
  const firstTileY = Math.floor(top / TILE);
  const lastTileX = Math.floor((left + WIDTH) / TILE);
  const lastTileY = Math.floor((top + HEIGHT) / TILE);
  const tiles: { tx: number; ty: number }[] = [];
  for (let tx = firstTileX; tx <= lastTileX; tx++) {
    for (let ty = firstTileY; ty <= lastTileY; ty++) tiles.push({ tx, ty });
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="block w-[260px] max-w-full overflow-hidden rounded-lg text-inherit no-underline"
    >
      <div
        className="relative overflow-hidden rounded-md bg-muted"
        style={{ width: WIDTH, maxWidth: "100%", height: HEIGHT }}
      >
        {tiles.map(({ tx, ty }) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={`${tx}-${ty}`}
            src={`https://tile.openstreetmap.org/${ZOOM}/${tx}/${ty}.png`}
            alt=""
            draggable={false}
            loading="lazy"
            className="absolute max-w-none select-none"
            style={{
              width: TILE,
              height: TILE,
              left: tx * TILE - left,
              top: ty * TILE - top,
            }}
          />
        ))}
        <MapPin
          className="absolute h-8 w-8 fill-red-500 text-red-700 drop-shadow"
          style={{ left: WIDTH / 2 - 16, top: HEIGHT / 2 - 32 }}
        />
        <span className="absolute bottom-0 right-0 bg-white/80 px-1 text-[9px] text-gray-600">
          © OpenStreetMap
        </span>
      </div>
      <div className="mt-1.5 flex items-start gap-1.5 text-sm">
        <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          {loc.label && <p className="break-words font-medium">{loc.label}</p>}
          <span className="inline-flex items-center gap-1 text-xs font-medium text-primary underline-offset-2 hover:underline">
            {t("openInMaps")}
            <ExternalLink className="h-3 w-3" />
          </span>
        </div>
      </div>
    </a>
  );
}
