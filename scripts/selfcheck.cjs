#!/usr/bin/env node
"use strict";

/**
 * Selfcheck offline untuk bot-telegram.
 * Tidak butuh BOT_TOKEN asli dan tidak menyentuh Telegram/9Router.
 *
 * Yang diuji:
 *   1. pemuatan modul & konfigurasi (mode, driver store, warnings)
 *   2. utils
 *   3. driver store SQLite (CRUD lengkap)
 *   4. driver store Redis lewat server Upstash tiruan (in-memory)
 *   5. paritas interface kedua driver
 *   6. keyboards
 *   7. klien 9Router (server HTTP lokal: health, non-stream, SSE, error)
 *   8. wiring bot & registry
 *   9. helper Telegram
 *
 * Jalankan: npm run check
 */

process.env.BOT_TOKEN = process.env.BOT_TOKEN || "123456789:SELFCHECK_FakeToken_aaaaaaaaaaaaaaaaaaa";
process.env.ADMIN_IDS = process.env.ADMIN_IDS || "111111,222222";
process.env.DB_PATH = ":memory:";
process.env.LOG_LEVEL = "error";
process.env.NINEROUTER_URL = "http://127.0.0.1:1";
process.env.NINEROUTER_API_KEY = "sk-selfcheck";
process.env.NINEROUTER_MODEL = "free";
process.env.NINEROUTER_MAX_RETRIES = "0";

const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { startFakeUpstash } = require("./fake-upstash.cjs");

const results = [];

function record(name, error) {
  results.push({ name, ok: !error, error: error?.message });
}

async function test(name, fn) {
  try {
    await fn();
    record(name, null);
  } catch (error) {
    record(name, error);
  }
}

/** Server tiruan 9Router: /v1/models, /v1/chat/completions (stream & non-stream), /v1/unauthorized */
function startFakeServer() {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "free" }, { id: "code" }, { id: "free" }] }));
      return;
    }

    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");

        if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n`);
          for (const piece of ["ha", "lo", " dunia"]) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
          }
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            model: body.model,
            choices: [{ message: { role: "assistant", content: "halo dunia" } }],
            usage: { total_tokens: 5 },
          }),
        );
      });
      return;
    }

    if (req.url === "/v1/unauthorized") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid api key" } }));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function listen(server) {
  return new Promise((resolve) => server.close(resolve));
}

/** Susun konfigurasi untuk driver Redis yang menunjuk ke server Upstash tiruan. */
function redisConfig(url, token, prefix = "test:") {
  return {
    store: { driver: "redis", redis: { url, token, prefix, retries: 0 } },
    ai: { historyLimit: 40 },
    session: { ttlMs: 12 * 60 * 60 * 1000 },
  };
}

/** Uji CRUD lengkap untuk satu driver store (dipakai sqlite & redis). */
async function exerciseStore(store, label) {
  // ---- meta
  await store.setMeta("uji", "42");
  assert.equal(await store.getMeta("uji"), "42", `${label}: meta harus tersimpan`);
  assert.equal(await store.getMeta("tidak-ada", "fallback"), "fallback");

  // ---- user
  await store.upsertUser({ id: 7, first_name: "Mans", last_name: "Dev", username: "mansxdev", language_code: "id" });
  const firstWrite = await store.getUser(7);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await store.upsertUser({ id: 7, first_name: "Mans", username: "mansxdev2" });
  assert.equal(await store.countUsers(), 1, `${label}: upsert tidak boleh menduplikasi user`);
  assert.equal((await store.getUser(7)).username, "mansxdev2", `${label}: data user harus ter-update`);
  assert.equal(
    (await store.getUser(7)).created_at,
    firstWrite.created_at,
    `${label}: created_at tidak boleh berubah saat upsert`,
  );

  // ---- chat
  await store.upsertChat({ id: -1001, type: "group", title: "Grup Tes" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await store.upsertChat({ id: 7, type: "private" });
  assert.equal(await store.countChats(), 2, `${label}: harus ada 2 chat`);
  assert.equal((await store.listChatIds())[0], 7, `${label}: chat terbaru harus paling depan`);
  assert.equal((await store.getChat(-1001)).title, "Grup Tes");

  // ---- settings
  assert.equal(await store.getSetting(7, "ai_enabled"), "1", `${label}: default ai_enabled = 1`);
  assert.equal(await store.isSettingOn(7, "ai_enabled"), true);
  assert.equal(await store.toggleSetting(7, "ai_enabled"), "0");
  assert.equal(await store.isSettingOn(7, "ai_enabled"), false);
  await store.setSetting(7, "model", "code");
  assert.equal(await store.getSetting(7, "model"), "code");
  const settings = await store.getChatSettings(7);
  assert.equal(settings.model, "code");
  assert.equal(settings.ai_enabled, "0");
  assert.equal(settings.ai_stream, "1", `${label}: setting yang tidak diubah harus tetap default`);
  await store.resetChatSettings(7);
  assert.equal(await store.getSetting(7, "model", ""), "", `${label}: reset harus mengembalikan default kosong`);
  assert.equal(await store.isSettingOn(7, "ai_enabled"), true);

  // ---- kv + session storage
  await store.kvSet("demo", "nilai");
  assert.equal(await store.kvGet("demo"), "nilai");
  await store.kvDelete("demo");
  assert.equal(await store.kvGet("demo"), null);

  const storage = store.sessionStorage();
  assert.equal(await storage.read("abc"), undefined, `${label}: session baru harus undefined`);
  await storage.write("abc", { aiCount: 3 });
  assert.deepEqual(await storage.read("abc"), { aiCount: 3 });
  await storage.delete("abc");
  assert.equal(await storage.read("abc"), undefined);
  assert.equal(await store.kvCount("session:"), 0);

  // ---- conversation storage adapter
  const conv = store.conversationStorage();
  assert.equal(conv.type, "key");
  assert.equal(typeof conv.getStorageKey, "function");
  assert.equal(conv.getStorageKey({ chat: { id: 99 } }), "99");
  assert.equal(conv.getStorageKey({ from: { id: 55 } }), "55");
  const state = { version: [0, 1], state: { feedback: [{ step: 1 }] } };
  assert.equal(await conv.adapter.read("99"), undefined);
  await conv.adapter.write("99", state);
  assert.deepEqual(await conv.adapter.read("99"), state);
  await conv.adapter.delete("99");
  assert.equal(await conv.adapter.read("99"), undefined);

  // ---- riwayat AI
  const chatId = 555;
  for (let index = 1; index <= 5; index += 1) {
    await store.addAiMessage({ chatId, userId: 1, role: "user", content: `pesan-${index}`, model: "free" });
    await store.addAiMessage({ chatId, userId: 1, role: "assistant", content: `balas-${index}`, model: "free" });
  }
  const history = await store.getAiHistory(chatId, 10);
  assert.equal(history.length, 10, `${label}: riwayat harus 10`);
  assert.equal(history[0].content, "pesan-1", `${label}: urutan paling lama dulu`);
  assert.equal(history.at(-1).content, "balas-5", `${label}: paling baru terakhir`);
  assert.equal(await store.countAiMessages(), 10, `${label}: counter pesan AI salah`);

  assert.equal(await store.trimAiHistory(chatId, 4), 6, `${label}: harus menghapus 6 baris`);
  const trimmed = await store.getAiHistory(chatId, 10);
  assert.equal(trimmed.length, 4);
  assert.equal(trimmed.at(-1).content, "balas-5", `${label}: yang tersisa harus yang terbaru`);
  assert.equal(await store.countAiMessages(), 4, `${label}: counter harus ikut turun setelah trim`);

  assert.equal(await store.clearAiHistory(chatId), 4);
  assert.equal((await store.getAiHistory(chatId, 10)).length, 0);
  assert.equal(await store.countAiMessages(), 0, `${label}: counter harus nol setelah clear`);

  // ---- feedback & statistik
  await store.addFeedback({ chatId: 7, userId: 1, rating: 5, comment: "mantap" });
  assert.equal(await store.countFeedback(), 1);
  assert.equal((await store.listFeedback(1))[0].rating, 5);
  assert.equal((await store.listFeedback(1))[0].comment, "mantap");
  assert.equal(await store.getStat("feedback_total"), 1, `${label}: addFeedback harus menaikkan stat`);

  await store.bumpStat("updates_total", 3);
  await store.bumpStat("updates_total", 2);
  assert.equal(await store.getStat("updates_total"), 5);

  await store.recordBroadcast({ adminId: 1, text: "halo", sent: 9, failed: 1 });
  assert.equal((await store.listBroadcasts(1))[0].sent, 9);

  const summary = await store.summary();
  assert.equal(summary.users, 1);
  assert.equal(summary.chats, 2);
  assert.equal(summary.feedback, 1);
  assert.equal(typeof summary.stats, "object");
  assert.equal(summary.stats.updates_total, 5);

  // ---- batch (hot path middleware tracking)
  await store.recordUpdate({
    user: { id: 99, first_name: "Batch", username: "batch" },
    chat: { id: -500, type: "group", title: "Batch Group" },
    stats: [
      ["updates_total", 1],
      ["update_message", 1],
      ["messages_total", 1],
    ],
  });
  assert.equal(await store.countUsers(), 2, `${label}: recordUpdate harus menyimpan user`);
  assert.equal((await store.getChat(-500)).title, "Batch Group");
  assert.equal(await store.getStat("updates_total"), 6, `${label}: recordUpdate harus menambah stat`);
  assert.equal(await store.getStat("update_message"), 1);

  // ---- kvPrune
  await store.kvSet("session:fresh", "1");
  await store.kvSet("session:stale", "1");
  await store.debugSetKvUpdatedAt("session:stale", new Date(Date.now() - 999_999).toISOString());

  assert.equal(await store.kvPrune("session:", 1000), 1, `${label}: harus prune 1 entri`);
  assert.equal(await store.kvGet("session:fresh"), "1");
  assert.equal(await store.kvGet("session:stale"), null);
}

async function main() {
  // ------------------------------------------------------- 1. modul & config
  const configModule = require("../src/config");
  const { Store, createStore, SqliteStore, RedisStore, DEFAULT_CHAT_SETTINGS } = require("../src/store");
  const { createLogger } = require("../src/logger");
  const { Router9, Router9Error, describeHttpError, isOfflineError, describeAiError } = require("../src/services/router9");
  const { Registry } = require("../src/handlers");
  const { createBot, HANDLER_MODULES, initialSession } = require("../src/bot");
  const { createWebhookHandler, parseAllowedUpdates, DEFAULT_ALLOWED_UPDATES } = require("../src/webhook");
  const { bootstrap, getRuntime, resetRuntime } = require("../src/runtime");
  const keyboards = require("../src/keyboards");
  const utils = require("../src/utils");
  const telegram = require("../src/telegram");
  const { buildConversations, registerConversationCommands } = require("../src/conversations");
  const indexModule = require("../src/index");

  await test("semua modul bisa dimuat tanpa error", () => {
    assert.equal(typeof createBot, "function");
    assert.equal(typeof Store, "function");
    assert.equal(typeof SqliteStore, "function");
    assert.equal(typeof RedisStore, "function");
    assert.equal(typeof createStore, "function");
    assert.equal(typeof bootstrap, "function");
    assert.equal(typeof getRuntime, "function");
    assert.equal(typeof resetRuntime, "function");
    assert.equal(typeof createWebhookHandler, "function");
    assert.equal(typeof indexModule.main, "function");
    assert.equal(typeof keyboards.mainMenu, "function");
    assert.equal(typeof telegram.safeReply, "function");
    assert.equal(typeof buildConversations, "function");
    assert.equal(typeof registerConversationCommands, "function");
    assert.equal(DEFAULT_CHAT_SETTINGS.ai_enabled, "1");
  });

  await test("konfigurasi: default, DB path absolut, mode, dan isAdmin", () => {
    const config = configModule.buildConfig({ BOT_TOKEN: "1:abc", ADMIN_IDS: "42, 43", DB_PATH: "data/test.db" });

    assert.equal(config.router9.baseUrl, "http://localhost:20128");
    assert.equal(config.router9.model, "gh/gpt-4o-mini");
    assert.equal(config.ai.stream, true);
    assert.equal(config.ai.temperature, 0.7);
    assert.equal(config.mode, "polling", "default lokal harus polling");
    assert.equal(config.store.driver, "sqlite", "default lokal harus sqlite");
    assert.equal(config.serverless, false);
    assert.ok(path.isAbsolute(config.dbPath), "dbPath harus absolut");
    assert.equal(config.isAdmin(42), true);
    assert.equal(config.isAdmin(43), true);
    assert.equal(config.isAdmin(99), false);
    assert.equal(config.adminIds.length, 2);
  });

  await test("konfigurasi: Vercel memaksa webhook + redis + path /tmp", () => {
    const config = configModule.buildConfig({ BOT_TOKEN: "1:abc", VERCEL: "1" });

    assert.equal(config.mode, "webhook");
    assert.equal(config.serverless, true);
    assert.equal(config.store.driver, "redis");
    assert.ok(config.dbPath.startsWith("/tmp/"), `dbPath serverless harus di /tmp, dapat ${config.dbPath}`);
    assert.equal(config.ai.timeBudgetMs > 0, true, "serverless harus punya batas waktu AI");
    assert.equal(config.ai.maxTokens, 1024);

    const explicit = configModule.buildConfig({ BOT_TOKEN: "1:abc", VERCEL: "1", MODE: "polling" });
    assert.equal(explicit.mode, "polling", "MODE eksplisit harus menang");

    // MODE=webhook di laptop TIDAK berarti serverless (webhook bisa dites lokal).
    const localWebhook = configModule.buildConfig({ BOT_TOKEN: "1:abc", MODE: "webhook" });
    assert.equal(localWebhook.mode, "webhook");
    assert.equal(localWebhook.serverless, false, "MODE=webhook lokal bukan serverless");
    assert.equal(localWebhook.store.driver, "sqlite", "webhook lokal tetap boleh sqlite");

    // SERVERLESS=true dipakai untuk platform serverless lain (bukan Vercel).
    const marked = configModule.buildConfig({ BOT_TOKEN: "1:abc", SERVERLESS: "true" });
    assert.equal(marked.serverless, true);
    assert.equal(marked.mode, "webhook");
    assert.equal(marked.store.driver, "redis");

    const upstash = configModule.buildConfig({
      BOT_TOKEN: "1:abc",
      STORE_DRIVER: "upstash",
      UPSTASH_REDIS_REST_URL: "https://x.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "tok",
    });
    assert.equal(upstash.store.driver, "redis", "alias upstash harus jadi redis");
    assert.equal(upstash.store.redis.url, "https://x.upstash.io");
  });

  await test("validateConfig: hanya masalah fatal yang menghalangi", () => {
    const bad = configModule.buildConfig({ BOT_TOKEN: "", NINEROUTER_API_KEY: "" });
    const problems = configModule.validateConfig(bad);
    assert.ok(problems.some((item) => item.includes("BOT_TOKEN")), "harus lapor BOT_TOKEN");

    const warnings = configModule.configWarnings(bad);
    assert.ok(
      warnings.some((item) => item.includes("NINEROUTER_API_KEY")),
      "API key kosong harus jadi peringatan (AI opsional), bukan error fatal",
    );

    const good = configModule.buildConfig({ BOT_TOKEN: "123456789:AAabcdefghijklmnopqrstuvwxyz", NINEROUTER_API_KEY: "sk-x" });
    assert.deepEqual(configModule.validateConfig(good), []);

    const redisNoCreds = configModule.buildConfig({ BOT_TOKEN: good.botToken, STORE_DRIVER: "redis" });
    const redisProblems = configModule.validateConfig(redisNoCreds);
    assert.ok(redisProblems.some((item) => item.includes("UPSTASH_REDIS_REST_URL")));
    assert.ok(redisProblems.some((item) => item.includes("UPSTASH_REDIS_REST_TOKEN")));

    const webhookNoSecret = configModule.buildConfig({ BOT_TOKEN: good.botToken, MODE: "webhook" });
    assert.ok(
      configModule.validateConfig(webhookNoSecret).some((item) => item.includes("WEBHOOK_SECRET")),
      "mode webhook wajib punya WEBHOOK_SECRET",
    );

    const badDriver = configModule.buildConfig({ BOT_TOKEN: good.botToken, STORE_DRIVER: "mongodb" });
    assert.ok(configModule.validateConfig(badDriver).some((item) => item.includes("STORE_DRIVER")));
  });

  await test("configWarnings: localhost di serverless & redis butuh kredensial", () => {
    const serverless = configModule.buildConfig({
      BOT_TOKEN: "123456789:AAabcdefghijklmnopqrstuvwxyz",
      VERCEL: "1",
      NINEROUTER_API_KEY: "sk-x",
      NINEROUTER_URL: "http://localhost:20128",
    });
    const warnings = configModule.configWarnings(serverless);
    assert.ok(
      warnings.some((item) => item.includes("localhost")),
      "harus memperingatkan localhost tidak terjangkau dari cloud",
    );

    assert.equal(configModule.isLocalUrl("http://localhost:20128"), true);
    assert.equal(configModule.isLocalUrl("http://127.0.0.1:9"), true);
    assert.equal(configModule.isLocalUrl("https://9router.example.com"), false);
  });

  // ------------------------------------------------------------- 2. utils
  await test("utils: escapeHtml, chunkText, formatUptime, commandArgs", () => {
    assert.equal(utils.escapeHtml('<b>&"x"</b>'), "&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;");
    assert.equal(utils.formatUptime(1000 * 61), "1m 1s");
    assert.equal(utils.formatUptime(0), "0s");
    assert.equal(utils.commandArgs("/ai halo dunia"), "halo dunia");
    assert.equal(utils.commandArgs("/ai"), "");
    assert.equal(utils.truncate("abcdefghij", 5), "abcd…");

    const long = "x".repeat(9000) + "\n" + "y".repeat(9000);
    const chunks = utils.chunkText(long, 4096);
    assert.ok(chunks.length >= 5, `harus terpecah banyak, dapat ${chunks.length}`);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 4096, `chunk ${chunk.length} > 4096`);
    }
    assert.equal(chunks.join("").replace(/\n/g, ""), long.replace(/\n/g, ""));
  });

  await test("utils: updateTypeOf menurunkan tipe update dengan benar", () => {
    // grammY 1.46 tidak menyediakan ctx.updateType -> harus diturunkan dari Update.
    assert.equal(utils.updateTypeOf({ update_id: 1, message: { text: "hi" } }), "message");
    assert.equal(utils.updateTypeOf({ update_id: 2, callback_query: { data: "x" } }), "callback_query");
    assert.equal(utils.updateTypeOf({ update: { update_id: 3, my_chat_member: {} } }), "my_chat_member");
    assert.equal(utils.updateTypeOf({ updateType: "inline_query", update: { update_id: 4 } }), "inline_query");
    assert.equal(utils.updateTypeOf({ update_id: 5 }), "unknown");
    assert.equal(utils.updateTypeOf(null), "unknown");

    const line = utils.summarizeUpdate({
      update: { update_id: 6, callback_query: { data: "menu:stats" } },
      callbackQuery: { data: "menu:stats" },
      from: { id: 1, first_name: "Mans" },
    });
    assert.ok(line.startsWith("callback_query from Mans (1)"), line);
    assert.ok(line.includes("menu:stats"), line);
  });

  // -------------------------------------------------- 3. store (sqlite)
  const store = new Store(":memory:");

  await test("store sqlite: driver + lokasi terbaca", async () => {
    assert.equal(store.driver, "sqlite");
    assert.equal(store.location, ":memory:");
    assert.equal(await store.getMeta("schema_version"), "1");
  });

  await test("store sqlite: CRUD lengkap (user, chat, settings, kv, AI, feedback, stats)", async () => {
    await exerciseStore(store, "sqlite");
  });

  await test("store sqlite: database tertutup tidak bisa dipakai lagi", async () => {
    const tempStore = new Store(":memory:");
    await tempStore.upsertUser({ id: 1, first_name: "A" });
    await tempStore.close();
    await assert.rejects(() => tempStore.countUsers(), /sudah ditutup/);
    await tempStore.close(); // idempotent
  });

  // --------------------------------------------------- 4. store (redis)
  const fakeUpstash = await startFakeUpstash();

  await test("store factory: memilih driver dari konfigurasi", async () => {
    const sqliteStore = await createStore({ dbPath: ":memory:", store: { driver: "sqlite" }, ai: { historyLimit: 40 } });
    assert.equal(sqliteStore.driver, "sqlite");
    await sqliteStore.close();

    const redisStore = await createStore(redisConfig(fakeUpstash.url, fakeUpstash.token, "factory:"));
    assert.equal(redisStore.driver, "redis");
    assert.equal(await redisStore.getMeta("schema_version"), "1");
    await redisStore.close();

    await assert.rejects(() => createStore({ store: { driver: "mongodb" } }), /STORE_DRIVER tidak dikenal/);
    await assert.rejects(
      () => createStore({ store: { driver: "redis", redis: { url: "", token: "" } } }),
      /URL Upstash Redis kosong/,
    );
  });

  await test("store redis: CRUD lengkap lewat Upstash tiruan", async () => {
    const redisStore = await createStore(redisConfig(fakeUpstash.url, fakeUpstash.token, "crud:"));
    await exerciseStore(redisStore, "redis");
    await redisStore.close();
  });

  await test("store redis: TTL session dipasang + aiHardLimit dipatuhi", async () => {
    const redisStore = await createStore({
      ...redisConfig(fakeUpstash.url, fakeUpstash.token, "ttl:"),
      session: { ttlMs: 60_000 },
    });

    await redisStore.kvSet("session:x", "1");
    const ttlKey = redisStore.k("kv", "session:x");
    assert.ok(fakeUpstash.redis.expiry.has(ttlKey), "kvSet harus memasang TTL di Redis");

    // aiHardLimit default = max(200, historyLimit * 5) -> paksa kecil untuk uji.
    const small = await createStore({ ...redisConfig(fakeUpstash.url, fakeUpstash.token, "cap:"), ai: { historyLimit: 2 } });
    assert.equal(small.aiHardLimit, 200, "batas keras minimal 200");
    await small.close();
    await redisStore.close();
  });

  await test("store redis: error HTTP Upstash dibungkus pesan yang jelas", async () => {
    const failing = await createStore(redisConfig(fakeUpstash.url, fakeUpstash.token, "err:"));
    fakeUpstash.failWith(500);

    await assert.rejects(() => failing.countUsers(), (error) => {
      assert.ok(/Upstash HTTP 500/.test(error.message), error.message);
      assert.equal(error.name, "RedisStoreError");
      return true;
    });

    fakeUpstash.failWith(401);
    await assert.rejects(() => failing.getUser(1), /Upstash HTTP 401/);

    fakeUpstash.clearFailure();
    await assert.rejects(
      () => createStore(redisConfig(fakeUpstash.url, "token-salah", "bad:")).then((s) => s.countUsers()),
      /Upstash HTTP 401/,
    );

    await failing.close();
  });

  await test("store redis: database tertutup tidak bisa dipakai lagi", async () => {
    const tempStore = await createStore(redisConfig(fakeUpstash.url, fakeUpstash.token, "closed:"));
    await tempStore.close();
    await assert.rejects(() => tempStore.countUsers(), /sudah ditutup/);
    await tempStore.close(); // idempotent
  });

  await test("store: interface kedua driver identik", async () => {
    const methods = [
      "init", "close", "getMeta", "setMeta",
      "upsertUser", "getUser", "countUsers",
      "upsertChat", "getChat", "countChats", "listChatIds",
      "getSetting", "setSetting", "toggleSetting", "getChatSettings", "resetChatSettings", "isSettingOn",
      "kvGet", "kvSet", "kvDelete", "kvCount", "kvPrune", "debugSetKvUpdatedAt",
      "addAiMessage", "getAiHistory", "clearAiHistory", "trimAiHistory", "countAiMessages",
      "addFeedback", "listFeedback", "countFeedback",
      "bumpStat", "getStat", "getStats",
      "recordBroadcast", "listBroadcasts",
      "recordUpdate", "sessionStorage", "conversationStorage", "summary",
    ];

    const redisStore = await createStore(redisConfig(fakeUpstash.url, fakeUpstash.token, "parity:"));
    for (const name of methods) {
      assert.equal(typeof store[name], "function", `sqlite kehilangan method ${name}`);
      assert.equal(typeof redisStore[name], "function", `redis kehilangan method ${name}`);
    }
    await redisStore.close();
    assert.ok(methods.length >= 40, "daftar method tidak lengkap");
  });

  await test("store: adapter session/conversation bentuknya sama di kedua driver", async () => {
    const redisStore = await createStore(redisConfig(fakeUpstash.url, fakeUpstash.token, "adapter:"));
    for (const candidate of [store, redisStore]) {
      const session = candidate.sessionStorage();
      assert.equal(typeof session.read, "function");
      assert.equal(typeof session.write, "function");
      assert.equal(typeof session.delete, "function");

      const conv = candidate.conversationStorage();
      assert.equal(conv.type, "key");
      assert.equal(conv.version, 1);
      assert.equal(typeof conv.getStorageKey, "function");
      assert.equal(typeof conv.adapter.read, "function");
      assert.equal(typeof conv.adapter.write, "function");
      assert.equal(typeof conv.adapter.delete, "function");
    }
    await redisStore.close();
  });

  // --------------------------------------------------------- 5. keyboards
  await test("keyboards: struktur inline keyboard", () => {
    const main = keyboards.mainMenu();
    assert.ok(Array.isArray(main.inline_keyboard));
    assert.ok(main.inline_keyboard.length >= 3);
    assert.ok(main.inline_keyboard.flat().every((button) => button.callback_data && button.text));

    const settings = keyboards.settingsMenu({ ai_enabled: "1", ai_stream: "0", group_mention_only: "1" });
    const labels = settings.inline_keyboard.flat().map((button) => button.text);
    assert.ok(labels.some((label) => label.startsWith("✅ AI auto-reply")), "toggle aktif harus ✅");
    assert.ok(labels.some((label) => label.startsWith("❌ Streaming")), "toggle nonaktif harus ❌");

    const models = keyboards.modelMenu(["a", "b", "c"], { current: "b" });
    const modelLabels = models.inline_keyboard.flat().map((button) => button.text);
    assert.ok(modelLabels.includes("✅ b"), "model aktif harus ditandai");
    assert.ok(modelLabels.includes("a"));

    const rating = keyboards.feedbackRatingMenu();
    assert.equal(rating.inline_keyboard.flat().length, 6, "5 rating + tombol batal");
  });

  // ---------------------------------------------------------- 6. router9
  const { server: fakeServer, port } = await startFakeServer();
  const baseUrl = `http://127.0.0.1:${port}`;

  await test("router9: health, listModels (unik & terurut)", async () => {
    const router = new Router9({ baseUrl, apiKey: "sk-test", model: "free" });
    const health = await router.health();
    assert.equal(health.ok, true);
    assert.equal(health.models, 3);

    const models = await router.listModels();
    assert.deepEqual(models, ["code", "free"], "harus unik dan terurut");
  });

  await test("router9: chat non-stream + payload benar", async () => {
    const router = new Router9({ baseUrl, apiKey: "sk-test", model: "free" });
    const result = await router.chat({ messages: [{ role: "user", content: "hi" }], temperature: 0.2, maxTokens: 64 });

    assert.equal(result.content, "halo dunia");
    assert.equal(result.model, "free");
    assert.equal(result.usage.total_tokens, 5);
  });

  await test("router9: chatStream mengurai SSE sampai [DONE]", async () => {
    const router = new Router9({ baseUrl, apiKey: "sk-test", model: "free" });
    let text = "";
    let frames = 0;

    for await (const delta of router.chatStream({ messages: [{ role: "user", content: "hi" }] })) {
      text += delta;
      frames += 1;
    }

    assert.equal(text, "halo dunia");
    assert.equal(frames, 3, `harus 3 potongan, dapat ${frames}`);
  });

  await test("router9: error HTTP dibungkus Router9Error + pesan jelas", async () => {
    const router = new Router9({ baseUrl, apiKey: "sk-test", maxRetries: 0 });
    await assert.rejects(
      () => router.requestJson("/v1/unauthorized"),
      (error) => {
        assert.ok(error instanceof Router9Error);
        assert.equal(error.status, 401);
        assert.ok(error.message.includes("401"));
        assert.ok(error.message.includes("invalid api key"), "detail dari server harus ikut");
        return true;
      },
    );

    assert.ok(describeHttpError(429, "{}").includes("Rate limit"));
    assert.ok(describeHttpError(500, "{}").includes("bermasalah"));
    assert.ok(describeHttpError(404, "{}").includes("tidak ditemukan"));
  });

  await test("router9: server mati menghasilkan error yang ramah + pesan AI offline", async () => {
    const router = new Router9({ baseUrl: "http://127.0.0.1:1", apiKey: "sk-test", maxRetries: 0, timeoutMs: 3000 });
    let captured = null;

    await assert.rejects(
      () => router.chat({ messages: [{ role: "user", content: "hi" }] }),
      (error) => {
        captured = error;
        assert.ok(error instanceof Router9Error);
        assert.ok(/Gagal menghubungi 9Router|Timeout/.test(error.message), error.message);
        return true;
      },
    );

    assert.equal(isOfflineError(captured), true, "koneksi gagal harus terdeteksi offline");
    assert.equal(isOfflineError(new Router9Error("HTTP 500", { status: 500 })), false, "error HTTP bukan offline");

    const serverless = describeAiError(captured, { baseUrl: "http://localhost:20128", serverless: true });
    assert.ok(serverless.includes("AI sedang offline"), serverless);
    assert.ok(serverless.includes("localhost"), "harus menjelaskan localhost tidak terjangkau");

    const local = describeAiError(captured, { baseUrl: "http://localhost:20128", serverless: false });
    assert.ok(local.includes("systemctl"), "di lokal harus menyarankan cek service 9router");

    assert.ok(describeAiError(new Router9Error("HTTP 500: rusak"), { baseUrl }).includes("HTTP 500"));
  });

  await test("router9: isOfflineError aman untuk error non-Router9", () => {
    assert.equal(isOfflineError(null), false);
    assert.equal(isOfflineError(new Error("fetch failed")), false);
  });

  await listen(fakeServer);

  // -------------------------------------------------------------- 7. bot
  await test("createBot: wiring lengkap tanpa menyentuh jaringan", async () => {
    const config = configModule.buildConfig(process.env);
    const logger = createLogger("error");
    const botStore = new Store(":memory:");
    const { bot, registry, app } = await createBot({ config, store: botStore, logger });

    const summary = registry.summary();
    assert.equal(summary.commands, 16, `harus 16 command publik, dapat ${summary.commands}`);

    for (const expected of ["start", "help", "menu", "ping", "info", "id", "settings", "model", "ai", "reset", "echo", "stats", "health", "broadcast", "feedback", "feedbacklist"]) {
      assert.ok(summary.names.includes(expected), `command "${expected}" belum terdaftar`);
    }

    assert.ok(summary.callbacks >= 10, `callback handler kurang: ${summary.callbacks}`);
    assert.ok(summary.texts >= 1, "butuh minimal 1 text handler (auto-reply AI)");

    assert.equal(typeof bot.catch, "function");
    assert.equal(bot.token, config.botToken);
    assert.equal(app.store, botStore, "store yang diberikan harus dipakai");
    assert.ok(app.services.router9 instanceof Router9);
    await botStore.close();
  });

  await test("createBot: membuat store sendiri bila tidak diberikan", async () => {
    const config = configModule.buildConfig({ ...process.env, DB_PATH: ":memory:" });
    const { app } = await createBot({ config, logger: createLogger("error") });
    assert.equal(app.store.driver, "sqlite", "default tanpa store = sqlite");
    await app.store.close();
  });

  await test("registry: validasi duplikat & alias bentrok", () => {
    const config = configModule.buildConfig(process.env);
    const registry = new Registry({ config, store, logger: createLogger("error") });

    registry.register("demo", { aliases: ["d"], description: "demo", handler: async () => {} });
    assert.throws(() => registry.register("demo", { handler: async () => {} }), /sudah terdaftar/);
    assert.throws(() => registry.register("lain", { aliases: ["d"], handler: async () => {} }), /bentrok/);
    assert.throws(() => registry.register("tanpahandler", {}), /handler harus function/);
    assert.throws(() => registry.onCallback("x"), /handler harus function/);
    assert.throws(() => registry.onText("x"), /handler harus function/);
    assert.throws(() => registry.onCallback(123, async () => {}), /trigger harus string atau RegExp/);
  });

  await test("bot: initialSession default konsisten", () => {
    const session = initialSession();
    assert.equal(session.aiCount, 0);
    assert.equal(session.lastPromptAt, null);
    assert.ok(session.createdAt > 0);
  });

  await test("api/setup: daftar command bisa dirakit tanpa store (tanpa Redis)", async () => {
    // Endpoint /api/setup?action=commands merakit registry dengan app minimal
    // ({ config, store: null, logger }) supaya tetap jalan walau storage bermasalah.
    const config = configModule.buildConfig({
      BOT_TOKEN: "123456789:AAabcdefghijklmnopqrstuvwxyz",
      NINEROUTER_API_KEY: "sk-x",
    });
    const app = { config, store: null, logger: createLogger("error") };
    const registry = new Registry(app);

    registry.load(HANDLER_MODULES);
    registerConversationCommands(app, registry);

    const list = registry.commandList();
    assert.equal(list.length, 16, `harus 16 command, dapat ${list.length}`);
    assert.ok(list.every((item) => item.command && item.description));
    assert.equal(registry.summary().callbacks, 14);
  });

  await test("runtime: override URL 9Router dari store menang atas env", async () => {
    const { applyStoredOverrides } = require("../src/runtime");
    const messages = [];
    const quietLogger = {
      info: (message) => messages.push(message),
      warn: (message) => messages.push(message),
      error: () => {},
      debug: () => {},
    };

    const config = configModule.buildConfig({
      BOT_TOKEN: "123456789:AAabcdefghijklmnopqrstuvwxyz",
      NINEROUTER_URL: "https://env.example.com",
      NINEROUTER_MODEL: "gh/gpt-4o-mini",
    });

    const store = new Store(":memory:");

    // Store kosong: environment tetap dipakai.
    assert.deepEqual(await applyStoredOverrides(config, store, quietLogger), []);
    assert.equal(config.router9.baseUrl, "https://env.example.com");

    // Store terisi: menang, trailing slash dinormalkan, model ikut.
    await store.setMeta("router9_url", "https://tunnel.example.com/");
    await store.setMeta("router9_model", "gh/gpt-4.1");
    const applied = await applyStoredOverrides(config, store, quietLogger);

    assert.equal(applied.length, 2, "harus melaporkan 2 override");
    assert.equal(config.router9.baseUrl, "https://tunnel.example.com");
    assert.equal(config.router9.model, "gh/gpt-4.1");

    // Nilai sampah tidak boleh menimpa environment.
    await store.setMeta("router9_url", "bukan-url");
    const fresh = configModule.buildConfig({
      BOT_TOKEN: "123456789:AAabcdefghijklmnopqrstuvwxyz",
      NINEROUTER_URL: "https://env.example.com",
    });
    assert.deepEqual(await applyStoredOverrides(fresh, store, quietLogger), []);
    assert.equal(fresh.router9.baseUrl, "https://env.example.com");

    // Store bermasalah tidak boleh mematikan bootstrap.
    const brokenStore = {
      getMeta: async () => {
        throw new Error("redis down");
      },
    };
    assert.deepEqual(await applyStoredOverrides(fresh, brokenStore, quietLogger), []);
    assert.ok(
      messages.some((message) => message.includes("gagal membaca override")),
      "kegagalan store harus tercatat sebagai warning",
    );

    // setMeta kosong (dipakai `--clear`) mengembalikan ke nilai environment.
    await store.setMeta("router9_url", "");
    await store.setMeta("router9_model", "");
    assert.deepEqual(await applyStoredOverrides(fresh, store, quietLogger), []);
    assert.equal(fresh.router9.baseUrl, "https://env.example.com");

    await store.close();
  });

  await test("webhook: handler + allowed_updates", async () => {
    const config = configModule.buildConfig(process.env);
    const botStore = new Store(":memory:");
    const { bot } = await createBot({ config, store: botStore, logger: createLogger("error") });

    const handler = createWebhookHandler({ bot, config, logger: createLogger("error") });
    assert.equal(typeof handler, "function");

    assert.deepEqual(parseAllowedUpdates(""), DEFAULT_ALLOWED_UPDATES);
    assert.deepEqual(parseAllowedUpdates(" message, callback_query "), ["message", "callback_query"]);

    // GET (bukan POST) dijawab 200 tanpa memproses update.
    const response = { statusCode: null, body: "", headers: {}, writableEnded: false, end(body) { this.body = body ?? ""; this.writableEnded = true; }, setHeader() {}, writeHead(code) { this.statusCode = code; } };
    await handler({ method: "GET", url: "/api/webhook", headers: {} }, response);
    assert.equal(response.statusCode, 200);
    assert.ok(response.body.includes("webhook"), response.body);

    await botStore.close();
  });

  // ---------------------------------------------------------- 8. telegram
  await test("telegram helper: chunking & penanganan error Telegram", async () => {
    const sent = [];
    const fakeCtx = {
      reply: async (text, extra) => {
        sent.push({ text, extra });
        return { message_id: sent.length };
      },
    };

    const many = await telegram.safeReply(fakeCtx, "a".repeat(9000));
    assert.equal(many.length, 3, `9000 char harus jadi 3 pesan, dapat ${many.length}`);
    assert.equal(sent[0].extra.parse_mode, "HTML");

    const notModified = Object.assign(new Error("nope"), { description: "Bad Request: message is not modified" });
    assert.equal(telegram.isNotModified(notModified), true);
    assert.equal(telegram.isFloodWait({ error_code: 429, parameters: { retry_after: 3 } }), true);

    const editCtx = {
      editMessageText: async () => {
        throw notModified;
      },
    };
    assert.equal(await telegram.safeEdit(editCtx, "sama"), null, "not modified harus dianggap sukses");

    let answered = 0;
    await telegram.safeAnswer({ answerCallbackQuery: async () => { answered += 1; } }, "ok");
    assert.equal(answered, 1);
  });

  store.close();

  // ------------------------------------------------------------- laporan
  const failed = results.filter((item) => !item.ok);
  const passed = results.length - failed.length;

  console.log("");
  for (const item of results) {
    console.log(`${item.ok ? "  ✓" : "  ✗"} ${item.name}${item.ok ? "" : `\n      → ${item.error}`}`);
  }
  console.log("");
  console.log(`${passed}/${results.length} pemeriksaan lulus`);

  if (failed.length > 0) {
    console.error(`\n${failed.length} pemeriksaan GAGAL.`);
    process.exitCode = 1;
    return;
  }

  console.log("Semua pemeriksaan lulus ✅");
}

main()
  .catch((error) => {
    console.error("Selfcheck gagal di luar test:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    // pastikan proses tidak menggantung karena socket fetch
    setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
  });
