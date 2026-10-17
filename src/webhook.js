"use strict";

const { webhookCallback } = require("grammy");

/**
 * Mode webhook: Telegram mengirim update lewat HTTP POST (bukan long polling).
 * Wajib untuk serverless (Vercel) karena tidak ada proses yang bisa polling terus.
 *
 * Handler yang dikembalikan berbentuk `(req, res) => Promise<void>` — cocok untuk
 * fungsi Node di Vercel maupun server http biasa (lihat src/index.js).
 *
 * Keamanan: `secretToken` (WEBHOOK_SECRET) dicek grammY dengan perbandingan
 * constant-time lewat header `X-Telegram-Bot-Api-Secret-Token`; request dengan
 * token salah dibalas 401.
 */

/** Update yang didengarkan (dikirim saat setWebhook). */
const DEFAULT_ALLOWED_UPDATES = ["message", "edited_message", "callback_query", "my_chat_member"];

function parseAllowedUpdates(value) {
  const list = String(value ?? "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length > 0 ? list : DEFAULT_ALLOWED_UPDATES;
}

/**
 * @param {{ bot: object, config: object, logger: object }} options
 * @returns {(req: import("http").IncomingMessage, res: import("http").ServerResponse) => Promise<void>}
 */
function createWebhookHandler({ bot, config, logger }) {
  const callback = webhookCallback(bot, "http", {
    secretToken: config.webhook.secret || undefined,
    timeoutMilliseconds: config.webhook.timeoutMs,
    // Jangan biarkan request menggantung: setelah batas waktu, balas 200 saja
    // supaya Telegram tidak mengulang update yang sama.
    onTimeout: "return",
  });

  return async function handleWebhook(req, res) {
    const started = Date.now();

    if (req.method !== "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "bot-telegram", mode: "webhook" }));
      return;
    }

    try {
      await callback(req, res);
    } catch (error) {
      logger.error(`webhook gagal: ${error.message}`);
      if (!res.writableEnded) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      }
      return;
    }

    logger.debug(`webhook ${req.method} ${req.url} selesai dalam ${Date.now() - started}ms`);
  };
}

/**
 * Daftarkan URL webhook ke Telegram.
 * @param {object} api instance Api grammY (bot.api)
 * @param {string} url URL publik endpoint webhook
 * @param {object} config hasil buildConfig()
 */
async function registerWebhook(api, url, config) {
  const allowed = parseAllowedUpdates(config.webhook.allowedUpdates);

  await api.setWebhook(url, {
    secret_token: config.webhook.secret || undefined,
    drop_pending_updates: Boolean(config.webhook.dropPending),
    allowed_updates: allowed,
  });

  return { url, allowedUpdates: allowed, dropPending: Boolean(config.webhook.dropPending) };
}

module.exports = {
  createWebhookHandler,
  registerWebhook,
  parseAllowedUpdates,
  DEFAULT_ALLOWED_UPDATES,
};
