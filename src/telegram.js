"use strict";

const { chunkText, TELEGRAM_TEXT_LIMIT } = require("./utils");

const DEFAULT_EXTRA = { parse_mode: "HTML", link_preview_options: { is_disabled: true } };

function isNotModified(error) {
  const description = error?.description ?? error?.message ?? "";
  return typeof description === "string" && description.includes("message is not modified");
}

function isFloodWait(error) {
  return error?.error_code === 429 || Boolean(error?.parameters?.retry_after);
}

function mergeExtra(extra) {
  return { ...DEFAULT_EXTRA, ...(extra ?? {}) };
}

/**
 * Balas pesan; otomatis dipecah bila melebihi batas Telegram.
 * Mengembalikan array pesan terkirim (grammY Message objects).
 */
async function safeReply(ctx, text, extra) {
  const parts = chunkText(String(text ?? ""), TELEGRAM_TEXT_LIMIT);
  const sent = [];
  for (const part of parts) {
    sent.push(await ctx.reply(part, mergeExtra(extra)));
  }
  return sent;
}

/** Balas pesan sambil menampilkan indikator "typing". */
async function replyWithTyping(ctx, text, extra) {
  await safeChatAction(ctx, "typing");
  return safeReply(ctx, text, extra);
}

/**
 * Edit pesan dengan aman: abaikan "message is not modified",
 * dan hormati retry_after bila kena rate limit.
 */
async function safeEdit(ctx, text, extra) {
  const payload = mergeExtra(extra);
  const content = String(text ?? "").slice(0, TELEGRAM_TEXT_LIMIT);

  try {
    return await ctx.editMessageText(content, payload);
  } catch (error) {
    if (isNotModified(error)) return null;
    if (isFloodWait(error)) {
      const delay = Number(error?.parameters?.retry_after ?? 2);
      await new Promise((resolve) => setTimeout(resolve, (delay + 0.5) * 1000));
      try {
        return await ctx.editMessageText(content, payload);
      } catch (retryError) {
        if (isNotModified(retryError)) return null;
        throw retryError;
      }
    }
    throw error;
  }
}

/** Edit pesan berdasarkan chat_id + message_id (dipakai saat streaming). */
async function safeEditMessage(api, chatId, messageId, text, extra) {
  try {
    return await api.editMessageText(chatId, messageId, String(text ?? "").slice(0, TELEGRAM_TEXT_LIMIT), mergeExtra(extra));
  } catch (error) {
    if (isNotModified(error)) return null;
    throw error;
  }
}

/** answerCallbackQuery yang tidak melempar (spinner user tidak menggantung). */
async function safeAnswer(ctx, text, extra) {
  try {
    if (text !== undefined) return await ctx.answerCallbackQuery({ text: String(text).slice(0, 190), ...(extra ?? {}) });
    return await ctx.answerCallbackQuery(extra);
  } catch {
    return null;
  }
}

/** Kirim chat action (typing/upload_photo) tanpa melempar. */
async function safeChatAction(ctx, action = "typing") {
  try {
    await ctx.replyWithChatAction(action);
  } catch {
    // indikator tidak kritikal
  }
}

/** Tampilkan pesan error yang ramah ke user. */
async function replyError(ctx, error) {
  const message =
    error?.name === "Router9Error"
      ? `⚠️ ${error.message}`
      : "⚠️ Terjadi kesalahan saat memproses permintaanmu. Coba lagi sebentar lagi.";
  try {
    return await safeReply(ctx, message);
  } catch {
    return null;
  }
}

module.exports = {
  DEFAULT_EXTRA,
  safeReply,
  replyWithTyping,
  safeEdit,
  safeEditMessage,
  safeAnswer,
  safeChatAction,
  replyError,
  isNotModified,
  isFloodWait,
};
