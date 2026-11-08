// Server-side HTML. Everything crawlers need (title, description, canonical, Open Graph, JSON-LD,
// the intro text and the room list) is in the first response - the canvas itself needs JavaScript.
import { createHash } from "node:crypto";

export const SITE = (process.env.SITE_URL || "https://permaplace.warze.dev").replace(/\/$/, "");

const nf = new Intl.NumberFormat("en-US");
const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const jsonForHtml = (o) => JSON.stringify(o).replace(/</g, "\\u003c").replace(/\u2028|\u2029/g, "");

// Runs before first paint so the saved theme / "intro already seen" state never flashes.
export const THEME_SCRIPT = `(function(){try{var d=document.documentElement,t=localStorage.getItem("pp-theme");if(t==="light"||t==="dark")d.dataset.theme=t;if(localStorage.getItem("pp-seen"))d.classList.add("seen")}catch(e){}})()`;
export const THEME_HASH = "sha256-" + createHash("sha256").update(THEME_SCRIPT).digest("base64");

export const CSP = [
  "default-src 'self'",
  `script-src 'self' '${THEME_HASH}'`,
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ");

const ICONS = {
  rooms: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 1-1 1.7"/><path d="M12 17h.01"/>',
  theme: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>',
  practice: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  pipette:
    '<path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3z"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
};
const icon = (n) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n]}</svg>`;

const LOGO_SVG = '<svg class="logo" viewBox="0 0 7 7" aria-hidden="true" shape-rendering="crispEdges"><rect x="1" y="1" width="4" height="1" class="l1"/><rect x="1" y="2" width="1" height="1" class="l2"/><rect x="5" y="2" width="1" height="1" class="l2"/><rect x="1" y="3" width="4" height="1" class="l3"/><rect x="1" y="4" width="1" height="1" class="l4"/><rect x="1" y="5" width="1" height="1" class="l5"/></svg>';

function canonicalPath(ctx) {
  if (ctx.practice) return "/practice";
  return ctx.meta.name === "main" ? "/" : `/r/${ctx.meta.name}`;
}

function describe(ctx) {
  const { meta, practice } = ctx;
  if (practice) return "Try Permaplace without any pressure: a small private practice canvas with no cooldown. Learn to pan, zoom and place pixels.";
  const s = nf.format(meta.size);
  const base = `Place a pixel every ${meta.cooldown}s on a shared ${s} × ${s} canvas. Every pixel is permanent and can never be overwritten.`;
  const text = meta.description ? `${meta.description} ${base}` : base;
  if (text.length <= 160) return text;
  return text.slice(0, 157).replace(/\s+\S*$/, "") + "…";
}

function titleOf(ctx) {
  const { meta, practice } = ctx;
  if (practice) return "Practice Canvas - Permaplace";
  if (meta.name === "main") return `Permaplace - The Permanent ${nf.format(meta.size)} × ${nf.format(meta.size)} Pixel Canvas`;
  return `/${meta.name} - Permaplace Pixel Canvas`;
}

function roomList(rooms) {
  const items = rooms.slice(0, 200).map((r) => {
    const href = r.name === "main" ? "/" : `/r/${r.name}`;
    const lock = (r.view === 1 || r.place === 1) && r.password ? " · password" : "";
    const by = r.owner ? ` · by ${esc(r.owner)}` : "";
    return `<li><a href="${href}"><strong>/${esc(r.name === "main" ? "permaplace" : r.name)}</strong></a><span class="meta">${nf.format(r.size)} × ${nf.format(r.size)} · ${r.cooldown}s cooldown${by}${lock}</span>${
      r.description ? `<p>${esc(r.description)}</p>` : ""
    }</li>`;
  });
  return items.join("");
}

function aboutBody(ctx) {
  const { meta, practice, count } = ctx;
  const s = nf.format(meta.size);
  if (practice) {
    return `<h1 id="about-title">Practice canvas</h1>
<p class="lead">A private ${s} × ${s} sandbox with no cooldown. Nothing here is saved or sent to anyone, so you can freely draw, overwrite and experiment.</p>
<h2>Controls</h2>
<ul>
<li><strong>Drag</strong> or swipe to pan.</li>
<li><strong>Scroll</strong> or pinch to zoom.</li>
<li><strong>Click</strong> to place a pixel. On touch screens tap a pixel, then press <em>Place</em>.</li>
<li><strong>Right-click</strong> or use the eyedropper to copy a colour from the canvas.</li>
</ul>
<p>Ready for the real thing? <a href="/">Open the main Permaplace canvas</a>.</p>`;
  }
  const isMain = meta.name === "main";
  return `<h1 id="about-title">Welcome to ${isMain ? "Permaplace" : "/" + esc(meta.name)}</h1>
<p class="lead">${esc(meta.description || "The place where every pixel lasts a lifetime.")}</p>
<p>A shared canvas of <strong>${s} × ${s} pixels</strong>. You can place one pixel every <strong>${meta.cooldown} seconds</strong>, and once a pixel is placed it is <strong>permanent</strong>: nobody can paint over it, ever.${
    isMain ? " There are no rules." : ""
  } ${count > 0 ? `So far ${nf.format(count)} pixels have been placed here.` : "Be the first to leave a mark."}</p>
<h2>How it works</h2>
<ol>
<li>Pick a colour from the palette.</li>
<li>Zoom in and click the pixel you want. On touch screens tap it, then press <em>Place</em>.</li>
<li>Wait for the cooldown bar to fill, then place the next one.</li>
</ol>
<h2>Controls</h2>
<ul>
<li><strong>Drag</strong> or swipe to pan, <strong>scroll</strong> or pinch to zoom.</li>
<li><strong>Right-click</strong> or use the eyedropper to copy a colour from the canvas.</li>
<li>Share a spot by copying the address bar - it contains your coordinates.</li>
</ul>
<p class="warn">Anyone can place pixels, so artwork may contain NSFW content.</p>`;
}

export function renderPage(ctx) {
  const { meta, practice, assets, rooms, access } = ctx;
  const title = titleOf(ctx);
  const description = describe(ctx);
  const path = canonicalPath(ctx);
  const url = SITE + path;
  const denied = access.view === "denied";
  const robots = denied ? "noindex,nofollow" : "index,follow,max-image-preview:large";
  const ogImage = practice ? `${SITE}/og/main.png` : `${SITE}/og/${meta.name}.png`;
  const cfg = {
    room: practice ? "practice" : meta.name,
    size: meta.size,
    cooldown: practice ? 0 : meta.cooldown,
    interval: meta.interval,
    practice: !!practice,
    viewLocked: access.view === "password",
    placeLocked: access.place === "password",
    canPlace: access.place !== "denied",
  };

  const graph = [
    { "@type": "WebSite", "@id": `${SITE}/#website`, url: `${SITE}/`, name: "Permaplace", inLanguage: "en" },
    {
      "@type": "WebApplication",
      "@id": `${url}#app`,
      name: title,
      url,
      description,
      applicationCategory: "GameApplication",
      operatingSystem: "Any",
      browserRequirements: "Requires JavaScript",
      isAccessibleForFree: true,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      isPartOf: { "@id": `${SITE}/#website` },
      image: ogImage,
    },
  ];
  if (path !== "/") {
    graph.push({
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Permaplace", item: `${SITE}/` },
        { "@type": "ListItem", position: 2, name: practice ? "Practice" : `/${meta.name}`, item: url },
      ],
    });
  }

  const aboutHtml = denied
    ? `<h1 id="about-title">Private room</h1><p class="lead">/${esc(meta.name)} is only visible to its owner and friends.</p><p><a href="/">Go to the main canvas</a></p>`
    : aboutBody(ctx);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="${esc(description)}">
<meta name="robots" content="${robots}">
<link rel="canonical" href="${esc(url)}">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f4f4f5" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0a0a0a" media="(prefers-color-scheme: dark)">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="${assets.favicon}" type="${assets.faviconType}" sizes="any">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Permaplace">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(ogImage)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(ogImage)}">
${assets.font ? `<link rel="preload" href="${assets.font}" as="font" type="font/woff2" crossorigin>` : ""}
<link rel="stylesheet" href="${assets.css}">
<script>${THEME_SCRIPT}</script>
<script type="application/ld+json">${jsonForHtml({ "@context": "https://schema.org", "@graph": graph })}</script>
${denied ? "" : `<script type="module" src="${assets.js}"></script>`}
</head>
<body class="${practice ? "practice" : ""}">
<canvas id="view" role="img" aria-label="${esc(practice ? "Practice pixel canvas" : `Shared pixel canvas, ${nf.format(meta.size)} by ${nf.format(meta.size)} pixels`)}"></canvas>
<div id="loading" class="loading" aria-hidden="true"></div>

<header class="bar panel">
  <a class="brand" href="/" aria-label="Permaplace home">${assets.logo ? `<img class="logo" src="${assets.logo}" width="24" height="24" alt="">` : LOGO_SVG}<span class="brand-name">Permaplace</span></a>
  <span class="room-chip" title="Current room">${practice ? "practice" : "/" + esc(meta.name === "main" ? "permaplace" : meta.name)}</span>
  <nav class="actions" aria-label="Main">
    ${practice ? `<button class="btn" id="btn-clear" type="button">${icon("trash")}<span class="lbl">Clear</span></button>` : `<a class="btn" href="/practice" rel="nofollow">${icon("practice")}<span class="lbl">Practice</span></a>`}
    <button class="btn" id="btn-rooms" type="button" aria-haspopup="dialog">${icon("rooms")}<span class="lbl">Rooms</span></button>
    <button class="btn" id="btn-help" type="button" aria-haspopup="dialog">${icon("help")}<span class="lbl">Help</span></button>
    <button class="btn" id="btn-theme" type="button" aria-label="Theme: auto">${icon("theme")}<span class="lbl" id="theme-lbl">Auto</span></button>
  </nav>
</header>

<div class="zoom panel" role="group" aria-label="Zoom">
  <button class="btn icon" id="zoom-in" type="button" aria-label="Zoom in">${icon("plus")}</button>
  <button class="btn icon" id="zoom-out" type="button" aria-label="Zoom out">${icon("minus")}</button>
  <button class="btn icon" id="zoom-fit" type="button" aria-label="Show whole canvas">${icon("fit")}</button>
</div>

<div class="bottom">
  <div class="hud">
    <span class="chip" id="hud-pos" aria-hidden="true">-</span>
    <span class="chip" id="hud-state">Loading canvas…</span>
  </div>
  <footer class="dock panel">
    <div class="cd" aria-hidden="true"><i id="cd-fill"></i></div>
    <button class="btn icon" id="btn-pipette" type="button" aria-pressed="false" aria-label="Pick a colour from the canvas" title="Pick colour from canvas">${icon("pipette")}</button>
    <div id="palette" class="palette" role="radiogroup" aria-label="Colours"></div>
    <button class="btn primary" id="btn-place" type="button" hidden>${icon("check")}<span>Place</span></button>
  </footer>
</div>

<div id="toasts" class="toasts" aria-live="polite"></div>

<dialog id="dlg-about" open aria-labelledby="about-title">
  <div class="dlg-body">${aboutHtml}</div>
  <form method="dialog" class="dlg-foot">
    ${practice || denied ? "" : `<a class="btn" href="/practice" rel="nofollow">Practice first</a>`}
    <button class="btn primary" autofocus>${denied ? "Close" : practice ? "Start drawing" : "Start placing"}</button>
  </form>
</dialog>

<dialog id="dlg-rooms" aria-labelledby="rooms-title">
  <div class="dlg-body"><h2 id="rooms-title" class="h">Rooms</h2><ul class="rooms">${roomList(rooms)}</ul></div>
  <form method="dialog" class="dlg-foot"><button class="btn">Close</button></form>
</dialog>

<dialog id="dlg-pass" aria-labelledby="pass-title">
  <form id="pass-form" method="dialog">
    <div class="dlg-body">
      <h2 id="pass-title" class="h">Password required</h2>
      <p>This room needs a password.</p>
      <input id="pass-input" class="field" type="password" autocomplete="off" placeholder="Password" aria-label="Room password" required>
      <p id="pass-error" class="err" role="alert" hidden>Incorrect password.</p>
    </div>
    <div class="dlg-foot"><button class="btn" type="button" id="pass-cancel">Cancel</button><button class="btn primary" type="submit">Unlock</button></div>
  </form>
</dialog>

<noscript><div class="noscript"><strong>Permaplace needs JavaScript.</strong> ${practice ? "This is a private practice canvas." : `It is a ${nf.format(meta.size)} × ${nf.format(meta.size)} pixel canvas where everyone can place a pixel every ${meta.cooldown} seconds and no pixel can ever be overwritten.`}</div></noscript>
<script type="application/json" id="cfg">${jsonForHtml(cfg)}</script>
</body>
</html>`;
}

export function notFoundPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not found - Permaplace</title><meta name="robots" content="noindex"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/assets/style.css"></head><body class="plain"><main class="notfound"><h1>Nothing here</h1><p>This room does not exist.</p><p><a class="btn primary" href="/">Back to Permaplace</a></p></main></body></html>`;
}

export function sitemapXml(rooms, lastOf) {
  const urls = [{ loc: `${SITE}/`, last: lastOf("main") }, { loc: `${SITE}/practice` }];
  for (const r of rooms) {
    if (r.name === "main" || r.view !== 0) continue;
    urls.push({ loc: `${SITE}/r/${r.name}`, last: lastOf(r.name) });
  }
  const body = urls
    .map((u) => `<url><loc>${esc(u.loc)}</loc>${u.last ? `<lastmod>${new Date(u.last * 1000).toISOString()}</lastmod>` : ""}</url>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`;
}