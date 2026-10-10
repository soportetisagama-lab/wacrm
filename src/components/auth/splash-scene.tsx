'use client';

import { useEffect, useState } from 'react';

// ============================================================
// Animated logo scenes for the login welcome splash — two per line,
// each about what that line makes or sells, and one picked at random on
// every load so the splash doesn't feel the same every time:
//
//   maxi       — shopping cart that delivers the logo / gondola that
//                builds itself and hangs the logo sign
//   retail     — laser cutting the logo / 2D plan turning into a 3D counter
//   inox       — press stamping the logo on steel / industrial kitchen
//   castor     — circular saw cutting a melamine board / melamine cabinet
//   industrial — pallet rack being built / forklift storing the logo
//
// Everything is one 400×200 SVG (logo included, as <image>) so the
// moving parts stay in sync at any size; plain CSS keyframes, no JS
// animation loop. The markup is static and built from constants below.
// Assets: /branding/splash/<line>-full.png (+ the four maxi pieces for
// the cart). Users who ask for reduced motion get the plain logo.
// ============================================================

export type SplashLine = 'maxi' | 'retail' | 'inox' | 'castor' | 'industrial';

const LINES: Record<SplashLine, { b: string; ar: number }> = {
  maxi: { b: '#e6007e', ar: 720 / 239 },
  retail: { b: '#f59612', ar: 720 / 205 },
  inox: { b: '#247afa', ar: 300 / 93 },
  castor: { b: '#5a6169', ar: 720 / 238 },
  industrial: { b: '#006fb5', ar: 720 / 216 },
};

const src = (l: SplashLine, p: string) => `/branding/splash/${l}-${p}.png`;
const im = (l: SplashLine, p: string, x: number, y: number, w: number, attrs = '') =>
  `<image ${attrs} href="${src(l, p)}" x="${x}" y="${y}" width="${w}" height="${(w / LINES[l].ar).toFixed(1)}" preserveAspectRatio="xMidYMid meet"/>`;

function gear(cx: number, cy: number, r: number, t: number) {
  let d = '';
  const n = t * 2;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const a2 = ((i + 1) / n) * Math.PI * 2;
    const rr = i % 2 ? r : r * 1.18;
    d += `${i ? 'L' : 'M'}${(cx + rr * Math.cos(a)).toFixed(1)} ${(cy + rr * Math.sin(a)).toFixed(1)}L${(cx + rr * Math.cos(a2)).toFixed(1)} ${(cy + rr * Math.sin(a2)).toFixed(1)}`;
  }
  return `${d}Z`;
}
const starP = (x: number, y: number, s: number) =>
  `M${x} ${y - s} l${s * 0.3} ${s * 0.7} l${s * 0.7} ${s * 0.3} l${-s * 0.7} ${s * 0.3} l${-s * 0.3} ${s * 0.7} l${-s * 0.3} ${-s * 0.7} l${-s * 0.7} ${-s * 0.3} l${s * 0.7} ${-s * 0.3}z`;
const shine = (delay: number) =>
  `<rect class="shineBand" x="-120" y="-20" width="90" height="240" fill="url(#ss-shineG)" transform="skewX(-20)" style="animation-delay:${delay}s"/>`;
const pallet = (x: number, y: number, w: number) =>
  `<rect x="${x}" y="${y}" width="${w}" height="4" fill="#b07a45"/><rect x="${x}" y="${y + 7}" width="${w}" height="3" fill="#b07a45"/>${[0, 0.47, 0.94]
    .map((f) => `<rect x="${(x + f * (w - 10)).toFixed(1)}" y="${y + 3}" width="10" height="5" fill="#8d5f33"/>`)
    .join('')}`;

const DEFS = `<defs>
 <linearGradient id="ss-shineG" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".85"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
 <linearGradient id="ss-steelDark" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a4047"/><stop offset="1" stop-color="#1f2328"/></linearGradient>
 <linearGradient id="ss-brushed" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#eceff2"/><stop offset=".45" stop-color="#c3c9cf"/><stop offset=".55" stop-color="#f1f3f5"/><stop offset="1" stop-color="#b3bac1"/></linearGradient>
 <linearGradient id="ss-steelCab" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#cfd5db"/><stop offset="1" stop-color="#9aa3ab"/></linearGradient>
 <pattern id="ss-hair" width="400" height="3" patternUnits="userSpaceOnUse"><rect width="400" height="1" fill="#fff" opacity=".35"/></pattern>
 <pattern id="ss-grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" fill="none" stroke="#5b8fc4" stroke-opacity=".25" stroke-width="1"/></pattern>
 <pattern id="ss-wood" width="60" height="200" patternUnits="userSpaceOnUse"><rect width="60" height="200" fill="#c99a6b"/><path d="M5 0C12 50 0 100 8 200M22 0C30 60 18 120 26 200M40 0C46 40 36 130 44 200M54 0C58 70 50 140 56 200" stroke="#a87a4e" stroke-width="2" fill="none" opacity=".55"/></pattern>
 <pattern id="ss-woodH" width="200" height="40" patternUnits="userSpaceOnUse"><rect width="200" height="40" fill="#c99a6b"/><path d="M0 6C60 12 120 0 200 7M0 20C70 26 130 14 200 22M0 33C60 38 140 28 200 35" stroke="#a87a4e" stroke-width="2" fill="none" opacity=".55"/></pattern>
 <linearGradient id="ss-bulbG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff7c2"/><stop offset="1" stop-color="#ffd23f"/></linearGradient>
 <linearGradient id="ss-flameG" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#1e6bff"/><stop offset=".6" stop-color="#46b3ff"/><stop offset="1" stop-color="#c8ecff"/></linearGradient>
 <filter id="ss-hotF"><feFlood flood-color="#ff8a00"/><feComposite in2="SourceAlpha" operator="in"/><feGaussianBlur stdDeviation=".6"/></filter>
 <filter id="ss-emboss"><feDropShadow dx="0" dy="1" stdDeviation="0" flood-color="#fff" flood-opacity=".9"/><feDropShadow dx="0" dy="-1" stdDeviation="0" flood-color="#000" flood-opacity=".3"/></filter>
 <pattern id="ss-hz" width="16" height="10" patternUnits="userSpaceOnUse" patternTransform="skewX(-35)"><rect width="8" height="10" fill="#ffb703"/><rect x="8" width="8" height="10" fill="#2b3138"/></pattern>
</defs>`;

type Scene = { cls: string; label: string; svg: () => string };

const SCENES: Record<SplashLine, [Scene, Scene]> = {
  maxi: [
    {
      cls: 'm1',
      label: 'Carrito de compras',
      svg: () => {
        const b = LINES.maxi.b;
        return `<line class="floor" x1="10" y1="190" x2="390" y2="190" stroke="rgba(0,0,0,.15)" stroke-width="2"/>
  <g class="cart"><g transform="translate(200 150) scale(.72) translate(-200 -150)">
    <rect class="item" x="168" y="128" width="20" height="18" rx="2" fill="#ffb703" style="animation-delay:.72s"/>
    <rect class="item" x="190" y="120" width="16" height="26" rx="3" fill="#06d6a0" style="animation-delay:.8s"/>
    <rect class="item" x="208" y="130" width="22" height="16" rx="2" fill="#118ab2" style="animation-delay:.88s"/>
    <path d="M140 118 L152 118 L162 168 L238 168 L248 130 L156 130" fill="none" stroke="${b}" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/>
    <path d="M158 140 L244 140 M160 152 L241 152 M180 130 L184 168 M204 130 L206 168 M226 130 L222 168" stroke="${b}" stroke-width="2.5" opacity=".7"/>
    <g class="wheel"><circle cx="172" cy="180" r="9" fill="#2b3138"/><circle cx="172" cy="180" r="3" fill="#cfd4d9"/><rect x="171" y="172" width="2" height="5" fill="#cfd4d9"/></g>
    <g class="wheel"><circle cx="230" cy="180" r="9" fill="#2b3138"/><circle cx="230" cy="180" r="3" fill="#cfd4d9"/><rect x="229" y="172" width="2" height="5" fill="#cfd4d9"/></g>
  </g></g>
  ${['top', 'bot', 'word', 'sub']
    .map((p, i) => `<g class="pc" style="animation-delay:${(0.95 + i * 0.1).toFixed(2)}s">${im('maxi', p, 86, 48, 228)}</g>`)
    .join('')}
  <path class="star" d="${starP(330, 46, 9)}" fill="#ffd23f" style="animation-delay:1.6s"/>
  <path class="star" d="${starP(74, 128, 6)}" fill="${b}" style="animation-delay:1.75s"/>`;
      },
    },
    {
      cls: 'm2',
      label: 'Góndola',
      svg: () => {
        const b = LINES.maxi.b;
        const cols = [b, '#ffb703', '#06d6a0', '#118ab2', '#ef476f', '#8338ec'];
        let prods = '';
        ([[106, 0.65], [134, 0.8], [162, 0.95]] as const).forEach(([y, dl], si) => {
          for (let i = 0; i < 7; i++) {
            const x = 128 + i * 21 + (si % 2 ? 6 : 0);
            const h = 13 + ((i * 7 + si * 3) % 3) * 4;
            prods += `<rect class="prod" x="${x}" y="${y - h}" width="14" height="${h}" rx="2" fill="${cols[(i + si * 2) % 6]}" style="animation-delay:${(dl + i * 0.04).toFixed(2)}s"/>`;
          }
        });
        return `<line x1="20" y1="190" x2="380" y2="190" stroke="rgba(0,0,0,.15)" stroke-width="2"/>
   <rect class="up" x="114" y="74" width="8" height="116" rx="2" fill="#cfd4d9"/><rect class="up" x="278" y="74" width="8" height="116" rx="2" fill="#cfd4d9" style="animation-delay:.08s"/>
   <rect class="fadeIn" x="114" y="174" width="172" height="16" rx="2" fill="${b}" style="animation-delay:.2s"/>
   <rect class="shelf" x="118" y="106" width="164" height="5" rx="2" fill="#aab2ba" style="animation-delay:.35s"/><rect class="shelf" x="118" y="134" width="164" height="5" rx="2" fill="#aab2ba" style="--fx:-60px;animation-delay:.45s"/><rect class="shelf" x="118" y="162" width="164" height="5" rx="2" fill="#aab2ba" style="animation-delay:.55s"/>
   ${prods}
   <g class="sign"><line x1="150" y1="-40" x2="150" y2="8" stroke="#9aa0a6" stroke-width="2"/><line x1="250" y1="-40" x2="250" y2="8" stroke="#9aa0a6" stroke-width="2"/>
   <rect x="96" y="6" width="208" height="70" rx="10" fill="#fff" stroke="${b}" stroke-width="2.5"/>${im('maxi', 'full', 108, 9, 184)}</g>`;
      },
    },
  ],
  retail: [
    {
      cls: 'r1',
      label: 'Corte láser',
      svg: () => {
        const X = 48;
        const Y = 57;
        const W = 304;
        const H = W / LINES.retail.ar;
        let sp = '';
        for (let i = 0; i < 9; i++) {
          sp += `<circle class="sp" cx="0" cy="${(Y + H * 0.6).toFixed(0)}" r="1.6" fill="#ffd76a" style="--sx:${-22 + i * 6}px;--sy:${16 + (i % 4) * 8}px;animation-delay:${(i * 0.05).toFixed(2)}s"/>`;
        }
        return `<rect width="400" height="200" fill="url(#ss-steelDark)"/><rect width="400" height="200" fill="url(#ss-hair)" opacity=".25"/>
   <rect x="24" y="12" width="352" height="6" rx="3" fill="#aeb5bc"/>
   <clipPath id="ss-r1c"><rect class="cut" x="${X}" y="0" width="${W}" height="200"/></clipPath>
   <g clip-path="url(#ss-r1c)">${im('retail', 'full', X, Y, W)}<g class="hot">${im('retail', 'full', X, Y, W, 'filter="url(#ss-hotF)"')}</g></g>
   <g class="beam" transform="translate(${X} 0)"><rect x="-13" y="14" width="26" height="18" rx="4" fill="#2a2f35" stroke="#555" stroke-width="1"/><rect x="-4" y="32" width="8" height="5" fill="#555"/>
     <rect x="-1.5" y="37" width="3" height="${(Y + H - 37).toFixed(0)}" rx="1.5" fill="#fff"/><rect x="-4" y="37" width="8" height="${(Y + H - 37).toFixed(0)}" rx="4" fill="#ff3b1f" opacity=".45"/>${sp}</g>`;
      },
    },
    {
      cls: 'r2',
      label: 'Del plano 2D al mueble 3D',
      svg: () => {
        const e = 'class="edge" pathLength="1"';
        return `<rect width="400" height="200" fill="#0f2c4a"/><rect width="400" height="200" fill="url(#ss-grid)"/>
   <g transform="translate(0 -10)">
   <path class="face" d="M110 160 L250 192 L250 142 L110 110Z" fill="#f59612" style="animation-delay:.95s"/>
   <path class="face" d="M250 192 L300 172 L300 122 L250 142Z" fill="#b8650a" style="animation-delay:1.02s"/>
   <path class="face" d="M110 110 L250 142 L300 122 L160 90Z" fill="#ffd9a3" style="animation-delay:1.09s"/>
   <path class="face" d="M128 140 L232 164" stroke="#8a4b05" stroke-width="2" style="animation-delay:1.15s"/>
   <path ${e} d="M110 160 L250 192 L250 142 L110 110Z"/><path ${e} d="M250 192 L300 172 L300 122 L250 142" style="animation-delay:.15s"/><path ${e} d="M110 110 L160 90 L300 122" style="animation-delay:.3s"/>
   <path class="dim" pathLength="1" d="M108 172 L248 204 M108 168 L108 176 M248 200 L248 208"/>
   <text class="dimtxt" x="150" y="194" fill="#cfe5fb" font-size="10" font-family="ui-monospace,monospace" transform="rotate(13 150 194)">1.80 m</text></g>
   <g class="logo">${im('retail', 'full', 86, 12, 228)}</g>`;
      },
    },
  ],
  inox: [
    {
      cls: 'i1',
      label: 'Prensa sobre acero',
      svg: () => `<g class="shake"><rect width="400" height="200" fill="url(#ss-brushed)"/>
   <path class="steam" d="M60 196 C50 176 72 166 60 146 C50 128 70 118 62 102" style="animation-delay:.3s"/>
   <path class="steam" d="M340 196 C330 176 352 166 340 146 C330 128 350 118 342 102" style="animation-delay:.6s"/>
   <g class="stamp" filter="url(#ss-emboss)">${im('inox', 'full', 52, 54, 296)}</g>
   ${shine(1.35)}
   <path class="star" d="${starP(318, 44, 8)}" fill="#fff" style="animation-delay:1.7s"/><path class="star" d="${starP(96, 150, 6)}" fill="#fff" style="animation-delay:1.9s"/></g>
   <g class="press"><rect x="190" y="-260" width="20" height="160" fill="#c9cfd5"/><rect x="40" y="-112" width="320" height="100" rx="8" fill="#3d444b"/><rect x="40" y="-24" width="320" height="12" rx="4" fill="#24292e"/></g>`,
    },
    {
      cls: 'i2',
      label: 'Cocina industrial',
      svg: () => {
        const fl = (x: number, d: number) =>
          `<g transform="translate(${x} 150)"><path class="flame" d="M0 0 C-12 -6 -9 -22 0 -32 C9 -22 12 -6 0 0Z" fill="url(#ss-flameG)" style="animation-delay:${d}s,${d + 0.35}s"/><path class="flame" d="M-14 0 C-20 -4 -18 -14 -12 -20 C-9 -12 -6 -6 -10 0Z" fill="url(#ss-flameG)" opacity=".85" style="animation-delay:${d + 0.05}s,${d + 0.4}s"/><path class="flame" d="M14 0 C20 -4 18 -14 12 -20 C9 -12 6 -6 10 0Z" fill="url(#ss-flameG)" opacity=".85" style="animation-delay:${d + 0.08}s,${d + 0.43}s"/></g>`;
        return `<rect width="400" height="150" fill="url(#ss-brushed)"/><rect width="400" height="150" fill="url(#ss-hair)" opacity=".4"/>
   <rect y="146" width="400" height="8" fill="#e6eaee"/><rect y="154" width="400" height="46" fill="url(#ss-steelCab)"/>
   <path d="M133 154V200M266 154V200" stroke="#7d868f" stroke-width="1.5"/>${[66, 200, 334]
     .map((x) => `<circle cx="${x}" cy="178" r="6" fill="#2b3138"/><rect x="${x - 1}" y="172" width="2" height="6" fill="#cfd5db"/>`)
     .join('')}
   ${[110, 200, 290].map((x) => `<ellipse cx="${x}" cy="150" rx="24" ry="3" fill="#2b3138"/>`).join('')}
   ${fl(110, 0.2)}${fl(200, 0.42)}${fl(290, 0.64)}
   <path class="steam" d="M200 118 C190 100 210 90 200 72" style="animation-delay:.9s"/><path class="steam" d="M110 118 C100 100 120 92 110 76" style="animation-delay:1.1s"/>
   <g class="logo">${im('inox', 'full', 62, 18, 276)}</g>${shine(1.5)}`;
      },
    },
  ],
  castor: [
    {
      cls: 'c1',
      label: 'Corte de melamina',
      svg: () => {
        let du = '';
        for (let i = 0; i < 8; i++) {
          du += `<circle class="dust" cx="-6" cy="100" r="1.8" fill="#d9b78f" style="--sx:${-14 - i * 4}px;--sy:${(i % 2 ? 1 : -1) * (6 + i * 3)}px;animation-delay:${(i * 0.06).toFixed(2)}s"/>`;
        }
        return `<rect width="400" height="200" fill="#f6f2ec"/>
   <g class="logo">${im('castor', 'full', 64, 55, 272)}</g>
   <g class="halfT"><rect x="-10" y="-10" width="420" height="110" fill="url(#ss-woodH)"/><rect x="-10" y="97" width="420" height="3" fill="#7a5532"/></g>
   <g class="halfB"><rect x="-10" y="100" width="420" height="110" fill="url(#ss-woodH)"/><rect x="-10" y="100" width="420" height="3" fill="#7a5532"/></g>
   <rect class="kerf" x="0" y="98.5" width="400" height="3" fill="#3b2a1a"/>
   <g class="blade" transform="translate(-10 0)">${du}<g class="teeth"><path d="${gear(0, 100, 26, 18)}" fill="#c4cad0" stroke="#7d868f" stroke-width="1"/><circle cx="0" cy="100" r="9" fill="#5a6169"/><circle cx="0" cy="100" r="3" fill="#cfd5db"/></g></g>`;
      },
    },
    {
      cls: 'c2',
      label: 'Mueble de melamina',
      svg: () => `<rect width="400" height="200" fill="#f6f2ec"/><line x1="10" y1="190" x2="390" y2="190" stroke="rgba(0,0,0,.15)" stroke-width="2"/>
   <rect class="back" x="34" y="50" width="94" height="136" fill="#e8dccb"/>
   <rect class="pS" x="34" y="116" width="94" height="7" fill="url(#ss-woodH)"/>
   <rect class="pL" x="26" y="42" width="9" height="148" fill="url(#ss-wood)"/><rect class="pR" x="127" y="42" width="9" height="148" fill="url(#ss-wood)"/>
   <rect class="pT" x="22" y="36" width="118" height="9" rx="1" fill="url(#ss-woodH)"/>
   <rect class="door doorL" x="35" y="46" width="46" height="140" fill="url(#ss-wood)" stroke="#a87a4e" stroke-width="1" style="animation-delay:.85s"/>
   <rect class="door doorR" x="81" y="46" width="46" height="140" fill="url(#ss-wood)" stroke="#a87a4e" stroke-width="1" style="animation-delay:.95s"/>
   <rect class="knob" x="74" y="108" width="3" height="16" rx="1.5" fill="#5a6169"/><rect class="knob" x="85" y="108" width="3" height="16" rx="1.5" fill="#5a6169"/>
   <g transform="translate(81 6)"><g class="bulb"><circle cx="0" cy="14" r="16" fill="#ffd23f" opacity=".35"/><path d="M-9 14 a9 9 0 1 1 18 0 c0 5 -4 7 -4 10 h-10 c0 -3 -4 -5 -4 -10z" fill="url(#ss-bulbG)" stroke="#e0a800" stroke-width="1.2"/><rect x="-5" y="24" width="10" height="5" rx="1.5" fill="#8b939b"/></g>
   <g class="rays" stroke="#ffb703" stroke-width="2" stroke-linecap="round"><line x1="-16" y1="4" x2="-23" y2="-1"/><line x1="16" y1="4" x2="23" y2="-1"/><line x1="-18" y1="18" x2="-26" y2="19"/><line x1="18" y1="18" x2="26" y2="19"/></g></g>
   <g class="logo">${im('castor', 'full', 150, 60, 236)}</g>`,
    },
  ],
  industrial: [
    {
      cls: 'n1',
      label: 'Rack armándose',
      svg: () => {
        const b = LINES.industrial.b;
        const box = (x: number, y: number, c: string) =>
          `<rect x="${x}" y="${y}" width="22" height="18" fill="${c}" stroke="#8d5f33" stroke-width=".8"/><path d="M${x + 8} ${y}v6h6v-6" fill="none" stroke="#8d5f33" stroke-width=".8"/>`;
        const pal = (x: number, y: number, d: number) =>
          `<g class="pallet" style="animation-delay:${d}s">${pallet(x, y, 64)}${box(x + 4, y - 18, '#d9b07a')}${box(x + 28, y - 18, '#e3bd8a')}${box(x + 16, y - 36, '#cfa36a')}</g>`;
        return `<line x1="10" y1="190" x2="390" y2="190" stroke="rgba(0,0,0,.15)" stroke-width="2"/>
   ${[40, 196, 352]
     .map(
       (x, i) =>
         `<rect class="up" x="${x}" y="98" width="8" height="92" fill="${b}" style="animation-delay:${i * 0.07}s"/>${Array.from({ length: 9 }, (_, k) => `<rect x="${x + 3}" y="${102 + k * 10}" width="2" height="4" fill="#fff" opacity=".5"/>`).join('')}`
     )
     .join('')}
   ${([[98, 0.35], [142, 0.45]] as const)
     .map(
       ([y, d]) =>
         `<rect class="beam" x="48" y="${y}" width="148" height="7" fill="#f97316" style="animation-delay:${d}s"/><rect class="beam" x="204" y="${y}" width="148" height="7" fill="#f97316" style="animation-delay:${d + 0.05}s"/>`
     )
     .join('')}
   ${pal(84, 132, 0.7)}${pal(240, 132, 0.8)}${pal(84, 180, 0.9)}${pal(240, 180, 1)}
   ${([['A-01', 56, 145], ['A-02', 212, 145]] as const)
     .map(
       ([t, x, y]) =>
         `<g class="label" style="animation-delay:1.25s"><rect x="${x}" y="${y - 2}" width="24" height="9" rx="1.5" fill="#ffd23f"/><text x="${x + 12}" y="${y + 5}" text-anchor="middle" font-size="6.5" font-weight="700" font-family="sans-serif" fill="#2b3138">${t}</text></g>`
     )
     .join('')}
   <g class="logo">${im('industrial', 'full', 70, 6, 260)}</g>`;
      },
    },
    {
      cls: 'n2',
      label: 'Montacargas',
      svg: () => {
        const b = LINES.industrial.b;
        return `<line x1="10" y1="192" x2="390" y2="192" stroke="rgba(0,0,0,.15)" stroke-width="2"/><rect x="0" y="192" width="400" height="8" fill="url(#ss-hz)" opacity=".8"/>
   <rect x="30" y="40" width="8" height="152" fill="${b}"/><rect x="362" y="40" width="8" height="152" fill="${b}"/>
   <rect x="38" y="44" width="324" height="6" fill="#f97316"/><rect x="38" y="160" width="324" height="7" fill="#f97316"/>
   <g class="label"><rect x="188" y="168" width="24" height="9" rx="1.5" fill="#ffd23f"/><text x="200" y="175" text-anchor="middle" font-size="6.5" font-weight="700" font-family="sans-serif" fill="#2b3138">B-02</text></g>
   <g class="load">${pallet(72, 150, 256)}${im('industrial', 'full', 80, 70, 240)}</g>
   <g class="body">
     <rect x="58" y="62" width="6" height="128" fill="#3d434a"/>
     <g class="forks"><rect x="64" y="150" width="4" height="10" fill="#2b3138"/><rect x="64" y="154" width="110" height="4" fill="#2b3138"/></g>
     <path d="M-6 136 L56 136 L56 182 L-6 182Z" fill="#ffb703"/><rect x="-10" y="140" width="10" height="38" rx="2" fill="#2b3138"/>
     <path d="M8 136 L14 96 L52 96 L56 136" fill="none" stroke="#2b3138" stroke-width="3"/>
     <g class="wheel"><circle cx="8" cy="184" r="9" fill="#2b3138"/><circle cx="8" cy="184" r="3" fill="#cfd4d9"/></g><g class="wheel"><circle cx="44" cy="184" r="8" fill="#2b3138"/><circle cx="44" cy="184" r="3" fill="#cfd4d9"/></g>
   </g>`;
      },
    },
  ],
};

// Scoped under .ss-scene; keyframes prefixed ss- so nothing leaks.
const CSS = `
.ss-scene{display:block;width:100%;height:auto;aspect-ratio:2/1}
.ss-scene *{transform-box:fill-box}
@keyframes ss-fade{from{opacity:0}to{opacity:1}}
@keyframes ss-spin{to{transform:rotate(360deg)}}
@keyframes ss-popIn{0%{opacity:0;transform:scale(.3)}70%{opacity:1;transform:scale(1.08)}100%{opacity:1;transform:none}}
@keyframes ss-riseIn{0%{opacity:0;transform:translateY(14px)}100%{opacity:1;transform:none}}
@keyframes ss-twinkle{0%{opacity:0;transform:scale(0) rotate(0)}50%{opacity:1;transform:scale(1.2) rotate(45deg)}100%{opacity:0;transform:scale(.5) rotate(90deg)}}
@keyframes ss-draw{to{stroke-dashoffset:0}}
@keyframes ss-growY{0%{transform:scaleY(0)}100%{transform:none}}
@keyframes ss-growX{0%{transform:scaleX(0)}100%{transform:none}}
@keyframes ss-sweep{0%{transform:translateX(-260px)}100%{transform:translateX(460px)}}
@keyframes ss-steam{0%{stroke-dashoffset:90;opacity:0}30%{opacity:.9}100%{stroke-dashoffset:-90;opacity:0;transform:translateY(-14px)}}
@keyframes ss-spark{0%{opacity:1;transform:translate(0,0)}100%{opacity:0;transform:translate(var(--sx),var(--sy))}}
.ss-scene .fadeIn{animation:ss-fade .3s both}
.ss-scene .shineBand{animation:ss-sweep .9s ease-in-out both}
.ss-scene .star{animation:ss-twinkle .7s ease-out both;transform-origin:50% 50%}
.ss-scene .steam{fill:none;stroke:rgba(255,255,255,.9);stroke-width:4;stroke-linecap:round;stroke-dasharray:90;stroke-dashoffset:90;animation:ss-steam 1.6s ease-out both}

.ss-scene.m1 .cart{animation:ss-m1cart 2.4s cubic-bezier(.45,0,.25,1) both}
.ss-scene.m1 .wheel{transform-origin:50% 50%;animation:ss-spin .35s linear 6}
.ss-scene.m1 .item{animation:ss-m1hop .4s cubic-bezier(.3,1.6,.5,1) both}
.ss-scene.m1 .pc{animation:ss-m1fly .6s cubic-bezier(.2,1.25,.4,1) both;transform-origin:50% 100%}
.ss-scene.m1 .floor{animation:ss-fade .3s both}
@keyframes ss-m1cart{0%{transform:translateX(-300px)}28%{transform:translateX(0)}32%{transform:translateX(-5px)}36%,62%{transform:translateX(0)}100%{transform:translateX(330px)}}
@keyframes ss-m1hop{0%{opacity:0;transform:translateY(-46px) rotate(-25deg)}100%{opacity:1;transform:none}}
@keyframes ss-m1fly{0%{opacity:0;transform:translateY(70px) scale(.12)}100%{opacity:1;transform:none}}

.ss-scene.m2 .up{transform-origin:50% 100%;animation:ss-growY .45s cubic-bezier(.3,1.3,.5,1) both}
.ss-scene.m2 .shelf{animation:ss-m2slide .4s cubic-bezier(.3,1.3,.5,1) both}
.ss-scene.m2 .prod{animation:ss-m2drop .45s cubic-bezier(.3,1.5,.5,1) both}
.ss-scene.m2 .sign{transform-origin:50% -30%;animation:ss-m2sign 1s cubic-bezier(.3,1.2,.5,1) 1.15s both}
@keyframes ss-m2slide{0%{opacity:0;transform:translateX(var(--fx,60px))}100%{opacity:1;transform:none}}
@keyframes ss-m2drop{0%{opacity:0;transform:translateY(-36px)}100%{opacity:1;transform:none}}
@keyframes ss-m2sign{0%{opacity:0;transform:translateY(-110px)}40%{opacity:1;transform:translateY(0) rotate(5deg)}60%{transform:rotate(-3.5deg)}78%{transform:rotate(1.8deg)}100%{opacity:1;transform:none}}

.ss-scene.r1 .cut{transform-origin:0 50%;animation:ss-growX 1.5s cubic-bezier(.55,0,.35,1) .35s both}
.ss-scene.r1 .beam{animation:ss-r1beam 1.5s cubic-bezier(.55,0,.35,1) .35s both}
.ss-scene.r1 .hot{animation:ss-r1cool 1.1s ease-out 1.15s both}
.ss-scene.r1 .sp{animation:ss-spark .45s ease-out 4}
@keyframes ss-r1beam{0%{transform:translateX(0);opacity:1}92%{opacity:1}100%{transform:translateX(304px);opacity:0}}
@keyframes ss-r1cool{0%{opacity:1}100%{opacity:0}}

.ss-scene.r2 .edge{fill:none;stroke:#ffb347;stroke-width:2;stroke-linejoin:round;stroke-dasharray:1;stroke-dashoffset:1;animation:ss-draw .9s ease-in-out both}
.ss-scene.r2 .face{animation:ss-fade .45s ease-out both}
.ss-scene.r2 .dim{stroke:#9cc3e6;stroke-width:1.2;stroke-dasharray:1;stroke-dashoffset:1;animation:ss-draw .5s ease-out 1s both}
.ss-scene.r2 .dimtxt{animation:ss-fade .3s ease-out 1.35s both}
.ss-scene.r2 .logo{animation:ss-r2logo .6s cubic-bezier(.2,1.2,.4,1) 1.45s both}
@keyframes ss-r2logo{0%{opacity:0;transform:translateY(10px)}100%{opacity:1;transform:none}}

.ss-scene.i1 .stamp{animation:ss-i1stamp .8s linear both}
.ss-scene.i1 .press{animation:ss-i1press 1.3s cubic-bezier(.6,0,.3,1) .1s both}
.ss-scene.i1 .shake{animation:ss-i1shake .25s linear .78s both}
@keyframes ss-i1stamp{0%,97%{opacity:0}100%{opacity:1}}
@keyframes ss-i1press{0%{transform:translateY(0)}45%{transform:translateY(150px)}52%{transform:translateY(146px) scaleY(.97)}70%{transform:translateY(146px)}100%{transform:translateY(-10px)}}
@keyframes ss-i1shake{0%,100%{transform:none}25%{transform:translate(2px,1px)}50%{transform:translate(-2px,-1px)}75%{transform:translate(1px,-1px)}}

.ss-scene.i2 .flame{transform-origin:50% 100%;animation:ss-i2ignite .35s cubic-bezier(.3,1.6,.5,1) both,ss-i2flick .16s ease-in-out 12 alternate}
.ss-scene.i2 .logo{animation:ss-riseIn .6s cubic-bezier(.2,1.1,.4,1) 1.05s both}
@keyframes ss-i2ignite{0%{opacity:0;transform:scaleY(0)}100%{opacity:1;transform:none}}
@keyframes ss-i2flick{0%{transform:scaleY(1) scaleX(1)}100%{transform:scaleY(1.12) scaleX(.94)}}

.ss-scene.c1 .blade{animation:ss-c1blade 1.1s cubic-bezier(.5,0,.4,1) .2s both}
.ss-scene.c1 .teeth{transform-origin:50% 50%;animation:ss-spin .18s linear 8}
.ss-scene.c1 .kerf{transform-origin:0 50%;animation:ss-growX 1.1s cubic-bezier(.5,0,.4,1) .2s both,ss-c1kerfOut .2s ease-out 1.4s forwards}
.ss-scene.c1 .halfT{animation:ss-c1up .6s cubic-bezier(.6,0,.3,1) 1.4s both}
.ss-scene.c1 .halfB{animation:ss-c1down .6s cubic-bezier(.6,0,.3,1) 1.4s both}
.ss-scene.c1 .dust{animation:ss-spark .5s ease-out 3}
.ss-scene.c1 .logo{animation:ss-popIn .5s ease-out 1.55s both}
@keyframes ss-c1blade{0%{transform:translateX(0)}100%{transform:translateX(470px)}}
@keyframes ss-c1up{to{transform:translateY(-110px)}}
@keyframes ss-c1down{to{transform:translateY(110px)}}
@keyframes ss-c1kerfOut{to{opacity:0}}

.ss-scene.c2 .pL{animation:ss-c2fromL .45s cubic-bezier(.3,1.3,.5,1) both}
.ss-scene.c2 .pR{animation:ss-c2fromR .45s cubic-bezier(.3,1.3,.5,1) .1s both}
.ss-scene.c2 .pT{animation:ss-c2fromT .45s cubic-bezier(.3,1.3,.5,1) .25s both}
.ss-scene.c2 .pS{animation:ss-c2fromR .4s cubic-bezier(.3,1.3,.5,1) .4s both}
.ss-scene.c2 .back{animation:ss-fade .3s .5s both}
.ss-scene.c2 .door{animation:ss-growX .45s cubic-bezier(.3,1.2,.5,1) both}
.ss-scene.c2 .doorL{transform-origin:0 50%}
.ss-scene.c2 .doorR{transform-origin:100% 50%}
.ss-scene.c2 .knob{animation:ss-popIn .3s ease-out 1.25s both;transform-origin:50% 50%}
.ss-scene.c2 .logo{animation:ss-riseIn .6s cubic-bezier(.2,1.1,.4,1) 1.2s both}
.ss-scene.c2 .bulb{transform-origin:50% 100%;animation:ss-popIn .45s 1.55s both}
.ss-scene.c2 .rays line{stroke-dasharray:10;stroke-dashoffset:10;animation:ss-draw .35s ease-out 1.85s both}
@keyframes ss-c2fromL{0%{opacity:0;transform:translateX(-80px) rotate(-12deg)}100%{opacity:1;transform:none}}
@keyframes ss-c2fromR{0%{opacity:0;transform:translateX(80px) rotate(12deg)}100%{opacity:1;transform:none}}
@keyframes ss-c2fromT{0%{opacity:0;transform:translateY(-70px)}100%{opacity:1;transform:none}}

.ss-scene.n1 .up{transform-origin:50% 100%;animation:ss-growY .45s cubic-bezier(.3,1.3,.5,1) both}
.ss-scene.n1 .beam{transform-origin:0 50%;animation:ss-growX .3s cubic-bezier(.3,1.3,.5,1) both}
.ss-scene.n1 .pallet{animation:ss-n1drop .45s cubic-bezier(.3,1.4,.5,1) both}
.ss-scene.n1 .label{animation:ss-fade .25s both}
.ss-scene.n1 .logo{animation:ss-popIn .55s ease-out 1.35s both;transform-origin:50% 100%}
@keyframes ss-n1drop{0%{opacity:0;transform:translateY(-40px)}100%{opacity:1;transform:none}}

.ss-scene.n2 .body{animation:ss-n2body 2.4s ease-in-out both}
.ss-scene.n2 .forks{animation:ss-n2forks 2.4s ease-in-out both}
.ss-scene.n2 .load{animation:ss-n2load 2.4s ease-in-out both}
.ss-scene.n2 .wheel{transform-origin:50% 50%;animation:ss-spin .4s linear 2}
.ss-scene.n2 .label{animation:ss-fade .3s 1.7s both}
@keyframes ss-n2body{0%{transform:translateX(-330px)}40%,72%{transform:translateX(0)}100%{transform:translateX(-330px)}}
@keyframes ss-n2forks{0%,40%{transform:translateY(30px)}62%{transform:translateY(-6px)}72%{transform:translateY(0)}80%,100%{transform:translateY(3px)}}
@keyframes ss-n2load{0%{transform:translate(-330px,30px)}40%{transform:translate(0,30px)}62%{transform:translate(0,-6px)}72%,100%{transform:translate(0,0)}}
`;

// Waits for every image URL to finish (or fail) loading.
function preload(urls: string[]): Promise<void> {
  return Promise.all(
    urls.map(
      (url) =>
        new Promise<void>((resolve) => {
          const img = new Image();
          img.onload = img.onerror = () => resolve();
          img.src = url;
        })
    )
  ).then(() => undefined);
}

/**
 * One of the line's two scenes, picked at random per mount (client-only,
 * so server and first client render agree: nothing until the pick).
 * Reduced motion → the plain logo.
 *
 * The SVG only mounts once its images are downloaded: its CSS animations
 * start on mount, so on a cold first load they used to play (and end)
 * before the logo had arrived. `onReady` fires at that moment so the
 * splash can start its own hold timer then, not on page load.
 */
export function SplashScene({
  line,
  logoSrc,
  alt,
  onReady,
}: {
  line: SplashLine;
  logoSrc: string;
  alt: string;
  onReady?: () => void;
}) {
  const [pick, setPick] = useState<0 | 1 | 'still' | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time client-only pick (random + media query), can't run during SSR
    setPick(reduce ? 'still' : Math.random() < 0.5 ? 0 : 1);
  }, []);

  useEffect(() => {
    if (pick === null) return;
    const urls =
      pick === 'still'
        ? [logoSrc]
        : [...new Set(Array.from(SCENES[line][pick].svg().matchAll(/href="([^"]+)"/g), (m) => m[1]))];
    let cancelled = false;
    preload(urls).then(() => {
      if (!cancelled) setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [pick, line, logoSrc]);

  useEffect(() => {
    if (loaded) onReady?.();
  }, [loaded, onReady]);

  // Reserve the 2:1 box while the scene is being picked, so the card
  // doesn't collapse for a frame.
  if (pick === null || !loaded) return <div className="aspect-[2/1] w-full" aria-hidden="true" />;
  if (pick === 'still') {
    return (
      <div className="flex aspect-[2/1] w-full items-center justify-center p-6">
        {/* eslint-disable-next-line @next/next/no-img-element -- static brand asset */}
        <img src={logoSrc} alt={alt} className="h-auto w-[78%]" />
      </div>
    );
  }

  const scene = SCENES[line][pick];
  return (
    <>
      <style>{CSS}</style>
      <svg
        className={`ss-scene ${scene.cls}`}
        viewBox="0 0 400 200"
        role="img"
        aria-label={`${alt} — ${scene.label}`}
        dangerouslySetInnerHTML={{ __html: DEFS + scene.svg() }}
      />
    </>
  );
}
