"use strict";

/**
 * Upstash Redis REST tiruan (in-memory) untuk menguji driver Redis tanpa akun asli.
 *
 * Meniru protokol HTTP Upstash:
 *   POST /             body: ["SET", "k", "v"]        -> { result: "OK" }
 *   POST /pipeline     body: [["GET","a"],["GET","b"]] -> [{ result: ... }, ...]
 *   Authorization: Bearer <token>
 *
 * Perintah yang diimplementasikan: PING, GET, SET, DEL, INCRBY, DECRBY, EXPIRE,
 * SCAN, SADD, SCARD, HSET, HSETNX, HGET, HGETALL, HDEL, HINCRBY, RPUSH, LLEN,
 * LRANGE, LTRIM, ZADD, ZCARD, ZREVRANGE.
 *
 * Nilai disimpan bertipe (string/hash/list/set/zset) supaya error "wrong type"
 * tetap bisa muncul seperti Redis sungguhan.
 */

const http = require("node:http");

/** Ubah pola glob Redis (SCAN MATCH) jadi RegExp. */
function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
}

function toInt(value) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

class FakeRedis {
  constructor() {
    this.data = new Map();
    this.expiry = new Map();
    this.commands = [];
  }

  /** Ambil entri, menghormati TTL (seperti Redis). */
  #entry(key, expectedType) {
    const expiresAt = this.expiry.get(key);
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      this.data.delete(key);
      this.expiry.delete(key);
    }

    const entry = this.data.get(key);
    if (!entry) return null;

    if (expectedType && entry.type !== expectedType) {
      throw new Error(`WRONGTYPE Operation against a key holding the wrong kind of value (${key}: ${entry.type})`);
    }
    return entry;
  }

  #get(key, type) {
    return this.#entry(key, type);
  }

  #create(key, type, value) {
    const entry = { type, value };
    this.data.set(key, entry);
    return entry;
  }

  run(args) {
    const [rawCommand, ...params] = args;
    const command = String(rawCommand ?? "").toUpperCase();
    this.commands.push([command, ...params]);

    switch (command) {
      case "PING":
        return "PONG";

      // ---------------------------------------------------------- strings
      case "GET": {
        const entry = this.#get(params[0], "string");
        return entry ? entry.value : null;
      }
      case "SET": {
        this.#create(params[0], "string", String(params[1] ?? ""));
        return "OK";
      }
      case "INCRBY":
      case "DECRBY": {
        const delta = command === "INCRBY" ? toInt(params[1]) : -toInt(params[1]);
        const entry = this.#get(params[0], "string");
        const next = (entry ? toInt(entry.value) : 0) + delta;
        if (entry) entry.value = String(next);
        else this.#create(params[0], "string", String(next));
        return next;
      }
      case "DEL": {
        let removed = 0;
        for (const key of params) {
          if (this.data.delete(key)) removed += 1;
          this.expiry.delete(key);
        }
        return removed;
      }
      case "EXPIRE": {
        const entry = this.data.get(params[0]);
        if (!entry) return 0;
        const seconds = toInt(params[1]);
        if (seconds <= 0) {
          this.data.delete(params[0]);
          this.expiry.delete(params[0]);
          return 1;
        }
        this.expiry.set(params[0], Date.now() + seconds * 1000);
        return 1;
      }
      case "SCAN": {
        const matchIndex = params.findIndex((item) => String(item).toUpperCase() === "MATCH");
        const pattern = matchIndex === -1 ? "*" : String(params[matchIndex + 1]);
        const regex = globToRegExp(pattern);
        const keys = [];
        for (const key of this.data.keys()) {
          this.#get(key); // buang yang sudah kedaluwarsa
          if (this.data.has(key) && regex.test(key)) keys.push(key);
        }
        return ["0", keys.sort()];
      }

      // ------------------------------------------------------------- sets
      case "SADD": {
        const entry = this.#get(params[0], "set") ?? this.#create(params[0], "set", new Set());
        let added = 0;
        for (const member of params.slice(1)) {
          if (!entry.value.has(member)) {
            entry.value.add(member);
            added += 1;
          }
        }
        return added;
      }
      case "SCARD": {
        const entry = this.#get(params[0], "set");
        return entry ? entry.value.size : 0;
      }

      // ------------------------------------------------------------ zsets
      case "ZADD": {
        const entry = this.#get(params[0], "zset") ?? this.#create(params[0], "zset", new Map());
        let added = 0;
        for (let index = 1; index + 1 < params.length; index += 2) {
          const score = Number(params[index]);
          const member = String(params[index + 1]);
          if (!entry.value.has(member)) added += 1;
          entry.value.set(member, score);
        }
        return added;
      }
      case "ZCARD": {
        const entry = this.#get(params[0], "zset");
        return entry ? entry.value.size : 0;
      }
      case "ZREVRANGE": {
        const entry = this.#get(params[0], "zset");
        if (!entry) return [];
        const sorted = [...entry.value.entries()].sort((a, b) => b[1] - a[1]).map(([member]) => member);
        return sliceRange(sorted, params[1], params[2]);
      }

      // ----------------------------------------------------------- hashes
      case "HSET": {
        const entry = this.#get(params[0], "hash") ?? this.#create(params[0], "hash", new Map());
        let added = 0;
        for (let index = 1; index + 1 < params.length; index += 2) {
          const field = String(params[index]);
          if (!entry.value.has(field)) added += 1;
          entry.value.set(field, String(params[index + 1]));
        }
        return added;
      }
      case "HSETNX": {
        const entry = this.#get(params[0], "hash") ?? this.#create(params[0], "hash", new Map());
        const field = String(params[1]);
        if (entry.value.has(field)) return 0;
        entry.value.set(field, String(params[2]));
        return 1;
      }
      case "HGET": {
        const entry = this.#get(params[0], "hash");
        if (!entry) return null;
        const value = entry.value.get(String(params[1]));
        return value === undefined ? null : value;
      }
      case "HGETALL": {
        const entry = this.#get(params[0], "hash");
        if (!entry) return [];
        const out = [];
        for (const [field, value] of entry.value) out.push(field, value);
        return out;
      }
      case "HDEL": {
        const entry = this.#get(params[0], "hash");
        if (!entry) return 0;
        let removed = 0;
        for (const field of params.slice(1)) {
          if (entry.value.delete(String(field))) removed += 1;
        }
        return removed;
      }
      case "HINCRBY": {
        const entry = this.#get(params[0], "hash") ?? this.#create(params[0], "hash", new Map());
        const field = String(params[1]);
        const next = (entry.value.has(field) ? toInt(entry.value.get(field)) : 0) + toInt(params[2]);
        entry.value.set(field, String(next));
        return next;
      }

      // ------------------------------------------------------------ lists
      case "RPUSH": {
        const entry = this.#get(params[0], "list") ?? this.#create(params[0], "list", []);
        for (const item of params.slice(1)) entry.value.push(String(item));
        return entry.value.length;
      }
      case "LLEN": {
        const entry = this.#get(params[0], "list");
        return entry ? entry.value.length : 0;
      }
      case "LRANGE": {
        const entry = this.#get(params[0], "list");
        if (!entry) return [];
        return sliceRange(entry.value, params[1], params[2]);
      }
      case "LTRIM": {
        const entry = this.#get(params[0], "list");
        if (!entry) return "OK";
        const [start, stop] = normalizeRange(entry.value.length, params[1], params[2]);
        entry.value = entry.value.slice(start, stop + 1);
        return "OK";
      }

      default:
        throw new Error(`ERR unknown command '${command}'`);
    }
  }

  /** Jalankan satu perintah; mengembalikan {result} atau {error}. */
  handleOne(args) {
    try {
      return { result: this.run(args) ?? null };
    } catch (error) {
      return { error: error.message };
    }
  }
}

/** Normalisasi indeks gaya Redis (mendukung negatif) jadi [start, stop] absolut. */
function normalizeRange(length, startRaw, stopRaw) {
  let start = toInt(startRaw);
  let stop = toInt(stopRaw);

  if (start < 0) start = Math.max(length + start, 0);
  if (stop < 0) stop = length + stop;
  if (stop >= length) stop = length - 1;

  return [start, stop];
}

function sliceRange(items, startRaw, stopRaw) {
  const [start, stop] = normalizeRange(items.length, startRaw, stopRaw);
  if (stop < start) return [];
  return items.slice(start, stop + 1);
}

/**
 * Jalankan server Upstash tiruan.
 * @param {{ token?: string, failNextWith?: number }} [options]
 */
async function startFakeUpstash(options = {}) {
  const token = options.token ?? "sk-fake-upstash-token";
  const redis = new FakeRedis();
  let forcedFailure = options.failNext ?? null;

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });

    req.on("end", () => {
      const respond = (status, payload) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      if (forcedFailure) {
        respond(forcedFailure, { error: `forced failure ${forcedFailure}` });
        return;
      }

      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${token}`) {
        respond(401, { error: "Unauthorized: token salah" });
        return;
      }

      let body;
      try {
        body = JSON.parse(raw || "null");
      } catch {
        respond(400, { error: "body bukan JSON" });
        return;
      }

      if (req.url?.startsWith("/pipeline")) {
        if (!Array.isArray(body)) {
          respond(400, { error: "/pipeline butuh array" });
          return;
        }
        respond(200, body.map((args) => redis.handleOne(args)));
        return;
      }

      if (!Array.isArray(body)) {
        respond(400, { error: "perintah harus array" });
        return;
      }

      const result = redis.handleOne(body);
      respond(200, result);
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    token,
    redis,
    /** Paksa request berikutnya gagal dengan status tertentu (uji error handling). */
    failWith(status) {
      forcedFailure = status;
    },
    clearFailure() {
      forcedFailure = null;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { startFakeUpstash, FakeRedis, sliceRange, normalizeRange, globToRegExp };
