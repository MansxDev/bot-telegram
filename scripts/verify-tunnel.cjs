#!/usr/bin/env node
"use strict";

/**
 * Verifikasi 9Router lewat URL publik (Cloudflare Tunnel) memakai klien asli bot.
 * Jalankan: node --env-file=.env scripts/verify-tunnel.cjs <url>
 */

const { Router9 } = require("../src/services/router9");

const baseUrl = process.argv[2] || process.env.NINEROUTER_URL;

(async () => {
  console.log(`base: ${baseUrl}`);
  const router = new Router9({
    baseUrl,
    apiKey: process.env.NINEROUTER_API_KEY,
    model: process.env.NINEROUTER_MODEL || "gh/gpt-4o-mini",
    maxRetries: 0,
    timeoutMs: 45_000,
  });

  const health = await router.health();
  console.log(`health: ok=${health.ok} models=${health.models}${health.error ? ` error=${health.error}` : ""}`);
  if (!health.ok) process.exit(1);

  const result = await router.chat({
    messages: [{ role: "user", content: "Balas satu kata saja: tes" }],
    maxTokens: 24,
    temperature: 0,
  });
  console.log(`non-stream: model=${result.model} content=${JSON.stringify(result.content)}`);

  let streamed = "";
  for await (const delta of router.chatStream({
    messages: [{ role: "user", content: "Balas satu kata saja: halo" }],
    maxTokens: 24,
    temperature: 0,
  })) {
    streamed += delta;
  }
  console.log(`stream: ${JSON.stringify(streamed)}`);

  console.log("VERIFIKASI TUNNEL LULUS ✅");
})().catch((error) => {
  console.error(`GAGAL: ${error.message}`);
  process.exit(1);
});
