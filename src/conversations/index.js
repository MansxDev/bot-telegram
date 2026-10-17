"use strict";

const { createConversation } = require("@grammyjs/conversations");

const feedbackConversation = require("./feedback");
const echoConversation = require("./echo");

/** Daftar conversation yang dipasang ke bot (urutan tidak penting). */
function buildConversations(app) {
  return [
    createConversation(feedbackConversation(app), "feedback"),
    createConversation(echoConversation(app), "echo"),
  ];
}

/**
 * Command yang membuka conversation.
 * Dipisah dari handlers/ supaya bagian conversation tetap satu tempat.
 */
function registerConversationCommands(app, registry) {
  const { safeReply } = require("../telegram");

  registry.register("echo", {
    description: "Demo conversation loop (echo)",
    handler: async (ctx) => {
      try {
        await ctx.conversation.enter("echo");
      } catch (error) {
        app.logger.warn(`gagal masuk conversation echo: ${error.message}`);
        await safeReply(ctx, "⚠️ Masih ada percakapan aktif. Kirim /batal dulu.");
      }
    },
  });
}

module.exports = { buildConversations, registerConversationCommands };
