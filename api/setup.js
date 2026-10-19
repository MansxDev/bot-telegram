"use strict";

/**
 * Vercel serverless function: utilitas setup webhook Telegram.
 *
 * Dipakai untuk mengatur/memeriksa webhook tanpa perlu akses terminal:
 *   GET /api/setup?key=<SETUP_SECRET>                         -> status bot + webhook
 *   GET /api/setup?key=<SETUP_SECRET>&action=set&url=https://x.vercel.app
 *   GET /api/setup?key=<SETUP_SECRET>&action=delete            -> hapus webhook
 *   GET /api/setup?key=<SETUP_SECRET>&action=commands          -> pasang menu command
 *   GET /api/setup?key=<SETUP_SECRET>&action=router-url        -> lihat URL 9Router aktif
 *   GET /api/setup?key=<SETUP_SECRET>&action=set-router-url&url=https://x.trycloudflare.com
 *
 * Untuk aksi utama (status/set/delete/commands) store sengaja TIDAK disentuh
 * supaya tetap bisa dipakai untuk diagnosis walau penyimpanan sedang bermasalah.
 * Store hanya dibuat oleh aksi router-url (override URL 9Router) dan status,
 * dan bila gagal, sisanya tetap dilaporkan.
 */

const crypto = require("node:crypto");
const { Api } = require("grammy");

const { buildConfig, validateConfig, configWarnings } = require("../src/config");
const { registerWebhook } = require("../src/webhook");
const { applyStoredOverrides } = require("../src/runtime");
const { Router9 } = require("../src/services/router9");

/** Buat store sejenak, pakai, lalu tutup (serverless: tanpa state global). */
async function withStore(config, fn) {
  const { createStore } = require("../src/store");
  const store = await createStore(config);
  try {
    return await fn(store);
  } finally {
    await store.close().catch(() => {});
  }
}

/** Cek apakah 9Router benar-benar bisa dijangkau dari mesin ini. */
async function probeRouter9(config, baseUrl) {
  const router = new Router9({
    baseUrl,
    apiKey: config.router9.apiKey,
    model: config.router9.model,
    timeoutMs: Math.min(config.router9.timeoutMs, 10_000),
    maxRetries: 0,
  });

  try {
    const health = await router.health();
    return { reachable: Boolean(health.ok), models: health.models ?? 0, error: health.error ?? null };
  } catch (error) {
    return { reachable: false, models: 0, error: error?.message ?? String(error) };
  }
}

/** Ringkasan konfigurasi 9Router: env, override dari store, dan hasil probe. */
async function router9Report(config) {
  const report = {
    envUrl: config.router9.baseUrl,
    storedUrl: null,
    effectiveUrl: config.router9.baseUrl,
    model: config.router9.model,
    apiKeyTerpasang: Boolean(config.router9.apiKey),
    reachable: null,
    models: 0,
    error: null,
  };

  try {
    report.storedUrl = (await withStore(config, (store) => store.getMeta("router9_url", ""))) || null;
    // applyStoredOverrides menimpa config dengan nilai store (kalau ada).
    await applyStoredOverrides(config, { getMeta: async () => report.storedUrl, setMeta: async () => {} }, console);
    report.effectiveUrl = config.router9.baseUrl;
    report.model = config.router9.model;
  } catch (error) {
    report.error = `gagal membaca store: ${error?.message ?? String(error)}`;
  }

  const probe = await probeRouter9(config, report.effectiveUrl);
  report.reachable = probe.reachable;
  report.models = probe.models;
  if (!report.error) report.error = probe.error;

  return report;
}

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

    // ---- override URL 9Router (dipakai bersama Cloudflare Tunnel) ----
    if (action === "set-router-url" || action === "set-router9") {
      const target = String(url.searchParams.get("url") ?? "").trim().replace(/\/+$/, "");
      if (!/^https?:\/\//i.test(target)) {
        send(400, {
          ok: false,
          error: "Parameter `url` wajib berisi http(s)://… (mis. https://xxx.trycloudflare.com)",
        });
        return;
      }

      const model = String(url.searchParams.get("model") ?? "").trim();

      await withStore(config, async (store) => {
        await store.setMeta("router9_url", target);
        if (model) await store.setMeta("router9_model", model);
      });

      const probe = await probeRouter9(config, target);
      send(200, {
        ok: true,
        action,
        message: "URL 9Router disimpan di database. Efeknya langsung untuk request berikutnya (tanpa redeploy).",
        router9: { storedUrl: target, storedModel: model || null, model: model || config.router9.model, ...probe },
      });
      return;
    }

    if (action === "router-url" || action === "get-router-url" || action === "router9") {
      send(200, { ok: true, action, envUrl: config.router9.baseUrl, router9: await router9Report(config) });
      return;
    }

    // default: status
    const [me, webhookInfo] = await Promise.all([api.getMe(), api.getWebhookInfo()]);
    const router9 = await router9Report(config);

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
      router9,
    });
  } catch (error) {
    send(500, { ok: false, action, error: error?.message ?? String(error) });
  }
};
