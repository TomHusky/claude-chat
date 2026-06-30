// Render the brand sunburst (media/icon.svg) into a 256x256 PNG with a dark
// rounded-square background, for use as the extension gallery icon.
// Pure Node (zlib only) — no native/image deps. Run: node scripts/gen-icon.js
const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

const SIZE = 256;
const S = SIZE / 24; // SVG is a 24x24 viewBox
const STROKE = 2.2 * S; // match the SVG stroke-width
const HALF = STROKE / 2;
const RADIUS = 52; // background corner radius
const BG = [0x14, 0x16, 0x1c]; // dark charcoal

// 12 spokes from media/icon.svg: [x1,y1,x2,y2,'#hex']
const LINES = [
  [16.0, 12.0, 23.0, 12.0, "#e74c3c"],
  [15.46, 14.0, 21.53, 17.5, "#e67e22"],
  [14.0, 15.46, 17.5, 21.53, "#f1c40f"],
  [12.0, 16.0, 12.0, 23.0, "#2ecc71"],
  [10.0, 15.46, 6.5, 21.53, "#27ae60"],
  [8.54, 14.0, 2.47, 17.5, "#1abc9c"],
  [8.0, 12.0, 1.0, 12.0, "#00bcd4"],
  [8.54, 10.0, 2.47, 6.5, "#3498db"],
  [10.0, 8.54, 6.5, 2.47, "#5b6cf0"],
  [12.0, 8.0, 12.0, 1.0, "#8e44ad"],
  [14.0, 8.54, 17.5, 2.47, "#c0399b"],
  [15.46, 10.0, 21.53, 6.5, "#e84393"],
].map(([x1, y1, x2, y2, c]) => ({
  x1: x1 * S, y1: y1 * S, x2: x2 * S, y2: y2 * S,
  col: [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)],
}));

const buf = Buffer.alloc(SIZE * SIZE * 4); // RGBA

function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}
function roundRectCoverage(px, py) {
  // signed coverage of a rounded square inset by 0 (full canvas), radius RADIUS
  const r = RADIUS;
  const cx = Math.min(Math.max(px, r), SIZE - r);
  const cy = Math.min(Math.max(py, r), SIZE - r);
  const inCorner = (px < r || px > SIZE - r) && (py < r || py > SIZE - r);
  if (!inCorner) return 1;
  const d = Math.hypot(px - cx, py - cy);
  return Math.max(0, Math.min(1, r + 0.5 - d));
}
function blend(i, col, a) {
  buf[i] = Math.round(buf[i] * (1 - a) + col[0] * a);
  buf[i + 1] = Math.round(buf[i + 1] * (1 - a) + col[1] * a);
  buf[i + 2] = Math.round(buf[i + 2] * (1 - a) + col[2] * a);
}

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4;
    const px = x + 0.5, py = y + 0.5;
    const bgA = roundRectCoverage(px, py);
    buf[i] = BG[0]; buf[i + 1] = BG[1]; buf[i + 2] = BG[2];
    buf[i + 3] = Math.round(255 * bgA);
    if (bgA <= 0) continue;
    for (const L of LINES) {
      const d = distToSeg(px, py, L.x1, L.y1, L.x2, L.y2);
      const cov = Math.max(0, Math.min(1, HALF + 0.5 - d));
      if (cov > 0) blend(i, L.col, cov * bgA);
    }
  }
}

// ---- PNG encode ----
function crc32(b) {
  let c = ~0;
  for (let i = 0; i < b.length; i++) {
    c ^= b[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter none
  buf.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
const out = path.join(__dirname, "..", "media", "icon.png");
fs.writeFileSync(out, png);
console.log("wrote", out, png.length, "bytes");
