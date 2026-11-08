// SQLite access + in-memory chunk cache.
//
// The on-disk format is unchanged from the Flask version:
//   pprooms.db  -> table pprooms(name, description, size, public, cooldown, updateinterval,
//                                password, owner, friends, viewpermission, placepermission,
//                                modifypermission)
//   pppixels.db -> table chunks(room, coords, data, lastchange)
// A chunk is 100x100 pixels, `coords` is "cx,cy" and `data` is a run-length string such as
// "523.a4999." (a count is written in front of a character only when the run is > 1).
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CHUNK, EMPTY } from "../public/palette.js";

export const DB_DIR = process.env.DB_DIR || "./databases";
export const CELLS = CHUNK * CHUNK;
export const GRID = 100; // chunk index = cx + cy * GRID (same key the old /ppu endpoint used)
const DOT = EMPTY.charCodeAt(0);

mkdirSync(DB_DIR, { recursive: true });
const roomsDb = new Database(join(DB_DIR, "pprooms.db"), { create: true });
const pixelsDb = new Database(join(DB_DIR, "pppixels.db"), { create: true });

for (const db of [roomsDb, pixelsDb]) {
  // WAL makes many small writes cheap. Set SQLITE_WAL=0 to keep the default rollback journal.
  if (process.env.SQLITE_WAL !== "0") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
}

// Only created on a brand new database - existing tables are never altered.
roomsDb.exec(`CREATE TABLE IF NOT EXISTS pprooms (
  name TEXT, description TEXT, size INTEGER, public INTEGER, cooldown REAL, updateinterval REAL,
  password TEXT, owner TEXT, friends TEXT, viewpermission INTEGER, placepermission INTEGER,
  modifypermission INTEGER)`);
pixelsDb.exec("CREATE TABLE IF NOT EXISTS chunks (room TEXT, coords TEXT, data TEXT, lastchange REAL)");

if (roomsDb.query("SELECT COUNT(*) AS n FROM pprooms").get().n === 0) {
  roomsDb
    .query(
      `INSERT INTO pprooms(name, description, size, public, cooldown, updateinterval, password, owner,
        friends, viewpermission, placepermission, modifypermission) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run("main", "The place where every pixel lasts a lifetime.", 10000, 1, 5, 5, "", "system", "", 0, 0, 3);
}

// ---------------------------------------------------------------- run-length format

export function rleDecode(s) {
  const out = new Uint8Array(CELLS).fill(DOT);
  let p = 0;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 48 && c <= 57) {
      n = n * 10 + (c - 48);
      continue;
    }
    const len = n || 1;
    n = 0;
    if (p < CELLS) out.fill(c, p, Math.min(CELLS, p + len));
    p += len;
  }
  return out;
}

export function rleEncode(bytes) {
  const parts = [];
  let last = bytes[0];
  let count = 1;
  for (let i = 1; i <= bytes.length; i++) {
    if (i < bytes.length && bytes[i] === last) {
      count++;
      continue;
    }
    if (count > 1) parts.push(count);
    parts.push(String.fromCharCode(last));
    if (i < bytes.length) {
      last = bytes[i];
      count = 1;
    }
  }
  return parts.join("");
}

/** Calls fn(start, length, charCode) for every run of a chunk string. */
export function eachRun(s, fn) {
  let p = 0;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 48 && c <= 57) {
      n = n * 10 + (c - 48);
      continue;
    }
    const len = n || 1;
    n = 0;
    fn(p, len, c);
    p += len;
  }
}

function countFilled(s) {
  let total = 0;
  eachRun(s, (_p, len, c) => {
    if (c !== DOT) total += len;
  });
  return total;
}

// ---------------------------------------------------------------- rooms

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const roomsQuery = roomsDb.query(
  `SELECT name, description, size, public, cooldown, updateinterval, password, owner, friends,
     viewpermission, placepermission, modifypermission FROM pprooms`,
);

let metaCache = { at: 0, map: new Map(), list: [] };

/** Room metadata, refreshed from SQLite every few seconds so manual edits show up. */
export function roomMetas() {
  const now = Date.now();
  if (now - metaCache.at < 10_000) return metaCache;
  const map = new Map();
  for (const r of roomsQuery.all()) {
    const name = String(r.name ?? "").toLowerCase();
    if (!name || map.has(name)) continue;
    map.set(name, {
      name,
      description: String(r.description ?? ""),
      size: clamp(Math.round(num(r.size, 1000)), 100, 10000),
      cooldown: clamp(num(r.cooldown, 5), 0, 3600),
      interval: clamp(num(r.updateinterval, 5), 1, 60),
      password: String(r.password ?? ""),
      owner: String(r.owner ?? ""),
      view: num(r.viewpermission, 0),
      place: num(r.placepermission, 0),
    });
  }
  const list = [...map.values()].sort((a, b) => (a.name === "main" ? -1 : b.name === "main" ? 1 : a.name.localeCompare(b.name)));
  metaCache = { at: now, map, list };
  return metaCache;
}

export const getRoom = (name) => roomMetas().map.get(name);

// ---------------------------------------------------------------- chunk state

const loadQuery = pixelsDb.query("SELECT rowid AS id, coords, data, lastchange FROM chunks WHERE room = ?");
const updateQuery = pixelsDb.query("UPDATE chunks SET data = ?, lastchange = ? WHERE rowid = ?");
const insertQuery = pixelsDb.query("INSERT INTO chunks(room, coords, data, lastchange) VALUES (?, ?, ?, ?)");

const LOG_MAX = 50_000;

export class RoomState {
  constructor(name) {
    this.name = name;
    this.chunks = new Map(); // idx -> { id (rowid), coords, rle, t }
    this.log = []; // [{ t, idx }] ascending by t - every change since `floor`
    this.lastT = 0;
    this.floor = 0;
    this.count = 0; // pixels placed
    this.version = 0;
    this.snap = null;
    for (const r of loadQuery.all(name)) {
      const [cx, cy] = String(r.coords).split(",").map(Number);
      if (!Number.isInteger(cx) || !Number.isInteger(cy)) continue;
      const idx = cx + cy * GRID;
      const t = num(r.lastchange, 0);
      const old = this.chunks.get(idx);
      if (old && old.t >= t) continue;
      this.chunks.set(idx, { id: r.id, coords: `${cx},${cy}`, rle: String(r.data), t });
      if (t > this.lastT) this.lastT = t;
    }
    for (const c of this.chunks.values()) this.count += countFilled(c.rle);
    this.floor = this.lastT; // changes older than this are not in the log
  }

  nextT() {
    this.lastT = Math.max(Date.now() / 1000, this.lastT + 1e-6);
    return this.lastT;
  }

  /** Chunks changed after `since`, plus the timestamp the client should ask for next. */
  delta(since) {
    const c = {};
    if (since >= this.floor) {
      for (let i = this.log.length - 1; i >= 0; i--) {
        const e = this.log[i];
        if (e.t <= since) break;
        c[e.idx] = this.chunks.get(e.idx).rle;
      }
    } else {
      for (const [idx, ch] of this.chunks) if (ch.t > since) c[idx] = ch.rle;
    }
    return { t: this.lastT, c };
  }

  /** Full canvas as JSON; rebuilt at most every 2 seconds under load. */
  snapshot() {
    const now = Date.now();
    if (this.snap && (this.snap.v === this.version || now - this.snap.at < 2000)) return this.snap.json;
    const json = JSON.stringify(this.delta(-1));
    this.snap = { v: this.version, at: now, json };
    return json;
  }

  /** Places one pixel. The pixel must be empty - nothing is ever overwritten. */
  place(size, x, y, ch) {
    const cx = Math.floor(x / CHUNK);
    const cy = Math.floor(y / CHUNK);
    const idx = cx + cy * GRID;
    const pos = (y % CHUNK) * CHUNK + (x % CHUNK);
    const code = ch.charCodeAt(0);
    const chunk = this.chunks.get(idx);

    let rle;
    if (chunk) {
      const bytes = rleDecode(chunk.rle);
      if (bytes[pos] !== DOT) return { error: "taken" };
      bytes[pos] = code;
      rle = rleEncode(bytes);
      const t = this.nextT();
      updateQuery.run(rle, t, chunk.id);
      chunk.rle = rle;
      chunk.t = t;
    } else {
      const bytes = new Uint8Array(CELLS).fill(DOT);
      bytes[pos] = code;
      rle = rleEncode(bytes);
      const t = this.nextT();
      const res = insertQuery.run(this.name, `${cx},${cy}`, rle, t);
      this.chunks.set(idx, { id: Number(res.lastInsertRowid), coords: `${cx},${cy}`, rle, t });
    }

    this.log.push({ t: this.lastT, idx });
    if (this.log.length > LOG_MAX) {
      const cut = this.log.splice(0, LOG_MAX / 2);
      this.floor = cut[cut.length - 1].t;
    }
    this.count++;
    this.version++;
    return { ok: true, idx, rle, t: this.lastT };
  }
}

const states = new Map();
export function roomState(name) {
  let s = states.get(name);
  if (!s) states.set(name, (s = new RoomState(name)));
  return s;
}

/** Already-loaded state, without touching the database. */
export const peekState = (name) => states.get(name);