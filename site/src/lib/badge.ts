/**
 * README badges: a small, self-contained SVG per library, in the familiar
 * "label | value" shape. Left: the lattice mark and "PQC". Right: the
 * library's status in its status colour. Text widths come from a Verdana
 * width table (the font badges conventionally use), and `textLength` pins
 * the rendered width so other fallback fonts still fit the box.
 */
import { STATUS_INFO, type Status } from '@pqc-deps/core';

/** Solid status colours with white text at ≥ 4.5:1 contrast. */
export const BADGE_COLORS: Record<Status, string> = {
  ready: '#13693f',
  available: '#0a6176',
  partial: '#8a5300',
  planned: '#5d3aa6',
  'no-plan': '#a3271d',
  unknown: '#5a5850',
  'n/a': '#34507a',
};
const LABEL_BG = '#121722';
const ACCENT = '#ff8a3d';

// Verdana 11px advance widths (px) for the characters badges use.
const W: Record<string, number> = {
  ' ': 3.87,
  '-': 4.87,
  '/': 4.87,
  '.': 3.83,
  '0': 7,
  '1': 7,
  '2': 7,
  '3': 7,
  '4': 7,
  '5': 7,
  '6': 7,
  '7': 7,
  '8': 7,
  '9': 7,
  a: 6.66,
  b: 6.85,
  c: 5.73,
  d: 6.85,
  e: 6.6,
  f: 3.86,
  g: 6.85,
  h: 6.96,
  i: 3.01,
  j: 3.79,
  k: 6.5,
  l: 3.01,
  m: 10.7,
  n: 6.96,
  o: 6.68,
  p: 6.85,
  q: 6.85,
  r: 4.69,
  s: 5.73,
  t: 4.33,
  u: 6.96,
  v: 6.5,
  w: 8.98,
  x: 6.5,
  y: 6.5,
  z: 5.77,
  A: 7.52,
  B: 7.52,
  C: 7.66,
  D: 8.48,
  E: 6.95,
  F: 6.32,
  G: 8.52,
  H: 8.27,
  I: 4.62,
  K: 7.62,
  L: 6.12,
  M: 9.27,
  N: 8.22,
  O: 8.65,
  P: 6.63,
  Q: 8.65,
  R: 7.65,
  S: 7.52,
  T: 6.78,
  U: 8.05,
};
export const textWidth = (s: string) => [...s].reduce((n, c) => n + (W[c] ?? 7), 0);

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Status text shown on the badge ("no plan", "delegates", …). */
export const badgeText = (status: Status) => STATUS_INFO[status].label.toLowerCase();

export function badgeSvg(status: Status, libraryName: string): string {
  const label = 'PQC';
  const value = badgeText(status);
  const pad = 6;
  const logo = 12; // 3×3 lattice mark
  const labelW = Math.round(pad + logo + 4 + textWidth(label) + pad);
  const valueW = Math.round(pad + textWidth(value) + pad);
  const w = labelW + valueW;
  const title = `PQC Deps: ${libraryName} is ${STATUS_INFO[status].label} (${STATUS_INFO[status].description})`;
  const dots = [0, 1, 2]
    .flatMap((r) => [0, 1, 2].map((c) => [c, r] as const))
    .map(([c, r]) => {
      const fill = c === 1 && r === 1 ? ACCENT : '#ece8dd';
      return `<circle cx="${pad + 2 + c * 4}" cy="${6 + r * 4}" r="1.5" fill="${fill}"/>`;
    })
    .join('');
  const tx = (x: number, text: string, len: number) =>
    `<text x="${x * 10}" y="150" transform="scale(.1)" fill="#000" fill-opacity=".25" textLength="${len * 10}" aria-hidden="true">${esc(text)}</text>` +
    `<text x="${x * 10}" y="140" transform="scale(.1)" fill="#fff" textLength="${len * 10}">${esc(text)}</text>`;
  const labelX = pad + logo + 4;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${esc(`PQC: ${value}`)}"><title>${esc(title)}</title><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#r)"><rect width="${labelW}" height="20" fill="${LABEL_BG}"/><rect x="${labelW}" width="${valueW}" height="20" fill="${BADGE_COLORS[status]}"/><rect width="${w}" height="20" fill="url(#s)"/></g>${dots}<g font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="110" text-rendering="geometricPrecision" text-anchor="start">${tx(labelX, label, textWidth(label))}${tx(labelW + pad, value, textWidth(value))}</g></svg>`;
}

export const badgeUrl = (site: URL | string, id: string) =>
  new URL(`/badge/${id}.svg`, site).toString();
export const libraryUrl = (site: URL | string, id: string) =>
  new URL(`/libraries/${id}`, site).toString();
export const badgeMarkdown = (site: URL | string, id: string) =>
  `[![PQC status](${badgeUrl(site, id)})](${libraryUrl(site, id)})`;
