# bot-telegram

Bot Telegram **JavaScript (CommonJS, tanpa build step)** berbasis [grammY](https://grammy.dev) — command registry gaya bot-wa, inline keyboard, conversations, penyimpanan **SQLite atau Redis**, dan chat AI lewat **9Router**.

Bisa dijalankan dua cara:

| Mode | Untuk | Store | Cara kerja |
|---|---|---|---|
| `polling` | laptop / VPS / systemd | SQLite (default) | proses panjang, bot menarik update sendiri |
| `webhook` | **Vercel** / serverless | Redis (Upstash) | Telegram mem-POST update ke `/api/webhook` |

> Ringkasnya: **1 basis kode, 2 mode jalan.** Ganti mode hanya lewat environment variable.

---

## Daftar isi

- [Fitur](#fitur)
- [Prasyarat](#prasyarat)
- [Instalasi](#instalasi)
- [Konfigurasi](#konfigurasi)
- [Menjalankan](#menjalankan)
  - [A. Polling (lokal / VPS)](#a-polling-lokal--vps)
  - [B. Webhook lokal (uji dulu)](#b-webhook-lokal-uji-dulu)
  - [C. Deploy ke Vercel](#c-deploy-ke-vercel)
- [Penyimpanan: SQLite vs Redis](#penyimpanan-sqlite-vs-redis)
- [Daftar command](#daftar-command)
- [Struktur folder](#struktur-folder)
- [Verifikasi](#verifikasi)
- [Troubleshooting](#troubleshooting)
- [Catatan teknis penting](#catatan-teknis-penting)

---

## Fitur

**Telegram / bot**
- Command registry: `register(name, { aliases, description, admin, hidden, handler })`
- Middleware registry: `onCallback(pattern)`, `onText(pattern)`
- Inline keyboard + callback handler bertombol (menu, settings, pilih model, rating)
- Conversations (`@grammyjs/conversations`): `/feedback` bertahap & `/echo` loop
- Session per user/chat (`ctx.session`) + auto-reply AI
- `auto-retry` untuk error sementara Telegram (flood wait, 5xx)
- `bot.catch` kustom: satu update gagal tidak mematikan polling
- Balasan panjang otomatis dipecah (< 4096 karakter), placeholder AI diedit bertahap (streaming)
- Command admin (`ADMIN_IDS`): stats, health, broadcast, feedbacklist

**Data** (driver apa pun, API async yang sama)
- user, chat, settings per chat, session, conversation state
- riwayat AI per chat (dibatasi `AI_HISTORY_LIMIT`, ada trim)
- feedback, statistik counter, riwayat broadcast

**AI**
- Streaming SSE dari 9Router (`/v1/chat/completions`), edit placeholder dengan throttle
- Model per chat (`/model`) atau global (`NINEROUTER_MODEL`)
- **Graceful offline**: 9Router tidak terjangkau → user dapat pesan `AI sedang offline`, command lain tetap normal
- Batas waktu untuk serverless (`AI_TIME_BUDGET_MS`) supaya tidak kena limit 60 detik Vercel

**Deployment**
- `MODE=webhook` + `WEBHOOK_SECRET` (verifikasi constant-time oleh grammY, 401 kalau salah)
- `api/setup.js`: atur/hapus/lihat webhook lewat HTTP (dilindungi `SETUP_SECRET`)
- `scripts/set-webhook.cjs`: CLI set/delete/status webhook dari terminal
- `vercel.json`: `maxDuration 60`, memory 1024 MB
- Sistem penyimpanan pluggable: `sqlite` | `redis` (Upstash REST)

---

## Prasyarat

- **Node.js >= 20.12** (dites di Node 26.11.1). Dipakai `process.loadEnvFile`, `AbortSignal.timeout`, dan `fetch` bawaan.
- Token bot dari [@BotFather](https://t.me/BotFather)
- Untuk mode `webhook`/Vercel: database **Upstash Redis** (gratis) — `STORE_DRIVER=redis`
- Opsional (untuk AI): gateway 9Router yang bisa dijangkau. Lokal: `http://localhost:20128`. Di cloud: URL publik.
- Untuk Vercel: akun Vercel + `vercel` CLI (opsional, bisa juga import repo dari dashboard)

---

## Instalasi

```bash
cd bot-telegram
npm install

# siapkan konfigurasi
cp .env.example .env
# lalu isi BOT_TOKEN (dan ADMIN_IDS kalau perlu)
```

Cek cepat tanpa jaringan:

```bash
npm run check   # 31 pemeriksaan offline (store sqlite + redis tiruan, config, 9Router, bot)
npm run e2e     # 17 skenario end-to-end (command, callback, conversation, webhook, AI)
```

---

## Konfigurasi

Semua lewat environment variable (lihat `.env.example` untuk daftar lengkap + komentar).

**Wajib**
| Variabel | Keterangan |
|---|---|
| `BOT_TOKEN` | token dari @BotFather |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | hanya kalau `STORE_DRIVER=redis` |
| `WEBHOOK_SECRET` | hanya kalau `MODE=webhook` |

**Penting**
| Variabel | Default | Keterangan |
|---|---|---|
| `MODE` | `polling` (lokal) / `webhook` (di Vercel) | mode jalan |
| `STORE_DRIVER` | `sqlite` (lokal) / `redis` (di Vercel) | driver penyimpanan |
| `DB_PATH` | `data/bot.db` (di Vercel otomatis `/tmp/bot.db`) | file SQLite |
| `REDIS_PREFIX` | `bot:` | awalan kunci Redis |
| `ADMIN_IDS` | kosong | daftar ID admin, pisah koma |
| `NINEROUTER_URL` | `http://localhost:20128` | alamat gateway AI |
| `NINEROUTER_API_KEY` | kosong | API key 9Router (kalau kosong, fitur AI non-aktif) |
| `NINEROUTER_MODEL` | `gh/gpt-4o-mini` | model default |
| `AI_TIME_BUDGET_MS` | `0` lokal / `45000` di Vercel | batas waktu satu balasan AI |
| `SETUP_SECRET` | kosong | kunci endpoint `/api/setup` |
| `LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `debug` |

**Cara cepat bikin rahasia:**

```bash
openssl rand -hex 24   # untuk WEBHOOK_SECRET
openssl rand -hex 24   # untuk SETUP_SECRET
```

Nilai default lingkungan: kalau `VERCEL=1` terdeteksi (Vercel otomatis mengesetnya), maka `MODE=webhook`, `STORE_DRIVER=redis`, dan `DB_PATH=/tmp/...`. `MODE`/`STORE_DRIVER` yang ditulis eksplisit selalu menang.

---

## Menjalankan

### A. Polling (lokal / VPS)

```bash
npm start          # node src/index.js
npm run dev        # auto-restart saat file berubah (node --watch)
```

Log yang benar:

```
INFO  environment: development | node v26.11.1 | mode: polling
INFO  storage: sqlite (/home/mans/project/bot-telegram/data/bot.db)
INFO  command terdaftar: 16 (start, help, menu, ...)
INFO  9Router: online (134 model) di http://localhost:20128
INFO  bot @manstele_bot siap — menunggu update (long polling)
```

> Webhook dan polling **saling meniadakan**. Kalau bayangan bot "tidak merespons", cek dulu
> `node scripts/set-webhook.cjs status` — kalau ada URL, hapus dengan
> `node scripts/set-webhook.cjs delete`.

**Jalan terus di VPS (systemd user unit):** contoh unit ada di `deploy/bot-telegram.service`.

```bash
mkdir -p ~/.config/systemd/user
cp deploy/bot-telegram.service ~/.config/systemd/user/bot-telegram.service
# sesuaikan WorkingDirectory & ExecStart, lalu:
systemctl --user daemon-reload
systemctl --user enable --now bot-telegram
journalctl --user -u bot-telegram -f
```

### B. Webhook lokal (uji dulu)

```bash
MODE=webhook WEBHOOK_SECRET=$(openssl rand -hex 24) npm run start:webhook
# server HTTP lokal menerima POST di http://localhost:3000/api/webhook
```

Untuk Telegram benar-benar mengirim update, butuh URL publik. Paling mudah pakai Cloudflare Tunnel:

```bash
cloudflared tunnel --url http://localhost:3000
# copy URL https yang muncul, lalu:
node scripts/set-webhook.cjs set https://xxxx.trycloudflare.com
```

Kembali ke polling: `node scripts/set-webhook.cjs delete`.

### C. Deploy ke Vercel

#### C.1 Push ke GitHub

```bash
cd bot-telegram
git init -b main
git add -A
git commit -m "bot-telegram: grammY bot + store pluggable (SQLite/Redis) + Vercel ready"
gh repo create MansxDev/bot-telegram --private --source=. --remote=origin --push
```

`.env` **tidak** ikut ter-commit (ada di `.gitignore`).

#### C.2 Ambil kredensial Upstash Redis

1. Buat database gratis di <https://console.upstash.com> (region terdekat, mis. Singapore).
2. Tab **REST API** → copy `UPSTASH_REDIS_REST_URL` dan `UPSTASH_REDIS_REST_TOKEN`.

#### C.3 Deploy

```bash
npm i -g vercel
vercel login          # ikuti instruksi di browser
vercel link           # pilih akun & buat project "bot-telegram"
```

> Kalau `vercel` tidak dikenali, pastikan bin global npm ada di `PATH`
> (`npm config get prefix` → tambahkan `.../bin`), atau jalankan lewat `npx vercel`.

Set environment variable (production):

```bash
vercel env add BOT_TOKEN production
vercel env add ADMIN_IDS production
vercel env add NINEROUTER_URL production        # URL publik 9Router (bukan localhost!)
vercel env add NINEROUTER_API_KEY production
vercel env add NINEROUTER_MODEL production
vercel env add UPSTASH_REDIS_REST_URL production
vercel env add UPSTASH_REDIS_REST_TOKEN production
vercel env add WEBHOOK_SECRET production        # openssl rand -hex 24
vercel env add SETUP_SECRET production          # openssl rand -hex 24

vercel --prod
```

Atau lewat dashboard: **Project → Settings → Environment Variables** (pilih Production), lalu redeploy.

#### C.4 Daftarkan webhook Telegram

Dari laptop (pakai token di `.env` lokal):

```bash
node scripts/set-webhook.cjs set https://bot-telegram.vercel.app
node scripts/set-webhook.cjs status
```

Atau lewat HTTP (tanpa terminal, pakai `SETUP_SECRET`):

```
https://bot-telegram.vercel.app/api/setup?key=<SETUP_SECRET>
https://bot-telegram.vercel.app/api/setup?key=<SETUP_SECRET>&action=set&url=https://bot-telegram.vercel.app
https://bot-telegram.vercel.app/api/setup?key=<SETUP_SECRET>&action=delete
```

`action=status` mengembalikan info bot + webhook + peringatan konfigurasi yang berguna saat deploy.

#### C.5 Batasan yang perlu diketahui (plan Hobby)

- Function Vercel maksimal **60 detik** → `AI_TIME_BUDGET_MS=45000` supaya jawaban AI dipotong rapi sebelum limit.
- Vercel **tidak bisa** menjangkau `localhost:20128`. `NINEROUTER_URL` harus URL publik (Cloudflare Tunnel / VPS). Kalau tidak, bot tetap hidup, AI membalas `AI sedang offline`.
- Filesystem read-only & sementara → **wajib** `STORE_DRIVER=redis`. Kalau dipaksa `sqlite`, bot memberi peringatan dan session tidak akan bertahan.
- Endpoint webhook bersifat publik; keamanan bergantung pada `WEBHOOK_SECRET` (grammY menolak 401 kalau header tidak cocok).

---

## Penyimpanan: SQLite vs Redis

Kedua driver mengimplementasikan **interface async yang sama** (`createStore()` di `src/store/index.js`), jadi kode handler tidak berubah saat pindah driver.

| | SQLite (`better-sqlite3`) | Redis (`Upstash REST`) |
|---|---|---|
| Cocok untuk | polling lokal, VPS, single instance | Vercel/serverless, multi instance |
| Kredensial | tidak perlu | `UPSTASH_REDIS_REST_URL` + `TOKEN` |
| Persisten | file `data/bot.db` | di server Upstash |
| Dependency | `better-sqlite3` (`optionalDependencies`) | tanpa dependency (pakai `fetch`) |
| Session kedaluwarsa | `kvPrune()` dari timer | TTL Redis + `kvPrune()` sebagai jaring pengaman |

Beberapa catatan desain driver Redis:

- Semua operasi satu update dibungkus **satu HTTP call** (`recordUpdate()` → `/pipeline`), supaya latensi serverless tetap rendah.
- Nilai hash disimpan sebagai JSON agar tipe (string/number/null) sama seperti kolom SQLite.
- Counter (`cnt:ai`, `cnt:fb`, statistik) di-`INCRBY`/`HINCRBY` agar hitungan tetap O(1).

---

## Daftar command

| Command | Alias | Keterangan |
|---|---|---|
| `/start` | | sapaan + menu utama |
| `/help` | | daftar command |
| `/menu` | | menu inline |
| `/ping` | | cek latensi |
| `/info` | | info bot, mode, storage, status 9Router |
| `/id` | | ID user & chat + status admin |
| `/ai <prompt>` | `/ask`, `/tanya` | tanya AI sekali |
| `/reset` | `/clear`, `/aireset` | hapus riwayat AI chat ini |
| `/history` | `/riwayat` | lihat ringkasan riwayat AI (hidden dari /help) |
| `/settings` | `/pengaturan` | pengaturan chat (toggle AI/stream/mention) |
| `/model` | `/models` | pilih model 9Router |
| `/feedback` | | kirim feedback bertahap (conversation) |
| `/echo` | | demo conversation loop |
| `/stats` | | statistik lengkap (admin) |
| `/health` | | health check bot & 9Router (admin) |
| `/broadcast <teks>` | | kirim pesan ke semua chat (admin) |
| `/feedbacklist` | | feedback terbaru (admin) |

Chord/efek khusus:
- Chat pribadi: kirim teks apa pun → AI membalas otomatis (kalau `ai_enabled=1`).
- Grup: bot hanya menjawab kalau di-mention, di-reply, atau `group_mention_only=0`.

---

## Struktur folder

```
bot-telegram/
├── api/                      # Vercel serverless functions
│   ├── webhook.js            #   POST /api/webhook  (terima update Telegram)
│   └── setup.js              #   GET  /api/setup    (atur/lihat webhook)
├── deploy/
│   └── bot-telegram.service  # systemd user unit (template)
├── scripts/
│   ├── selfcheck.cjs         # npm run check  (31 pemeriksaan offline)
│   ├── e2e.cjs               # npm run e2e    (17 skenario end-to-end)
│   ├── fake-upstash.cjs      # server Upstash tiruan untuk test driver Redis
│   └── set-webhook.cjs       # CLI: status | set <url> | delete
├── src/
│   ├── index.js              # entry point proses panjang (polling / webhook lokal)
│   ├── runtime.js            # bootstrap bersama + cache runtime (serverless)
│   ├── webhook.js            # handler webhook + registerWebhook()
│   ├── bot.js                # createBot(): susun middleware & handler
│   ├── config.js             # buildConfig / validateConfig / configWarnings
│   ├── logger.js             # logger level error|warn|info|debug
│   ├── keyboards.js          # semua inline keyboard
│   ├── telegram.js           # helper aman: safeReply, safeEdit, safeAnswer, ...
│   ├── utils.js              # escapeHtml, chunkText, updateTypeOf, ...
│   ├── store/                # penyimpanan pluggable
│   │   ├── index.js          #   createStore() + dokumentasi interface
│   │   ├── shared.js         #   default settings + helper bersama
│   │   ├── sqlite.js         #   driver SQLite (better-sqlite3)
│   │   └── redis.js          #   driver Redis (Upstash REST) + RedisRestClient
│   ├── middlewares/
│   │   └── tracking.js       # catat user/chat/statistik (1 batch call)
│   ├── handlers/             # command + callback + text handler
│   │   ├── index.js          #   Registry gaya bot-wa
│   │   ├── general.js        #   start, help, menu, ping, info, id
│   │   ├── settings.js       #   settings, model, toggle, reset
│   │   ├── ai.js             #   ai, reset, history, auto-reply
│   │   └── admin.js          #   stats, health, broadcast, feedbacklist
│   ├── conversations/        # conversation bertahap
│   │   ├── index.js          #   buildConversations + command /echo
│   │   ├── feedback.js       #   /feedback: rating -> komentar -> konfirmasi
│   │   └── echo.js           #   /echo: loop sampai selesai
│   └── services/
│       └── router9.js        # klien 9Router + isOfflineError/describeAiError
├── .env.example
├── vercel.json
└── package.json
```

---

## Verifikasi

```bash
npm run check   # offline: config, utils, store sqlite, store redis (Upstash tiruan),
                # paritas interface driver, keyboards, klien 9Router, wiring bot
npm run e2e     # end-to-end: /start /ping /id /help, AI streaming, /ai, /reset,
                # callback menu & settings, conversation /feedback & /echo,
                # admin & non-admin, webhook (secret benar/salah/body rusak),
                # 9Router mati -> "AI sedang offline"
```

Keduanya tidak butuh token Telegram asli, tidak menyentuh Telegram, dan tidak menyentuh 9Router asli:

- `scripts/selfcheck.cjs` menjalankan server Upstash tiruan (`scripts/fake-upstash.cjs`) untuk menguji driver Redis.
- `scripts/e2e.cjs` meniru API Telegram dengan mem-patch `node-fetch` **sebelum** bot dibuat, karena plugin conversations membuat instance `Api` sendiri.

Simulasi build Vercel (memastikan entry point serverless tetap jalan tanpa modul native `better-sqlite3`):

```bash
SIM=/tmp/vercel-sim
mkdir -p "$SIM"
tar --exclude=node_modules --exclude=.git --exclude=data --exclude=.env -cf - . | (cd "$SIM" && tar -xf -)
cd "$SIM" && npm install --omit=dev --omit=optional   # di Vercel: installCommand di vercel.json
node -e "
const { createStore } = require('./src/store');
require('./api/webhook.js'); require('./api/setup.js'); require('./src/runtime.js');
console.log('entry point serverless bisa dimuat tanpa better-sqlite3 ✅');
"
```

Selain itu, verifikasi manual yang dipakai saat pengembangan:

```bash
node scripts/set-webhook.cjs status   # cek token + webhook lewat Telegram API asli
curl -s "$NINEROUTER_URL/v1/models" | head -c 200   # cek gateway AI
```

---

## Troubleshooting

**Bot tidak merespons apa pun (dan log kosong)**
1. Pastikan ada yang jalan: `pgrep -af 'bot-telegram/src/index.js'`.
2. Cek webhook menggantung: `node scripts/set-webhook.cjs status` → kalau ada URL, `... delete`.
3. Cek log Telegram: `curl -s "https://api.telegram.org/bot$BOT_TOKEN/getWebhookInfo"`.

**`AI sedang offline`**
- Lokal: `systemctl --user status 9router` (atau cek port `20128`).
- Vercel: `NINEROUTER_URL` masih menunjuk `localhost` — serverless tidak bisa menjangkau laptop.
  Pakai URL publik, atau biarkan AI non-aktif (fitur lain tetap jalan).

**Di Vercel muncul peringatan `STORE_DRIVER=sqlite` / session hilang**
- Set `STORE_DRIVER=redis` + kredensial Upstash. Filesystem Vercel read-only & sementara.

**`Konfigurasi belum lengkap: ...` saat start**
- Pesan menyebutkan variabel yang kurang. Isi `.env` (lokal) atau Environment Variables (Vercel).

**`better-sqlite3` gagal di-install / tidak terpasang**
- Paket ini `optionalDependencies`. Di serverless pakai `STORE_DRIVER=redis`; di lokal jalankan `npm install` ulang (butuh build tools) atau pindah ke Redis.
- Di Vercel paket ini sengaja **tidak** dipasang (`installCommand` memakai `--omit=optional`) dan
  require-nya dibuat dinamis di `src/store/sqlite.js` supaya bundler tidak gagal saat build.

**Webhook dibalas `401 "secret token is wrong"`**
- `WEBHOOK_SECRET` di Vercel berbeda dengan yang dipakai saat `set-webhook`. Set ulang:
  `node scripts/set-webhook.cjs set https://<domain>`.

**AI dipotong `⏱️ Jawaban dipotong karena batas waktu server`**
- Normal di plan Hobby (limit 60 detik). Naikkan plan, atau perkecil `AI_MAX_TOKENS`
  dan minta jawaban lebih singkat.

---

## Catatan teknis penting

Beberapa perilaku yang tidak kelihatan dari kode saja dan sudah diverifikasi dengan test:

1. **Conversations tidak mewarisi transformer API.** `@grammyjs/conversations` membuat instance
   `Api` baru dari token (`new Api(protoApi.token, protoApi.options)`), jadi `auto-retry`
   (maupun `bot.api.config.use()` apa pun) **tidak berlaku di dalam conversation**.
   Konsekuensinya: error jaringan Telegram di dalam conversation tidak di-retry.
2. **Body conversation di-replay setiap update.** Semua efek samping (tulis DB, naikkan
   statistik) harus lewat `conversation.external()`; kalau tidak, akan terhitung berkali-kali.
   Karena itu `feedback_flow_started` dinaikkan di command handler, bukan di dalam conversation
   (ada test regresinya di `npm run e2e`).
3. **`ctx.updateType` tidak ada di grammY 1.46.** Tipe update diturunkan dari kunci payload
   `Update` lewat `utils.updateTypeOf()`; tanpa itu statistik tercatat `update_unknown`.
4. **`bot.init()` mengembalikan `void`** — info bot dibaca dari `bot.botInfo`.
5. **Mode webhook butuh runtime yang di-cache.** `src/runtime.js` menyimpan satu runtime per
   instance function (`getRuntime()`), dan men-*reset* cache kalau bootstrap gagal agar request
   berikutnya bisa mencoba lagi.
6. **`webhookCallback(bot, "http", { ... })`** memakai adapter Node polos. Adapter ini
   mengakhiri response sendiri (`res.end()`), dan `onTimeout: "return"` membuat request dibalas
   200 setelah `WEBHOOK_TIMEOUT_MS` — supaya Telegram tidak mengulang update yang sama.
7. **Secret webhook dibandingkan constant-time** oleh grammY (`X-Telegram-Bot-Api-Secret-Token`);
   request dengan token salah dibalas `401`. Setara dengan itu, `/api/setup` memakai
   `crypto.timingSafeEqual` (via SHA-256) untuk `SETUP_SECRET`.
8. **Jumlah pesan AI dihitung counter**, bukan hasil query. Karena itu `trimAiHistory()` dan
   `clearAiHistory()` juga menyesuaikan counter (ada test-nya di `npm run check`).

---

## Lisensi

MIT.
