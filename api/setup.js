"use strict";

/**
 * Vercel serverless function: utilitas setup webhook Telegram.
 *
 * Dipakai untuk mengatur/memeriksa webhook tanpa perlu akses terminal:
 *   GET /api/setup?key=<SETUP_SECRET>                         -> status bot + webhook
 *   GET /api/setup?key=<SETUP_SECRET>&action=set&url=https://x.vercel.app
 *   GET /api/setup?key=<SETUP_SECRET>&action=delete            -> hapus webhook
 *
 * Sengaja TIDAK menyentuh store (Redis) supaya tetap bisa dipakai untuk
 * diagnosis walau penyimpanan sedang bermasalah.
 */

const crypto = require("node:crypto");
const { Api } = require("grammy");

const { buildConfig, validateConfig, configWarnings } = require("../src/config");
const { registerWebhook } = require("../src/webhook");

/** Perbandingan string constant-time (anti timing attack). */
function safeEqual(a, b) {
  const left = crypto.createHash("sha256").update(String(a ?? "")).digest();
  const right = crypto.createHash("sha256").update(String(b ?? "")).digest();
  return crypto.timingSafeEqual(left, right);
}

function maskToken(token) {
  const text = String(token ?? "");
  if (text.length < 12) return "(kosong)";
  return `${text.slice(0, 8)}…${text.slice(-4)}`;
}

module.exports = async function handler(req, res) {
  const config = buildConfig();
  const url = new URL(req.url ?? "/api/setup", "http://localhost");
  const action = String(url.searchParams.get("action") ?? "status").toLowerCase();

  const send = (status, payload) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(payload, null, 2));
  };

  // ---- otentikasi: wajib SETUP_SECRET, dibandingkan constant-time ----
  if (!config.webhook.setupSecret) {
    send(403, {
      ok: false,
      error: "SETUP_SECRET belum diisi di environment. Isi dulu supaya endpoint ini aman dipakai.",
    });
    return;
  }

  const provided = url.searchParams.get("key") ?? req.headers["x-setup-key"] ?? "";
  if (!safeEqual(provided, config.webhook.setupSecret)) {
    send(401, { ok: false, error: "key salah" });
    return;
  }

  const problems = validateConfig(config);
  if (!config.botToken) {
    send(500, { ok: false, error: "BOT_TOKEN belum diisi.", problems });
    return;
  }

  const api = new Api(config.botToken);

  try {
    if (action === "set") {
      const base = String(url.searchParams.get("url") ?? config.webhook.publicUrl ?? "").replace(/\/+$/, "");
      if (!/^https:\/\//i.test(base)) {
        send(400, {
          ok: false,
          error: "Parameter `url` wajib berisi https://… (mis. https://bot-telegram.vercel.app)",
        });
        return;
      }

      const endpoint = `${base}/api/webhook`;
      const info = await registerWebhook(api, endpoint, config);
      const webhookInfo = await api.getWebhookInfo();

      send(200, { ok: true, action, registered: info, webhook: webhookInfo });
      return;
    }

    if (action === "delete") {
      await api.deleteWebhook({ drop_pending_updates: true });
      send(200, { ok: true, action, message: "Webhook dihapus. Bot bisa kembali memakai long polling." });
      return;
    }

    if (action === "commands") {
      // Daftar command diringkas dari modul handler (tanpa perlu store/Redis),
      // termasuk command yang berasal dari conversation (/echo) supaya menu di
      // Telegram sama persis dengan yang dipasang runtime.
      const { Registry } = require("../src/handlers");
      const { HANDLER_MODULES } = require("../src/bot");
      const { registerConversationCommands } = require("../src/conversations");

      const app = { config, store: null, logger: console };
      const registry = new Registry(app);
      registry.load(HANDLER_MODULES);
      registerConversationCommands(app, registry);

      const list = registry.commandList();
      await api.setMyCommands(list);
      send(200, { ok: true, action, commands: list });
      return;
    }

    // default: status
    const [me, webhookInfo] = await Promise.all([api.getMe(), api.getWebhookInfo()]);

    send(200, {
      ok: true,
      action: "status",
      bot: { id: me.id, username: me.username, name: me.first_name, token: maskToken(config.botToken) },
      webhook: webhookInfo,
      runtime: {
        mode: config.mode,
        serverless: config.serverless,
        storeDriver: config.store.driver,
        publicUrl: config.webhook.publicUrl || null,
        secretTerpasang: Boolean(config.webhook.secret),
      },
      problems,
      warnings: configWarnings(config),
    });
  } catch (error) {
    send(500, { ok: false, action, error: error?.message ?? String(error) });
  }
};
