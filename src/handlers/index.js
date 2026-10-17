"use strict";

/**
 * Registry command/middleware gaya bot-wa:
 *   registry.register("menu", { aliases: ["help"], handler: async (ctx) => {} })
 *   registry.onCallback(/^settings:/, async (ctx) => {})
 *   registry.onText(/^halo$/i, async (ctx) => {})
 *
 * Modul handler cukup mengekspor function(app, registry) dan mendaftarkan dirinya.
 */
class Registry {
  constructor(app) {
    this.app = app;
    this.commands = new Map();
    this.callbacks = [];
    this.texts = [];

    // Bound supaya aman di-destructure: const { register } = registry;
    this.register = this.register.bind(this);
    this.onCallback = this.onCallback.bind(this);
    this.onText = this.onText.bind(this);
    this.load = this.load.bind(this);
    this.install = this.install.bind(this);
    this.commandList = this.commandList.bind(this);
  }

  /**
   * Daftarkan command.
   * @param {string} name nama command tanpa slash
   * @param {{ aliases?: string[], description?: string, admin?: boolean, hidden?: boolean, handler: Function }} options
   */
  register(name, options = {}) {
    const key = String(name).toLowerCase().replace(/^\//, "");
    if (!key) throw new Error("register(): nama command kosong");
    if (typeof options.handler !== "function") throw new Error(`register(${key}): handler harus function`);
    if (this.commands.has(key)) throw new Error(`register(${key}): command sudah terdaftar`);

    const aliases = (options.aliases ?? [])
      .map((alias) => String(alias).toLowerCase().replace(/^\//, ""))
      .filter((alias) => alias && alias !== key);

    for (const alias of aliases) {
      const existing = this.commands.get(alias);
      if (existing) throw new Error(`register(${key}): alias "${alias}" bentrok dengan command "${existing.name}"`);
    }

    const entry = {
      name: key,
      aliases,
      description: options.description ?? "",
      admin: Boolean(options.admin),
      hidden: Boolean(options.hidden),
      handler: options.handler,
    };

    this.commands.set(key, entry);
    for (const alias of aliases) this.commands.set(alias, { ...entry, name: key, aliasOf: key });

    return entry;
  }

  /** Daftarkan handler callback_query (string persis atau RegExp). */
  onCallback(trigger, handler) {
    if (typeof handler !== "function") throw new Error("onCallback(): handler harus function");
    if (!(typeof trigger === "string" || trigger instanceof RegExp)) {
      throw new Error("onCallback(): trigger harus string atau RegExp");
    }
    this.callbacks.push({ trigger, handler });
    return handler;
  }

  /** Daftarkan handler teks (string persis, array, atau RegExp). */
  onText(trigger, handler) {
    if (typeof handler !== "function") throw new Error("onText(): handler harus function");
    if (!(typeof trigger === "string" || trigger instanceof RegExp || Array.isArray(trigger))) {
      throw new Error("onText(): trigger harus string, array, atau RegExp");
    }
    this.texts.push({ trigger, handler });
    return handler;
  }

  /** Muat daftar modul handler; tiap modul = function(app, registry). */
  load(modules) {
    for (const mod of modules) {
      if (typeof mod !== "function") throw new Error("load(): setiap modul harus function(app, registry)");
      mod(this.app, this);
    }
    return this;
  }

  /** Pasang semua yang terdaftar ke instance bot grammY. */
  install(bot) {
    const { config, logger } = this.app;

    for (const entry of this.commands.values()) {
      if (entry.aliasOf) continue; // alias sudah ikut di trigger command utama

      const triggers = [entry.name, ...entry.aliases];
      bot.command(triggers, async (ctx) => {
        if (entry.admin && !config.isAdmin(ctx.from?.id)) {
          logger.warn(`tolak command admin /${entry.name} dari ${ctx.from?.id}`);
          await ctx.reply("⛔ Perintah ini khusus admin.").catch(() => {});
          return;
        }

        logger.debug(`jalankan command /${entry.name}`);
        await entry.handler(ctx);
      });
    }

    for (const { trigger, handler } of this.callbacks) {
      bot.callbackQuery(trigger, async (ctx) => {
        await handler(ctx);
      });
    }

    for (const { trigger, handler } of this.texts) {
      bot.hears(trigger, async (ctx) => {
        await handler(ctx);
      });
    }

    return bot;
  }

  /** Daftar command unik (tanpa alias & hidden) untuk setMyCommands. */
  commandList() {
    const unique = new Map();
    for (const entry of this.commands.values()) {
      if (entry.hidden || unique.has(entry.name)) continue;
      unique.set(entry.name, { command: entry.name, description: entry.description || entry.name });
    }
    return [...unique.values()].sort((a, b) => a.command.localeCompare(b.command));
  }

  /** Ringkasan untuk /help dan /stats. */
  summary() {
    return {
      commands: this.commandList().length,
      callbacks: this.callbacks.length,
      texts: this.texts.length,
      names: [...new Set([...this.commands.values()].map((entry) => entry.name))],
    };
  }
}

module.exports = { Registry };
