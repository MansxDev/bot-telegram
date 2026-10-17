"use strict";

const http = require("node:http");

const { loadEnv, buildConfig, validateConfig } = require("./config");
const { createLogger } = require("./logger");
const { bootstrap } = require("./runtime");
const { registerWebhook } = require("./webhook");
const { formatUptime } = require("./utils");

const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Entry point untuk proses panjang (VPS/lokal):
 *   MODE=polling  -> long polling (default di lokal)
 *   MODE=webhook  -> server HTTP lokal yang menerima update Telegram
 *
 * Di Vercel, yang dipakai adalah api/webhook.js (serverless), bukan file ini.
 */
async function main() {
  loadEnv();

  const config = buildConfig();
  const logger = createLogger(config.logLevel);

  logger.info(`environment: ${config.nodeEnv} | node ${process.version} | mode: ${config.mode}`);

  const problems = validateConfig(config);
  if (problems.length > 0) {
    for (const problem of problems) logger.error(`konfigurasi: ${problem}`);
    logger.error("Perbaiki .env lalu jalankan ulang (lihat .env.example).");
    process.exitCode = 1;
    return;
  }

  // Catatan: peringatan konfigurasi dicetak sekali oleh bootstrap() di bawah.
  const runtime = await bootstrap({ logger, loadEnvFile: false });
  const { bot, app, store, registry, me, config: cfg } = runtime;

  logger.info(`storage: ${cfg.store.driver} (${store.location})`);

  const summary = registry.summary();
  logger.info(`command terdaftar: ${summary.commands} (${summary.names.join(", ")})`);
  logger.info(`callback: ${summary.callbacks} | text handler: ${summary.texts}`);

  const health = await runtime.checkAi();
  if (health.ok) {
    logger.info(`9Router: online (${health.models} model) di ${health.baseUrl}`);
  } else {
    logger.warn(`9Router TIDAK terjangkau di ${health.baseUrl} — ${health.error}`);
    logger.warn("Fitur AI akan membalas \"AI sedang offline\"; command lain tetap normal.");
  }

  let shuttingDown = false;
  let server = null;
  let cleanupTimer = null;
  let heartbeatTimer = null;

  async function shutdown(signal, code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`menerima ${signal}, menghentikan bot…`);

    if (cleanupTimer) clearInterval(cleanupTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);

    try {
      if (cfg.mode === "polling") await bot.stop();
      if (server) await new Promise((resolve) => server.close(resolve));
    } catch (error) {
      logger.warn(`gagal menghentikan proses: ${error.message}`);
    }

    try {
      await store.kvPrune("session:", cfg.session.ttlMs);
      await store.kvPrune("conv:", cfg.session.ttlMs);
      await store.close();
      logger.info("storage ditutup rapi");
    } catch (error) {
      logger.warn(`gagal menutup storage: ${error.message}`);
    }

    process.exit(code);
  }

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  process.on("unhandledRejection", (reason) => {
    logger.error("unhandledRejection:", reason);
  });
  process.on("uncaughtException", (error) => {
    // Jangan biarkan proses hidup dalam kondisi tidak jelas: keluar supaya
    // supervisor (systemd/pm2) bisa me-restart bersih.
    logger.error("uncaughtException, proses dihentikan:", error);
    process.exit(1);
  });

  // Bersihkan session/conversation yang sudah kedaluwarsa.
  cleanupTimer = setInterval(() => {
    void (async () => {
      try {
        const sessions = await store.kvPrune("session:", cfg.session.ttlMs);
        const conversations = await store.kvPrune("conv:", cfg.session.ttlMs);
        if (sessions || conversations) {
          logger.debug(`cleanup: ${sessions} session, ${conversations} conversation dihapus`);
        }
      } catch (error) {
        logger.warn(`cleanup gagal: ${error.message}`);
      }
    })();
  }, cfg.session.cleanupIntervalMs);
  cleanupTimer.unref?.();

  heartbeatTimer = setInterval(() => {
    void (async () => {
      try {
        const memory = Math.round(process.memoryUsage().rss / 1024 / 1024);
        logger.info(
          `heartbeat | uptime ${formatUptime(Date.now() - app.startedAt)} | rss ${memory} MB | ` +
            `users ${await store.countUsers()} | ai ${await store.getStat("ai_requests")}`,
        );
      } catch (error) {
        logger.warn(`heartbeat gagal: ${error.message}`);
      }
    })();
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  // ------------------------------------------------------------ mode webhook
  if (cfg.mode === "webhook") {
    server = http.createServer((req, res) => {
      void runtime.handleWebhook(req, res);
    });

    server.on("error", (error) => {
      if (error.code === "EADDRINUSE") {
        logger.error(`port ${cfg.webhook.port} sudah dipakai proses lain. Set PORT lain, mis. PORT=3001.`);
      } else {
        logger.error(`server webhook gagal: ${error.message}`);
      }
      void shutdown("server-error", 1);
    });

    await new Promise((resolve) => server.listen(cfg.webhook.port, resolve));
    logger.info(`server webhook lokal aktif di http://localhost:${cfg.webhook.port} (POST)`);

    if (cfg.webhook.publicUrl) {
      try {
        const info = await registerWebhook(bot.api, `${cfg.webhook.publicUrl}/api/webhook`, cfg);
        logger.info(`webhook terdaftar: ${info.url} (allowed: ${info.allowedUpdates.join(", ")})`);
      } catch (error) {
        logger.error(`gagal mendaftarkan webhook: ${error.message}`);
      }
    } else {
      logger.warn(
        "PUBLIC_URL kosong: server lokal ini hanya bisa dites manual dengan POST JSON update. " +
          "Untuk Telegram, isi PUBLIC_URL atau jalankan `node scripts/set-webhook.cjs set <url>`.",
      );
    }

    logger.info(`bot @${me.username} siap menerima update lewat webhook`);
    return;
  }

  // ------------------------------------------------------------ mode polling
  logger.info(`bot @${me.username} siap — menunggu update (long polling)`);

  await bot.start({
    onStart: (botInfo) => {
      logger.info(`polling aktif untuk @${botInfo.username}`);
    },
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Fatal error saat start:", error);
    process.exit(1);
  });
}

module.exports = { main };
