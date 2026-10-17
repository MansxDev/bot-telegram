"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { nowIso, safeJsonParse } = require("../utils");
const { DEFAULT_CHAT_SETTINGS, SCHEMA_VERSION } = require("./shared");

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY,
  username       TEXT,
  first_name     TEXT,
  last_name      TEXT,
  language_code  TEXT,
  is_bot         INTEGER NOT NULL DEFAULT 0,
  is_premium     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  last_seen      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id         INTEGER PRIMARY KEY,
  type       TEXT NOT NULL,
  title      TEXT,
  username   TEXT,
  created_at TEXT NOT NULL,
  last_seen  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_settings (
  chat_id INTEGER NOT NULL,
  key     TEXT NOT NULL,
  value   TEXT,
  PRIMARY KEY (chat_id, key)
);

CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    INTEGER NOT NULL,
  user_id    INTEGER,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  model      TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_messages_chat ON ai_messages (chat_id, id DESC);

CREATE TABLE IF NOT EXISTS feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    INTEGER NOT NULL,
  user_id    INTEGER,
  rating     INTEGER NOT NULL,
  comment    TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stats (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS broadcast (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id   INTEGER NOT NULL,
  text       TEXT NOT NULL,
  sent       INTEGER NOT NULL DEFAULT 0,
  failed     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
`;

function bool(value) {
  return value === undefined || value === null ? null : value ? 1 : 0;
}

/**
 * Driver penyimpanan SQLite (better-sqlite3) untuk user, chat, settings,
 * session/conversation, riwayat AI, feedback, dan statistik.
 *
 * Semua method publik `async` supaya interface-nya sama dengan driver Redis
 * (lihat ./redis.js). Operasi internalnya tetap sinkron — better-sqlite3 memang
 * sinkron — sehingga tambahan await tidak menambah latency berarti.
 */
class SqliteStore {
  /** @param {string} dbPath */
  constructor(dbPath = "data/bot.db", options = {}) {
    let Database;
    try {
      // Lazy require + nama modul di variabel: bundler serverless (ncc di Vercel)
      // tidak boleh mencoba me-resolve `better-sqlite3` secara statis, karena
      // paket native ini sengaja tidak dipasang di sana (driver Vercel = redis).
      // Kalau benar-benar tidak ada, error ditangkap dan diganti pesan jelas.
      const moduleName = "better-sqlite3";
      Database = require(moduleName);
    } catch (error) {
      throw new Error(
        `better-sqlite3 tidak terpasang (${error.message}). Jalankan "npm install" ` +
          "atau pakai STORE_DRIVER=redis untuk deployment serverless.",
      );
    }

    this.driver = "sqlite";
    this.kind = "sqlite";
    this.dbPath = dbPath;
    this.location = dbPath;
    this.closed = false;
    this.aiHardLimit = Number(options.aiHardLimit ?? 0) || 0;

    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");

    this.#migrate();
    this.#prepare();
  }

  /** Dipanggil `createStore()`; disediakan agar seragam dengan driver Redis. */
  async init() {
    return this;
  }

  #migrate() {
    this.db.exec(DDL);

    // Pakai query langsung: prepared statements belum dibuat di titik ini.
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get("schema_version");
    const current = row ? row.value : null;

    if (current !== String(SCHEMA_VERSION)) {
      this.db
        .prepare(
          `INSERT INTO meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run("schema_version", String(SCHEMA_VERSION));
      this.db
        .prepare(
          `INSERT INTO meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run("migrated_at", nowIso());
    }
  }

  #prepare() {
    this.statements = {
      upsertUser: this.db.prepare(`
        INSERT INTO users (id, username, first_name, last_name, language_code, is_bot, is_premium, created_at, last_seen)
        VALUES (@id, @username, @first_name, @last_name, @language_code, @is_bot, @is_premium, @created_at, @last_seen)
        ON CONFLICT(id) DO UPDATE SET
          username = excluded.username,
          first_name = excluded.first_name,
          last_name = excluded.last_name,
          language_code = excluded.language_code,
          is_premium = excluded.is_premium,
          last_seen = excluded.last_seen
      `),
      getUser: this.db.prepare("SELECT * FROM users WHERE id = ?"),
      countUsers: this.db.prepare("SELECT COUNT(*) AS total FROM users"),

      upsertChat: this.db.prepare(`
        INSERT INTO chats (id, type, title, username, created_at, last_seen)
        VALUES (@id, @type, @title, @username, @created_at, @last_seen)
        ON CONFLICT(id) DO UPDATE SET
          type = excluded.type,
          title = excluded.title,
          username = excluded.username,
          last_seen = excluded.last_seen
      `),
      getChat: this.db.prepare("SELECT * FROM chats WHERE id = ?"),
      countChats: this.db.prepare("SELECT COUNT(*) AS total FROM chats"),
      allChatIds: this.db.prepare("SELECT id FROM chats ORDER BY last_seen DESC"),

      getSetting: this.db.prepare("SELECT value FROM chat_settings WHERE chat_id = ? AND key = ?"),
      allSettings: this.db.prepare("SELECT key, value FROM chat_settings WHERE chat_id = ?"),
      setSetting: this.db.prepare(`
        INSERT INTO chat_settings (chat_id, key, value) VALUES (?, ?, ?)
        ON CONFLICT(chat_id, key) DO UPDATE SET value = excluded.value
      `),
      deleteSettings: this.db.prepare("DELETE FROM chat_settings WHERE chat_id = ?"),

      kvGet: this.db.prepare("SELECT value FROM kv WHERE key = ?"),
      kvSet: this.db.prepare(`
        INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `),
      kvDelete: this.db.prepare("DELETE FROM kv WHERE key = ?"),
      kvStale: this.db.prepare("SELECT key FROM kv WHERE key LIKE ? AND updated_at < ?"),
      kvCount: this.db.prepare("SELECT COUNT(*) AS total FROM kv WHERE key LIKE ?"),
      kvTouch: this.db.prepare("UPDATE kv SET updated_at = ? WHERE key = ?"),

      addAiMessage: this.db.prepare(`
        INSERT INTO ai_messages (chat_id, user_id, role, content, model, created_at)
        VALUES (@chat_id, @user_id, @role, @content, @model, @created_at)
      `),
      aiHistory: this.db.prepare(
        "SELECT role, content, model, created_at FROM ai_messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?",
      ),
      clearAiHistory: this.db.prepare("DELETE FROM ai_messages WHERE chat_id = ?"),
      trimAiHistory: this.db.prepare(`
        DELETE FROM ai_messages
        WHERE chat_id = ?
          AND id NOT IN (
            SELECT id FROM ai_messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?
          )
      `),
      countAiMessages: this.db.prepare("SELECT COUNT(*) AS total FROM ai_messages"),

      addFeedback: this.db.prepare(`
        INSERT INTO feedback (chat_id, user_id, rating, comment, created_at)
        VALUES (@chat_id, @user_id, @rating, @comment, @created_at)
      `),
      listFeedback: this.db.prepare("SELECT * FROM feedback ORDER BY id DESC LIMIT ?"),
      countFeedback: this.db.prepare("SELECT COUNT(*) AS total FROM feedback"),

      bumpStat: this.db.prepare(`
        INSERT INTO stats (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = value + excluded.value
      `),
      allStats: this.db.prepare("SELECT key, value FROM stats"),
      getStat: this.db.prepare("SELECT value FROM stats WHERE key = ?"),

      addBroadcast: this.db.prepare(`
        INSERT INTO broadcast (admin_id, text, sent, failed, created_at)
        VALUES (@admin_id, @text, @sent, @failed, @created_at)
      `),
      lastBroadcasts: this.db.prepare("SELECT * FROM broadcast ORDER BY id DESC LIMIT ?"),

      getMeta: this.db.prepare("SELECT value FROM meta WHERE key = ?"),
      setMeta: this.db.prepare(`
        INSERT INTO meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `),
    };
  }

  #assertOpen() {
    if (this.closed) throw new Error("Store sudah ditutup (closed).");
  }

  // ---------------------------------------------------------------- meta

  async getMeta(key, fallback = null) {
    this.#assertOpen();
    const row = this.statements.getMeta.get(String(key));
    return row ? row.value : fallback;
  }

  async setMeta(key, value) {
    this.#assertOpen();
    this.statements.setMeta.run(String(key), String(value));
    return value;
  }

  // --------------------------------------------------------------- users

  async upsertUser(from) {
    if (!from || !from.id) return null;
    this.#assertOpen();
    this.#writeUser(from);
    return this.getUser(from.id);
  }

  /** Bagian sinkron dari upsertUser (dipakai juga oleh recordUpdate). */
  #writeUser(from, ts = nowIso()) {
    this.statements.upsertUser.run({
      id: from.id,
      username: from.username ?? null,
      first_name: from.first_name ?? null,
      last_name: from.last_name ?? null,
      language_code: from.language_code ?? null,
      is_bot: bool(from.is_bot) ?? 0,
      is_premium: bool(from.is_premium) ?? 0,
      created_at: ts,
      last_seen: ts,
    });
  }

  #writeChat(chat, ts = nowIso()) {
    this.statements.upsertChat.run({
      id: chat.id,
      type: chat.type ?? "private",
      title: chat.title ?? null,
      username: chat.username ?? null,
      created_at: ts,
      last_seen: ts,
    });
  }

  async getUser(id) {
    this.#assertOpen();
    return this.statements.getUser.get(Number(id)) ?? null;
  }

  async countUsers() {
    this.#assertOpen();
    return this.statements.countUsers.get().total;
  }

  // --------------------------------------------------------------- chats

  async upsertChat(chat) {
    if (!chat || chat.id === undefined) return null;
    this.#assertOpen();
    this.#writeChat(chat);
    return this.getChat(chat.id);
  }

  async getChat(id) {
    this.#assertOpen();
    return this.statements.getChat.get(Number(id)) ?? null;
  }

  async countChats() {
    this.#assertOpen();
    return this.statements.countChats.get().total;
  }

  async listChatIds(limit = 2000) {
    this.#assertOpen();
    return this.statements.allChatIds.all().slice(0, limit).map((row) => row.id);
  }

  // ------------------------------------------------------------ settings

  async getSetting(chatId, key, fallback = null) {
    this.#assertOpen();
    const row = this.statements.getSetting.get(Number(chatId), String(key));
    if (row && row.value !== null && row.value !== undefined) return row.value;
    if (fallback !== null) return fallback;
    return DEFAULT_CHAT_SETTINGS[key] ?? null;
  }

  async setSetting(chatId, key, value) {
    this.#assertOpen();
    this.statements.setSetting.run(Number(chatId), String(key), value === null ? null : String(value));
    return value;
  }

  /** Balik nilai "0"/"1" (menghormati default) dan kembalikan nilai baru. */
  async toggleSetting(chatId, key) {
    const next = (await this.isSettingOn(chatId, key)) ? "0" : "1";
    await this.setSetting(chatId, key, next);
    return next;
  }

  /** Semua setting chat, sudah digabung dengan default. */
  async getChatSettings(chatId) {
    this.#assertOpen();
    const rows = this.statements.allSettings.all(Number(chatId));
    const result = { ...DEFAULT_CHAT_SETTINGS };
    for (const row of rows) {
      if (row.value !== null && row.value !== undefined) result[row.key] = row.value;
    }
    return result;
  }

  async resetChatSettings(chatId) {
    this.#assertOpen();
    this.statements.deleteSettings.run(Number(chatId));
    return { ...DEFAULT_CHAT_SETTINGS };
  }

  /** Helper boolean untuk setting "0"/"1" (mengikuti default bila belum pernah diubah). */
  async isSettingOn(chatId, key) {
    return String((await this.getSetting(chatId, key)) ?? "0") === "1";
  }

  // ------------------------------------------------------------------ kv

  async kvGet(key) {
    this.#assertOpen();
    const row = this.statements.kvGet.get(String(key));
    return row ? row.value : null;
  }

  async kvSet(key, value) {
    this.#assertOpen();
    this.statements.kvSet.run(String(key), String(value), nowIso());
    return value;
  }

  async kvDelete(key) {
    this.#assertOpen();
    this.statements.kvDelete.run(String(key));
  }

  async kvCount(prefix = "") {
    this.#assertOpen();
    return this.statements.kvCount.get(`${prefix}%`).total;
  }

  /** Hapus entri kv (mis. session kedaluwarsa) berdasarkan prefix + umur. */
  async kvPrune(prefix, olderThanMs) {
    this.#assertOpen();
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const keys = this.statements.kvStale.all(`${prefix}%`, cutoff).map((row) => row.key);
    const remove = this.db.transaction((list) => list.forEach((key) => this.statements.kvDelete.run(key)));
    remove(keys);
    return keys.length;
  }

  /** Test hook: paksa `updated_at` sebuah entri kv (untuk menguji kvPrune). */
  async debugSetKvUpdatedAt(key, iso) {
    this.#assertOpen();
    this.statements.kvTouch.run(String(iso), String(key));
  }

  // ---------------------------------------------------------- ai history

  async addAiMessage({ chatId, userId = null, role, content, model = null }) {
    this.#assertOpen();
    this.statements.addAiMessage.run({
      chat_id: Number(chatId),
      user_id: userId === null ? null : Number(userId),
      role: String(role),
      content: String(content),
      model: model === null ? null : String(model),
      created_at: nowIso(),
    });
  }

  /** Riwayat terurut lama -> baru (siap dikirim ke API chat). */
  async getAiHistory(chatId, limit = 20) {
    this.#assertOpen();
    const rows = this.statements.aiHistory.all(Number(chatId), Number(limit));
    return rows
      .reverse()
      .map((row) => ({ role: row.role, content: row.content, model: row.model, createdAt: row.created_at }));
  }

  async clearAiHistory(chatId) {
    this.#assertOpen();
    return this.statements.clearAiHistory.run(Number(chatId)).changes;
  }

  /** Sisakan hanya `keep` pesan terbaru untuk chat tertentu. */
  async trimAiHistory(chatId, keep) {
    this.#assertOpen();
    return this.statements.trimAiHistory.run(Number(chatId), Number(chatId), Number(keep)).changes;
  }

  async countAiMessages() {
    this.#assertOpen();
    return this.statements.countAiMessages.get().total;
  }

  // ------------------------------------------------------------ feedback

  async addFeedback({ chatId, userId = null, rating, comment = null }) {
    this.#assertOpen();
    this.statements.addFeedback.run({
      chat_id: Number(chatId),
      user_id: userId === null ? null : Number(userId),
      rating: Number(rating),
      comment: comment === null ? null : String(comment),
      created_at: nowIso(),
    });
    await this.bumpStat("feedback_total");
  }

  async listFeedback(limit = 10) {
    this.#assertOpen();
    return this.statements.listFeedback.all(Number(limit));
  }

  async countFeedback() {
    this.#assertOpen();
    return this.statements.countFeedback.get().total;
  }

  // --------------------------------------------------------------- stats

  async bumpStat(key, by = 1) {
    this.#assertOpen();
    this.statements.bumpStat.run(String(key), Number(by));
  }

  async getStat(key) {
    this.#assertOpen();
    const row = this.statements.getStat.get(String(key));
    return row ? row.value : 0;
  }

  async getStats() {
    this.#assertOpen();
    const result = {};
    for (const row of this.statements.allStats.all()) result[row.key] = row.value;
    return result;
  }

  // ----------------------------------------------------------- broadcast

  async recordBroadcast({ adminId, text, sent, failed }) {
    this.#assertOpen();
    this.statements.addBroadcast.run({
      admin_id: Number(adminId),
      text: String(text),
      sent: Number(sent),
      failed: Number(failed),
      created_at: nowIso(),
    });
  }

  async listBroadcasts(limit = 5) {
    this.#assertOpen();
    return this.statements.lastBroadcasts.all(Number(limit));
  }

  // ------------------------------------------------------ batch (hot path)

  /**
   * Simpan user + chat + beberapa statistik dalam satu transaksi.
   * Dipakai middleware tracking: satu round-trip untuk semua penulisan.
   * @param {{ user?: object, chat?: object, stats?: Array<[string, number]> }} payload
   */
  async recordUpdate({ user, chat, stats = [] } = {}) {
    this.#assertOpen();
    const ts = nowIso();
    const write = this.db.transaction(() => {
      if (user?.id) this.#writeUser(user, ts);
      if (chat?.id !== undefined) this.#writeChat(chat, ts);
      for (const [key, by] of stats) this.statements.bumpStat.run(String(key), Number(by ?? 1));
    });
    write();
  }

  // -------------------------------------------------------------- helper

  /**
   * Storage adapter untuk middleware `session` bawaan grammY.
   * Nilai session disimpan sebagai JSON di tabel kv.
   */
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

  /** Storage adapter untuk plugin conversations (berbasis key per chat). */
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

  /** Statistik ringkas untuk /stats. */
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
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // checkpoint opsional; abaikan bila gagal
    }
    this.db.close();
  }
}

module.exports = { SqliteStore, DDL };
