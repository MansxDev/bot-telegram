"use strict";

const { summarizeUpdate, updateTypeOf } = require("../utils");

/**
 * Middleware global:
 *  1. catat user & chat ke store
 *  2. hitung statistik update
 *  3. log ringkas tiap update
 *
 * Penulisan digabung dalam satu panggilan `recordUpdate()` supaya driver Redis
 * (HTTP) hanya perlu SATU round-trip per update — penting untuk serverless.
 */
function createTrackingMiddleware(app) {
  const { store, logger } = app;

  return async function tracking(ctx, next) {
    const started = Date.now();
    const kind = updateTypeOf(ctx);

    try {
      const stats = [
        ["updates_total", 1],
        [`update_${kind}`, 1],
      ];
      if (ctx.message) stats.push(["messages_total", 1]);
      if (ctx.callbackQuery) stats.push(["callbacks_total", 1]);

      await store.recordUpdate({ user: ctx.from, chat: ctx.chat, stats });
    } catch (error) {
      logger.error("gagal menyimpan data update:", error.message);
    }

    logger.debug(`← ${summarizeUpdate(ctx)}`);

    await next();

    logger.debug(`→ ${kind} selesai dalam ${Date.now() - started}ms`);
  };
}

module.exports = { createTrackingMiddleware };
