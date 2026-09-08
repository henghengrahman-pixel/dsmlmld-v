# LIVECHAT AI Railway v1.10.0

Production-oriented LiveChat AI CS untuk Railway + PostgreSQL + OpenAI + Human Bridge Telegram.

## Perubahan utama v1.10.0

- Percakapan LiveChat dibuat near-realtime dengan polling 1 detik dan refresh UI 750 ms. Integrasi saat ini tetap REST polling, jadi bukan websocket/webhook zero-latency.
- Intent gangguan dibedakan tegas dari lupa password:
  - `FORGOT_PASSWORD`: lupa/reset/cek password.
  - `LOGIN_PROBLEM`: tidak bisa login/masuk tanpa indikasi lupa password.
  - `LINK_PROBLEM`: link/web/situs tidak bisa dibuka.
  - `GAME_PROBLEM`: permainan error/keluar sendiri/tidak bisa dibuka.
  - `GENERAL_DISTURBANCE`: gangguan/server bermasalah.
- Semua gangguan di atas dikirim ke Human Bridge Telegram kategori `ISSUE`.
- Reset password tetap mengumpulkan jenis rekening, nama rekening, dan nomor rekening; tidak meminta User ID dari member.
- WD selalu dikirim ke staff Telegram.
- Bonus umum ditanya dulu bonus apa yang mau diklaim; bonus spesifik meminta ID lalu dikirim ke grup bonus.
- Minta ganti rekening dikirim ke grup WD.
- Format pesan Telegram awal dibuat ringkas seperti chat CS biasa; mapping ticket/member tetap tersimpan internal agar reply tidak salah member.
- Belajar dari CS diperkuat:
  - seluruh reply human CS saat Take Over direkam dengan snapshot konteks;
  - semua reply human langsung dapat dipakai sebagai contoh gaya bahasa;
  - jawaban aman yang sama berulang >=3 kali dapat auto-approved sebagai pola belajar;
  - jawaban sensitif (password, rekening, username, link, nominal/status transaksi) tidak auto-approved sebagai fakta;
  - Tegur AI tetap langsung menjadi koreksi APPROVED.
- AI wajib membaca konteks kronologis, conversation digest, Responses Manual, Knowledge, dan learning sebelum balas.
- Jika tidak yakin, AI tidak menebak dan membuat Tanya Staff.

## Contoh format Telegram

Reset password:

```text
NO REK 083173119943
a/nkarni
JENIS REK : dana

reset password ko
```

Bonus harian:

```text
ID : ayam123

claim bonus harian
```

Ganti rekening:

```text
ID : ayam123

minta ganti rekening
```

Gangguan/login/link/game dikirim singkat berisi ID bila sudah ada, jenis gangguan, dan konteks terbaru.

## Routing Human Bridge

- `RESET_PASSWORD` → grup reset password
- `WD_PROBLEM` → grup WD
- `BONUS` → grup bonus
- `ISSUE` → grup gangguan/operasional
- Deposit complaint tetap ke Tanya Staff panel (bukan Telegram), setelah User ID + bukti transfer lengkap.

Semua Chat ID / Topic ID dapat diatur dari panel Human Bridge. Jika kategori dikosongkan, sistem memakai Default Chat ID.

## Railway ENV

```env
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
DATABASE_SSL=false

ADMIN_USERNAME=admin
ADMIN_PASSWORD=GANTI_PASSWORD_ADMIN
SESSION_SECRET=RANDOM_MINIMAL_32_KARAKTER

LIVECHAT_ACCOUNT_ID=ACCOUNT_ID
LIVECHAT_PAT=PAT
LIVECHAT_API_BASE=https://api.livechatinc.com/v3.5/agent/action
LIVECHAT_SYNC_MODE=polling
LIVECHAT_POLL_MS=1000
LIVECHAT_LIST_LIMIT=100
LIVECHAT_INBOX_MODE=my_active
LIVECHAT_BOOTSTRAP_REPLY_MAX_AGE_SECONDS=30

OPENAI_API_KEY=OPENAI_KEY
OPENAI_MODEL=gpt-5.6-luna
OPENAI_API_STYLE=responses
OPENAI_MAX_OUTPUT_TOKENS=220
OPENAI_TIMEOUT_MS=20000

AI_MODE=safe_auto
AI_CONFIDENCE_THRESHOLD=0.86
AI_MAX_CONTEXT_MESSAGES=24
AUTO_REPLY_ENABLED=true
APP_TIMEZONE=Asia/Jakarta
AI_GREETING_ENABLED=true
AI_HUMAN_ASK_ENABLED=true
LIVECHAT_CANNED_SYNC_ENABLED=false
```

## Deploy

1. Deploy ZIP ke Railway.
2. Hubungkan PostgreSQL menggunakan `DATABASE_URL` reference.
3. Redeploy.
4. Test LiveChat dan Test OpenAI.
5. Atur Human Bridge Telegram: Reset Password, WD, Bonus, Issue.
6. Pastikan LIVECHAT AI = ON.
7. Uji chat baru sebelum traffic penuh.

Migration berjalan otomatis dan tidak perlu menghapus database lama.


## v1.10.1
- Perbaikan menu Belajar dari CS kosong: backfill otomatis dari seluruh balasan human CS yang sudah tersimpan di database.
- Tambah tombol Scan Chat CS Sekarang untuk memindai ulang sampai 5000 balasan human yang belum pernah dijadikan kandidat.
- Balasan CS baru tetap ditangkap realtime seperti sebelumnya.

## v1.10.2 — WD/reset flow + LiveChat-like chat UI
- Reset password: setelah jenis/nama/nomor rekening lengkap, langsung Human Bridge dan member menerima pesan tunggu standar.
- WD: jika ID belum ada, minta ID; setelah ada, kirim cek kepastian WD ke grup dan member menerima pesan proses WD.
- Reply CS `WD pending` / `masih proses`: disimpan sebagai status tanpa mengirim balasan tambahan; AI baru merespons ketika member mengirim pesan berikutnya.
- Reply CS `DANA limit/limid`: member diminta rekening pengganti dengan nama pemilik yang sama; workflow mengumpulkan nama/nomor/jenis rekening sebelum meneruskan pengalihan WD ke grup.
- Dashboard Percakapan: bubble arah kiri/kanan seperti LiveChat, line break dipertahankan, waktu tampil per pesan, composer multiline di bawah (Enter kirim, Shift+Enter baris baru).
- Balasan manual dari dashboard saat Take Over langsung masuk pipeline Belajar dari CS.

## v1.10.3 — Reset password stateful verification

Reset password sekarang menyatukan data rekening walaupun member mengirim satu per satu. Field disimpan di workflow percakapan dan bot hanya menanyakan satu field yang benar-benar belum ada: nama rekening, jenis bank/e-wallet, lalu nomor rekening. Setelah semuanya lengkap, ticket langsung masuk grup Reset Password.

Ticket reset punya tindakan **Deposit dahulu** dan **Rekening tidak terdaftar**. Jika Deposit dahulu dipilih, sistem mencari rekening deposit pada Responses Manual sesuai jenis rekening member; jika tidak tersedia (termasuk SeaBank), sistem memakai response BCA. Nomor rekening tidak pernah dibuat atau ditebak. Jika response BCA juga tidak tersedia, tindakan gagal aman dan ticket tetap dapat ditangani staff.

Setelah member menyatakan sudah deposit, sistem membuat ticket reset baru dengan pesan `member sudah deposit, silahkan dicek dan di reset`. Ticket tahap ini punya tombol **DANA belum masuk** atau staff dapat langsung reply berisi User ID/Username + Password (+ link login bila ada). Reply tersebut hanya diteruskan ke LiveChat yang terikat ticket.

Default response **Rekening tidak terdaftar** dan **Deposit belum masuk** disediakan melalui Responses Manual dan tetap dapat diedit dari dashboard.
