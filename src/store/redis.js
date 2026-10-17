"use strict";

const { nowIso, sleep, safeJsonParse } = require("../utils");
const { DEFAULT_CHAT_SETTINGS, SCHEMA_VERSION } = require("./shared");

/**
 * Driver penyimpanan Redis lewat Upstash REST API (HTTP).
 *
 * Dipakai untuk deployment serverless (Vercel) di mana filesystem bersifat
 * sementara: SQLite tidak bisa diandalkan, sedangkan Redis HTTP bisa.
 *
 * Tata letak kunci (semua diawali `prefix`, default "bot:"):
 *
 *   meta              HASH   schema_version, migrated_at, created_at
 *   user:<id>         HASH   profil user (nilai di-JSON-kan)
 *   idx:users         SET    daftar id user (untuk SCARD)
 *   chat:<id>         HASH   profil chat
 *   idx:chats         ZSET   id chat, skor = last_seen (ms) -> urut terbaru
 *   set:<chatId>      HASH   chat_settings (key -> "0"/"1"/model)
 *   kv:<key>          HASH   { v: nilai, t: epoch ms } + TTL (session/conversation)
 *   stats             HASH   counter integer (HINCRBY)
 *   ai:<chatId>       LIST   riwayat AI (JSON per baris, dibatasi aiHardLimit)
 *   cnt:ai            STRING jumlah total pesan AI
 *   fb:list           LIST   feedback (JSON per baris)
 *   cnt:fb            STRING jumlah feedback
 *   bc:list           LIST   riwayat broadcast
 *
 * Semua nilai hash disimpan sebagai JSON supaya tipe (string/number/null) tetap
 * utuh saat dibaca kembali — sama seperti kolom SQLite.
 */

class RedisStoreError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "RedisStoreError";
    this.status = options.status ?? 0;
    this.retryable = options.retryable ?? false;
  }
}

/** Klien tipis Upstash REST: POST / untuk satu perintah, POST /pipeline untuk banyak. */
class RedisRestClient {
  /**
   * @param {{ url: string, token: string, timeoutMs?: number, retries?: number, fetchImpl?: Function }} options
   */
  constructor(options = {}) {
    const url = String(options.url ?? "").trim().replace(/\/+$/, "");
    const token = String(options.token ?? "").trim();

    if (!url) throw new RedisStoreError("URL Upstash Redis kosong (UPSTASH_REDIS_REST_URL).");
    if (!token) throw new RedisStoreError("Token Upstash Redis kosong (UPSTASH_REDIS_REST_TOKEN).");

    this.url = url;
    this.token = token;
    this.timeoutMs = Number(options.timeoutMs ?? 10_000);
    this.retries = Number(options.retries ?? 1);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Ubah semua argumen jadi string (format REST Upstash) + tolak nilai kosong. */
  #args(list) {
    return list.map((item) => {
      if (item === null || item === undefined) {
        throw new RedisStoreError(`Argumen perintah Redis tidak boleh null: ${JSON.stringify(list)}`);
      }
      return typeof item === "string" ? item : String(item);
    });
  }

  async #request(path, payload) {
    const endpoint = `${this.url}${path}`;
    let lastError = null;

    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        const response = await this.fetchImpl(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        const text = await response.text();

        if (!response.ok) {
          throw new RedisStoreError(`Upstash HTTP ${response.status}: ${text.slice(0, 200)}`, {
            status: response.status,
            retryable: response.status === 429 || response.status >= 500,
          });
        }

        return text ? JSON.parse(text) : null;
      } catch (error) {
        const wrapped =
          error instanceof RedisStoreError
            ? error
            : new RedisStoreError(`Gagal menghubungi Redis (${endpoint}): ${error?.message ?? error}`, {
                retryable: error?.name !== "TimeoutError",
              });

        if (wrapped.retryable && attempt < this.retries) {
          lastError = wrapped;
          await sleep(150 * (attempt + 1));
          continue;
        }
        throw wrapped;
      }
    }

    throw lastError ?? new RedisStoreError("Perintah Redis gagal tanpa detail.");
  }

  /** Jalankan satu perintah Redis. */
  async command(args) {
    const data = await this.#request("", this.#args(args));
    if (data && typeof data === "object" && data.error) {
      throw new RedisStoreError(`Redis error: ${String(data.error).slice(0, 300)}`);
    }
    return data && typeof data === "object" && "result" in data ? data.result : null;
  }

  /** Jalankan banyak perintah dalam satu round-trip HTTP. */
  async pipeline(commands) {
    if (!Array.isArray(commands) || commands.length === 0) return [];
    const payload = commands.map((command) => this.#args(command));
    const data = await this.#request("/pipeline", payload);

    if (!Array.isArray(data)) {
      throw new RedisStoreError(`Respons /pipeline tidak valid: ${JSON.stringify(data).slice(0, 200)}`);
    }

    return data.map((entry) => {
      if (entry && typeof entry === "object" && entry.error) {
        throw new RedisStoreError(`Redis pipeline error: ${String(entry.error).slice(0, 300)}`);
      }
      return entry && typeof entry === "object" && "result" in entry ? entry.result : null;
    });
  }

  /** Cek koneksi + kredensial. */
  async ping() {
    const result = await this.command(["PING"]);
    return String(result ?? "").toUpperCase() === "PONG";
  }
}

class RedisStore {
  /**
   * @param {{ url: string, token: string, prefix?: string, timeoutMs?: number, retries?: number,
   *           aiHardLimit?: number, kvTtlMs?: number, fetchImpl?: Function }} options
   */
  constructor(options = {}) {
    this.driver = "redis";
    this.kind = "redis";
    this.prefix = String(options.prefix ?? "bot:");
    this.aiHardLimit = Number(options.aiHardLimit ?? 0) || 200;
    this.kvTtlSeconds = Math.max(0, Math.floor(Number(options.kvTtlMs ?? 12 * 60 * 60 * 1000) / 1000));
    this.client = new RedisRestClient(options);
    this.location = this.client.url.replace(/\/\/[^@]*@/, "//"); // tanpa kredensial
    this.closed = false;
    this.raw = this.client; // sama seperti sqlite mengekspos `db`
  }

  /** Tulis versi skema ke meta (idempotent). */
  async init() {
    const pipeline = [
      ["HSETNX", this.k("meta"), "created_at", JSON.stringify(nowIso())],
      [
        "HSET",
        this.k("meta"),
        "schema_version",
        JSON.stringify(String(SCHEMA_VERSION)),
        "migrated_at",
        JSON.stringify(nowIso()),
      ],
    ];
    await this.client.pipeline(pipeline);
    return this;
  }

  /** Kunci lengkap dengan prefix. */
  k(...parts) {
    return `${this.prefix}${parts.join(":")}`;
  }

  #assertOpen() {
    if (this.closed) throw new Error("Store sudah ditutup (closed).");
  }

  /** Objek -> daftar field/nilai rata untuk HSET (nilai di-JSON-kan). */
  #flat(object) {
    const out = [];
    for (const [field, value] of Object.entries(object)) {
      if (value === undefined) continue;
      out.push(field, JSON.stringify(value ?? null));
    }
    return out;
  }

  /** HGETALL -> objek (menerima bentuk array rata maupun objek). */
  #decodeHash(raw) {
    if (!raw) return {};

    if (Array.isArray(raw)) {
      const out = {};
      for (let index = 0; index + 1 < raw.length; index += 2) {
        out[raw[index]] = safeJsonParse(raw[index + 1], raw[index + 1]);
      }
      return out;
    }

    if (typeof raw === "object") {
      const out = {};
      for (const [field, value] of Object.entries(raw)) out[field] = safeJsonParse(value, value);
      return out;
    }

    return {};
  }

  /** Daftar item JSON -> array objek (item rusak dilewati). */
  #decodeList(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map((item) => safeJsonParse(item, null)).filter((item) => item !== null);
  }

  async #scanKeys(match) {
    const keys = [];
    let cursor = "0";

    do {
      const result = await this.client.command(["SCAN", cursor, "MATCH", match, "COUNT", 200]);
      const [next, batch] = Array.isArray(result) ? result : ["0", []];
      for (const key of batch ?? []) keys.push(key);
      cursor = String(next ?? "0");
    } while (cursor !== "0");

    return keys;
  }

  // ---------------------------------------------------------------- meta

  async getMeta(key, fallback = null) {
    this.#assertOpen();
    const raw = await this.client.command(["HGET", this.k("meta"), String(key)]);
    const value = safeJsonParse(raw, raw);
    return value === null || value === undefined ? fallback : value;
  }

  async setMeta(key, value) {
    this.#assertOpen();
    await this.client.command(["HSET", this.k("meta"), String(key), JSON.stringify(String(value))]);
    return value;
  }

  // --------------------------------------------------------------- users

  async upsertUser(from) {
    if (!from || !from.id) return null;
    this.#assertOpen();
    await this.#writeUser(from);
    return this.getUser(from.id);
  }

  #userRecord(from, ts) {
    return {
      id: Number(from.id),
      username: from.username ?? null,
      first_name: from.first_name ?? null,
      last_name: from.last_name ?? null,
      language_code: from.language_code ?? null,
      is_bot: from.is_bot ? 1 : 0,
      is_premium: from.is_premium ? 1 : 0,
      created_at: ts,
      last_seen: ts,
    };
  }

  async #writeUser(from, ts = nowIso()) {
    const key = this.k("user", from.id);
    const record = this.#userRecord(from, ts);
    const mutable = { ...record };
    delete mutable.created_at;

    await this.client.pipeline([
      ["HSETNX", key, "created_at", JSON.stringify(ts)],
      ["HSET", key, ...this.#flat(mutable)],
      ["SADD", this.k("idx:users"), String(from.id)],
    ]);
  }

  #chatRecord(chat, ts) {
    return {
      id: Number(chat.id),
      type: chat.type ?? "private",
      title: chat.title ?? null,
      username: chat.username ?? null,
      created_at: ts,
      last_seen: ts,
    };
  }

  async #writeChat(chat, ts = nowIso()) {
    const key = this.k("chat", chat.id);
    const record = this.#chatRecord(chat, ts);
    const mutable = { ...record };
    delete mutable.created_at;

    await this.client.pipeline([
      ["HSETNX", key, "created_at", JSON.stringify(ts)],
      ["HSET", key, ...this.#flat(mutable)],
      ["ZADD", this.k("idx:chats"), String(Date.parse(ts) || Date.now()), String(chat.id)],
    ]);
  }

  async getUser(id) {
    this.#assertOpen();
    const raw = await this.client.command(["HGETALL", this.k("user", id)]);
    const record = this.#decodeHash(raw);
    return Object.keys(record).length === 0 ? null : record;
  }

  async countUsers() {
    this.#assertOpen();
    return Number(await this.client.command(["SCARD", this.k("idx:users")])) || 0;
  }

  // --------------------------------------------------------------- chats

  async upsertChat(chat) {
    if (!chat || chat.id === undefined) return null;
    this.#assertOpen();
    await this.#writeChat(chat);
    return this.getChat(chat.id);
  }

  async getChat(id) {
    this.#assertOpen();
    const raw = await this.client.command(["HGETALL", this.k("chat", id)]);
    const record = this.#decodeHash(raw);
    return Object.keys(record).length === 0 ? null : record;
  }

  async countChats() {
    this.#assertOpen();
    return Number(await this.client.command(["ZCARD", this.k("idx:chats")])) || 0;
  }

  async listChatIds(limit = 2000) {
    this.#assertOpen();
    const ids = await this.client.command(["ZREVRANGE", this.k("idx:chats"), 0, Math.max(0, Number(limit) - 1)]);
    if (!Array.isArray(ids)) return [];
    return ids.map((id) => Number(id)).filter((id) => Number.isFinite(id));
  }

  // ------------------------------------------------------------ settings

  async getSetting(chatId, key, fallback = null) {
    this.#assertOpen();
    const raw = await this.client.command(["HGET", this.k("set", chatId), String(key)]);
    const value = safeJsonParse(raw, raw);
    if (value !== null && value !== undefined) return value;
    if (fallback !== null) return fallback;
    return DEFAULT_CHAT_SETTINGS[key] ?? null;
  }

  async setSetting(chatId, key, value) {
    this.#assertOpen();
    const hash = this.k("set", chatId);
    if (value === null || value === undefined) {
      await this.client.command(["HDEL", hash, String(key)]);
      return value;
    }
    await this.client.command(["HSET", hash, String(key), JSON.stringify(String(value))]);
    return value;
  }

  async toggleSetting(chatId, key) {
    const next = (await this.isSettingOn(chatId, key)) ? "0" : "1";
    await this.setSetting(chatId, key, next);
    return next;
  }

  async getChatSettings(chatId) {
    this.#assertOpen();
    const raw = await this.client.command(["HGETALL", this.k("set", chatId)]);
    const stored = this.#decodeHash(raw);
    const result = { ...DEFAULT_CHAT_SETTINGS };
    for (const [key, value] of Object.entries(stored)) {
      if (value !== null && value !== undefined) result[key] = String(value);
    }
    return result;
  }

  async resetChatSettings(chatId) {
    this.#assertOpen();
    await this.client.command(["DEL", this.k("set", chatId)]);
    return { ...DEFAULT_CHAT_SETTINGS };
  }

  async isSettingOn(chatId, key) {
    return String((await this.getSetting(chatId, key)) ?? "0") === "1";
  }

  // ------------------------------------------------------------------ kv

  async kvGet(key) {
    this.#assertOpen();
    const raw = await this.client.command(["HGET", this.k("kv", key), "v"]);
    return raw === null || raw === undefined ? null : String(raw);
  }

  async kvSet(key, value) {
    this.#assertOpen();
    const hash = this.k("kv", key);
    const commands = [
      ["HSET", hash, "v", String(value), "t", String(Date.now())],
    ];
    if (this.kvTtlSeconds > 0) commands.push(["EXPIRE", hash, String(this.kvTtlSeconds)]);
    await this.client.pipeline(commands);
    return value;
  }

  async kvDelete(key) {
    this.#assertOpen();
    await this.client.command(["DEL", this.k("kv", key)]);
  }

  async kvCount(prefix = "") {
    this.#assertOpen();
    const keys = await this.#scanKeys(`${this.k("kv", prefix)}*`);
    return keys.length;
  }

  /** TTL sudah menangani kedaluwarsa; ini jaring pengaman untuk data lama. */
  async kvPrune(prefix, olderThanMs) {
    this.#assertOpen();
    const keys = await this.#scanKeys(`${this.k("kv", prefix)}*`);
    if (keys.length === 0) return 0;

    const cutoff = Date.now() - Number(olderThanMs);
    const stamps = await this.client.pipeline(keys.map((key) => ["HGET", key, "t"]));

    const stale = [];
    keys.forEach((key, index) => {
      const updatedAt = Number(stamps[index]);
      if (!Number.isFinite(updatedAt) || updatedAt < cutoff) stale.push(key);
    });

    if (stale.length > 0) {
      await this.client.pipeline(stale.map((key) => ["DEL", key]));
    }
    return stale.length;
  }

  /** Test hook: paksa `t` sebuah entri kv (untuk menguji kvPrune). */
  async debugSetKvUpdatedAt(key, iso) {
    this.#assertOpen();
    const at = Date.parse(String(iso));
    await this.client.command(["HSET", this.k("kv", key), "t", String(Number.isFinite(at) ? at : Date.now())]);
  }

  // ---------------------------------------------------------- ai history

  async addAiMessage({ chatId, userId = null, role, content, model = null }) {
    this.#assertOpen();
    const key = this.k("ai", chatId);
    const record = {
      chat_id: Number(chatId),
      user_id: userId === null ? null : Number(userId),
      role: String(role),
      content: String(content),
      model: model === null ? null : String(model),
      created_at: nowIso(),
    };

    await this.client.pipeline([
      ["RPUSH", key, JSON.stringify(record)],
      ["LTRIM", key, String(-this.aiHardLimit), "-1"],
      ["INCRBY", this.k("cnt:ai"), 1],
    ]);
  }

  async getAiHistory(chatId, limit = 20) {
    this.#assertOpen();
    const count = Math.max(1, Number(limit) || 1);
    const raw = await this.client.command(["LRANGE", this.k("ai", chatId), String(-count), "-1"]);
    return this.#decodeList(raw).map((item) => ({
      role: item.role,
      content: item.content,
      model: item.model ?? null,
      createdAt: item.created_at ?? null,
    }));
  }

  async clearAiHistory(chatId) {
    this.#assertOpen();
    const key = this.k("ai", chatId);
    const length = Number(await this.client.command(["LLEN", key])) || 0;
    if (length === 0) return 0;

    await this.client.pipeline([
      ["DEL", key],
      ["DECRBY", this.k("cnt:ai"), length],
    ]);
    return length;
  }

  async trimAiHistory(chatId, keep) {
    this.#assertOpen();
    const key = this.k("ai", chatId);
    const limit = Math.max(0, Number(keep) || 0);
    const length = Number(await this.client.command(["LLEN", key])) || 0;
    if (length <= limit) return 0;

    const removed = length - limit;
    const commands = [["DECRBY", this.k("cnt:ai"), removed]];
    commands.push(limit === 0 ? ["DEL", key] : ["LTRIM", key, String(-limit), "-1"]);

    await this.client.pipeline(commands);
    return removed;
  }

  async countAiMessages() {
    this.#assertOpen();
    return Number(await this.client.command(["GET", this.k("cnt:ai")])) || 0;
  }

  // ------------------------------------------------------------ feedback

  async addFeedback({ chatId, userId = null, rating, comment = null }) {
    this.#assertOpen();
    const record = {
      chat_id: Number(chatId),
      user_id: userId === null ? null : Number(userId),
      rating: Number(rating),
      comment: comment === null ? null : String(comment),
      created_at: nowIso(),
    };

    await this.client.pipeline([
      ["RPUSH", this.k("fb:list"), JSON.stringify(record)],
      ["INCRBY", this.k("cnt:fb"), 1],
      ["HINCRBY", this.k("stats"), "feedback_total", 1],
    ]);
  }

  async listFeedback(limit = 10) {
    this.#assertOpen();
    const count = Math.max(1, Number(limit) || 1);
    const raw = await this.client.command(["LRANGE", this.k("fb:list"), String(-count), "-1"]);
    return this.#decodeList(raw).reverse(); // terbaru dulu, seperti SQLite
  }

  async countFeedback() {
    this.#assertOpen();
    return Number(await this.client.command(["GET", this.k("cnt:fb")])) || 0;
  }

  // --------------------------------------------------------------- stats

  async bumpStat(key, by = 1) {
    this.#assertOpen();
    await this.client.command(["HINCRBY", this.k("stats"), String(key), Number(by) || 0]);
  }

  async getStat(key) {
    this.#assertOpen();
    return Number(await this.client.command(["HGET", this.k("stats"), String(key)])) || 0;
  }

  async getStats() {
    this.#assertOpen();
    const raw = await this.client.command(["HGETALL", this.k("stats")]);
    const result = {};
    if (Array.isArray(raw)) {
      for (let index = 0; index + 1 < raw.length; index += 2) result[raw[index]] = Number(raw[index + 1]) || 0;
    } else if (raw && typeof raw === "object") {
      for (const [key, value] of Object.entries(raw)) result[key] = Number(value) || 0;
    }
    return result;
  }

  // ----------------------------------------------------------- broadcast

  async recordBroadcast({ adminId, text, sent, failed }) {
    this.#assertOpen();
    const record = {
      admin_id: Number(adminId),
      text: String(text),
      sent: Number(sent),
      failed: Number(failed),
      created_at: nowIso(),
    };
    await this.client.command(["RPUSH", this.k("bc:list"), JSON.stringify(record)]);
  }

  async listBroadcasts(limit = 5) {
    this.#assertOpen();
    const count = Math.max(1, Number(limit) || 1);
    const raw = await this.client.command(["LRANGE", this.k("bc:list"), String(-count), "-1"]);
    return this.#decodeList(raw).reverse();
  }

  // ------------------------------------------------------ batch (hot path)

  /** Satu pipeline untuk user + chat + statistik (padanan transaksi SQLite). */
  async recordUpdate({ user, chat, stats = [] } = {}) {
    this.#assertOpen();
    const ts = nowIso();
    const commands = [];

    if (user?.id) {
      const key = this.k("user", user.id);
      const record = this.#userRecord(user, ts);
      const mutable = { ...record };
      delete mutable.created_at;
      commands.push(["HSETNX", key, "created_at", JSON.stringify(ts)]);
      commands.push(["HSET", key, ...this.#flat(mutable)]);
      commands.push(["SADD", this.k("idx:users"), String(user.id)]);
    }

    if (chat?.id !== undefined) {
      const key = this.k("chat", chat.id);
      const record = this.#chatRecord(chat, ts);
      const mutable = { ...record };
      delete mutable.created_at;
      commands.push(["HSETNX", key, "created_at", JSON.stringify(ts)]);
      commands.push(["HSET", key, ...this.#flat(mutable)]);
      commands.push(["ZADD", this.k("idx:chats"), String(Date.parse(ts) || Date.now()), String(chat.id)]);
    }

    for (const [key, by] of stats) {
      commands.push(["HINCRBY", this.k("stats"), String(key), Number(by ?? 1) || 0]);
    }

    if (commands.length > 0) await this.client.pipeline(commands);
  }

  // -------------------------------------------------------------- helper

  sessionStorage(prefix = "session:") {
    const store = this;
    return {
      async read(key) {
        const raw = await store.kvGet(prefix + key);
        return raw === null ? undefined : safeJsonParse(raw, undefined);
      },
      async write(key, value) {
        await store.kvSet(prefix + key, JSON.stringify(value ?? {}));
      },
      async delete(key) {
        await store.kvDelete(prefix + key);
      },
    };
  }

  conversationStorage(prefix = "conv:") {
    const store = this;
    return {
      type: "key",
      version: 1,
      getStorageKey: (ctx) => String(ctx.chat?.id ?? ctx.from?.id ?? "unknown"),
      adapter: {
        async read(key) {
          const raw = await store.kvGet(prefix + key);
          return raw === null ? undefined : safeJsonParse(raw, undefined);
        },
        async write(key, state) {
          await store.kvSet(prefix + key, JSON.stringify(state));
        },
        async delete(key) {
          await store.kvDelete(prefix + key);
        },
      },
    };
  }

  async summary() {
    return {
      users: await this.countUsers(),
      chats: await this.countChats(),
      aiMessages: await this.countAiMessages(),
      feedback: await this.countFeedback(),
      sessions: await this.kvCount("session:"),
      conversations: await this.kvCount("conv:"),
      stats: await this.getStats(),
    };
  }

  async close() {
    this.closed = true;
  }
}

module.exports = { RedisStore, RedisRestClient, RedisStoreError };
