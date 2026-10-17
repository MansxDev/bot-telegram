"use strict";

const { escapeHtml, chunkText, isCommand, truncate, formatNumber } = require("../utils");
const { safeReply, safeEditMessage, safeChatAction } = require("../telegram");
const { describeAiError } = require("../services/router9");

/**
 * Fitur AI: /ai, /reset, dan auto-reply untuk chat biasa (streaming via 9Router).
 *
 * Catatan serverless (Vercel): function dibatasi waktu (maks 60s di plan Hobby),
 * jadi balasan dibatasi `AI_TIME_BUDGET_MS`. Kalau 9Router tidak terjangkau,
 * bot membalas dengan pesan ramah dan command lain tetap normal.
 */
module.exports = function registerAi(app, registry) {
  const { register, onText } = registry;
  const { config, store, logger } = app;

  const PLACEHOLDER = config.ai.placeholder;

  /** Susun daftar pesan untuk API dari system prompt + riwayat + pesan baru. */
  async function buildMessages(chatId, prompt) {
    const history = await store.getAiHistory(chatId, config.ai.contextMessages);
    return [
      { role: "system", content: config.ai.systemPrompt },
      ...history
        .filter((item) => item.role === "user" || item.role === "assistant")
        .map((item) => ({ role: item.role, content: item.content })),
      { role: "user", content: prompt },
    ];
  }

  async function resolveModel(chatId) {
    return (await store.getSetting(chatId, "model", "")) || config.router9.model;
  }

  /** Kirim balasan panjang: edit bagian pertama, sisanya sebagai pesan baru. */
  async function deliverLong(ctx, chatId, messageId, text) {
    const parts = chunkText(text);
    await safeEditMessage(ctx.api, chatId, messageId, parts[0]);
    for (const extra of parts.slice(1)) {
      await ctx.reply(extra, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    }
  }

  /** Sisa waktu yang boleh dipakai AI (0 = tanpa batas). */
  function budgetSignal(startedAt) {
    if (!config.ai.timeBudgetMs) return undefined;
    const left = config.ai.timeBudgetMs - (Date.now() - startedAt);
    return left > 0 ? AbortSignal.timeout(left) : AbortSignal.timeout(1);
  }

  /**
   * Jalankan satu putaran chat AI.
   * @param {*} ctx
   * @param {string} prompt
   * @param {{ stream?: boolean }} [options]
   */
  async function runAi(ctx, prompt, options = {}) {
    const chatId = ctx.chat.id;
    const userId = ctx.from?.id ?? null;

    if (!config.ai.enabled) {
      await safeReply(ctx, "🤖 Fitur AI dimatikan oleh admin (AI_ENABLED=false).");
      return;
    }

    if (!prompt.trim()) {
      await safeReply(ctx, "⚠️ Pertanyaannya kosong. Contoh: <code>/ai jelaskan apa itu SQLite</code>");
      return;
    }

    if (prompt.length > 4000) {
      await safeReply(ctx, "⚠️ Pertanyaannya terlalu panjang (maksimal 4000 karakter).");
      return;
    }

    const model = await resolveModel(chatId);
    const settings = await store.getChatSettings(chatId);
    const useStream = options.stream ?? (config.ai.stream && settings.ai_stream === "1");

    await store.addAiMessage({ chatId, userId, role: "user", content: prompt, model });
    await store.bumpStat("ai_requests");

    if (ctx.session) {
      ctx.session.aiCount = (ctx.session.aiCount ?? 0) + 1;
      ctx.session.lastPromptAt = Date.now();
    }

    const messages = await buildMessages(chatId, prompt);
    const startedAt = Date.now();

    let placeholder = null;

    try {
      let answer;

      if (useStream) {
        await safeChatAction(ctx, "typing");
        placeholder = await ctx.reply(PLACEHOLDER, { parse_mode: "HTML" });

        let buffer = "";
        let lastEditAt = 0;
        let lastShown = "";
        let truncatedByBudget = false;

        try {
          for await (const delta of app.services.router9.chatStream({
            model,
            messages,
            temperature: config.ai.temperature,
            maxTokens: config.ai.maxTokens,
            signal: budgetSignal(startedAt),
          })) {
            buffer += delta;

            if (config.ai.timeBudgetMs && Date.now() - startedAt > config.ai.timeBudgetMs) {
              truncatedByBudget = true;
              break;
            }

            const now = Date.now();
            if (now - lastEditAt < config.ai.editIntervalMs) continue;

            const shown = truncate(buffer, 3900, "") + " ▍";
            if (shown === lastShown) continue;

            await safeEditMessage(ctx.api, chatId, placeholder.message_id, shown);
            lastShown = shown;
            lastEditAt = now;
          }
        } catch (error) {
          if (!buffer.trim()) throw error;
          buffer += `\n\n⚠️ <i>Streaming terputus: ${escapeHtml(error.message)}</i>`;
        }

        if (truncatedByBudget) {
          buffer += "\n\n⏱️ <i>Jawaban dipotong karena batas waktu server.</i>";
        }

        answer = buffer.trim() || "(model tidak mengembalikan teks)";
        await deliverLong(ctx, chatId, placeholder.message_id, answer);
      } else {
        await safeChatAction(ctx, "typing");
        const result = await app.services.router9.chat({
          model,
          messages,
          temperature: config.ai.temperature,
          maxTokens: config.ai.maxTokens,
          signal: budgetSignal(startedAt),
        });
        answer = result.content.trim();
        await safeReply(ctx, answer);
      }

      const elapsed = Date.now() - startedAt;

      await store.addAiMessage({ chatId, userId, role: "assistant", content: answer, model });
      await store.trimAiHistory(chatId, config.ai.historyLimit);
      await store.bumpStat("ai_success");
      await store.bumpStat("ai_latency_ms", elapsed);

      logger.debug(`AI jawab chat ${chatId} via ${model} dalam ${elapsed}ms (${answer.length} char)`);
    } catch (error) {
      await store.bumpStat("ai_failures");
      logger.error(`AI gagal untuk chat ${chatId}: ${error.message}`);

      const text = describeAiError(error, {
        baseUrl: config.router9.baseUrl,
        serverless: config.serverless,
      });

      // Kalau placeholder sudah tampil, ubah placeholder-nya jadi pesan error
      // supaya user tidak melihat "sedang berpikir…" menggantung.
      if (placeholder) {
        await safeEditMessage(ctx.api, chatId, placeholder.message_id, text).catch(() => {});
      } else {
        await safeReply(ctx, text).catch(() => {});
      }
    }
  }

  // --------------------------------------------------------------- commands

  register("ai", {
    aliases: ["ask", "tanya"],
    description: "Tanya AI sekali (via 9Router)",
    handler: async (ctx) => {
      const prompt = ctx.match?.trim() ?? "";
      if (!prompt) {
        await safeReply(
          ctx,
          [
            "🤖 <b>MODE AI</b>",
            "",
            "Pakai: <code>/ai pertanyaan kamu</code>",
            "Contoh: <code>/ai buatkan 3 ide caption IG untuk UMKM kuliner</code>",
            "",
            "Atau kirim chat biasa dan saya balas otomatis.",
          ].join("\n"),
        );
        return;
      }

      await runAi(ctx, prompt);
    },
  });

  register("reset", {
    aliases: ["clear", "aireset", "hapusriwayat"],
    description: "Hapus riwayat percakapan AI di chat ini",
    handler: async (ctx) => {
      const removed = await store.clearAiHistory(ctx.chat.id);
      await safeReply(ctx, `🗑️ Riwayat AI dihapus (${formatNumber(removed)} pesan).`);
    },
  });

  register("history", {
    aliases: ["riwayat"],
    description: "Lihat ringkasan riwayat AI terakhir",
    hidden: true,
    handler: async (ctx) => {
      const history = await store.getAiHistory(ctx.chat.id, config.ai.contextMessages);
      if (history.length === 0) {
        await safeReply(ctx, "📭 Belum ada riwayat AI di chat ini.");
        return;
      }

      const lines = ["<b>🧾 RIWAYAT AI</b>", `(${history.length} pesan terakhir)`, ""];
      for (const item of history) {
        const icon = item.role === "user" ? "🧑" : "🤖";
        lines.push(`${icon} ${escapeHtml(truncate(item.content.replace(/\s+/g, " "), 120))}`);
      }
      lines.push("");
      lines.push(`Session ini: ${formatNumber(ctx.session?.aiCount ?? 0)} permintaan AI`);
      lines.push("Hapus dengan /reset");

      await safeReply(ctx, lines.join("\n"));
    },
  });

  // ------------------------------------------------------- auto-reply teks

  onText(/^[\s\S]+$/, async (ctx) => {
    const message = ctx.message;
    if (!message) return;
    if (ctx.from?.is_bot) return;
    if (ctx.chat?.type === "channel") return;
    if (isCommand(ctx)) return;
    if (!config.ai.enabled) return;

    const settings = await store.getChatSettings(ctx.chat.id);
    if (settings.ai_enabled !== "1") return;

    const text = (message.text ?? message.caption ?? "").trim();
    if (!text) return;

    if (ctx.chat.type !== "private" && settings.group_mention_only === "1") {
      const me = ctx.me;
      const repliedToBot = message.reply_to_message?.from?.id === me.id;
      const mentioned = me.username ? text.includes(`@${me.username}`) : false;
      const entities = message.entities ?? message.caption_entities ?? [];
      const textMention = entities.some((entity) => entity.type === "text_mention" && entity.user?.id === me.id);

      if (!repliedToBot && !mentioned && !textMention) return;
    }

    const cleaned = ctx.me.username ? text.replace(new RegExp(`@${ctx.me.username}\\b`, "gi"), "").trim() : text;
    await runAi(ctx, cleaned || text);
  });
};
