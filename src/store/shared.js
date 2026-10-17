"use strict";

/** Versi skema penyimpanan (dipakai driver sqlite & redis). */
const SCHEMA_VERSION = 1;

/** Pengaturan default per chat (disimpan sebagai string "0"/"1" agar sederhana). */
const DEFAULT_CHAT_SETTINGS = {
  ai_enabled: "1",
  ai_stream: "1",
  group_mention_only: "1",
  model: "",
};

/** Ubah nilai apa pun jadi "0"/"1" (null dipertahankan) untuk kolom is_bot/is_premium. */
function bool(value) {
  return value === undefined || value === null ? null : value ? 1 : 0;
}

/**
 * Normalisasi limit query: selalu integer positif yang wajar.
 * @param {unknown} value
 * @param {number} fallback
 */
function normalizeLimit(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

module.exports = { SCHEMA_VERSION, DEFAULT_CHAT_SETTINGS, bool, normalizeLimit };
