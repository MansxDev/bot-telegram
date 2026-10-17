"use strict";

const { escapeHtml, formatNumber } = require("../utils");
const { safeReply, safeEdit, safeAnswer } = require("../telegram");
const { TOGGLE_LABELS } = require("../keyboards");

const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Pengaturan per chat (toggle AI, streaming, mention-only) + pemilih model.
 */
module.exports = function registerSettings(app, registry) {
  const { register, onCallback } = registry;
  const { config, store, keyboards, logger } = app;

  /** Cache daftar model supaya tidak spam 9Router. */
  const modelCache = { at: 0, list: [] };

  async function getModels({ force = false } = {}) {
    const fresh = Date.now() - modelCache.at < MODEL_CACHE_TTL_MS;
    if (!force && fresh && modelCache.list.length) return modelCache.list;

    const list = await app.services.router9.listModels();
    modelCache.at = Date.now();
    modelCache.list = list;
    logger.debug(`daftar model diperbarui: ${list.length} model`);
    return list;
  }

  async function currentModel(chatId) {
    return (await store.getSetting(chatId, "model", "")) || config.router9.model;
  }

  async function settingsText(chatId, settings = null) {
    const resolved = settings ?? (await store.getChatSettings(chatId));
    const on = (key) => (resolved[key] === "1" ? "aktif" : "nonaktif");

    return [
      "⚙️ <b>PENGATURAN CHAT</b>",
      "",
      `🧠 Model          : <code>${escapeHtml(await currentModel(chatId))}</code>`,
      `🤖 AI auto-reply  : ${on("ai_enabled")}`,
      `📡 Streaming      : ${on("ai_stream")}`,
      `👥 Grup mention   : ${on("group_mention_only")}`,
      "",
      `<i>Tombol ✅/❌ untuk mengubah. Tersimpan per chat di ${escapeHtml(config.store.driver)}.</i>`,
    ].join("\n");
  }

  async function modelText(chatId, total) {
    return [
      "🧠 <b>PILIH MODEL</b>",
      "",
      `Model aktif : <code>${escapeHtml(await currentModel(chatId))}</code>`,
      `Tersedia    : ${formatNumber(total)} model`,
      "",
      "<i>Daftar diambil dari 9Router GET /v1/models.</i>",
    ].join("\n");
  }

  async function showSettings(ctx) {
    const chatId = ctx.chat.id;
    // Satu kali baca untuk teks + tombol (hemat round-trip, terutama di Redis).
    const settings = await store.getChatSettings(chatId);
    await safeEdit(ctx, await settingsText(chatId, settings), {
      reply_markup: keyboards.settingsMenu(settings),
    });
  }

  async function showModels(ctx, page = 0, force = false) {
    const chatId = ctx.chat.id;

    let models;
    try {
      models = await getModels({ force });
    } catch (error) {
      logger.error("gagal ambil daftar model:", error.message);
      await safeEdit(ctx, `⚠️ Gagal mengambil daftar model.\n\n<code>${escapeHtml(error.message)}</code>`, {
        reply_markup: keyboards.backMenu("menu:settings"),
      });
      return;
    }

    if (models.length === 0) {
      await safeEdit(ctx, "⚠️ 9Router tidak mengembalikan model apa pun.", {
        reply_markup: keyboards.backMenu("menu:settings"),
      });
      return;
    }

    await safeEdit(ctx, await modelText(chatId, models.length), {
      reply_markup: keyboards.modelMenu(models, { page, current: await currentModel(chatId) }),
    });
  }

  // --------------------------------------------------------------- commands

  register("settings", {
    aliases: ["pengaturan", "preferensi"],
    description: "Pengaturan bot untuk chat ini",
    handler: async (ctx) => {
      const chatId = ctx.chat.id;
      const settings = await store.getChatSettings(chatId);
      await safeReply(ctx, await settingsText(chatId, settings), {
        reply_markup: keyboards.settingsMenu(settings),
      });
    },
  });

  register("model", {
    aliases: ["models"],
    description: "Pilih model AI dari 9Router",
    handler: async (ctx) => {
      let models;
      try {
        models = await getModels();
      } catch (error) {
        await safeReply(ctx, `⚠️ Gagal mengambil daftar model.\n\n<code>${escapeHtml(error.message)}</code>`);
        return;
      }

      await safeReply(ctx, await modelText(ctx.chat.id, models.length), {
        reply_markup: keyboards.modelMenu(models, { page: 0, current: await currentModel(ctx.chat.id) }),
      });
    },
  });

  // -------------------------------------------------------------- callbacks

  onCallback("menu:settings", async (ctx) => {
    await safeAnswer(ctx);
    await showSettings(ctx);
  });

  onCallback(/^settings:toggle:(\w+)$/, async (ctx) => {
    const key = ctx.match[1];
    if (!(key in TOGGLE_LABELS)) {
      await safeAnswer(ctx, "Pengaturan tidak dikenal");
      return;
    }

    const next = await store.toggleSetting(ctx.chat.id, key);
    await store.bumpStat("settings_changes");
    logger.debug(`chat ${ctx.chat.id}: ${key} -> ${next}`);

    await safeAnswer(ctx, `${TOGGLE_LABELS[key]}: ${next === "1" ? "aktif" : "nonaktif"}`);
    await showSettings(ctx);
  });

  onCallback("settings:model", async (ctx) => {
    await safeAnswer(ctx);
    await showModels(ctx, 0);
  });

  onCallback(/^settings:model:page:(\d+)$/, async (ctx) => {
    await safeAnswer(ctx);
    await showModels(ctx, Number(ctx.match[1]));
  });

  onCallback("settings:model:reload", async (ctx) => {
    await safeAnswer(ctx, "Memuat ulang…");
    await showModels(ctx, 0, true);
  });

  onCallback("settings:model:noop", async (ctx) => {
    await safeAnswer(ctx);
  });

  onCallback(/^settings:model:set:(.+)$/, async (ctx) => {
    const model = ctx.match[1];
    await store.setSetting(ctx.chat.id, "model", model);
    await store.bumpStat("model_changes");
    await safeAnswer(ctx, `Model: ${model}`);
    await showModels(ctx, 0);
  });

  onCallback("settings:reset", async (ctx) => {
    await store.resetChatSettings(ctx.chat.id);
    await safeAnswer(ctx, "Pengaturan direset");
    await showSettings(ctx);
  });

  onCallback("settings:clearhistory", async (ctx) => {
    const removed = await store.clearAiHistory(ctx.chat.id);
    await safeAnswer(ctx, `${removed} pesan dihapus`);
    await showSettings(ctx);
  });
};
