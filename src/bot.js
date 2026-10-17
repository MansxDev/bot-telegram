"use strict";

const { Bot, session } = require("grammy");
const { autoRetry } = require("@grammyjs/auto-retry");
const { conversations } = require("@grammyjs/conversations");

const { Store, createStore } = require("./store");
const { createLogger } = require("./logger");
const { Router9 } = require("./services/router9");
const { Registry } = require("./handlers/index");
const { createTrackingMiddleware } = require("./middlewares/tracking");
const { buildConversations, registerConversationCommands } = require("./conversations");

const keyboards = require("./keyboards");
const telegram = require("./telegram");
const utils = require("./utils");

const HANDLER_MODULES = [
  require("./handlers/general"),
  require("./handlers/settings"),
  require("./handlers/ai"),
  require("./handlers/admin"),
];

/** Objek dependency bersama yang dipakai semua handler. */
function createApp({ config, store, logger }) {
  return {
    config,
    store,
    logger,
    startedAt: Date.now(),
    services: {
      router9: new Router9(config.router9),
    },
    keyboards,
    telegram,
    utils,
  };
}

/** Data session awal (disimpan di SQLite, per chat). */
function initialSession() {
  return { createdAt: Date.now(), aiCount: 0, lastPromptAt: null };
}

/** Error handler: catat, jawab user, dan JANGAN hentikan polling. */
function createErrorHandler(app) {
  const { logger, store } = app;

  return async function onError(error) {
    const ctx = error.ctx;
    const cause = error.error ?? error;

    logger.error(`update gagal: ${cause?.message ?? cause}`);
    if (logger.level === "debug" && cause?.stack) logger.debug(cause.stack);

    try {
      await store.bumpStat("errors_total");
    } catch {
      // store bisa saja sudah ditutup saat shutdown
    }

    try {
      if (ctx?.callbackQuery) {
        await ctx.answerCallbackQuery({ text: "⚠️ Terjadi kesalahan" }).catch(() => {});
      } else if (ctx?.chat) {
        await ctx.reply("⚠️ Terjadi kesalahan internal. Coba lagi sebentar lagi.").catch(() => {});
      }
    } catch {
      // jangan biarkan error handler melempar lagi
    }
  };
}

/**
 * Bangun bot lengkap (tanpa menyentuh jaringan).
 * Urutan middleware penting:
 *   tracking -> session -> conversations -> commands -> callbacks -> text
 * conversations dipasang SEBELUM handler agar bisa mengambil alih update saat aktif.
 *
 * Async karena store bisa perlu koneksi (mis. driver Redis). Kalau `options.store`
 * tidak diberikan, store dibuat otomatis dari konfigurasi.
 *
 * @param {{ config: object, store?: object, logger?: object }} options
 */
async function createBot(options = {}) {
  const config = options.config;
  if (!config) throw new Error("createBot(): options.config wajib diisi");

  const logger = options.logger ?? createLogger(config.logLevel);
  const store = options.store ?? (await createStore(config));
  const app = createApp({ config, store, logger });

  const bot = new Bot(config.botToken);

  // Retry otomatis untuk error jaringan/rate limit Telegram.
  bot.api.config.use(
    autoRetry({
      maxRetryAttempts: 3,
      maxDelaySeconds: 20,
      rethrowInternalServerErrors: false,
    }),
  );

  bot.use(createTrackingMiddleware(app));

  bot.use(
    session({
      initial: initialSession,
      storage: store.sessionStorage(),
      getSessionKey: (ctx) => {
        const key = ctx.chat?.id ?? ctx.from?.id;
        return key === undefined || key === null ? undefined : String(key);
      },
    }),
  );

  bot.use(conversations({ storage: store.conversationStorage() }));

  for (const conversation of buildConversations(app)) {
    bot.use(conversation);
  }

  const registry = new Registry(app);
  registry.load(HANDLER_MODULES);
  registerConversationCommands(app, registry);
  registry.install(bot);

  bot.catch(createErrorHandler(app));

  return { bot, app, store, registry };
}

module.exports = { createBot, createApp, createErrorHandler, initialSession, HANDLER_MODULES };
