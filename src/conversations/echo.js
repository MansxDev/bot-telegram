"use strict";

const { escapeHtml } = require("../utils");
const { safeAnswer } = require("../telegram");

/**
 * Conversation demo loop: mengulang teks user sampai ditekan tombol selesai.
 * Menunjukkan pemakaian loop + tombol inline di dalam conversation.
 *
 * Catatan: di dalam conversation, grammY membuat instance `Api` baru dari token,
 * jadi transformer `bot.api.config.use()` (mis. auto-retry) tidak ikut berlaku.
 */
module.exports = function echoConversation(app) {
  const { keyboards } = app;

  return async function echo(conversation, ctx) {
    await ctx.reply(
      ["🔁 <b>MODE ECHO</b>", "", "Kirim teks apa pun, saya ulangi.", "Tekan ⏹️ Selesai atau kirim /selesai untuk keluar."].join("\n"),
      { parse_mode: "HTML", reply_markup: keyboards.stopMenu("echo:stop") },
    );

    let count = 0;

    while (true) {
      const next = await conversation.wait();

      if (next.callbackQuery?.data === "echo:stop") {
        await safeAnswer(next, "Selesai");
        await next.reply(`✅ Selesai. ${count} pesan di-echo.`);
        return;
      }

      const text = next.message?.text?.trim();

      if (!text) {
        await next.reply("Kirim teks ya, bukan media (atau /selesai).");
        continue;
      }

      if (text === "/selesai" || text === "/batal" || text === "/stop") {
        await next.reply(`✅ Selesai. ${count} pesan di-echo.`);
        return;
      }

      count += 1;
      await next.reply(`🔁 <b>${count}.</b> ${escapeHtml(text)}`, { parse_mode: "HTML" });
    }
  };
};
