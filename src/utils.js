"use strict";

const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const TELEGRAM_TEXT_LIMIT = 4096;
const TELEGRAM_CAPTION_LIMIT = 1024;

/** Escape karakter HTML supaya aman dipakai dengan parse_mode: "HTML". */
function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/** Potong teks ke panjang maksimum, tambahkan elipsis bila perlu. */
function truncate(text, max = 200, suffix = "…") {
  const str = String(text ?? "");
  if (str.length <= max) return str;
  return str.slice(0, Math.max(0, max - suffix.length)) + suffix;
}

/**
 * Pecah teks panjang jadi beberapa bagian <= limit Telegram.
 * Usahakan memotong di batas baris baru supaya tidak memotong kalimat.
 */
function chunkText(text, limit = TELEGRAM_TEXT_LIMIT) {
  const str = String(text ?? "");
  if (!str) return [""];
  if (str.length <= limit) return [str];

  const chunks = [];
  let rest = str;

  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) {
      const space = rest.lastIndexOf(" ", limit);
      cut = space > limit * 0.5 ? space : limit;
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }

  if (rest.length) chunks.push(rest);
  return chunks;
}

/** Format durasi milidetik jadi "1h 2m 3s". */
function formatUptime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

/** Format byte jadi satuan yang mudah dibaca. */
function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(bytes) || 0;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

/** Format angka dengan pemisah ribuan gaya Indonesia. */
function formatNumber(value) {
  return new Intl.NumberFormat("id-ID").format(Number(value) || 0);
}

/** Format timestamp ISO jadi waktu lokal ringkas. */
function formatDateTime(iso) {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Nama tampilan user (first + last, fallback username, fallback id). */
function displayName(from) {
  if (!from) return "Unknown";
  const full = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
  if (full) return full;
  if (from.username) return `@${from.username}`;
  return `User ${from.id}`;
}

/** Mention HTML yang bisa diklik menuju profil user. */
function mentionUser(from) {
  const name = escapeHtml(displayName(from));
  if (!from || !from.id) return name;
  return `<a href="tg://user?id=${from.id}">${name}</a>`;
}

/** Deskripsi chat untuk logging: "private 123" / "group -100... (Judul)". */
function describeChat(chat) {
  if (!chat) return "unknown";
  const title = chat.title ? ` "${chat.title}"` : "";
  return `${chat.type} ${chat.id}${title}`;
}

/**
 * Apakah URL menunjuk ke mesin lokal / alamat yang tidak bisa dijangkau cloud.
 * Dipakai untuk memberi peringatan saat bot jalan serverless (Vercel).
 */
function isLocalUrl(url) {
  return /(\/\/|@)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal)([:/]|$)/i.test(
    String(url ?? ""),
  );
}

/** Buang prefix command dari teks, mis. "/ai halo" -> "halo". */
function commandArgs(text) {
  const str = String(text ?? "").trim();
  if (!str.startsWith("/")) return str;
  const space = str.indexOf(" ");
  const withoutCommand = space === -1 ? "" : str.slice(space + 1);
  return withoutCommand.trim();
}

/** Apakah update ini berisi command (bukan teks biasa yang mirip)? */
function isCommand(ctx) {
  try {
    return ctx.entities("bot_command").length > 0;
  } catch {
    return false;
  }
}

/** Batasi nilai ke rentang tertentu. */
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/** JSON.parse yang tidak melempar, mengembalikan fallback bila gagal. */
function safeJsonParse(raw, fallback = undefined) {
  if (raw === undefined || raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * Tipe update ("message", "callback_query", ...).
 * grammY 1.46 tidak lagi menyediakan `ctx.updateType`, jadi tipe diturunkan dari
 * kunci payload pada objek Update (selain `update_id`).
 * Menerima Context maupun objek Update mentah.
 */
function updateTypeOf(source) {
  if (!source) return "unknown";
  if (typeof source.updateType === "string" && source.updateType) return source.updateType;

  const update = source.update ?? source;
  if (!update || typeof update !== "object") return "unknown";

  for (const key of Object.keys(update)) {
    if (key !== "update_id") return key;
  }
  return "unknown";
}

/** Ambil ringkasan pesan (atau callback) untuk pratinjau log/history. */
function summarizeUpdate(ctx) {
  const type = updateTypeOf(ctx);
  const from = ctx.from ? `${displayName(ctx.from)} (${ctx.from.id})` : "no-from";

  if (ctx.callbackQuery) {
    return `${type} from ${from}: [${truncate(ctx.callbackQuery.data ?? "-", 60)}]`;
  }

  const text = ctx.msg?.text ?? ctx.msg?.caption;
  const preview = text ? `: ${truncate(text.replace(/\s+/g, " "), 80)}` : "";
  return `${type} from ${from}${preview}`;
}

module.exports = {
  TELEGRAM_TEXT_LIMIT,
  TELEGRAM_CAPTION_LIMIT,
  escapeHtml,
  truncate,
  chunkText,
  formatUptime,
  formatBytes,
  formatNumber,
  formatDateTime,
  nowIso,
  sleep,
  displayName,
  mentionUser,
  describeChat,
  isLocalUrl,
  commandArgs,
  isCommand,
  clamp,
  safeJsonParse,
  updateTypeOf,
  summarizeUpdate,
};
