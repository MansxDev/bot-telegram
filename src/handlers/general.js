"use strict";

const { escapeHtml, formatUptime, formatNumber, displayName } = require("../utils");
const { safeReply, safeEdit, safeAnswer } = require("../telegram");

/**
 * Command umum: /start /help /menu /ping /info /id + navigasi callback menu utama.
 */
module.exports = function registerGeneral(app, registry) {
  const { register, onCallback } = registry;
  const { config, store, keyboards, logger } = app;
  const startedAt = app.startedAt ?? Date.now();

  function helpText() {
    const lines = ["<b>📖 DAFTAR PERINTAH</b>", ""];

    for (const cmd of registry.commandList()) {
      lines.push(`<code>/${escapeHtml(cmd.command)}</code> — ${escapeHtml(cmd.description)}`);
    }

    lines.push("");
    lines.push("<b>💬 Cara pakai AI</b>");
    lines.push("• Chat langsung di private chat, bot otomatis membalas.");
    lines.push("• Di grup, mention bot atau reply pesan bot.");
    lines.push("• Atau pakai <code>/ai pertanyaan kamu</code>.");
    lines.push("");
    lines.push("Model aktif: <code>" + escapeHtml(config.router9.model) + "</code>");

    return lines.join("\n");
  }

  /** Label penyimpanan untuk ditampilkan di /info dan /stats. */
  function storageLabel() {
    if (config.store.driver === "redis") return `redis (${config.store.redis.prefix})`;
    return config.dbPath.split("/").slice(-2).join("/");
  }

  async function statsText() {
    const summary = await store.summary();
    return [
      "<b>📊 STATISTIK BOT</b>",
      "",
      `Uptime      : ${formatUptime(Date.now() - startedAt)}`,
      `Users       : ${formatNumber(summary.users)}`,
      `Chats       : ${formatNumber(summary.chats)}`,
      `Pesan AI    : ${formatNumber(summary.aiMessages)}`,
      `Feedback    : ${formatNumber(summary.feedback)}`,
      `Updates     : ${formatNumber(summary.stats.updates_total ?? 0)}`,
      `Sessions    : ${formatNumber(summary.sessions)}`,
      "",
      `<i>Storage: ${escapeHtml(storageLabel())}</i>`,
    ].join("\n");
  }

  register("start", {
    description: "Mulai bot & tampilkan menu utama",
    handler: async (ctx) => {
      const name = escapeHtml(displayName(ctx.from));
      const text = [
        `👋 Halo <b>${name}</b>!`,
        "",
        "Saya bot Telegram berbasis <b>grammY</b>. Saya bisa:",
        "• menjawab pertanyaan lewat AI (via 9Router lokal)",
        "• menyimpan pengaturan per chat",
        "• mencatat statistik & feedback",
        "",
        "Pilih menu di bawah, atau ketik /help untuk daftar perintah.",
      ].join("\n");

      await safeReply(ctx, text, { reply_markup: keyboards.mainMenu() });
    },
  });

  register("help", {
    aliases: ["bantuan", "h"],
    description: "Daftar semua perintah",
    handler: async (ctx) => {
      await safeReply(ctx, helpText(), { reply_markup: keyboards.backMenu() });
    },
  });

  register("menu", {
    description: "Menu utama dengan tombol",
    handler: async (ctx) => {
      await safeReply(ctx, "🏠 <b>MENU UTAMA</b>\n\nPilih salah satu:", { reply_markup: keyboards.mainMenu() });
    },
  });

  register("ping", {
    description: "Cek respons bot",
    handler: async (ctx) => {
      const sentAt = Date.now();
      const message = await ctx.reply("🏓 Pong…");
      const latency = Date.now() - sentAt;
      await safeEdit(ctx, `🏓 <b>Pong!</b>\nLatency: <code>${latency}ms</code>`);
      logger.debug(`ping latency ${latency}ms`);
      void message;
    },
  });

  register("info", {
    aliases: ["about"],
    description: "Info bot & runtime",
    handler: async (ctx) => {
      const me = ctx.me;
      const health = await app.services.router9.health().catch((error) => ({ ok: false, error: error.message }));

      const text = [
        "<b>ℹ️ INFO BOT</b>",
        "",
        `Bot        : @${escapeHtml(me.username ?? "-")} (${me.id})`,
        `Nama       : ${escapeHtml(me.first_name ?? "-")}`,
        `Uptime     : ${formatUptime(Date.now() - startedAt)}`,
        `Node       : ${escapeHtml(process.version)}`,
        `Runtime    : ${process.platform} ${process.arch}`,
        `Memory     : ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`,
        `Mode       : ${escapeHtml(`${config.mode}${config.serverless ? " (serverless)" : ""}`)}`,
        `Storage    : <code>${escapeHtml(storageLabel())}</code>`,
        "",
        "<b>🔌 9Router</b>",
        `URL        : <code>${escapeHtml(config.router9.baseUrl)}</code>`,
        `Status     : ${health.ok ? `✅ online (${health.models} model)` : `❌ ${escapeHtml(health.error ?? "tidak terjangkau")}`}`,
        `Model      : <code>${escapeHtml(config.router9.model)}</code>`,
      ].join("\n");

      await safeReply(ctx, text, { reply_markup: keyboards.backMenu() });
    },
  });

  register("id", {
    aliases: ["chatid"],
    description: "Tampilkan ID user & chat",
    handler: async (ctx) => {
      const text = [
        "<b>🆔 IDENTITAS</b>",
        "",
        `User ID : <code>${ctx.from?.id ?? "-"}</code>`,
        `Chat ID : <code>${ctx.chat?.id ?? "-"}</code>`,
        `Tipe    : ${escapeHtml(ctx.chat?.type ?? "-")}`,
        `Admin   : ${config.isAdmin(ctx.from?.id) ? "ya" : "tidak"}`,
      ].join("\n");
      await safeReply(ctx, text);
    },
  });

  // ------------------------------------------------------------- callbacks

  onCallback("menu:main", async (ctx) => {
    await safeAnswer(ctx);
    await safeEdit(ctx, "🏠 <b>MENU UTAMA</b>\n\nPilih salah satu:", { reply_markup: keyboards.mainMenu() });
  });

  onCallback("menu:ai", async (ctx) => {
    await safeAnswer(ctx);
    const model = (await store.getSetting(ctx.chat.id, "model", "")) || config.router9.model;
    const text = [
      "🤖 <b>MODE AI</b>",
      "",
      "Kirim pesan biasa dan saya akan menjawab lewat 9Router.",
      "• Private chat: otomatis dibalas",
      "• Grup: mention saya atau reply pesan saya",
      "• Satu kali: <code>/ai pertanyaan</code>",
      "",
      `🧠 Model aktif: <code>${escapeHtml(model)}</code>`,
      "Ganti model dari menu 🧠 Pilih Model.",
    ].join("\n");
    await safeEdit(ctx, text, { reply_markup: keyboards.backMenu() });
  });

  onCallback("menu:help", async (ctx) => {
    await safeAnswer(ctx);
    await safeEdit(ctx, helpText(), { reply_markup: keyboards.backMenu() });
  });

  onCallback("menu:stats", async (ctx) => {
    await safeAnswer(ctx);
    await safeEdit(ctx, await statsText(), { reply_markup: keyboards.backMenu() });
  });

  onCallback("menu:feedback", async (ctx) => {
    await safeAnswer(ctx);
    await store.bumpStat("feedback_flow_started");
    try {
      await ctx.conversation.enter("feedback");
    } catch (error) {
      logger.warn(`gagal masuk conversation feedback: ${error.message}`);
      await safeAnswer(ctx, "Selesaikan dulu percakapan yang aktif");
    }
  });

  register("feedback", {
    description: "Kirim feedback bertahap (contoh conversation)",
    handler: async (ctx) => {
      await store.bumpStat("feedback_flow_started");
      try {
        await ctx.conversation.enter("feedback");
      } catch (error) {
        logger.warn(`gagal masuk conversation feedback: ${error.message}`);
        await safeReply(ctx, "⚠️ Masih ada percakapan aktif. Selesaikan itu dulu, atau kirim /batal.");
      }
    },
  });
};
