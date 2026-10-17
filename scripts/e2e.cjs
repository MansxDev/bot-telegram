#!/usr/bin/env node
"use strict";

/**
 * E2E offline: update Telegram palsu + 9Router tiruan.
 * Membuktikan command, callback, conversation, jalur AI, dan mode webhook
 * benar-benar jalan tanpa token Telegram dan tanpa jaringan.
 *
 * Jalankan: npm run e2e
 */

process.env.LOG_LEVEL = "error";

const assert = require("node:assert/strict");
const http = require("node:http");
const { PassThrough } = require("node:stream");

const { buildConfig } = require("../src/config");
const { createLogger } = require("../src/logger");
const { Store } = require("../src/store");
const { createBot } = require("../src/bot");
const { createWebhookHandler } = require("../src/webhook");

const BOT_ID = 999000111;
const USER_ID = 7;
const CHAT_ID = 7;

const ME = {
  id: BOT_ID,
  is_bot: true,
  first_name: "Selfcheck Bot",
  username: "selfcheck_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
};

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
  }
}

/** Server 9Router tiruan. */
function startFakeRouter9() {
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "free" }] }));
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
        res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: "halo dunia" } }] }));
      });
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });

  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

/**
 * API Telegram tiruan: mencatat semua panggilan, tidak menyentuh jaringan.
 *
 * Catatan penting: plugin conversations membuat instance `Api` BARU dari token
 * (`new Api(protoApi.token, protoApi.options)` di @grammyjs/conversations/out/plugin.js),
 * sehingga transformer dari `bot.api.config.use()` — termasuk auto-retry — TIDAK ikut.
 * Karena itu stub ini mem-patch `node-fetch` (yang dipakai grammY di Node) dan
 * dipasang SEBELUM bot dibuat, agar semua instance Api tertangkap.
 */
function installFakeApi() {
  const nodeFetch = require("node-fetch");
  const originalFetch = nodeFetch.default;
  const calls = [];
  let messageId = 500;

  const makeMessage = (payload) => ({
    message_id: (messageId += 1),
    date: Math.floor(Date.now() / 1000),
    chat: { id: payload.chat_id, type: "private" },
    from: ME,
    text: payload.text ?? "",
  });

  const results = {
    getMe: () => ME,
    setMyCommands: () => true,
    sendMessage: (payload) => makeMessage(payload),
    sendChatAction: () => true,
    sendMediaGroup: () => [],
    editMessageText: (payload) => ({
      message_id: payload.message_id,
      date: Math.floor(Date.now() / 1000),
      chat: { id: payload.chat_id, type: "private" },
      from: ME,
      text: payload.text ?? "",
    }),
    answerCallbackQuery: () => true,
    deleteMessage: () => true,
    getUpdates: () => [],
  };

  nodeFetch.default = async (url, init = {}) => {
    const method = String(url).split("/").pop().split("?")[0];
    const payload = init.body ? JSON.parse(String(init.body)) : {};
    calls.push({ method, payload });

    const handler = results[method];
    const result = handler ? handler(payload) : true;
    return { json: async () => ({ ok: true, result }) };
  };

  return {
    calls,
    restore() {
      nodeFetch.default = originalFetch;
    },
    reset: () => calls.splice(0, calls.length),
    of: (method) => calls.filter((call) => call.method === method),
    last: (method) => [...calls].reverse().find((call) => call.method === method),
  };
}

// --------------------------------------------------------- builder update

let updateId = 100;
const nextUpdateId = () => (updateId += 1);

function textUpdate(text) {
  return {
    update_id: nextUpdateId(),
    message: {
      message_id: nextUpdateId(),
      date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT_ID, type: "private" },
      from: { id: USER_ID, is_bot: false, first_name: "Mans", username: "mans" },
      text,
      entities: text.startsWith("/")
        ? [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }]
        : undefined,
    },
  };
}

function callbackUpdate(data, promptText = "menu") {
  return {
    update_id: nextUpdateId(),
    callback_query: {
      id: String(nextUpdateId()),
      from: { id: USER_ID, is_bot: false, first_name: "Mans", username: "mans" },
      chat: { id: CHAT_ID, type: "private" },
      message: {
        message_id: nextUpdateId(),
        date: Math.floor(Date.now() / 1000),
        chat: { id: CHAT_ID, type: "private" },
        from: ME,
        text: promptText,
      },
      chat_instance: "selfcheck-instance",
      data,
    },
  };
}

/**
 * Tiru request HTTP yang dikirim Telegram ke endpoint webhook.
 * @returns {Promise<{statusCode: number, body: string, headers: object}>}
 */
function invokeWebhook(handler, body, secret) {
  return new Promise((resolve, reject) => {
    const req = new PassThrough();
    req.method = "POST";
    req.url = "/api/webhook";
    req.headers = {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret ?? "",
    };

    const chunks = [];
    const res = {
      statusCode: 200,
      headers: {},
      writableEnded: false,
      body: "",
      setHeader(key, value) {
        this.headers[String(key).toLowerCase()] = value;
        return this;
      },
      writeHead(code, headers) {
        this.statusCode = code;
        for (const [key, value] of Object.entries(headers ?? {})) this.headers[String(key).toLowerCase()] = value;
        return this;
      },
      end(payload) {
        if (payload !== undefined && payload !== null) chunks.push(String(payload));
        this.body = chunks.join("");
        this.writableEnded = true;
        resolve(this);
        return this;
      },
    };

    handler(req, res).catch(reject);
    req.end(body);
  });
}

async function main() {
  const { server, port } = await startFakeRouter9();

  const config = buildConfig({
    BOT_TOKEN: "123456789:SelfcheckFakeTokenBbbbbbbbbbbbbb",
    ADMIN_IDS: String(USER_ID),
    DB_PATH: ":memory:",
    NINEROUTER_URL: `http://127.0.0.1:${port}`,
    NINEROUTER_API_KEY: "sk-selfcheck",
    NINEROUTER_MODEL: "free",
    NINEROUTER_MAX_RETRIES: "0",
    AI_STREAM: "true",
    AI_EDIT_INTERVAL_MS: "0",
    LOG_LEVEL: "error",
  });

  const logger = createLogger("error");
  const store = new Store(":memory:");

  // Stub fetch HARUS dipasang sebelum createBot: grammY menangkap referensi fetch
  // saat ApiClient dibuat.
  const api = installFakeApi();
  const { bot, registry } = await createBot({ config, store, logger });

  await bot.init();
  await bot.api.setMyCommands(registry.commandList());

  await test("bot.init() menyediakan botInfo (dipakai entry point)", () => {
    assert.ok(bot.botInfo, "bot.botInfo harus tersedia setelah init");
    assert.equal(bot.botInfo.username, ME.username);
    assert.equal(bot.botInfo.id, BOT_ID);
  });

  api.reset();

  // ------------------------------------------------------------- /start
  await test("/start membalas sapaan + inline keyboard", async () => {
    await bot.handleUpdate(textUpdate("/start"));

    const sent = api.last("sendMessage");
    assert.ok(sent, "harus ada sendMessage");
    assert.ok(sent.payload.text.includes("Halo"), `teks tidak menyapa: ${sent.payload.text}`);
    assert.ok(sent.payload.text.includes("Mans"), "harus menyebut nama user");
    assert.ok(sent.payload.reply_markup?.inline_keyboard?.length > 0, "harus ada inline keyboard");
    assert.equal(await store.countUsers(), 1, "user harus tercatat di store");
    assert.equal(await store.countChats(), 1, "chat harus tercatat di store");
    assert.ok((await store.getStat("updates_total")) >= 1, "statistik update harus naik");
    assert.ok(
      (await store.getStat("update_message")) >= 1,
      "tipe update harus terbaca (bug ctx.updateType undefined)",
    );
  });

  // -------------------------------------------------------------- /ping
  await test("/ping membalas lalu mengedit dengan latensi", async () => {
    api.reset();
    await bot.handleUpdate(textUpdate("/ping"));

    assert.ok(api.last("sendMessage").payload.text.includes("Pong"), "harus kirim Pong");
    const edited = api.last("editMessageText");
    assert.ok(edited, "harus edit pesan");
    assert.match(edited.payload.text, /Pong!/);
    assert.match(edited.payload.text, /\d+ms/);
  });

  // ---------------------------------------------------------------- /id
  await test("/id menampilkan ID user & chat + status admin", async () => {
    api.reset();
    await bot.handleUpdate(textUpdate("/id"));

    const text = api.last("sendMessage").payload.text;
    assert.ok(text.includes(String(USER_ID)), "harus memuat user id");
    assert.ok(text.includes(String(CHAT_ID)), "harus memuat chat id");
    assert.ok(text.includes("Admin") && text.includes("ya"), "ADMIN_IDS harus dikenali");
  });

  // -------------------------------------------------------------- /help
  await test("/help memuat daftar command dari registry", async () => {
    api.reset();
    await bot.handleUpdate(textUpdate("/help"));

    const text = api.last("sendMessage").payload.text.replace(/<[^>]+>/g, "");
    for (const command of ["start", "help", "menu", "ai", "settings", "model", "stats", "echo"]) {
      assert.ok(text.includes(`/${command}`), `help harus memuat /${command}`);
    }
  });

  // ------------------------------------------------- auto-reply AI (stream)
  await test("teks biasa memicu AI streaming lewat 9Router", async () => {
    api.reset();
    await bot.handleUpdate(textUpdate("halo bot, apa kabar?"));

    const placeholder = api.of("sendMessage")[0];
    assert.ok(placeholder, "harus kirim placeholder");
    assert.ok(placeholder.payload.text.includes("berpikir"), `placeholder aneh: ${placeholder.payload.text}`);

    const edits = api.of("editMessageText");
    assert.ok(edits.length >= 1, "placeholder harus diedit");
    assert.ok(
      edits.some((call) => call.payload.text.includes("halo dunia")),
      `balasan AI tidak muncul: ${JSON.stringify(edits.map((e) => e.payload.text))}`,
    );

    const history = await store.getAiHistory(CHAT_ID, 10);
    assert.equal(history.length, 2, "harus simpan 1 pesan user + 1 balasan");
    assert.equal(history[0].role, "user");
    assert.equal(history[1].role, "assistant");
    assert.equal(history[1].content, "halo dunia");
    assert.equal(await store.getStat("ai_requests"), 1);
    assert.equal(await store.getStat("ai_success"), 1);
  });

  // --------------------------------------------------------- /ai sekali
  await test("/ai <prompt> menjawab sekali + /reset membersihkan riwayat", async () => {
    api.reset();
    await bot.handleUpdate(textUpdate("/ai jelaskan SQLite singkat"));

    assert.ok(api.of("sendMessage").length >= 1, "harus ada balasan");
    assert.equal((await store.getAiHistory(CHAT_ID, 10)).length, 4, "riwayat bertambah 2");

    api.reset();
    await bot.handleUpdate(textUpdate("/reset"));
    const text = api.last("sendMessage").payload.text;
    assert.ok(text.includes("Riwayat"), `konfirmasi reset tidak muncul: ${text}`);
    assert.equal((await store.getAiHistory(CHAT_ID, 10)).length, 0, "riwayat harus kosong");
  });

  // ------------------------------------------------------ callback menu
  await test("callback menu:stats mengedit pesan dengan statistik", async () => {
    api.reset();
    await bot.handleUpdate(callbackUpdate("menu:stats"));

    assert.equal(api.of("answerCallbackQuery").length, 1, "callback harus dijawab");
    const edited = api.last("editMessageText");
    assert.ok(edited, "pesan menu harus diedit");
    assert.ok(edited.payload.text.includes("STATISTIK"), "isi statistik tidak muncul");
    assert.ok(edited.payload.reply_markup?.inline_keyboard?.length > 0, "tombol kembali hilang");
  });

  await test("callback settings:toggle mengubah setting + label ✅/❌", async () => {
    api.reset();
    await bot.handleUpdate(callbackUpdate("menu:settings", "menu"));
    assert.ok(api.last("editMessageText").payload.text.includes("PENGATURAN"));

    api.reset();
    await bot.handleUpdate(callbackUpdate("settings:toggle:ai_enabled", "pengaturan"));

    assert.equal(await store.getSetting(CHAT_ID, "ai_enabled"), "0", "toggle harus mematikan AI");
    const labels = api.last("editMessageText").payload.reply_markup.inline_keyboard.flat().map((b) => b.text);
    assert.ok(labels.some((label) => label.startsWith("❌ AI auto-reply")), `label belum berubah: ${labels.join(" | ")}`);

    // matikan -> AI harus diam
    api.reset();
    await bot.handleUpdate(textUpdate("apakah kamu masih hidup?"));
    assert.equal(api.of("sendMessage").length, 0, "AI harus diam saat ai_enabled=0");

    await store.setSetting(CHAT_ID, "ai_enabled", "1");
  });

  // ------------------------------------------------------ conversation
  await test("conversation /feedback: rating -> komentar -> simpan", async () => {
    api.reset();

    await bot.handleUpdate(textUpdate("/feedback"));
    const prompt = api.last("sendMessage");
    assert.ok(prompt, "harus kirim prompt rating");
    assert.ok(
      prompt.payload.text.includes("FEEDBACK"),
      `prompt feedback tidak muncul. Pesan terkirim: ${JSON.stringify(api.of("sendMessage").map((call) => call.payload.text))}`,
    );
    assert.equal(prompt.payload.reply_markup.inline_keyboard.flat().length, 6, "keyboard rating harus 6 tombol");

    api.reset();
    await bot.handleUpdate(callbackUpdate("fb:rate:5", "feedback"));
    assert.equal(api.of("answerCallbackQuery").length, 1, "rating harus dijawab");
    assert.ok(
      api.of("editMessageText").some((call) => call.payload.text.includes("⭐")),
      "pesan rating harus diedit menampilkan bintang",
    );
    assert.ok(api.last("sendMessage").payload.text.includes("komentar"), "harus minta komentar");

    api.reset();
    await bot.handleUpdate(textUpdate("botnya keren, AI-nya cepat"));
    assert.ok(api.last("sendMessage").payload.text.includes("KONFIRMASI"), "harus minta konfirmasi");

    // Regresi: conversation di-replay setiap update, jadi statistik flow harus
    // tetap 1 (dinaikkan di command handler, bukan di dalam body conversation).
    assert.equal(
      await store.getStat("feedback_flow_started"),
      1,
      "statistik feedback_flow_started harus dihitung sekali walau conversation di-replay",
    );

    api.reset();
    await bot.handleUpdate(callbackUpdate("fb:yes", "konfirmasi"));

    assert.equal(await store.countFeedback(), 1, "feedback harus tersimpan di store");
    assert.equal((await store.listFeedback(1))[0].rating, 5);
    assert.equal((await store.listFeedback(1))[0].comment, "botnya keren, AI-nya cepat");
    assert.ok(api.last("sendMessage").payload.text.includes("Terima kasih"), "harus ucapkan terima kasih");
    assert.equal(await store.getStat("feedback_flow_started"), 1, "statistik flow tidak boleh bertambah setelah replay");
  });

  await test("conversation /echo: loop sampai /selesai", async () => {
    api.reset();

    await bot.handleUpdate(textUpdate("/echo"));
    assert.ok(api.last("sendMessage").payload.text.includes("ECHO"), "prompt echo tidak muncul");

    api.reset();
    await bot.handleUpdate(textUpdate("tes satu"));
    assert.ok(api.last("sendMessage").payload.text.includes("tes satu"), "harus mengulang teks");

    api.reset();
    await bot.handleUpdate(textUpdate("tes dua"));
    assert.ok(api.last("sendMessage").payload.text.includes("2."), "counter harus naik");

    api.reset();
    await bot.handleUpdate(textUpdate("/selesai"));
    assert.ok(api.last("sendMessage").payload.text.includes("Selesai"), "harus menutup conversation");
  });

  await test("command hanya admin ditolak untuk non-admin", async () => {
    const outsider = textUpdate("/stats");
    outsider.message.from = { id: 888888, is_bot: false, first_name: "Orang" };

    api.reset();
    await bot.handleUpdate(outsider);

    const text = api.last("sendMessage").payload.text;
    assert.ok(text.includes("khusus admin"), `harus ditolak, dapat: ${text}`);
  });

  await test("admin /stats & /health berjalan tanpa error", async () => {
    api.reset();
    await bot.handleUpdate(textUpdate("/stats"));
    assert.ok(api.last("sendMessage").payload.text.includes("STATISTIK BOT"), "stats admin gagal");

    api.reset();
    await bot.handleUpdate(textUpdate("/health"));
    const text = api.last("sendMessage").payload.text;
    assert.ok(text.includes("HEALTH CHECK"), "health gagal");
    assert.ok(text.includes("online"), "9Router tiruan harus terdeteksi online");
  });

  await test("error handler tidak menghentikan polling", async () => {
    api.reset();
    await bot.handleUpdate(textUpdate("/broadcast"));
    const text = api.last("sendMessage").payload.text;
    assert.ok(text.includes("/broadcast"), "harus memberi contoh pemakaian");
    assert.equal(bot.pollingRunning, false, "handleUpdate tidak boleh menyalakan polling");
  });

  // ----------------------------------------------------------- webhook
  await test("mode webhook: secret benar diproses, secret salah ditolak 401", async () => {
    const webhookConfig = {
      ...config,
      webhook: { ...config.webhook, secret: "rahasia-uji-webhook", timeoutMs: 5000 },
    };
    const handler = createWebhookHandler({ bot, config: webhookConfig, logger });

    // Secret salah -> 401, update tidak diproses.
    api.reset();
    const rejected = await invokeWebhook(handler, JSON.stringify(textUpdate("/ping")), "secret-palsu");
    assert.equal(rejected.statusCode, 401, `harus 401, dapat ${rejected.statusCode}`);
    assert.equal(api.of("sendMessage").length, 0, "update dengan secret salah tidak boleh diproses");

    // Secret benar -> 200, update diproses seperti biasa.
    api.reset();
    const accepted = await invokeWebhook(handler, JSON.stringify(textUpdate("/ping")), "rahasia-uji-webhook");
    assert.equal(accepted.statusCode, 200, `harus 200, dapat ${accepted.statusCode}`);
    assert.ok(api.of("sendMessage").length >= 1, "update dengan secret benar harus diproses");

    // GET dijawab 200 (health check sederhana).
    const health = await invokeWebhookGet(handler);
    assert.equal(health.statusCode, 200);
  });

  await test("body webhook rusak tidak membuat proses mati", async () => {
    const webhookConfig = {
      ...config,
      webhook: { ...config.webhook, secret: "rahasia-uji-webhook", timeoutMs: 5000 },
    };
    const handler = createWebhookHandler({ bot, config: webhookConfig, logger });

    const broken = await invokeWebhook(handler, "{bukan json", "rahasia-uji-webhook");
    assert.equal(broken.statusCode, 200, "balasan tetap 200 supaya Telegram tidak mengulang terus");
  });

  // -------------------------------------------- AI offline (graceful)
  await test("9Router mati: user dapat pesan 'AI sedang offline', command lain normal", async () => {
    const offlineConfig = buildConfig({
      BOT_TOKEN: "123456789:SelfcheckFakeTokenBbbbbbbbbbbbbb",
      ADMIN_IDS: String(USER_ID),
      DB_PATH: ":memory:",
      NINEROUTER_URL: "http://127.0.0.1:1",
      NINEROUTER_API_KEY: "sk-selfcheck",
      NINEROUTER_MODEL: "free",
      NINEROUTER_MAX_RETRIES: "0",
      NINEROUTER_TIMEOUT_MS: "3000",
      AI_STREAM: "true",
      AI_EDIT_INTERVAL_MS: "0",
      LOG_LEVEL: "error",
    });

    const offlineStore = new Store(":memory:");
    const { bot: offlineBot } = await createBot({ config: offlineConfig, store: offlineStore, logger });
    await offlineBot.init(); // sama seperti yang dilakukan bootstrap() di runtime

    api.reset();
    await offlineBot.handleUpdate(textUpdate("halo, kamu ada?"));

    const replies = [
      ...api.of("sendMessage").map((call) => call.payload.text),
      ...api.of("editMessageText").map((call) => call.payload.text),
    ].join("\n");

    assert.ok(replies.includes("AI sedang offline"), `harus ada pesan AI offline, dapat: ${replies}`);
    assert.ok(replies.includes("systemctl"), "di lokal harus menyarankan cek service 9router");

    // Placeholder awal "sedang berpikir…" harus diedit jadi pesan error,
    // bukan dibiarkan menggantung.
    const lastEdit = api.last("editMessageText");
    assert.ok(lastEdit, "placeholder harus diedit saat AI gagal");
    assert.ok(!lastEdit.payload.text.includes("berpikir"), `placeholder menggantung: ${lastEdit.payload.text}`);

    api.reset();
    await offlineBot.handleUpdate(textUpdate("/ping"));
    assert.ok(api.last("sendMessage").payload.text.includes("Pong"), "command lain harus tetap jalan");

    await offlineStore.close();
  });

  // ------------------------------------------------------------- laporan
  await store.close();
  api.restore();
  await new Promise((resolve) => server.close(resolve));

  const failed = results.filter((item) => !item.ok);
  console.log("");
  for (const item of results) {
    console.log(`${item.ok ? "  ✓" : "  ✗"} ${item.name}${item.ok ? "" : `\n      → ${item.error}`}`);
  }
  console.log("");
  console.log(`${results.length - failed.length}/${results.length} skenario E2E lulus`);

  if (failed.length > 0) {
    console.error(`\n${failed.length} skenario E2E GAGAL.`);
    process.exitCode = 1;
    return;
  }

  console.log("Semua skenario E2E lulus ✅");
}

/** GET ke endpoint webhook (health check sederhana). */
function invokeWebhookGet(handler) {
  return new Promise((resolve, reject) => {
    const req = new PassThrough();
    req.method = "GET";
    req.url = "/api/webhook";
    req.headers = {};

    const res = {
      statusCode: 200,
      headers: {},
      writableEnded: false,
      body: "",
      setHeader(key, value) {
        this.headers[String(key).toLowerCase()] = value;
        return this;
      },
      writeHead(code, headers) {
        this.statusCode = code;
        for (const [key, value] of Object.entries(headers ?? {})) this.headers[String(key).toLowerCase()] = value;
        return this;
      },
      end(payload) {
        this.body = payload === undefined || payload === null ? "" : String(payload);
        this.writableEnded = true;
        resolve(this);
        return this;
      },
    };

    handler(req, res).catch(reject);
    req.end();
  });
}

main().catch((error) => {
  console.error("E2E gagal di luar test:", error);
  process.exitCode = 1;
});
