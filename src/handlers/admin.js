"use strict";

const { escapeHtml, formatUptime, formatNumber, formatDateTime, sleep, truncate } = require("../utils");
const { safeReply, safeChatAction } = require("../telegram");

/**
 * Command khusus admin (ADMIN_IDS di .env): /stats, /broadcast, /feedbacklist, /health.
 */
module.exports = function registerAdmin(app, registry) {
  const { register } = registry;
  const { config, store, logger } = app;
  const startedAt = app.startedAt ?? Date.now();

  register("stats", {
    description: "Statistik lengkap bot (admin)",
    admin: true,
    handler: async (ctx) => {
      const summary = await store.summary();
      const stats = Object.entries(summary.stats).sort((a, b) => b[1] - a[1]);

      const lines = [
        "<b>📈 STATISTIK BOT (ADMIN)</b>",
        "",
        `Uptime        : ${formatUptime(Date.now() - startedAt)}`,
        `Users         : ${formatNumber(summary.users)}`,
        `Chats         : ${formatNumber(summary.chats)}`,
        `Pesan AI      : ${formatNumber(summary.aiMessages)}`,
        `Feedback      : ${formatNumber(summary.feedback)}`,
        `Session aktif : ${formatNumber(summary.sessions)}`,
        `Conversation  : ${formatNumber(summary.conversations)}`,
        "",
        "<b>Counter</b>",
      ];

      for (const [key, value] of stats.slice(0, 15)) {
        lines.push(`• <code>${escapeHtml(key)}</code> = ${formatNumber(value)}`);
      }

      if (stats.length === 0) lines.push("<i>belum ada data</i>");

      const aiRequests = await store.getStat("ai_requests");
      const aiLatency = await store.getStat("ai_latency_ms");
      if (aiRequests > 0) {
        lines.push("");
        lines.push(`Rata-rata latency AI: <b>${Math.round(aiLatency / aiRequests)}ms</b>`);
      }

      const broadcasts = await store.listBroadcasts(3);
      if (broadcasts.length) {
        lines.push("", "<b>Broadcast terakhir</b>");
        for (const item of broadcasts) {
          lines.push(
            `• ${formatDateTime(item.created_at)} — ✅${item.sent} ❌${item.failed}: ${escapeHtml(truncate(item.text, 40))}`,
          );
        }
      }

      await safeReply(ctx, lines.join("\n"));
    },
  });

  register("feedbacklist", {
    aliases: ["fb"],
    description: "Feedback terakhir dari user (admin)",
    admin: true,
    handler: async (ctx) => {
      const rows = await store.listFeedback(10);
      if (rows.length === 0) {
        await safeReply(ctx, "📭 Belum ada feedback.");
        return;
      }

      const lines = ["<b>📝 FEEDBACK TERAKHIR</b>", ""];
      for (const row of rows) {
        lines.push(`⭐${row.rating}/5 — ${formatDateTime(row.created_at)}`);
        lines.push(`   ${escapeHtml(truncate(row.comment || "(tanpa komentar)", 120))}`);
      }

      await safeReply(ctx, lines.join("\n"));
    },
  });

  register("health", {
    description: "Cek koneksi 9Router & database (admin)",
    admin: true,
    handler: async (ctx) => {
      const health = await app.services.router9.health().catch((error) => ({ ok: false, error: error.message }));
      const summary = await store.summary();

      const lines = [
        "<b>🩺 HEALTH CHECK</b>",
        "",
        `Mode      : ${escapeHtml(config.mode)}${config.serverless ? " (serverless)" : ""}`,
        `9Router   : ${health.ok ? `✅ online — ${health.models} model` : `❌ ${escapeHtml(health.error ?? "tidak terjangkau")}`}`,
        `Base URL  : <code>${escapeHtml(config.router9.baseUrl)}</code>`,
        `API key   : ${config.router9.apiKey ? "✅ terisi" : "❌ kosong"}`,
        `Model     : <code>${escapeHtml(config.router9.model)}</code>`,
        "",
        `Storage   : <code>${escapeHtml(config.store.driver === "redis" ? `redis ${config.store.redis.prefix}` : config.dbPath)}</code>`,
        `Users     : ${formatNumber(summary.users)} | Chats: ${formatNumber(summary.chats)}`,
        `Node      : ${escapeHtml(process.version)}`,
        `RSS       : ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`,
      ].join("\n");

      await safeReply(ctx, lines);
    },
  });

  register("broadcast", {
    aliases: ["bc"],
    description: "Kirim pesan ke semua chat (admin)",
    admin: true,
    handler: async (ctx) => {
      const text = ctx.match?.trim() ?? "";
      if (!text) {
        await safeReply(ctx, "Pakai: <code>/broadcast teks pesan</code>");
        return;
      }

      const chatIds = await store.listChatIds(config.limits.maxBroadcastRecipients);
      if (chatIds.length === 0) {
        await safeReply(ctx, "📭 Belum ada chat yang tercatat.");
        return;
      }

      const status = await ctx.reply(`📣 Mengirim broadcast ke ${chatIds.length} chat…`);
      await safeChatAction(ctx, "typing");

      let sent = 0;
      let failed = 0;

      for (const chatId of chatIds) {
        try {
          await ctx.api.sendMessage(chatId, text, {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
          });
          sent += 1;
        } catch (error) {
          failed += 1;
          logger.debug(`broadcast gagal ke ${chatId}: ${error.message}`);
        }
        await sleep(config.limits.broadcastDelayMs);
      }

      await store.recordBroadcast({ adminId: ctx.from.id, text, sent, failed });
      await store.bumpStat("broadcasts_total");

      await ctx.api.editMessageText(
        ctx.chat.id,
        status.message_id,
        [`✅ <b>Broadcast selesai</b>`, "", `Terkirim : ${sent}`, `Gagal    : ${failed}`, `Total    : ${chatIds.length}`].join("\n"),
        { parse_mode: "HTML" },
      );
    },
  });
};
