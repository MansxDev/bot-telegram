"use strict";

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

/**
 * Logger sederhana dengan level filtering + timestamp lokal.
 * @param {string} level salah satu dari error|warn|info|debug
 * @param {{ scope?: string }} [options]
 */
function createLogger(level = "info", options = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const scope = options.scope;

  function stamp() {
    const d = new Date();
    const pad = (n, len = 2) => String(n).padStart(len, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  }

  function emit(kind, args) {
    if ((LEVELS[kind] ?? 99) > threshold) return;
    const prefix = `${stamp()} ${kind.toUpperCase().padEnd(5)}${scope ? ` [${scope}]` : ""}`;
    const sink = kind === "error" ? console.error : kind === "warn" ? console.warn : console.log;
    sink(prefix, ...args);
  }

  return {
    level,
    error: (...args) => emit("error", args),
    warn: (...args) => emit("warn", args),
    info: (...args) => emit("info", args),
    debug: (...args) => emit("debug", args),
    /** Logger turunan dengan scope baru. */
    child(childScope) {
      return createLogger(level, { scope: scope ? `${scope}:${childScope}` : childScope });
    },
  };
}

module.exports = { createLogger, LEVELS };
