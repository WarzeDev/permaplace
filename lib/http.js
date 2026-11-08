import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { createHash } from "node:crypto";

const enc = new TextEncoder();

/** A response body that is compressed lazily, once per encoding, and then reused. */
export class Payload {
  constructor(body, type, { cache = "no-cache", etag = true, brQuality = 5, minCompress = 1024, headers = {} } = {}) {
    this.raw = typeof body === "string" ? enc.encode(body) : body;
    this.type = type;
    this.cache = cache;
    this.brQuality = brQuality;
    this.minCompress = minCompress;
    this.headers = headers;
    this.gz = null;
    this.br = null;
    this.etag = etag ? `"${createHash("sha1").update(this.raw).digest("base64url").slice(0, 20)}"` : null;
    this.compressible = /^(text\/|application\/(json|javascript|xml|manifest|ld)|image\/svg|font\/ttf)/.test(type) || type.includes("+json");
  }

  response(req, status = 200, extra = {}) {
    const h = { "content-type": this.type, "cache-control": this.cache, vary: "Accept-Encoding", ...this.headers, ...extra };
    if (this.etag) {
      h.etag = this.etag;
      if (req.headers.get("if-none-match") === this.etag) return new Response(null, { status: 304, headers: h });
    }
    let body = this.raw;
    if (this.compressible && this.raw.length >= this.minCompress) {
      const ae = req.headers.get("accept-encoding") || "";
      if (/\bbr\b/.test(ae)) {
        this.br ??= brotliCompressSync(this.raw, { params: { [constants.BROTLI_PARAM_QUALITY]: this.brQuality } });
        body = this.br;
        h["content-encoding"] = "br";
      } else if (/\bgzip\b/.test(ae)) {
        this.gz ??= gzipSync(this.raw, { level: 6 });
        body = this.gz;
        h["content-encoding"] = "gzip";
      }
    }
    return new Response(body, { status, headers: h });
  }
}

export const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

/** Gzip a dynamic JSON string when the client supports it (used for canvas snapshots and deltas). */
export function dynamicJson(req, text, status = 200) {
  const h = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", vary: "Accept-Encoding" };
  let body = text;
  if (text.length > 1024 && /\bgzip\b/.test(req.headers.get("accept-encoding") || "")) {
    body = gzipSync(text, { level: 5 });
    h["content-encoding"] = "gzip";
  }
  return new Response(body, { status, headers: h });
}