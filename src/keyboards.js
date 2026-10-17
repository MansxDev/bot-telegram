"use strict";

const { InlineKeyboard } = require("grammy");

const TOGGLE_LABELS = {
  ai_enabled: "AI auto-reply",
  ai_stream: "Streaming balasan",
  group_mention_only: "Hanya saat di-mention (grup)",
};

const TOGGLE_ORDER = ["ai_enabled", "ai_stream", "group_mention_only"];

const MODELS_PER_PAGE = 8;

/** Menu utama (dipakai /start, /menu, /help). */
function mainMenu() {
  return new InlineKeyboard()
    .text("🤖 Mulai AI", "menu:ai")
    .text("⚙️ Pengaturan", "menu:settings")
    .row()
    .text("🧠 Pilih Model", "settings:model")
    .text("📊 Statistik", "menu:stats")
    .row()
    .text("❓ Bantuan", "menu:help")
    .text("📝 Feedback", "menu:feedback");
}

/** Tombol kembali ke menu utama. */
function backMenu(target = "menu:main") {
  return new InlineKeyboard().text("« Kembali", target);
}

/** Menu pengaturan dengan status toggle ✅/❌ dan tombol aksi. */
function settingsMenu(settings, options = {}) {
  const keyboard = new InlineKeyboard();

  for (const key of TOGGLE_ORDER) {
    const label = TOGGLE_LABELS[key] ?? key;
    const on = settings[key] === "1";
    keyboard.text(`${on ? "✅" : "❌"} ${label}`, `settings:toggle:${key}`).row();
  }

  keyboard.text("🧠 Ganti Model", "settings:model").row();
  if (options.showReset) keyboard.text("♻️ Reset Pengaturan", "settings:reset").row();

  keyboard.text("🗑️ Hapus Riwayat AI", "settings:clearhistory").row();
  keyboard.text("« Kembali", "menu:main");
  return keyboard;
}

/** Daftar model dengan pagination; `models` array of string id. */
function modelMenu(models, options = {}) {
  const page = Math.max(0, Number(options.page) || 0);
  const current = options.current ?? "";
  const totalPages = Math.max(1, Math.ceil(models.length / MODELS_PER_PAGE));
  const safePage = Math.min(page, totalPages - 1);
  const slice = models.slice(safePage * MODELS_PER_PAGE, safePage * MODELS_PER_PAGE + MODELS_PER_PAGE);

  const keyboard = new InlineKeyboard();

  if (slice.length === 0) {
    keyboard.text("(tidak ada model)", "settings:model:noop").row();
  }

  for (const model of slice) {
    const mark = model === current ? "✅ " : "";
    keyboard.text(`${mark}${model}`, `settings:model:set:${model}`).row();
  }

  if (totalPages > 1) {
    const prev = safePage === 0 ? "settings:model:noop" : `settings:model:page:${safePage - 1}`;
    const next =
      safePage >= totalPages - 1 ? "settings:model:noop" : `settings:model:page:${safePage + 1}`;
    keyboard.text("«", prev).text(`${safePage + 1}/${totalPages}`, "settings:model:noop").text("»", next);
    keyboard.row();
  }

  keyboard.text("🔄 Muat Ulang", "settings:model:reload").text("« Kembali", "menu:settings");
  return keyboard;
}

/** Keyboard rating 1..5 untuk conversation feedback. */
function feedbackRatingMenu() {
  const keyboard = new InlineKeyboard();
  for (let score = 1; score <= 5; score += 1) {
    keyboard.text(`${"⭐".repeat(score)}`, `fb:rate:${score}`).row();
  }
  keyboard.text("❌ Batal", "fb:cancel");
  return keyboard;
}

/** Konfirmasi ya/tidak generik. */
function confirmMenu(yesData, noData) {
  return new InlineKeyboard().text("✅ Ya", yesData).text("❌ Tidak", noData);
}

/** Keyboard pemilihan keyakinan/opsi untuk conversation echo. */
function stopMenu(data = "echo:stop") {
  return new InlineKeyboard().text("⏹️ Selesai", data);
}

module.exports = {
  TOGGLE_LABELS,
  TOGGLE_ORDER,
  MODELS_PER_PAGE,
  mainMenu,
  backMenu,
  settingsMenu,
  modelMenu,
  feedbackRatingMenu,
  confirmMenu,
  stopMenu,
};
