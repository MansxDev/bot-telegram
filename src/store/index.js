"use strict";

/**
 * Entry point penyimpanan.
 *
 * `createStore()` memilih driver berdasarkan konfigurasi:
 *   - STORE_DRIVER=sqlite -> SQLite via better-sqlite3 (default, untuk polling lokal)
 *   - STORE_DRIVER=redis  -> Upstash Redis REST (untuk Vercel / serverless)
 *
 * Kedua driver mengimplementasikan interface async yang sama:
 *
 *   meta      : getMeta, setMeta
 *   user/chat : upsertUser, getUser, countUsers, upsertChat, getChat, countChats, listChatIds
 *   settings  : getSetting, setSetting, toggleSetting, getChatSettings, resetChatSettings, isSettingOn
 *   kv        : kvGet, kvSet, kvDelete, kvCount, kvPrune
 *   ai        : addAiMessage, getAiHistory, clearAiHistory, trimAiHistory, countAiMessages
 *   feedback  : addFeedback, listFeedback, countFeedback
 *   stats     : bumpStat, getStat, getStats
 *   broadcast : recordBroadcast, listBroadcasts
 *   batch     : recordUpdate
 *   adapter   : sessionStorage, conversationStorage
 *   misc      : summary, close, init, driver, location
 *
 * Karena HTTP bersifat async, SEMUA method driver harus di-await oleh pemanggil.
 */

const { SqliteStore } = require("./sqlite");
const { RedisStore } = require("./redis");
const { DEFAULT_CHAT_SETTINGS, SCHEMA_VERSION } = require("./shared");

/**
 * Bangun store sesuai konfigurasi.
 * @param {object} config hasil buildConfig()
 * @param {{ aiHardLimit?: number, kvTtlMs?: number }} [options]
 */
async function createStore(config, options = {}) {
  const storeConfig = config?.store ?? {};
  const driver = String(storeConfig.driver ?? "sqlite").toLowerCase();

  const aiHardLimit =
    options.aiHardLimit ?? Math.max(200, Number(config?.ai?.historyLimit ?? 40) * 5);
  const kvTtlMs = options.kvTtlMs ?? Number(config?.session?.ttlMs ?? 12 * 60 * 60 * 1000);

  let store;

  if (driver === "sqlite") {
    store = new SqliteStore(config?.dbPath ?? "data/bot.db", { aiHardLimit });
  } else if (driver === "redis" || driver === "upstash") {
    store = new RedisStore({
      ...(storeConfig.redis ?? {}),
      aiHardLimit,
      kvTtlMs,
    });
  } else {
    throw new Error(`STORE_DRIVER tidak dikenal: "${driver}" (pilih sqlite atau redis).`);
  }

  await store.init();
  return store;
}

module.exports = {
  createStore,
  SqliteStore,
  RedisStore,
  Store: SqliteStore, // alias lama: new Store(":memory:")
  DEFAULT_CHAT_SETTINGS,
  SCHEMA_VERSION,
};
