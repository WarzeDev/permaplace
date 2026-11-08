// Permaplace client. Plain JS, no dependencies. Rendering is chunk based: only the 100x100 chunks
// that are on screen are decoded and drawn, and a 1/10 scale overview is used when zoomed far out,
// so the full 10,000 x 10,000 canvas never has to exist as one giant bitmap.
import { COLORS, CHUNK, BLACK, BLACK_DARK_HEX } from "./palette.js";

const cfg = JSON.parse(document.getElementById("cfg").textContent);
const SIZE = cfg.size;
const ROOM = cfg.room;
const PRACTICE = cfg.practice;
const GRID = 100; // chunk key = cx + cy * GRID (matches the database / API)
const MIN_PLACE_Z = 2; // css pixels per canvas pixel needed to place
const MAX_VISIBLE = 500; // above this many visible chunks the overview is drawn instead
const MAX_CACHE = 700; // decoded chunks kept in memory
const OVS = 10; // overview downscale
const OVN = Math.ceil(SIZE / OVS);
const USE_OVERVIEW = SIZE >= 1000;

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ------------------------------------------------------------------ theme + palette

const darkMq = matchMedia("(prefers-color-scheme: dark)");
const isDark = () => (root.dataset.theme ? root.dataset.theme === "dark" : darkMq.matches);

const CODE_TO_IDX = new Uint8Array(128); // char code -> palette index + 1 (0 = empty)
COLORS.forEach((c, i) => (CODE_TO_IDX[c[0].charCodeAt(0)] = i + 1));
const pal = new Uint32Array(COLORS.length + 1); // ABGR for ImageData
const palCss = new Array(COLORS.length + 1);
const colors = { empty: "#ddd", void: "#aaa" };

function buildPalette() {
  const dark = isDark();
  COLORS.forEach(([ch, hex], i) => {
    if (ch === BLACK && dark) hex = BLACK_DARK_HEX;
    const r = parseInt(hex[0], 16) * 17, g = parseInt(hex[1], 16) * 17, b = parseInt(hex[2], 16) * 17;
    pal[i + 1] = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
    palCss[i + 1] = "#" + hex;
  });
  colors.empty = dark ? "#000" : "#ddd";
  colors.void = dark ? "#111" : "#aaa";
}
buildPalette();

// ------------------------------------------------------------------ chunk storage

const rle = new Map(); // chunk key -> run-length string from the server
const cache = new Map(); // chunk key -> { px: Uint8Array, cv, cx } (LRU, most recent last)
const overlay = new Map(); // y * SIZE + x -> palette index (pixels sent but not yet confirmed)
const scratch = new ImageData(CHUNK, CHUNK);
const scratch32 = new Uint32Array(scratch.data.buffer);

function decode(s) {
  const px = new Uint8Array(CHUNK * CHUNK);
  let p = 0, n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 48 && c <= 57) { n = n * 10 + c - 48; continue; }
    const len = n || 1;
    n = 0;
    const v = CODE_TO_IDX[c];
    if (v) px.fill(v, p, p + len);
    p += len;
  }
  return px;
}

function newEntry(px) {
  const cv = document.createElement("canvas");
  cv.width = cv.height = CHUNK;
  const e = { px, cv, cx: cv.getContext("2d") };
  paintEntry(e);
  return e;
}
function paintEntry(e) {
  scratch32.fill(0);
  const px = e.px;
  for (let i = 0; i < px.length; i++) if (px[i]) scratch32[i] = pal[px[i]];
  e.cx.putImageData(scratch, 0, 0);
}
function chunkEntry(key) {
  let e = cache.get(key);
  if (e) { cache.delete(key); cache.set(key, e); return e; }
  const s = rle.get(key);
  if (s === undefined) return null;
  e = newEntry(decode(s));
  cache.set(key, e);
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
  return e;
}

// Overview: one cell per 10x10 canvas pixels; a filled pixel always wins over an empty one.
let ovIdx, ovImg, ov32, ovCv, ovCx, ovDirty = false;
if (USE_OVERVIEW) {
  ovIdx = new Uint8Array(OVN * OVN);
  ovImg = new ImageData(OVN, OVN);
  ov32 = new Uint32Array(ovImg.data.buffer);
  ovCv = document.createElement("canvas");
  ovCv.width = ovCv.height = OVN;
  ovCx = ovCv.getContext("2d");
}
function overviewAdd(key, s) {
  const bx = (key % GRID) * CHUNK, by = Math.floor(key / GRID) * CHUNK;
  let p = 0, n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 48 && c <= 57) { n = n * 10 + c - 48; continue; }
    const len = n || 1;
    n = 0;
    const v = CODE_TO_IDX[c];
    if (v) {
      for (let q = p; q < p + len; q++) {
        const o = Math.floor((by + Math.floor(q / CHUNK)) / OVS) * OVN + Math.floor((bx + (q % CHUNK)) / OVS);
        ovIdx[o] = v;
        ov32[o] = pal[v];
      }
    }
    p += len;
  }
  ovDirty = true;
}
function overviewRepaint() {
  if (!USE_OVERVIEW) return;
  for (let i = 0; i < ovIdx.length; i++) ov32[i] = ovIdx[i] ? pal[ovIdx[i]] : 0;
  ovDirty = true;
}

function setChunk(key, s) {
  rle.set(key, s);
  cache.delete(key);
  if (USE_OVERVIEW) overviewAdd(key, s);
  invalidate();
}

function pixelAt(x, y) {
  const o = overlay.get(y * SIZE + x);
  if (o) return o;
  const key = Math.floor(x / CHUNK) + Math.floor(y / CHUNK) * GRID;
  if (!rle.has(key)) return 0;
  return chunkEntry(key).px[(y % CHUNK) * CHUNK + (x % CHUNK)];
}

// ------------------------------------------------------------------ camera

const cv = $("view");
const g = cv.getContext("2d", { alpha: false });
const view = { w: 1, h: 1, dpr: 1 };
const cam = { x: SIZE / 2, y: SIZE / 2, z: 4 };
const tgt = { x: cam.x, y: cam.y, z: cam.z };
let anchor = null; // keeps the world point under the cursor fixed while zooming
const vel = { x: 0, y: 0 }; // swipe momentum, css px per ms
let hover = null; // pixel under the mouse
let aim = null; // pixel chosen by touch, waiting for confirmation
let cameraReady = false;

const fitZ = () => Math.min(view.w, view.h) / SIZE;
const minZ = () => fitZ() * 0.5;
const maxZ = () => 80;
const clampZ = (z) => clamp(z, minZ(), maxZ());
function clampCam() {
  cam.x = clamp(cam.x, 0, SIZE);
  cam.y = clamp(cam.y, 0, SIZE);
}
const toWorld = (sx, sy) => ({ x: cam.x + (sx - view.w / 2) / cam.z, y: cam.y + (sy - view.h / 2) / cam.z });
const pixelFromScreen = (sx, sy) => {
  const w = toWorld(sx, sy);
  return { x: Math.floor(w.x), y: Math.floor(w.y) };
};
const inWorld = (p) => p && p.x >= 0 && p.y >= 0 && p.x < SIZE && p.y < SIZE;

function stopMotion() {
  tgt.x = cam.x; tgt.y = cam.y; tgt.z = cam.z;
  anchor = null;
  vel.x = vel.y = 0;
}
function applyAnchor() {
  cam.x = anchor.wx - (anchor.sx - view.w / 2) / cam.z;
  cam.y = anchor.wy - (anchor.sy - view.h / 2) / cam.z;
}
function zoomAt(factor, sx, sy) {
  const nz = clampZ(tgt.z * factor);
  if (nz === tgt.z) return;
  vel.x = vel.y = 0;
  const w = toWorld(sx, sy);
  anchor = { sx, sy, wx: w.x, wy: w.y };
  tgt.z = nz;
  if (reduceMotion) { cam.z = nz; applyAnchor(); clampCam(); tgt.x = cam.x; tgt.y = cam.y; anchor = null; }
  touched();
}
function flyTo(x, y, z) {
  vel.x = vel.y = 0;
  anchor = null;
  tgt.x = clamp(x, 0, SIZE); tgt.y = clamp(y, 0, SIZE); tgt.z = clampZ(z);
  if (reduceMotion) { cam.x = tgt.x; cam.y = tgt.y; cam.z = tgt.z; }
  touched();
}

function step(dt) {
  let busy = false;
  if (cam.z !== tgt.z) {
    cam.z += (tgt.z - cam.z) * (1 - Math.exp(-dt / 80));
    if (Math.abs(tgt.z - cam.z) < tgt.z * 0.002) cam.z = tgt.z;
    if (anchor) { applyAnchor(); tgt.x = cam.x; tgt.y = cam.y; if (cam.z === tgt.z) anchor = null; }
    busy = cam.z !== tgt.z;
  }
  if (cam.x !== tgt.x || cam.y !== tgt.y) {
    const k = 1 - Math.exp(-dt / 80);
    cam.x += (tgt.x - cam.x) * k;
    cam.y += (tgt.y - cam.y) * k;
    if (Math.abs(tgt.x - cam.x) * cam.z < 0.05 && Math.abs(tgt.y - cam.y) * cam.z < 0.05) { cam.x = tgt.x; cam.y = tgt.y; }
    busy = true;
  }
  if (vel.x || vel.y) {
    cam.x -= (vel.x * dt) / cam.z;
    cam.y -= (vel.y * dt) / cam.z;
    tgt.x = cam.x; tgt.y = cam.y;
    const f = Math.exp(-dt / 320);
    vel.x *= f; vel.y *= f;
    if (Math.hypot(vel.x, vel.y) < 0.02) vel.x = vel.y = 0;
    busy = true;
  }
  clampCam();
  return busy;
}

// ------------------------------------------------------------------ rendering

let raf = 0, lastTs = 0;
function invalidate() { if (!raf) raf = requestAnimationFrame(frame); }
function frame(ts) {
  raf = 0;
  const dt = Math.min(64, lastTs ? ts - lastTs : 16);
  lastTs = ts;
  const busy = step(dt);
  render();
  updateHud();
  if (busy) invalidate(); else lastTs = 0;
}

function render() {
  const W = cv.width, H = cv.height;
  const sc = cam.z * view.dpr;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = colors.void;
  g.fillRect(0, 0, W, H);

  const ox = W / 2 - cam.x * sc, oy = H / 2 - cam.y * sc;
  const x0 = Math.round(ox), y0 = Math.round(oy);
  const x1 = Math.round(ox + SIZE * sc), y1 = Math.round(oy + SIZE * sc);
  g.fillStyle = colors.empty;
  g.fillRect(x0, y0, x1 - x0, y1 - y0);
  g.imageSmoothingEnabled = false;

  const vx0 = Math.max(0, Math.floor(-ox / sc)), vy0 = Math.max(0, Math.floor(-oy / sc));
  const vx1 = Math.min(SIZE, Math.ceil((W - ox) / sc)), vy1 = Math.min(SIZE, Math.ceil((H - oy) / sc));
  if (vx1 <= vx0 || vy1 <= vy0) return;

  const c0 = Math.floor(vx0 / CHUNK), c1 = Math.floor((vx1 - 1) / CHUNK);
  const r0 = Math.floor(vy0 / CHUNK), r1 = Math.floor((vy1 - 1) / CHUNK);
  if (USE_OVERVIEW && (c1 - c0 + 1) * (r1 - r0 + 1) > MAX_VISIBLE) {
    if (ovDirty) { ovCx.putImageData(ovImg, 0, 0); ovDirty = false; }
    g.drawImage(ovCv, 0, 0, OVN, OVN, x0, y0, Math.round(ox + OVN * OVS * sc) - x0, Math.round(oy + OVN * OVS * sc) - y0);
  } else {
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const key = c + r * GRID;
        if (!rle.has(key)) continue;
        const e = chunkEntry(key);
        const dx0 = Math.round(ox + c * CHUNK * sc), dy0 = Math.round(oy + r * CHUNK * sc);
        const dx1 = Math.round(ox + (c + 1) * CHUNK * sc), dy1 = Math.round(oy + (r + 1) * CHUNK * sc);
        g.drawImage(e.cv, 0, 0, CHUNK, CHUNK, dx0, dy0, dx1 - dx0, dy1 - dy0);
      }
    }
  }

  const cell = (x, y) => [Math.round(ox + x * sc), Math.round(oy + y * sc), Math.round(ox + (x + 1) * sc), Math.round(oy + (y + 1) * sc)];
  for (const [k, v] of overlay) {
    const [a, b, c, d] = cell(k % SIZE, Math.floor(k / SIZE));
    g.fillStyle = palCss[v];
    g.fillRect(a, b, c - a, d - b);
  }

  if (sc >= 12) { // pixel grid
    g.fillStyle = "rgba(128,128,128,0.22)";
    for (let x = vx0; x <= vx1; x++) g.fillRect(Math.round(ox + x * sc), Math.max(0, y0), 1, Math.min(H, y1) - Math.max(0, y0));
    for (let y = vy0; y <= vy1; y++) g.fillRect(Math.max(0, x0), Math.round(oy + y * sc), Math.min(W, x1) - Math.max(0, x0), 1);
  }

  const cur = aim || (inWorld(hover) ? hover : null);
  if (cur) {
    const [a, b, c, d] = cell(cur.x, cur.y);
    if (sel && cam.z >= MIN_PLACE_Z && cfg.canPlace) {
      g.globalAlpha = 0.6;
      g.fillStyle = palCss[sel];
      g.fillRect(a, b, c - a, d - b);
      g.globalAlpha = 1;
    }
    const lw = Math.max(1, Math.round(view.dpr));
    g.lineWidth = lw * 3; g.strokeStyle = "#fff";
    g.strokeRect(a - lw / 2, b - lw / 2, c - a + lw, d - b + lw);
    g.lineWidth = lw; g.strokeStyle = "#000";
    g.strokeRect(a - lw / 2, b - lw / 2, c - a + lw, d - b + lw);
  }
}

function resize() {
  view.dpr = Math.min(window.devicePixelRatio || 1, 3);
  view.w = cv.clientWidth || window.innerWidth;
  view.h = cv.clientHeight || window.innerHeight;
  cv.width = Math.round(view.w * view.dpr);
  cv.height = Math.round(view.h * view.dpr);
  if (!cameraReady) initCamera();
  cam.z = clampZ(cam.z);
  tgt.z = clampZ(tgt.z);
  invalidate();
}

function parseHash() {
  const m = /^#(-?\d+),(-?\d+)(?:,(\d+(?:\.\d+)?))?$/.exec(location.hash);
  return m ? { x: +m[1] + 0.5, y: +m[2] + 0.5, z: m[3] ? +m[3] : null } : null;
}
function initCamera() {
  cameraReady = true;
  const h = parseHash();
  cam.x = h ? clamp(h.x, 0, SIZE) : SIZE / 2;
  cam.y = h ? clamp(h.y, 0, SIZE) : SIZE / 2;
  cam.z = h?.z || (PRACTICE ? fitZ() * 0.9 : 4);
  tgt.x = cam.x; tgt.y = cam.y; tgt.z = cam.z;
}

// Keep the address bar in sync so any spot on the canvas can be shared as a link.
let hashTimer = 0;
function touched() {
  invalidate();
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const h = `#${Math.floor(tgt.x)},${Math.floor(tgt.y)},${+tgt.z.toFixed(2)}`;
    if (location.hash !== h) history.replaceState(null, "", location.pathname + location.search + h);
  }, 600);
}
addEventListener("hashchange", () => {
  const h = parseHash();
  if (h) flyTo(h.x, h.y, h.z || cam.z);
});

// ------------------------------------------------------------------ HUD, toasts, status

const hudPos = $("hud-pos"), hudState = $("hud-state");
let hudText = "";
function updateHud() {
  const p = aim || (inWorld(hover) ? hover : null);
  const pos = p ? `${p.x}, ${p.y}` : `${Math.floor(cam.x)}, ${Math.floor(cam.y)}`;
  const z = cam.z < 1 ? cam.z.toFixed(2) : cam.z.toFixed(1);
  const s = `${pos} · ${z}×`;
  if (s !== hudText) { hudText = s; hudPos.textContent = s; }
}

function toast(msg, isError = false) {
  const box = $("toasts");
  while (box.children.length >= 3) box.firstChild.remove();
  const t = document.createElement("div");
  t.className = "toast" + (isError ? " error" : "");
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.remove(), 3600);
}

let net = "loading"; // loading | ok | offline | locked
function renderState() {
  let text, kind = "";
  const left = remaining();
  if (net === "loading") text = "Loading canvas…";
  else if (net === "offline") { text = "Offline - retrying…"; kind = "error"; }
  else if (net === "locked") { text = "Password required"; kind = "error"; }
  else if (PRACTICE) text = "Practice - no limits";
  else if (left > 0) text = `Next pixel in ${(left / 1000).toFixed(1)}s`;
  else text = "Ready";
  if (hudState.textContent !== text) hudState.textContent = text;
  hudState.dataset.kind = kind;
}
function setNet(v) { net = v; renderState(); root.classList.toggle("busy", v === "loading"); }

// ------------------------------------------------------------------ colour selection

const palEl = $("palette");
const swatches = COLORS.map(([ch, , name]) => {
  const b = document.createElement("button");
  b.type = "button"; b.className = "sw"; b.tabIndex = -1;
  b.setAttribute("role", "radio"); b.setAttribute("aria-label", name); b.title = name;
  b.dataset.c = ch;
  palEl.appendChild(b);
  return b;
});
let sel = 0; // palette index + 1
function paintSwatches() { swatches.forEach((b, i) => (b.style.background = palCss[i + 1])); }
function selectColor(idx, persist = true) {
  sel = idx;
  swatches.forEach((b, i) => { b.setAttribute("aria-checked", i + 1 === idx); b.tabIndex = i + 1 === idx ? 0 : -1; });
  if (persist) store.set("pp-color", COLORS[idx - 1][0]);
  invalidate();
}
palEl.addEventListener("click", (e) => {
  const b = e.target.closest(".sw");
  if (b) selectColor(swatches.indexOf(b) + 1);
});
palEl.addEventListener("keydown", (e) => {
  const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
  if (!d) return;
  e.preventDefault();
  const n = (sel - 1 + d + swatches.length) % swatches.length;
  selectColor(n + 1);
  swatches[n].focus();
});
paintSwatches();
selectColor(CODE_TO_IDX[(store.get("pp-color") || "l").charCodeAt(0)] || CODE_TO_IDX["l".charCodeAt(0)], false);

let pipette = false;
const btnPipette = $("btn-pipette");
function setPipette(on) {
  pipette = on;
  btnPipette.setAttribute("aria-pressed", on);
  if (on) toast("Tap a pixel to copy its colour.");
}
btnPipette.addEventListener("click", () => setPipette(!pipette));
function pick(p) {
  const v = pixelAt(p.x, p.y);
  if (!v) return toast("That pixel is empty.");
  selectColor(v);
}

// ------------------------------------------------------------------ cooldown

const cdFill = $("cd-fill");
const cdKey = "pp-cd:" + ROOM;
let cdEnd = Number(store.get(cdKey)) || 0;
let cdTimer = 0;
const remaining = () => (PRACTICE ? 0 : Math.max(0, cdEnd - Date.now()));
function runBar(ms, from) {
  cdFill.getAnimations().forEach((a) => a.cancel());
  if (!reduceMotion) cdFill.animate([{ transform: `scaleX(${from})` }, { transform: "scaleX(1)" }], { duration: ms, easing: "linear", fill: "forwards" });
}
function tick() {
  clearInterval(cdTimer);
  renderState();
  if (remaining() > 0) cdTimer = setInterval(() => { renderState(); if (remaining() <= 0) clearInterval(cdTimer); }, 100);
}
function startCooldown(ms, from = 0) {
  if (PRACTICE || ms <= 0) return;
  cdEnd = Date.now() + ms;
  store.set(cdKey, String(cdEnd));
  runBar(ms, from);
  tick();
}
function endCooldown() {
  cdEnd = 0;
  store.del(cdKey);
  cdFill.getAnimations().forEach((a) => a.cancel());
  tick();
}
if (remaining() > 0 && cfg.cooldown > 0) startCooldown(remaining(), 1 - remaining() / (cfg.cooldown * 1000));
else store.del(cdKey);

// ------------------------------------------------------------------ network

const api = `/api/rooms/${encodeURIComponent(ROOM)}`;
const pwKey = "pp-pw:" + ROOM;
const getPw = () => { try { return sessionStorage.getItem(pwKey) || ""; } catch { return ""; } };
const authHeaders = () => (getPw() ? { "x-room-password": encodeURIComponent(getPw()) } : {});

let since = 0, pollTimer = 0, polling = false, failures = 0;
function schedulePoll(ms) {
  clearTimeout(pollTimer);
  if (!document.hidden) pollTimer = setTimeout(poll, ms ?? cfg.interval * 1000);
}
async function poll() {
  if (polling || PRACTICE) return;
  if (cfg.viewLocked && !getPw()) { setNet("locked"); return askPassword(poll); }
  polling = true;
  try {
    const r = await fetch(`${api}/pixels?since=${since}`, { headers: authHeaders(), cache: "no-store" });
    if (r.status === 401) { sessionStorage.removeItem(pwKey); setNet("locked"); return askPassword(poll); }
    if (!r.ok) throw new Error("http " + r.status);
    const j = await r.json();
    for (const k in j.c) setChunk(+k, j.c[k]);
    for (const [key, v] of overlay) { // drop optimistic pixels the server now has
      if (pixelAtServer(key)) overlay.delete(key);
    }
    since = j.t;
    failures = 0;
    setNet("ok");
    schedulePoll();
  } catch {
    failures++;
    setNet("offline");
    schedulePoll(Math.min(30000, cfg.interval * 1000 * 2 ** Math.min(failures, 3)));
  } finally {
    polling = false;
  }
}
function pixelAtServer(key) {
  const x = key % SIZE, y = Math.floor(key / SIZE);
  const ck = Math.floor(x / CHUNK) + Math.floor(y / CHUNK) * GRID;
  return rle.has(ck) ? chunkEntry(ck).px[(y % CHUNK) * CHUNK + (x % CHUNK)] : 0;
}
document.addEventListener("visibilitychange", () => (document.hidden ? clearTimeout(pollTimer) : poll()));
addEventListener("online", () => poll());

async function place(p) {
  if (!cfg.canPlace) return toast("Placing pixels is not allowed in this room.", true);
  if (cam.z < MIN_PLACE_Z) return toast("Zoom in a little to place a pixel.");
  if (!sel) return toast("Pick a colour first.");
  if (PRACTICE) return practiceSet(p.x, p.y, sel), clearAim();
  const wait = remaining();
  if (wait > 0) return toast(`Next pixel in ${(wait / 1000).toFixed(1)}s.`);
  if (pixelAt(p.x, p.y)) return toast("That pixel is already taken.", true);
  if (cfg.placeLocked && !getPw()) return askPassword(() => place(p));

  const key = p.y * SIZE + p.x;
  overlay.set(key, sel);
  clearAim();
  startCooldown(cfg.cooldown * 1000);
  invalidate();
  try {
    const r = await fetch(`${api}/pixel`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ x: p.x, y: p.y, c: COLORS[sel - 1][0] }),
    });
    const j = await r.json().catch(() => ({}));
    overlay.delete(key);
    if (r.ok && j.ok) return setChunk(j.idx, j.rle);
    invalidate();
    switch (j.error) {
      case "taken": toast("Someone just took that pixel.", true); endCooldown(); poll(); break;
      case "cooldown": startCooldown(Math.ceil(j.retry * 1000)); toast("You are placing too quickly.", true); break;
      case "password": sessionStorage.removeItem(pwKey); endCooldown(); askPassword(() => place(p)); break;
      case "forbidden": endCooldown(); toast("Placing pixels is not allowed in this room.", true); break;
      case "slow": toast("Too many requests - slow down.", true); break;
      default: endCooldown(); toast("Something went wrong. Please try again.", true);
    }
  } catch {
    overlay.delete(key);
    endCooldown();
    invalidate();
    toast("Couldn't reach the server. Please try again.", true);
  }
}

// Practice mode: everything stays in the browser and may be overwritten.
function practiceSet(x, y, v) {
  const key = Math.floor(x / CHUNK) + Math.floor(y / CHUNK) * GRID;
  let e = cache.get(key);
  if (!e) { e = newEntry(new Uint8Array(CHUNK * CHUNK)); cache.set(key, e); rle.set(key, "#"); }
  e.px[(y % CHUNK) * CHUNK + (x % CHUNK)] = v;
  paintEntry(e);
  invalidate();
}

// ------------------------------------------------------------------ pointer input (pan, pinch, tap)

const ptrs = new Map();
let drag = null, pinch = null;

function startPinch() {
  const [a, b] = [...ptrs.values()];
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const w = toWorld(mx, my);
  pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: cam.z, wx: w.x, wy: w.y };
}
function updatePinch() {
  const [a, b] = [...ptrs.values()];
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  cam.z = tgt.z = clampZ((pinch.z * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.d);
  cam.x = pinch.wx - (mx - view.w / 2) / cam.z;
  cam.y = pinch.wy - (my - view.h / 2) / cam.z;
  clampCam();
  tgt.x = cam.x; tgt.y = cam.y;
  touched();
}
function beginDrag(id, x, y, type, moved) {
  drag = { id, sx: x, sy: y, cx: cam.x, cy: cam.y, moved, type, samples: [[performance.now(), x, y]] };
}

cv.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  cv.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  stopMotion();
  if (ptrs.size === 1) beginDrag(e.pointerId, e.clientX, e.clientY, e.pointerType, false);
  else if (ptrs.size === 2) { if (drag) drag.moved = true; startPinch(); }
});

cv.addEventListener("pointermove", (e) => {
  if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && ptrs.size >= 2) return updatePinch();
  if (drag && drag.id === e.pointerId) {
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) > (drag.type === "mouse" ? 4 : 8)) { drag.moved = true; cv.classList.add("dragging"); }
    if (drag.moved) {
      cam.x = tgt.x = drag.cx - dx / cam.z;
      cam.y = tgt.y = drag.cy - dy / cam.z;
      clampCam();
      const now = performance.now();
      drag.samples.push([now, e.clientX, e.clientY]);
      while (drag.samples.length > 2 && now - drag.samples[0][0] > 100) drag.samples.shift();
      touched();
    }
  }
  if (e.pointerType === "mouse" || e.pointerType === "pen") {
    const p = pixelFromScreen(e.clientX, e.clientY);
    if (!hover || hover.x !== p.x || hover.y !== p.y) { hover = p; invalidate(); }
  }
});

function endPointer(e, cancelled) {
  if (!ptrs.delete(e.pointerId)) return;
  if (pinch) {
    pinch = null;
    if (ptrs.size === 1) { const [id, p] = [...ptrs][0]; beginDrag(id, p.x, p.y, e.pointerType, true); }
    return;
  }
  if (!drag || drag.id !== e.pointerId) return;
  const d = drag;
  drag = null;
  cv.classList.remove("dragging");
  if (cancelled) return;
  if (!d.moved) return onTap(e);
  const s = d.samples, a = s[0], b = s[s.length - 1];
  const dt = b[0] - a[0];
  if (!reduceMotion && dt > 8 && performance.now() - b[0] < 60) {
    const vx = (b[1] - a[1]) / dt, vy = (b[2] - a[2]) / dt;
    if (Math.hypot(vx, vy) > 0.15) { vel.x = vx; vel.y = vy; invalidate(); }
  }
}
cv.addEventListener("pointerup", (e) => endPointer(e, false));
cv.addEventListener("pointercancel", (e) => endPointer(e, true));
cv.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse" && hover) { hover = null; invalidate(); } });

function clearAim() { aim = null; btnPlace.hidden = true; invalidate(); }
const btnPlace = $("btn-place");
btnPlace.addEventListener("click", () => aim && place(aim));

function onTap(e) {
  const p = pixelFromScreen(e.clientX, e.clientY);
  if (!inWorld(p)) return clearAim();
  if (pipette) { pick(p); return setPipette(false); }
  if (e.pointerType === "mouse") { hover = p; return place(p); }
  if (aim && aim.x === p.x && aim.y === p.y) return place(p);
  aim = p;
  btnPlace.hidden = !cfg.canPlace;
  if (cam.z < MIN_PLACE_Z) toast("Zoom in a little to place a pixel.");
  invalidate();
}

cv.addEventListener("wheel", (e) => {
  e.preventDefault();
  let dy = e.deltaY;
  if (e.deltaMode === 1) dy *= 16; else if (e.deltaMode === 2) dy *= view.h;
  zoomAt(clamp(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0018)), 0.5, 2), e.clientX, e.clientY);
}, { passive: false });

cv.addEventListener("contextmenu", (e) => { // right click / long press = eyedropper
  e.preventDefault();
  const p = pixelFromScreen(e.clientX, e.clientY);
  if (inWorld(p)) pick(p);
});

$("zoom-in").addEventListener("click", () => zoomAt(1.7, view.w / 2, view.h / 2));
$("zoom-out").addEventListener("click", () => zoomAt(1 / 1.7, view.w / 2, view.h / 2));
$("zoom-fit").addEventListener("click", () => flyTo(SIZE / 2, SIZE / 2, fitZ() * 0.9));

// ------------------------------------------------------------------ dialogs

const dlgAbout = $("dlg-about"), dlgRooms = $("dlg-rooms"), dlgPass = $("dlg-pass");
const openDlg = (d) => { if (d.open) d.close(); d.showModal(); };
for (const d of [dlgAbout, dlgRooms, dlgPass]) d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
$("btn-help").addEventListener("click", () => openDlg(dlgAbout));
$("btn-rooms").addEventListener("click", () => openDlg(dlgRooms));
$("btn-clear")?.addEventListener("click", () => { rle.clear(); cache.clear(); invalidate(); toast("Canvas cleared."); });
dlgAbout.addEventListener("close", () => store.set("pp-seen", "1"));

let passThen = null;
const passInput = $("pass-input"), passError = $("pass-error");
function askPassword(then) {
  passThen = then || null;
  passError.hidden = true;
  passInput.value = "";
  openDlg(dlgPass);
}
$("pass-cancel").addEventListener("click", () => dlgPass.close());
$("pass-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const p = passInput.value;
  try {
    const r = await fetch(`${api}/unlock`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ p }) });
    const j = await r.json();
    if (j.ok) {
      try { sessionStorage.setItem(pwKey, p); } catch {}
      dlgPass.close();
      const fn = passThen;
      passThen = null;
      fn?.();
      return;
    }
  } catch {}
  passError.hidden = false;
  passInput.select();
});

// ------------------------------------------------------------------ theme toggle (auto / light / dark)

const themeBtn = $("btn-theme"), themeLbl = $("theme-lbl");
const themePref = () => store.get("pp-theme");
function applyTheme() {
  const pref = themePref();
  if (pref === "light" || pref === "dark") root.dataset.theme = pref; else delete root.dataset.theme;
  const label = pref === "light" || pref === "dark" ? pref : "auto";
  themeLbl.textContent = label[0].toUpperCase() + label.slice(1);
  themeBtn.setAttribute("aria-label", `Theme: ${label}. Activate to change.`);
  const bg = isDark() ? "#0a0a0a" : "#f4f4f5";
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", bg));
  buildPalette();
  paintSwatches();
  for (const e of cache.values()) paintEntry(e);
  overviewRepaint();
  invalidate();
}
themeBtn.addEventListener("click", () => {
  const next = { null: "light", light: "dark", dark: null }[themePref()];
  next ? store.set("pp-theme", next) : store.del("pp-theme");
  applyTheme();
});
darkMq.addEventListener("change", applyTheme);

// ------------------------------------------------------------------ start

new ResizeObserver(resize).observe(cv);
resize();
applyTheme();
dlgAbout.close(); // the server renders it open so crawlers and no-JS visitors see the intro
root.classList.remove("seen");
if (!store.get("pp-seen")) dlgAbout.showModal();
renderState();
if (PRACTICE) setNet("ok"); else poll();