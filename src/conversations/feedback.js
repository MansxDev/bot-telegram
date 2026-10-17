"use strict";

const { escapeHtml, truncate, formatDateTime } = require("../utils");
const { safeAnswer } = require("../telegram");

/**
 * Conversation bertahap: rating (inline keyboard) -> komentar (teks) -> konfirmasi.
 * Menunjukkan pemakaian `conversation.wait()`, `conversation.external()`, dan
 * penyimpanan state lewat storage adapter conversations (SQLite atau Redis).
 *
 * PENTING: isi conversation dijalankan ULANG (replay) dari awal pada setiap update,
 * jadi efek samping seperti menulis DB/statistik hanya boleh lewat
 * `conversation.external()` — kalau tidak, statistik akan terhitung berkali-kali.
 * Statistik "feedback_flow_started" karena itu dinaikkan di command handler.
 */
module.exports = function feedbackConversation(app) {
  const { keyboards, store, logger } = app;

  return async function feedback(conversation, ctx) {
    const chatId = ctx.chat.id;
    const userId = ctx.from?.id ?? null;

    // ---------------------------------------------------- langkah 1: rating
    await ctx.reply(
      [
        "📝 <b>FEEDBACK</b>",
        "",
        "Seberapa puas kamu dengan bot ini?",
        "Pilih rating di bawah, atau kirim /batal untuk keluar.",
      ].join("\n"),
      { parse_mode: "HTML", reply_markup: keyboards.feedbackRatingMenu() },
    );

    let rating = null;

    while (rating === null) {
      const next = await conversation.wait();

      if (next.callbackQuery?.data === "fb:cancel" || next.message?.text === "/batal") {
        await safeAnswer(next, "Dibatalkan");
        await next.reply("❌ Feedback dibatalkan.").catch(() => {});
        logger.debug(`feedback dibatalkan oleh ${userId} di chat ${chatId}`);
        return;
      }

      const match = /^fb:rate:(\d+)$/.exec(next.callbackQuery?.data ?? "");
      if (!match) {
        await next.reply("Pilih rating lewat tombol di atas ya, atau kirim /batal.").catch(() => {});
        continue;
      }

      rating = Math.min(5, Math.max(1, Number(match[1])));
      await safeAnswer(next, `Rating ${rating}/5 diterima`);
      await next.editMessageText(`📝 Rating kamu: ${"⭐".repeat(rating)}`).catch(() => {});
    }

    // -------------------------------------------------- langkah 2: komentar
    await ctx.reply("✍️ Tulis komentar atau saran (minimal 3 karakter), atau /batal:");

    let comment = null;

    while (comment === null) {
      const next = await conversation.waitFor("message:text");
      const text = next.message.text.trim();

      if (text === "/batal") {
        await next.reply("❌ Feedback dibatalkan.");
        return;
      }

      if (text.length < 3) {
        await next.reply("Komentarnya terlalu pendek, coba lagi ya (atau /batal).");
        continue;
      }

      comment = truncate(text, 1000, "");
    }

    // ------------------------------------------------- langkah 3: konfirmasi
    const preview = [
      "🔎 <b>KONFIRMASI</b>",
      "",
      `Rating  : ${"⭐".repeat(rating)} (${rating}/5)`,
      `Komentar: ${escapeHtml(truncate(comment, 300))}`,
      "",
      "Simpan feedback ini?",
    ].join("\n");

    await ctx.reply(preview, { parse_mode: "HTML", reply_markup: keyboards.confirmMenu("fb:yes", "fb:no") });

    let confirmed = null;

    while (confirmed === null) {
      const next = await conversation.wait();

      if (next.message?.text === "/batal") {
        await next.reply("❌ Feedback dibatalkan.");
        return;
      }

      const data = next.callbackQuery?.data ?? "";
      if (data === "fb:no") {
        await safeAnswer(next, "Tidak disimpan");
        await next.editMessageText("❌ Feedback tidak disimpan.").catch(() => {});
        return;
      }

      if (data !== "fb:yes") {
        await next.reply("Tekan ✅ Ya untuk menyimpan, atau ❌ Tidak.").catch(() => {});
        continue;
      }

      confirmed = true;
      await safeAnswer(next, "Tersimpan!");
      await next.editMessageText("✅ Feedback tersimpan. Terima kasih!").catch(() => {});
    }

    // ------------------------------------------- efek samping: hanya di sini
    await conversation.external(async () => {
      await store.addFeedback({ chatId, userId, rating, comment });
      await store.bumpStat("feedback_saved");
      logger.info(`feedback baru dari ${userId}: ${rating}/5`);
    });

    await ctx.reply(
      [
        "🙏 <b>Terima kasih!</b>",
        "",
        `Rating   : ${"⭐".repeat(rating)}`,
        `Dikirim  : ${formatDateTime(new Date().toISOString())}`,
        "",
        "Masukanmu membantu bot ini jadi lebih baik.",
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  };
};
