"use strict";

const { loadEnv, buildConfig, validateConfig, configWarnings } = require("./config");
const { createLogger } = require("./logger");
const { createStore } = require("./store");
const { createBot } = require("./bot");
const { createWebhookHandler } = require("./webhook");

/**
 * Bootstrap bersama untuk semua mode:
 *   - polling (lokal / VPS): src/index.js -> bot.start()
 *   - webhook (Vercel):      api/webhook.js -> handleWebhook(req, res)
 *
 * Fungsi ini TIDAK memulai polling; pemanggil yang menentukan.
 *
 * @param {{ env?: object, logger?: object, loadEnvFile?: boolean, prepare?: boolean }} [options]
 */
async function bootstrap(options = {}) {
  const env = options.env ?? process.env;

  if (options.loadEnvFile !== false) loadEnv();

  const config = buildConfig(env);
  const logger = options.logger ?? createLogger(config.logLevel);

  const problems = validateConfig(config);
  if (problems.length > 0) {
    const error = new Error(`Konfigurasi belum lengkap:\n- ${problems.join("\n- ")}`);
    error.problems = problems;
    error.validation = true;
    throw error;
  }

  for (const warning of configWarnings(config)) logger.warn(`konfigurasi: ${warning}`);

  const store = await createStore(config);
  const { bot, app, registry } = await createBot({ config, store, logger });

  // Siapkan info bot + daftar command di menu Telegram.
  await bot.init();
  const me = bot.botInfo;

  if (options.prepare !== false) {
    await bot.api.setMyCommands(registry.commandList());
  }

  const runtime = {
    config,
    logger,
    store,
    bot,
    app,
    registry,
    me,
    summary: registry.summary(),
    /** Cek koneksi 9Router (dipakai entry point untuk log). */
    async checkAi() {
      try {
        return await app.services.router9.health();
      } catch (error) {
        return { ok: false, error: error.message, baseUrl: config.router9.baseUrl };
      }
    },
    async close() {
      await store.close();
    },
  };

  if (config.mode === "webhook") {
    runtime.handleWebhook = createWebhookHandler({ bot, config, logger });
  }

  return runtime;
}

let cachedRuntime = null;
let cachedPromise = null;

/**
 * Runtime tunggal per instance (khusus serverless: dipakai ulang antar request
 * selama container-nya masih hidup). Gagal bootstrap tidak di-cache supaya
 * request berikutnya bisa mencoba lagi.
 */
function getRuntime(options = {}) {
  if (cachedRuntime) return cachedRuntime;
  if (!cachedPromise) {
    cachedPromise = bootstrap(options)
      .then((runtime) => {
        cachedRuntime = runtime;
        return runtime;
      })
      .catch((error) => {
        cachedPromise = null;
        throw error;
      });
  }
  return cachedPromise;
}

/** Bersihkan cache runtime (dipakai test). */
async function resetRuntime() {
  const runtime = cachedRuntime;
  cachedRuntime = null;
  cachedPromise = null;
  if (runtime) await runtime.close().catch(() => {});
}

module.exports = { bootstrap, getRuntime, resetRuntime };
