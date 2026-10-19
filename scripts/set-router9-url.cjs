#!/usr/bin/env node
"use strict";

/**
 * Simpan URL 9Router (gateway AI) ke database bot.
 *
 * Kenapa perlu: URL Cloudflare Tunnel mode "quick" (xxx.trycloudflare.com)
 * berubah setiap tunnel di-restart. Nilai di database menimpa NINEROUTER_URL
 * dari environment, jadi cukup jalankan script ini — tanpa redeploy Vercel.
 *
 * Pakai:
 *   node scripts/set-router9-url.cjs                        # lihat yang tersimpan
 *   node scripts/set-router9-url.cjs <url>                  # simpan + uji
 *   node scripts/set-router9-url.cjs <url> --model gh/gpt-4o-mini
 *   node scripts/set-router9-url.cjs --clear                # hapus override
 *
 * Skrip ini memakai .env (token & store) dan menguji URL-nya lewat klien
 * 9Router yang sama dengan bot, sehingga "berhasil" berarti benar-benar bisa
 * dipakai AI.
 */

process.env.LOG_LEVEL = process.env.LOG_LEVEL || "error";

const { loadEnv, buildConfig } = require("../src/config");
const { createStore } = require("../src/store");
const { Router9 } = require("../src/services/router9");

function parseArgs(argv) {
  const out = { url: "", model: "", clear: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--clear" || arg === "-c") out.clear = true;
    else if (arg === "--model" || arg === "-m") out.model = String(argv[(index += 1)] ?? "").trim();
    else if (!out.url) out.url = arg.trim();
  }
  return out;
}

async function probe(config, baseUrl, model) {
  const router = new Router9({
    baseUrl,
    apiKey: config.router9.apiKey,
    model,
    timeoutMs: 30_000,
    maxRetries: 0,
  });

  const health = await router.health();
  if (!health.ok) return { ok: false, models: 0, error: health.error ?? "tidak terjangkau" };

  const reply = await router.chat({
    messages: [{ role: "user", content: "Balas satu kata: siap" }],
    maxTokens: 16,
    temperature: 0,
  });

  return { ok: true, models: health.models ?? 0, sample: (reply.content || "").trim().slice(0, 40) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnv();

  const config = buildConfig();
  const store = await createStore(config);

  try {
    if (args.clear) {
      await store.setMeta("router9_url", "");
      await store.setMeta("router9_model", "");
      console.log("✓ Override URL/model 9Router dihapus. Bot memakai NINEROUTER_URL dari environment.");
      console.log(`  URL dari environment: ${config.router9.baseUrl}`);
      return;
    }

    if (!args.url) {
      const storedUrl = (await store.getMeta("router9_url", "")) || "";
      const storedModel = (await store.getMeta("router9_model", "")) || "";
      const effective = storedUrl || config.router9.baseUrl;

      console.log(`store       : ${config.store.driver}`);
      console.log(`env URL     : ${config.router9.baseUrl}`);
      console.log(`URL disimpan: ${storedUrl || "(belum ada)"}`);
      console.log(`model       : ${storedModel || config.router9.model}${storedModel ? " (disimpan)" : ""}`);
      console.log("");
      console.log(`efektif     : ${effective}`);

      const result = await probe(config, effective, storedModel || config.router9.model);
      console.log(result.ok ? `✓ terjangkau (${result.models} model), jawab: ${result.sample}` : `✗ ${result.error}`);
      if (!result.ok) process.exitCode = 1;
      return;
    }

    const target = args.url.replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(target)) {
      throw new Error(`URL tidak valid: ${target} (harus diawali http:// atau https://)`);
    }

    await store.setMeta("router9_url", target);
    if (args.model) await store.setMeta("router9_model", args.model);

    console.log(`URL 9Router disimpan di store (${config.store.driver}): ${target}`);
    if (args.model) console.log(`Model disimpan: ${args.model}`);

    const result = await probe(config, target, args.model || config.router9.model);
    if (result.ok) {
      console.log(`✓ terverifikasi: ${result.models} model, jawab: ${result.sample}`);
      console.log("Bot (polling maupun webhook/Vercel) akan memakai URL ini pada request berikutnya.");
    } else {
      console.error(`✗ URL tersimpan, tapi belum bisa dipakai: ${result.error}`);
      process.exitCode = 1;
    }
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  console.error(`Gagal: ${error.message}`);
  process.exitCode = 1;
});
