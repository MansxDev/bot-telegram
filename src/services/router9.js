"use strict";

/**
 * Klien tipis untuk 9Router (gateway OpenAI-compatible lokal).
 * Endpoint yang dipakai:
 *   GET  /v1/models
 *   POST /v1/chat/completions        (non-stream)
 *   POST /v1/chat/completions        (stream: true -> SSE)
 */

const { escapeHtml, isLocalUrl } = require("../utils");

class Router9Error extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "Router9Error";
    this.status = options.status ?? 0;
    this.url = options.url ?? "";
    this.body = options.body ?? null;
    this.retryable = options.retryable ?? false;
  }
}

/** Bangun pesan error yang enak dibaca dari respons HTTP. */
function describeHttpError(status, bodyText) {
  const hint = (() => {
    if (status === 401 || status === 403) return "API key 9Router tidak valid / tidak punya akses.";
    if (status === 404) return "Endpoint atau model tidak ditemukan.";
    if (status === 429) return "Rate limit / kuota provider habis.";
    if (status >= 500) return "Server 9Router atau provider sedang bermasalah.";
    return "Permintaan ditolak.";
  })();

  let detail = "";
  try {
    const parsed = JSON.parse(bodyText);
    detail = parsed?.error?.message || parsed?.message || "";
  } catch {
    detail = String(bodyText ?? "").slice(0, 300);
  }

  return [`HTTP ${status}: ${hint}`, detail].filter(Boolean).join(" ");
}

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

class Router9 {
  /**
   * @param {{ baseUrl: string, apiKey?: string, model?: string, timeoutMs?: number, maxRetries?: number }} options
   */
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || "http://localhost:20128").replace(/\/+$/, "");
    this.apiKey = options.apiKey || "";
    this.defaultModel = options.model || "gh/gpt-4o-mini";
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxRetries = options.maxRetries ?? 2;
  }

  get headers() {
    const headers = { "content-type": "application/json", accept: "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  url(pathname) {
    return `${this.baseUrl}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
  }

  /** Gabung timeout internal dengan AbortSignal eksternal (bila ada). */
  #signal(externalSignal, timeoutMs = this.timeoutMs) {
    const timeout = AbortSignal.timeout(timeoutMs);
    if (!externalSignal) return timeout;
    if (typeof AbortSignal.any === "function") return AbortSignal.any([externalSignal, timeout]);
    return timeout;
  }

  /**
   * Request JSON dengan retry sederhana untuk error yang layak diulang.
   * @param {string} pathname
   * @param {{ method?: string, body?: unknown, signal?: AbortSignal, retries?: number }} options
   */
  async requestJson(pathname, options = {}) {
    const url = this.url(pathname);
    const method = options.method ?? "GET";
    const retries = options.retries ?? this.maxRetries;
    let attempt = 0;
    let lastError = null;

    while (attempt <= retries) {
      attempt += 1;
      try {
        const response = await fetch(url, {
          method,
          headers: this.headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: this.#signal(options.signal),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          const error = new Router9Error(describeHttpError(response.status, text), {
            status: response.status,
            url,
            body: text.slice(0, 1000),
            retryable: isRetryableStatus(response.status),
          });
          if (error.retryable && attempt <= retries) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
            continue;
          }
          throw error;
        }

        const text = await response.text();
        if (!text) return {};
        try {
          return JSON.parse(text);
        } catch {
          throw new Router9Error(`Respons bukan JSON valid dari ${url}`, { url, body: text.slice(0, 300) });
        }
      } catch (error) {
        if (error instanceof Router9Error) {
          if (error.retryable && attempt <= retries) {
            lastError = error;
            continue;
          }
          throw error;
        }

        const isAbort = error?.name === "AbortError" || error?.name === "TimeoutError";
        const wrapped = new Router9Error(
          isAbort
            ? `Timeout/abort saat menghubungi 9Router (${url}).`
            : `Gagal menghubungi 9Router (${url}): ${error?.message ?? error}`,
          { url, retryable: !isAbort },
        );

        if (!isAbort && attempt <= retries) {
          lastError = wrapped;
          await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
          continue;
        }
        throw wrapped;
      }
    }

    throw lastError ?? new Router9Error(`Permintaan ke ${url} gagal tanpa detail.`);
  }

  /** Cek 9Router hidup dan bisa diakses. */
  async health() {
    try {
      const data = await this.requestJson("/v1/models", { retries: 0 });
      const models = Array.isArray(data?.data) ? data.data : [];
      return { ok: true, models: models.length, baseUrl: this.baseUrl };
    } catch (error) {
      return { ok: false, error: error.message, baseUrl: this.baseUrl };
    }
  }

  /** Daftar id model yang tersedia (terurut). */
  async listModels(options = {}) {
    const data = await this.requestJson("/v1/models", { retries: options.retries ?? 1, signal: options.signal });
    const list = Array.isArray(data?.data) ? data.data : [];
    const ids = list
      .map((item) => item?.id)
      .filter((id) => typeof id === "string" && id.length > 0);
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
  }

  /**
   * Chat non-stream.
   * @returns {Promise<{ content: string, model: string, usage: unknown, raw: unknown }>}
   */
  async chat({ model, messages, temperature, maxTokens, signal, extraBody } = {}) {
    const body = this.#chatBody({ model, messages, temperature, maxTokens, stream: false, extraBody });
    const data = await this.requestJson("/v1/chat/completions", { method: "POST", body, signal });

    const content =
      data?.choices?.[0]?.message?.content ??
      data?.choices?.[0]?.text ??
      "";

    if (!content) {
      throw new Router9Error("9Router mengembalikan balasan kosong.", { body: JSON.stringify(data).slice(0, 500) });
    }

    return {
      content: String(content),
      model: data?.model || body.model,
      usage: data?.usage ?? null,
      raw: data,
    };
  }

  /**
   * Chat streaming (SSE). Yield potongan teks bertipe string.
   * @returns {AsyncGenerator<string, void, void>}
   */
  async *chatStream({ model, messages, temperature, maxTokens, signal, extraBody } = {}) {
    const body = this.#chatBody({ model, messages, temperature, maxTokens, stream: true, extraBody });
    const url = this.url("/v1/chat/completions");

    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { ...this.headers, accept: "text/event-stream" },
        body: JSON.stringify(body),
        signal: this.#signal(signal),
      });
    } catch (error) {
      const isAbort = error?.name === "AbortError" || error?.name === "TimeoutError";
      throw new Router9Error(
        isAbort ? `Timeout saat streaming dari 9Router (${url}).` : `Gagal streaming dari 9Router: ${error?.message ?? error}`,
        { url },
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Router9Error(describeHttpError(response.status, text), {
        status: response.status,
        url,
        body: text.slice(0, 1000),
      });
    }

    if (!response.body) {
      // Server tidak mendukung streaming -> fallback ke hasil non-stream.
      const fallback = await this.chat({ model, messages, temperature, maxTokens, signal, extraBody });
      yield fallback.content;
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";

    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const text = this.#parseSseBlock(block);
        if (text === null) return; // [DONE]
        if (text) yield text;
        boundary = buffer.indexOf("\n\n");
      }
    }

    const tail = this.#parseSseBlock(buffer);
    if (tail) yield tail;
  }

  #chatBody({ model, messages, temperature, maxTokens, stream, extraBody }) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Router9Error("messages tidak boleh kosong.");
    }
    const body = {
      model: model || this.defaultModel,
      messages,
      stream: Boolean(stream),
    };
    if (Number.isFinite(temperature)) body.temperature = temperature;
    if (Number.isFinite(maxTokens)) body.max_tokens = maxTokens;
    if (extraBody && typeof extraBody === "object") Object.assign(body, extraBody);
    return body;
  }

  /**
   * Parse satu blok SSE. Mengembalikan:
   *  - null  -> sinyal [DONE] (stream selesai)
   *  - ""    -> blok tanpa delta teks (mis. hanya role/usage)
   *  - teks  -> potongan konten
   */
  #parseSseBlock(block) {
    const raw = String(block ?? "").trim();
    if (!raw) return "";

    const lines = raw.split("\n");
    let out = "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":")) continue;
      if (!trimmed.startsWith("data:")) continue;

      const payload = trimmed.slice(5).trim();
      if (!payload) continue;
      if (payload === "[DONE]") return null;

      try {
        const json = JSON.parse(payload);
        const choice = json?.choices?.[0];
        const delta = choice?.delta?.content ?? choice?.message?.content ?? choice?.text ?? "";
        if (typeof delta === "string" && delta) out += delta;
      } catch {
        // blok rusak / bukan JSON -> abaikan, jangan gagalkan seluruh stream
      }
    }

    return out;
  }
}

/**
 * Apakah error ini karena 9Router TIDAK BISA DIJANGKAU (bukan error HTTP dari
 * server): koneksi ditolak, DNS gagal, atau timeout.
 */
function isOfflineError(error) {
  if (!error || error.name !== "Router9Error") return false;
  if (Number(error.status) > 0) return false;
  return /Gagal menghubungi 9Router|Gagal streaming dari 9Router|Timeout|abort/i.test(String(error.message ?? ""));
}

/**
 * Pesan siap-kirim (HTML) untuk user saat AI gagal.
 * @param {Error} error
 * @param {{ baseUrl?: string, serverless?: boolean }} [options]
 */
function describeAiError(error, options = {}) {
  const baseUrl = String(options.baseUrl ?? "");

  if (isOfflineError(error)) {
    const lines = [
      "🤖 <b>AI sedang offline</b>",
      "",
      `Gateway 9Router di <code>${escapeHtml(baseUrl || "-")}</code> tidak bisa dihubungi dari sini.`,
      "Command lain (help, settings, stats, feedback, echo) tetap berjalan normal.",
    ];

    if (options.serverless) {
      lines.push(
        "",
        "<i>Bot ini berjalan di server (Vercel) yang tidak bisa menjangkau localhost laptop. " +
          "Arahkan NINEROUTER_URL ke URL publik 9Router (mis. lewat Cloudflare Tunnel atau VPS).</i>",
      );
    } else if (isLocalUrl(baseUrl)) {
      lines.push("", "<i>Cek status gateway: <code>systemctl --user status 9router</code></i>");
    } else {
      lines.push("", `<i>Cek koneksi ke <code>${escapeHtml(baseUrl)}</code> dari server ini.</i>`);
    }

    return lines.join("\n");
  }

  return `⚠️ ${escapeHtml(error?.message ?? "AI gagal menjawab.")}`;
}

module.exports = { Router9, Router9Error, describeHttpError, isOfflineError, describeAiError };
