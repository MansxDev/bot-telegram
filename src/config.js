"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { isLocalUrl } = require("./utils");

const ROOT = path.resolve(__dirname, "..");
const ENV_FILE = path.join(ROOT, ".env");

const VALID_MODES = ["polling", "webhook"];
const VALID_DRIVERS = ["sqlite", "redis"];

const DEFAULT_SYSTEM_PROMPT = [
  "Kamu adalah asisten AI di dalam bot Telegram.",
  "Jawab dengan Bahasa Indonesia yang natural, ringkas, dan langsung ke inti.",
  "Gunakan format teks polos tanpa Markdown tabel. Bila perlu daftar, pakai tanda - atau angka.",
  "Kalau pertanyaannya ambigu, ajukan satu pertanyaan klarifikasi singkat.",
].join(" ");

/**
 * Memuat file .env memakai API bawaan Node (>= 20.12), tanpa dependency tambahan.
 * Variabel yang sudah ada di environment tidak akan ditimpa.
 * Di Vercel file .env tidak ada — environment diisi dari dashboard.
 */
function loadEnv(file = ENV_FILE) {
  if (typeof process.loadEnvFile !== "function") {
    console.warn(`[config] process.loadEnvFile tidak tersedia di Node ${process.version}; lewati ${file}`);
    return false;
  }
  if (!fs.existsSync(file)) return false;

  try {
    process.loadEnvFile(file);
    return true;
  } catch (error) {
    console.warn(`[config] gagal membaca ${file}: ${error.message}`);
    return false;
  }
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on", "y"].includes(String(value).trim().toLowerCase());
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toFloat(value, fallback) {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** "1, 2 3" -> [1, 2, 3] */
function toIdList(value) {
  return String(value ?? "")
    .split(/[,\s]+/)
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => Number.isFinite(item));
}

function firstOf(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

/** Path DB: relatif -> ROOT, kecuali di serverless (filesystem read-only) -> /tmp. */
function resolveDbPath(value, serverless) {
  const target = String(value ?? "").trim();
  const fallback = serverless ? "/tmp/bot.db" : "data/bot.db";
  const chosen = target || fallback;

  if (chosen === ":memory:" || chosen.startsWith("/tmp/")) return chosen;
  if (path.isAbsolute(chosen)) return serverless ? `/tmp/${path.basename(chosen)}` : chosen;
  return serverless ? `/tmp/${path.basename(chosen)}` : path.join(ROOT, chosen);
}

/** Apakah URL menunjuk ke mesin lokal (tidak bisa dijangkau dari cloud). */
// isLocalUrl diimpor dari ./utils agar dipakai bersama klien 9Router.

/**
 * Bangun objek konfigurasi dari process.env (atau env yang di-inject untuk testing).
 *
 * @param {Record<string, string|undefined>} env
 */
function buildConfig(env = process.env) {
  // `serverless` = lingkungan tanpa proses panjang (Vercel). Dianggap serverless
  // bila terdeteksi VERCEL=1 atau SERVERLESS=true; mode webhook SENDIRI tidak
  // cukup, karena webhook juga bisa dijalankan lokal untuk uji coba.
  const serverless = Boolean(env.VERCEL) || toBool(env.SERVERLESS, false);
  const explicitMode = String(env.MODE ?? "").trim().toLowerCase();

  const config = {
    root: ROOT,
    envFile: ENV_FILE,
    nodeEnv: env.NODE_ENV || "development",
    serverless,
    mode: VALID_MODES.includes(explicitMode) ? explicitMode : serverless ? "webhook" : "polling",
    botToken: String(env.BOT_TOKEN ?? "").trim(),
    adminIds: toIdList(env.ADMIN_IDS),
    dbPath: resolveDbPath(env.DB_PATH, serverless),
    logLevel: String(env.LOG_LEVEL || (env.VERCEL ? "info" : "info")).trim().toLowerCase(),

    store: {
      driver: (() => {
        const explicit = String(env.STORE_DRIVER ?? "").trim().toLowerCase();
        if (explicit === "upstash") return "redis";
        if (explicit) return explicit;
        return serverless ? "redis" : "sqlite";
      })(),
      redis: {
        url: firstOf(env.UPSTASH_REDIS_REST_URL, env.KV_REST_API_URL, env.REDIS_REST_URL),
        token: firstOf(env.UPSTASH_REDIS_REST_TOKEN, env.KV_REST_API_TOKEN, env.REDIS_REST_TOKEN),
        prefix: String(env.REDIS_PREFIX || "bot:").trim(),
        timeoutMs: toInt(env.REDIS_TIMEOUT_MS, 10_000),
        retries: toInt(env.REDIS_RETRIES, 1),
      },
    },

    webhook: {
      secret: String(env.WEBHOOK_SECRET ?? "").trim(),
      setupSecret: String(env.SETUP_SECRET ?? "").trim(),
      timeoutMs: toInt(env.WEBHOOK_TIMEOUT_MS, 55_000),
      dropPending: toBool(env.WEBHOOK_DROP_PENDING, false),
      allowedUpdates: String(env.WEBHOOK_ALLOWED_UPDATES ?? "").trim(),
      port: toInt(env.PORT, 3000),
      publicUrl: firstOf(env.PUBLIC_URL, env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : "", env.VERCEL_URL ? `https://${env.VERCEL_URL}` : ""),
    },

    router9: {
      baseUrl: String(env.NINEROUTER_URL || "http://localhost:20128").trim().replace(/\/+$/, ""),
      apiKey: String(env.NINEROUTER_API_KEY ?? "").trim(),
      model: String(env.NINEROUTER_MODEL || "gh/gpt-4o-mini").trim(),
      timeoutMs: toInt(env.NINEROUTER_TIMEOUT_MS, serverless ? 45_000 : 120_000),
      maxRetries: toInt(env.NINEROUTER_MAX_RETRIES, serverless ? 0 : 2),
    },

    ai: {
      enabled: toBool(env.AI_ENABLED, true),
      stream: toBool(env.AI_STREAM, true),
      historyLimit: toInt(env.AI_HISTORY_LIMIT, 40),
      contextMessages: toInt(env.AI_CONTEXT_MESSAGES, 12),
      maxTokens: toInt(env.AI_MAX_TOKENS, serverless ? 1024 : 2048),
      temperature: toFloat(env.AI_TEMPERATURE, 0.7),
      systemPrompt: String(env.AI_SYSTEM_PROMPT || "").trim() || DEFAULT_SYSTEM_PROMPT,
      editIntervalMs: toInt(env.AI_EDIT_INTERVAL_MS, serverless ? 1500 : 1200),
      /** Batas waktu satu balasan AI (0 = tanpa batas). Serverless wajib dibatasi. */
      timeBudgetMs: toInt(env.AI_TIME_BUDGET_MS, serverless ? 45_000 : 0),
      placeholder: String(env.AI_PLACEHOLDER || "").trim() || "🤖 <i>sedang berpikir…</i>",
    },

    session: {
      ttlMs: toInt(env.SESSION_TTL_MS, 12 * 60 * 60 * 1000),
      cleanupIntervalMs: toInt(env.SESSION_CLEANUP_INTERVAL_MS, 60 * 60 * 1000),
    },

    limits: {
      broadcastDelayMs: toInt(env.BROADCAST_DELAY_MS, 60),
      maxBroadcastRecipients: toInt(env.MAX_BROADCAST_RECIPIENTS, 2000),
    },
  };

  /** Cek apakah userId termasuk admin (dari ADMIN_IDS). */
  config.isAdmin = (userId) => config.adminIds.includes(Number(userId));

  return config;
}

/**
 * Validasi konfigurasi wajib sebelum bot dijalankan.
 * Hanya hal yang membuat bot TIDAK BISA jalan yang masuk sini.
 * @returns {string[]} daftar masalah (kosong = valid)
 */
function validateConfig(config) {
  const problems = [];

  if (!config.botToken) {
    problems.push("BOT_TOKEN belum diisi. Buat bot lewat @BotFather lalu isi BOT_TOKEN di file .env");
  } else if (!/^\d+:[\w-]{20,}$/.test(config.botToken)) {
    problems.push("BOT_TOKEN formatnya tidak wajar (harus seperti 123456789:AA...).");
  }

  if (!VALID_MODES.includes(config.mode)) {
    problems.push(`MODE tidak dikenal: "${config.mode}" (pilih polling atau webhook).`);
  }

  if (!VALID_DRIVERS.includes(config.store.driver)) {
    problems.push(`STORE_DRIVER tidak dikenal: "${config.store.driver}" (pilih sqlite atau redis).`);
  }

  if (config.store.driver === "redis") {
    if (!config.store.redis.url) {
      problems.push("UPSTASH_REDIS_REST_URL belum diisi (wajib untuk STORE_DRIVER=redis).");
    }
    if (!config.store.redis.token) {
      problems.push("UPSTASH_REDIS_REST_TOKEN belum diisi (wajib untuk STORE_DRIVER=redis).");
    }
  }

  if (!/^https?:\/\/.+/i.test(config.router9.baseUrl)) {
    problems.push(`NINEROUTER_URL tidak valid: ${config.router9.baseUrl}`);
  }

  if (config.mode === "webhook" && !config.webhook.secret) {
    problems.push(
      "WEBHOOK_SECRET belum diisi. Telegram memakainya untuk membuktikan bahwa request benar dari Telegram " +
        "(buat string acak, mis. `openssl rand -hex 24`).",
    );
  }

  return problems;
}

/**
 * Peringatan yang tidak menghalangi bot jalan (fitur tertentu bisa terbatas).
 * @returns {string[]}
 */
function configWarnings(config) {
  const warnings = [];

  if (!config.router9.apiKey) {
    warnings.push(
      "NINEROUTER_API_KEY kosong — fitur AI akan gagal sampai diisi (command lain tetap jalan).",
    );
  }

  if (config.store.driver === "sqlite" && config.serverless) {
    warnings.push(
      "Mesin ini serverless (Vercel) tapi STORE_DRIVER=sqlite — data (session & conversation) TIDAK akan bertahan. " +
        "Pakai STORE_DRIVER=redis.",
    );
  }

  if (config.serverless && isLocalUrl(config.router9.baseUrl)) {
    warnings.push(
      `NINEROUTER_URL=${config.router9.baseUrl} menunjuk ke mesin lokal; serverless tidak bisa menjangkau localhost. ` +
        "Arahkan ke URL publik 9Router, atau biarkan dan fitur AI akan membalas \"AI sedang offline\".",
    );
  }

  if (config.mode === "webhook" && !config.webhook.publicUrl) {
    warnings.push(
      "PUBLIC_URL belum diisi — set webhook Telegram secara manual: " +
        "`node scripts/set-webhook.cjs set https://<domain-vercel-kamu>`.",
    );
  }

  if (!config.webhook.setupSecret && config.mode === "webhook") {
    warnings.push("SETUP_SECRET kosong — endpoint /api/setup akan menolak semua request (aman, tapi tidak bisa dipakai).");
  }

  return warnings;
}

module.exports = {
  ROOT,
  ENV_FILE,
  DEFAULT_SYSTEM_PROMPT,
  VALID_MODES,
  VALID_DRIVERS,
  loadEnv,
  buildConfig,
  validateConfig,
  configWarnings,
  isLocalUrl,
  toBool,
  toInt,
  toFloat,
  toIdList,
};
