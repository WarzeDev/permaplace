// Dependency-free PNG/SVG generation: favicon, app icons and the social preview image.
import { deflateSync, inflateSync } from "node:zlib";
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

/** Minimal PNG decoder (8/16-bit, non-interlaced) -> { w, h, rgba }. Returns null if unsupported. */
export function decodePng(buf) {
  try {
    if (buf.readUInt32BE(0) !== 0x89504e47) return null;
    let pos = 8, w = 0, h = 0, depth = 0, type = 0, interlace = 0, plte = null, trns = null;
    const idat = [];
    while (pos < buf.length) {
      const len = buf.readUInt32BE(pos), name = buf.toString("latin1", pos + 4, pos + 8);
      const data = buf.subarray(pos + 8, pos + 8 + len);
      if (name === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
      else if (name === "PLTE") plte = data;
      else if (name === "tRNS") trns = data;
      else if (name === "IDAT") idat.push(data);
      else if (name === "IEND") break;
      pos += 12 + len;
    }
    if (interlace || (depth !== 8 && depth !== 16) || (depth === 16 && type === 3)) return null;
    const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
    const bpp = ch * (depth / 8), stride = w * bpp;
    const raw = inflateSync(Buffer.concat(idat));
    const out = Buffer.alloc(stride * h);
    for (let y = 0; y < h; y++) {
      const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? out[dst + x - bpp] : 0, b = y ? out[dst - stride + x] : 0, c = x >= bpp && y ? out[dst - stride + x - bpp] : 0;
        let v = raw[src + x];
        if (f === 1) v += a;
        else if (f === 2) v += b;
        else if (f === 3) v += (a + b) >> 1;
        else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        out[dst + x] = v & 255;
      }
    }
    const rgba = new Uint8Array(w * h * 4), step = depth / 8;
    for (let i = 0; i < w * h; i++) {
      const o = i * bpp, g = (k) => out[o + k * step];
      let r, gr, b, a = 255;
      if (type === 0) r = gr = b = g(0);
      else if (type === 2) [r, gr, b] = [g(0), g(1), g(2)];
      else if (type === 3) { const n = out[o]; [r, gr, b] = [plte[n * 3], plte[n * 3 + 1], plte[n * 3 + 2]]; a = trns && n < trns.length ? trns[n] : 255; }
      else if (type === 4) { r = gr = b = g(0); a = g(1); }
      else [r, gr, b, a] = [g(0), g(1), g(2), g(3)];
      rgba.set([r, gr, b, a], i * 4);
    }
    return { w, h, rgba };
  } catch {
    return null;
  }
}

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
  /** Draws an RGBA image scaled to fit inside the box, centred, alpha-blended. */
  fitImage(img, bx, by, bw, bh) {
    const k = Math.min(bw / img.w, bh / img.h);
    const dw = Math.round(img.w * k), dh = Math.round(img.h * k);
    const ox = bx + Math.floor((bw - dw) / 2), oy = by + Math.floor((bh - dh) / 2);
    const up = k >= 1;
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        // nearest when enlarging (keeps pixel art crisp), box average when shrinking
        const sx0 = Math.floor(x / k), sy0 = Math.floor(y / k);
        const sx1 = up ? sx0 + 1 : Math.min(img.w, Math.max(sx0 + 1, Math.floor((x + 1) / k)));
        const sy1 = up ? sy0 + 1 : Math.min(img.h, Math.max(sy0 + 1, Math.floor((y + 1) / k)));
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let yy = sy0; yy < sy1; yy++) for (let xx = sx0; xx < sx1; xx++) {
          const i = (yy * img.w + xx) * 4, al = img.rgba[i + 3];
          r += img.rgba[i] * al; g += img.rgba[i + 1] * al; b += img.rgba[i + 2] * al; a += al; n++;
        }
        if (!a) continue;
        const o = ((oy + y) * this.w + ox + x) * 3, al = a / n / 255;
        this.data[o] = Math.round(r / a * al + this.data[o] * (1 - al));
        this.data[o + 1] = Math.round(g / a * al + this.data[o + 1] * (1 - al));
        this.data[o + 2] = Math.round(b / a * al + this.data[o + 2] * (1 - al));
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
export function ogPng(state, size, logo = null) {
  const W = 1200, H = 630, S = 530, CELL = 2;
  const r = new Raster(W, H, LOGO_BG);
  if (logo) r.fitImage(logo, 60, 85, 500, 460);
  else drawLogo(r, 60, 90, 60);

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