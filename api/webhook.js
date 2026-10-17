"use strict";

/**
 * Vercel serverless function: endpoint webhook Telegram.
 *
 * Alur:
 *   1. Telegram POST update ke https://<project>.vercel.app/api/webhook
 *   2. fungsi ini mengambil runtime (bot + store Redis) — di-cache per instance
 *   3. grammY memverifikasi header secret lalu memproses update
 *
 * Karena serverless tidak punya proses panjang, mode ini WAJIB memakai webhook
 * (bukan long polling) dan store Redis (bukan SQLite).
 */

const { getRuntime } = require("../src/runtime");

module.exports = async function handler(req, res) {
  // Health check sederhana: GET /api/webhook
  if (req.method !== "POST") {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, service: "bot-telegram", mode: "webhook" }));
    return;
  }

  try {
    const runtime = await getRuntime();
    await runtime.handleWebhook(req, res);
  } catch (error) {
    const message = error?.message ?? String(error);
    console.error(`[api/webhook] gagal: ${message}`);

    // Balas 200 supaya Telegram tidak mengulang update yang sama terus-menerus,
    // tapi sertakan detail agar mudah dicek dari log Vercel.
    if (!res.writableEnded) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: false, error: message }));
    }
  }
};
