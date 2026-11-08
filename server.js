// Permaplace - Bun backend. Run with:  bun run server.js
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { CHARS } from "./public/palette.js";
import { roomMetas, getRoom, roomState, peekState, DB_DIR } from "./lib/db.js";
import { Payload, json, dynamicJson } from "./lib/http.js";
import { faviconSvg, iconPng, ogPng, decodePng } from "./lib/images.js";
import { renderPage, notFoundPage, sitemapXml, CSP, SITE } from "./lib/render.js";

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const TRUST_PROXY = process.env.TRUST_PROXY !== "0"; // read the client IP from X-Real-Ip / X-Forwarded-For
const ROOT = import.meta.dir;
const PUBLIC = join(ROOT, "public");
const IMMUTABLE = "public, max-age=31536000, immutable";

// ------------------------------------------------------------------ static assets

const hash = (buf) => createHash("sha1").update(buf).digest("base64url").slice(0, 10);
const assets = new Map(); // name -> { payload, version }
const urls = { js: "", css: "", font: "", logo: "", favicon: "/favicon.svg", faviconType: "image/svg+xml" };
let faviconIco = null;
let logoImage = null; // decoded public/logo.png, used on the social preview image

function register(name, body, type, extra = {}) {
  const payload = new Payload(body, type, { cache: "no-cache", brQuality: 11, minCompress: 256, ...extra });
  const version = hash(payload.raw);
  assets.set(name, { payload, version });
  return `/assets/${name}?v=${version}`;
}

const minifyCss = (css) =>
  css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([{};,>])\s*/g, "$1")
    .replace(/;}/g, "}")
    .trim();

async function buildAssets() {
  // Font: Geist (variable) from the `geist` npm package - skipped gracefully if not installed.
  const fontFile = join(ROOT, "node_modules/geist/dist/fonts/geist-sans/Geist-Variable.woff2");
  let fontRule = "";
  if (existsSync(fontFile)) {
    urls.font = register("geist.woff2", readFileSync(fontFile), "font/woff2");
    fontRule = `@font-face{font-family:Geist;src:url(${urls.font}) format("woff2");font-weight:100 900;font-display:swap}`;
  } else {
    console.warn("[permaplace] Geist font not found - run `bun install`. Falling back to the system font.");
  }

  // Your own branding: public/logo.png (header logo) and public/favicon.ico. Both optional.
  const logoFile = join(PUBLIC, "logo.png");
  if (existsSync(logoFile)) {
    const bytes = readFileSync(logoFile);
    urls.logo = register("logo.png", bytes, "image/png");
    logoImage = decodePng(bytes);
    if (!logoImage) console.warn("[permaplace] logo.png could not be decoded for the preview image (interlaced?) - using the built-in logo there.");
  }
  const icoFile = join(PUBLIC, "favicon.ico");
  if (existsSync(icoFile)) {
    faviconIco = new Payload(readFileSync(icoFile), "image/x-icon", { cache: "public, max-age=86400" });
    urls.favicon = "/favicon.ico";
    urls.faviconType = "image/x-icon";
  }

  // CSS
  const css = fontRule + minifyCss(readFileSync(join(PUBLIC, "style.css"), "utf8"));
  urls.css = register("style.css", css, "text/css; charset=utf-8");

  // JS: bundle + minify app.js and palette.js into one file.
  try {
    const result = await Bun.build({ entrypoints: [join(PUBLIC, "app.js")], minify: true, target: "browser", format: "esm" });
    if (!result.success) throw new Error(result.logs.join("\n"));
    urls.js = register("app.js", await result.outputs[0].text(), "text/javascript; charset=utf-8");
  } catch (err) {
    console.warn("[permaplace] bundling failed, serving unminified files:", err.message);
    register("palette.js", readFileSync(join(PUBLIC, "palette.js")), "text/javascript; charset=utf-8");
    urls.js = register("app.js", readFileSync(join(PUBLIC, "app.js")), "text/javascript; charset=utf-8");
  }
}

function serveAsset(req, url, name) {
  const a = assets.get(name);
  if (!a) return text("Not found", 404);
  const versioned = url.searchParams.get("v") === a.version;
  return a.payload.response(req, 200, { "cache-control": versioned ? IMMUTABLE : "no-cache" });
}

// ------------------------------------------------------------------ small helpers

const text = (body, status = 200, type = "text/plain; charset=utf-8") =>
  new Response(body, { status, headers: { "content-type": type, "cache-control": "no-store" } });
const redirect = (to, status = 301) => new Response(null, { status, headers: { location: to } });

function clientIp(req, server) {
  if (TRUST_PROXY) {
    const h = req.headers;
    const ip = h.get("x-real-ip") || h.get("cf-connecting-ip") || (h.get("x-forwarded-for") || "").split(",")[0].trim();
    if (ip) return ip;
  }
  return server.requestIP(req)?.address || "unknown";
}

/** Fixed-window rate limiter keyed by string. */
function limiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, 60_000).unref();
  return (key) => {
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset < now) hits.set(key, (h = { n: 0, reset: now + windowMs }));
    return ++h.n <= max;
  };
}
const postLimit = limiter(30, 10_000);
const unlockLimit = limiter(10, 60_000);

// ------------------------------------------------------------------ rooms & permissions

/**
 * Permission levels stored in the database: 0 anyone, 1 password, 2 friends, 3 owner only.
 * There are no user accounts, so levels 2 and 3 can never be satisfied by a visitor.
 */
function roomAccess(meta) {
  const level = (p) => (p <= 0 ? "open" : p === 1 ? (meta.password ? "password" : "open") : "denied");
  return { view: level(meta.view), place: level(meta.place) };
}

function passwordOk(meta, req) {
  if (!meta.password) return true;
  let given = req.headers.get("x-room-password") || "";
  try {
    given = decodeURIComponent(given);
  } catch {}
  return safeEqual(given, meta.password);
}

function safeEqual(a, b) {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}

const ROOM_RE = /^[a-z0-9_-]{1,64}$/;
const normRoom = (s) => {
  try {
    s = decodeURIComponent(s).toLowerCase();
  } catch {
    return null;
  }
  return ROOM_RE.test(s) ? s : null;
};

// ------------------------------------------------------------------ pages

const PRACTICE_META = { name: "practice", description: "", size: 128, cooldown: 0, interval: 5, password: "", owner: "", view: 0, place: 0 };
const pageCache = new Map();
const PAGE_TTL = 15_000;
const htmlHeaders = {
  "content-security-policy": CSP,
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

function page(req, kind, name) {
  const key = `${kind}:${name}`;
  const hit = pageCache.get(key);
  if (hit && Date.now() - hit.at < PAGE_TTL) return hit.payload.response(req, hit.status);

  const meta = kind === "practice" ? PRACTICE_META : getRoom(name);
  if (!meta) return new Payload(notFoundPage(), "text/html; charset=utf-8", { cache: "no-store", headers: htmlHeaders }).response(req, 404);

  const access = kind === "practice" ? { view: "open", place: "open" } : roomAccess(meta);
  const count = kind === "practice" || access.view === "denied" ? 0 : roomState(name).count;
  const html = renderPage({ practice: kind === "practice", meta, access, count, rooms: roomMetas().list, assets: urls });
  const status = access.view === "denied" ? 403 : 200;
  const payload = new Payload(html, "text/html; charset=utf-8", { cache: "public, max-age=0, must-revalidate", headers: htmlHeaders });
  pageCache.set(key, { at: Date.now(), payload, status });
  return payload.response(req, status);
}

// ------------------------------------------------------------------ API

function apiPixels(req, url, room) {
  const meta = getRoom(room);
  if (!meta) return json({ error: "room" }, 404);
  const a = roomAccess(meta);
  if (a.view === "denied") return json({ error: "forbidden" }, 403);
  if (a.view === "password" && !passwordOk(meta, req)) return json({ error: "password" }, 401);
  const state = roomState(room);
  const since = parseFloat(url.searchParams.get("since"));
  const body = since > 0 ? JSON.stringify(state.delta(since)) : state.snapshot();
  return dynamicJson(req, body);
}

const placed = new Map(); // "room|ip" -> unix seconds of last successful placement
setInterval(() => {
  const old = Date.now() / 1000 - 3600;
  for (const [k, t] of placed) if (t < old) placed.delete(k);
}, 60_000).unref();

async function apiPlace(req, server, room) {
  const meta = getRoom(room);
  if (!meta) return json({ error: "room" }, 404);
  const a = roomAccess(meta);
  if (a.view === "denied" || a.place === "denied") return json({ error: "forbidden" }, 403);
  const pw = passwordOk(meta, req);
  if ((a.view === "password" || a.place === "password") && !pw) return json({ error: "password" }, 401);

  const ip = clientIp(req, server);
  if (!postLimit(ip)) return json({ error: "slow" }, 429);
  if (Number(req.headers.get("content-length") || 0) > 512) return json({ error: "invalid" }, 413);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid" }, 400);
  }
  const { x, y, c } = body ?? {};
  if (!Number.isInteger(x) || !Number.isInteger(y) || typeof c !== "string" || c.length !== 1 || !CHARS.has(c) || x < 0 || y < 0 || x >= meta.size || y >= meta.size) {
    return json({ error: "invalid" }, 400);
  }

  const key = `${room}|${ip}`;
  const now = Date.now() / 1000;
  const last = placed.get(key);
  if (last && last + meta.cooldown - 0.1 > now) return json({ error: "cooldown", retry: +(last + meta.cooldown - now).toFixed(2) }, 429);

  let res;
  try {
    res = roomState(room).place(meta.size, x, y, c);
  } catch (err) {
    console.error("[permaplace] write failed:", err);
    return json({ error: "server" }, 500);
  }
  if (res.error === "taken") return json({ error: "taken" }, 409);
  placed.set(key, now);
  return json(res);
}

async function apiUnlock(req, server, room) {
  const meta = getRoom(room);
  if (!meta) return json({ error: "room" }, 404);
  if (!unlockLimit(clientIp(req, server))) return json({ error: "slow" }, 429);
  let p = "";
  try {
    p = String((await req.json())?.p ?? "");
  } catch {}
  return json({ ok: !!meta.password && safeEqual(p, meta.password) });
}

// ------------------------------------------------------------------ images, manifest, robots, sitemap

const staticPayloads = {
  favicon: new Payload(faviconSvg(), "image/svg+xml", { cache: "public, max-age=86400" }),
  manifest: new Payload(
    JSON.stringify({
      name: "Permaplace",
      short_name: "Permaplace",
      description: "A shared pixel canvas where every pixel is permanent.",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#0a0a0a",
      theme_color: "#0a0a0a",
      icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
    }),
    "application/manifest+json",
    { cache: "public, max-age=86400" },
  ),
  robots: new Payload(`User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${SITE}/sitemap.xml\n`, "text/plain; charset=utf-8", { cache: "public, max-age=3600" }),
};
const iconCache = new Map();
function icon(req, size) {
  if (!iconCache.has(size)) iconCache.set(size, new Payload(iconPng(size), "image/png", { cache: "public, max-age=86400" }));
  return iconCache.get(size).response(req);
}

const ogCache = new Map();
function og(req, room) {
  let hit = ogCache.get(room);
  if (!hit || Date.now() - hit.at > 600_000) {
    const meta = getRoom(room);
    const viewable = meta && roomAccess(meta).view === "open";
    const png = ogPng(viewable ? roomState(room) : { chunks: new Map() }, meta?.size || 1000, logoImage);
    hit = { at: Date.now(), payload: new Payload(png, "image/png", { cache: "public, max-age=600", etag: false }) };
    ogCache.set(room, hit);
  }
  return hit.payload.response(req);
}

function sitemap(req) {
  const { list } = roomMetas();
  const body = sitemapXml(list, (name) => peekState(name)?.lastT || 0);
  return new Payload(body, "application/xml; charset=utf-8", { cache: "public, max-age=3600" }).response(req);
}

// ------------------------------------------------------------------ router

async function route(req, server) {
  const url = new URL(req.url);
  let path = url.pathname.replace(/\/{2,}/g, "/");
  if (path.length > 1) path = path.replace(/\/$/, "");
  const get = req.method === "GET" || req.method === "HEAD";
  let m;

  if (get) {
    if (path === "/") return page(req, "room", "main");
    if (path === "/practice") return page(req, "practice", "practice");
    if ((m = path.match(/^\/r\/([^/]+)$/))) {
      const room = normRoom(m[1]);
      if (!room) return page(req, "room", "-");
      if (room === "main") return redirect("/");
      if (room !== m[1]) return redirect(`/r/${room}`);
      return page(req, "room", room);
    }
    if ((m = path.match(/^\/assets\/([\w.-]+)$/))) return serveAsset(req, url, m[1]);
    if ((m = path.match(/^\/api\/rooms\/([^/]+)\/pixels$/))) {
      const room = normRoom(m[1]);
      return room ? apiPixels(req, url, room) : json({ error: "room" }, 404);
    }
    if ((m = path.match(/^\/og\/([^/]+)\.png$/))) {
      const room = normRoom(m[1]);
      return room ? og(req, room) : text("Not found", 404);
    }
    if (path === "/favicon.svg") return staticPayloads.favicon.response(req);
    if (path === "/favicon.ico") return faviconIco ? faviconIco.response(req) : redirect("/favicon.svg", 302);
    if (path === "/apple-touch-icon.png") return icon(req, 180);
    if (path === "/icon-192.png") return icon(req, 192);
    if (path === "/icon-512.png") return icon(req, 512);
    if (path === "/manifest.webmanifest") return staticPayloads.manifest.response(req);
    if (path === "/robots.txt") return staticPayloads.robots.response(req);
    if (path === "/sitemap.xml") return sitemap(req);
    if (path === "/healthz") return text("ok");

    // Old URLs from the Flask version.
    if (["/permaplace", "/perma", "/pp"].includes(path)) return redirect("/");
    if (path === "/permaplacepractice") return redirect("/practice");
    if ((m = path.match(/^\/(?:permaplace|perma|pp)\/([^/]+)$/))) {
      const room = normRoom(m[1]);
      return redirect(!room || room === "main" ? "/" : `/r/${room}`);
    }
  } else if (req.method === "POST") {
    if ((m = path.match(/^\/api\/rooms\/([^/]+)\/(pixel|unlock)$/))) {
      const room = normRoom(m[1]);
      if (!room) return json({ error: "room" }, 404);
      return m[2] === "pixel" ? apiPlace(req, server, room) : apiUnlock(req, server, room);
    }
  }
  return new Payload(notFoundPage(), "text/html; charset=utf-8", { cache: "no-store", headers: htmlHeaders }).response(req, 404);
}

await buildAssets();
roomMetas();
roomState("main"); // warm the cache so the first visitor is fast

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req, server) {
    try {
      const res = await route(req, server);
      res.headers.set("x-content-type-options", "nosniff");
      return req.method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
    } catch (err) {
      console.error("[permaplace] unhandled error:", err);
      return text("Internal Server Error", 500);
    }
  },
});

console.log(`Permaplace listening on http://${server.hostname}:${server.port}  (site: ${SITE}, databases: ${DB_DIR})`);