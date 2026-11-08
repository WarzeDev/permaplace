// Dependency-free PNG/SVG generation: favicon, app icons and the social preview image.
import { deflateSync } from "node:zlib";
import { COLORS, BLACK, BLACK_DARK_HEX } from "../public/palette.js";
import { eachRun, GRID } from "./db.js";
import { CHUNK } from "../public/palette.js";

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(w, h, rgb) {
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const hex3 = (h) => [parseInt(h[0], 16) * 17, parseInt(h[1], 16) * 17, parseInt(h[2], 16) * 17];
const HEX_BY_CHAR = Object.fromEntries(COLORS.map(([c, h]) => [c, hex3(c === BLACK ? BLACK_DARK_HEX : h)]));

class Raster {
  constructor(w, h, bg) {
    this.w = w;
    this.h = h;
    this.data = new Uint8Array(w * h * 3);
    this.rect(0, 0, w, h, bg);
  }
  rect(x, y, rw, rh, [r, g, b]) {
    const x0 = Math.max(0, x), x1 = Math.min(this.w, x + rw);
    for (let yy = Math.max(0, y); yy < Math.min(this.h, y + rh); yy++) {
      for (let xx = x0; xx < x1; xx++) {
        const o = (yy * this.w + xx) * 3;
        this.data[o] = r;
        this.data[o + 1] = g;
        this.data[o + 2] = b;
      }
    }
  }
  png() {
    return encodePng(this.w, this.h, this.data);
  }
}

// The logo: a pixel-art "P" on a 7x7 grid, one rainbow colour per row.
const P_ROWS = [
  [1, 2, 3, 4], // row 1
  [1, 5],
  [1, 2, 3, 4],
  [1],
  [1],
];
const P_COLORS = ["F00", "F80", "FF0", "0F0", "00F"].map(hex3);
const LOGO_BG = [10, 10, 10];

function drawLogo(r, x, y, cell) {
  P_ROWS.forEach((cols, row) => cols.forEach((col) => r.rect(x + col * cell, y + (row + 1) * cell, cell, cell, P_COLORS[row])));
}

export function iconPng(size) {
  const r = new Raster(size, size, LOGO_BG);
  const cell = Math.floor(size / 7);
  const off = Math.floor((size - cell * 7) / 2);
  drawLogo(r, off, off, cell);
  return r.png();
}

export function faviconSvg() {
  const rects = P_ROWS.flatMap((cols, row) =>
    cols.map((col) => `<rect x="${col}" y="${row + 1}" width="1" height="1" fill="#${["F00", "F80", "FF0", "0F0", "00F"][row]}"/>`),
  ).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 7 7" shape-rendering="crispEdges"><rect width="7" height="7" rx="1" fill="#0a0a0a"/>${rects}</svg>`;
}

/** 1200x630 social card: the logo plus a live downscaled picture of the canvas. */
export function ogPng(state, size) {
  const W = 1200, H = 630, S = 530, CELL = 2;
  const r = new Raster(W, H, LOGO_BG);
  drawLogo(r, 60, 90, 60);

  const left = 640, top = 50;
  r.rect(left - 2, top - 2, S + 4, S + 4, [48, 48, 48]);
  r.rect(left, top, S, S, [22, 22, 22]);
  const cells = S / CELL; // preview resolution, each cell is drawn 2x2
  const scale = size / cells;
  const filled = new Map(); // preview cell -> char (a filled pixel always wins over empty)
  for (const [idx, c] of state.chunks) {
    const bx = (idx % GRID) * CHUNK;
    const by = Math.floor(idx / GRID) * CHUNK;
    eachRun(c.rle, (start, len, code) => {
      if (code === 46) return;
      const ch = String.fromCharCode(code);
      for (let q = start; q < start + len; q++) {
        const wx = bx + (q % CHUNK);
        const wy = by + Math.floor(q / CHUNK);
        filled.set(Math.floor(wy / scale) * cells + Math.floor(wx / scale), ch);
      }
    });
  }
  for (const [cell, ch] of filled) {
    const col = HEX_BY_CHAR[ch];
    if (col) r.rect(left + (cell % cells) * CELL, top + Math.floor(cell / cells) * CELL, CELL, CELL, col);
  }
  return r.png();
}