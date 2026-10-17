#!/usr/bin/env node
"use strict";

/**
 * CLI untuk mengatur webhook Telegram dari terminal (tanpa deploy ulang).
 *
 *   node scripts/set-webhook.cjs status
 *   node scripts/set-webhook.cjs set https://bot-telegram.vercel.app
 *   node scripts/set-webhook.cjs set            # pakai PUBLIC_URL dari .env
 *   node scripts/set-webhook.cjs delete
 *
 * Catatan: webhook dan long polling saling meniadakan. Kalau webhook aktif,
 * `npm start` (polling) tidak akan menerima update apa pun.
 * Pakai `delete` sebelum kembali menjalankan bot secara lokal.
 */

const { Api } = require("grammy");
const { loadEnv, buildConfig, validateConfig, configWarnings } = require("../src/config");
const { registerWebhook } = require("../src/webhook");

function printWebhookInfo(info) {
  const lines = [
    `URL             : ${info.url || "(belum diset)"}`,
    `Pending updates : ${info.pending_update_count ?? 0}`,
    `Allowed updates : ${info.allowed_updates?.join(", ") || "(semua)"}`,
  ];

  if (info.last_error_date) {
    const when = new Date(info.last_error_date * 1000).toISOString();
    lines.push(`Error terakhir  : ${when} — ${info.last_error_message ?? "-"}`);
  }

  console.log(lines.join("\n"));
}

async function main() {
  loadEnv();

  const [command = "status", target] = process.argv.slice(2);
  const config = buildConfig();

  const problems = validateConfig(config);
  if (!config.botToken) {
    console.error("✗ BOT_TOKEN belum diisi di .env");
    process.exit(1);
  }

  // Untuk `set`, only perlu token + secret; masalah store tidak relevan di sini.
  const blocking = problems.filter((item) => !item.includes("WEBHOOK_SECRET") && !item.includes("STORE_DRIVER") && !item.includes("REDIS"));
  if (blocking.length > 0) {
    for (const problem of blocking) console.error(`✗ ${problem}`);
    process.exit(1);
  }

  for (const warning of configWarnings(config)) console.log(`! ${warning}`);

  const api = new Api(config.botToken);
  const me = await api.getMe();
  console.log(`Bot: @${me.username} (${me.id})\n`);

  if (command === "status") {
    printWebhookInfo(await api.getWebhookInfo());
    return;
  }

  if (command === "delete") {
    await api.deleteWebhook({ drop_pending_updates: true });
    console.log("✓ Webhook dihapus. Bot bisa kembali long polling (npm start).");
    return;
  }

  if (command === "set") {
    const base = String(target ?? config.webhook.publicUrl ?? "").replace(/\/+$/, "");
    if (!/^https:\/\//i.test(base)) {
      console.error("✗ Butuh URL https publik, mis: node scripts/set-webhook.cjs set https://bot-telegram.vercel.app");
      process.exit(1);
    }

    if (!config.webhook.secret) {
      console.error("✗ WEBHOOK_SECRET belum diisi di .env — isi dulu (openssl rand -hex 24).");
      process.exit(1);
    }

    const endpoint = `${base}/api/webhook`;
    const info = await registerWebhook(api, endpoint, config);

    console.log(`✓ Webhook terdaftar: ${info.url}`);
    console.log(`  allowed_updates : ${info.allowedUpdates.join(", ")}`);
    console.log(`  drop_pending    : ${info.dropPending}`);
    console.log("");
    printWebhookInfo(await api.getWebhookInfo());
    return;
  }

  console.error(`Perintah tidak dikenal: ${command}\nPakai: status | set <url> | delete`);
  process.exit(1);
}

main().catch((error) => {
  console.error(`✗ Gagal: ${error.message}`);
  process.exit(1);
});
