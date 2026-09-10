import crypto from 'node:crypto';
import pg from 'pg';
import { config } from './config.js';
import { isSafeHistoryExample, learningSignature } from './learning.js';
import { semanticScore } from './semantic.js';
const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized:false } : false,
  max: 15,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000
});

export async function migrate() {
  const sql = `
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS conversations (
    chat_id TEXT PRIMARY KEY, customer_name TEXT, customer_email TEXT, status TEXT NOT NULL DEFAULT 'active',
    human_takeover_until TIMESTAMPTZ, last_event_at TIMESTAMPTZ, last_member_event_at TIMESTAMPTZ,
    last_ai_event_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE conversations ADD COLUMN IF NOT EXISTS visible_in_inbox BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE conversations ADD COLUMN IF NOT EXISTS lc_is_followed BOOLEAN;
  ALTER TABLE conversations ADD COLUMN IF NOT EXISTS lc_active BOOLEAN;
  ALTER TABLE conversations ADD COLUMN IF NOT EXISTS lc_routing_status TEXT;
  ALTER TABLE conversations ADD COLUMN IF NOT EXISTS lc_summary JSONB;
  ALTER TABLE conversations ADD COLUMN IF NOT EXISTS bootstrapped_at TIMESTAMPTZ;
  ALTER TABLE conversations ADD COLUMN IF NOT EXISTS greeting_sent_at TIMESTAMPTZ;
  ALTER TABLE conversations ADD COLUMN IF NOT EXISTS greeting_thread_id TEXT;
  ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ai_waiting_human BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE conversations ADD COLUMN IF NOT EXISTS handling_mode TEXT NOT NULL DEFAULT 'AI';
  ALTER TABLE conversations ADD COLUMN IF NOT EXISTS takeover_reason TEXT;
  ALTER TABLE conversations ADD COLUMN IF NOT EXISTS takeover_at TIMESTAMPTZ;
  ALTER TABLE conversations ADD COLUMN IF NOT EXISTS workflow_type TEXT;
  ALTER TABLE conversations ADD COLUMN IF NOT EXISTS workflow_state TEXT;
  ALTER TABLE conversations ADD COLUMN IF NOT EXISTS workflow_data JSONB NOT NULL DEFAULT '{}'::jsonb;
  ALTER TABLE conversations ADD COLUMN IF NOT EXISTS member_typing BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE conversations ADD COLUMN IF NOT EXISTS member_typing_updated_at TIMESTAMPTZ;
  ALTER TABLE conversations ADD COLUMN IF NOT EXISTS conversation_digest TEXT;
  ALTER TABLE conversations ADD COLUMN IF NOT EXISTS digest_message_count INT NOT NULL DEFAULT 0;
  ALTER TABLE conversations ADD COLUMN IF NOT EXISTS digest_updated_at TIMESTAMPTZ;
  ALTER TABLE conversations ADD COLUMN IF NOT EXISTS case_brain JSONB NOT NULL DEFAULT '{}'::jsonb;
  ALTER TABLE conversations ADD COLUMN IF NOT EXISTS brain_message_count INT NOT NULL DEFAULT 0;
  ALTER TABLE conversations ADD COLUMN IF NOT EXISTS brain_updated_at TIMESTAMPTZ;
  ALTER TABLE conversations ADD COLUMN IF NOT EXISTS lc_inbox_rank INT;
  ALTER TABLE conversations ADD COLUMN IF NOT EXISTS inbox_last_seen_at TIMESTAMPTZ;
  ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;
  ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_handling_mode_check;
  ALTER TABLE conversations ADD CONSTRAINT conversations_handling_mode_check CHECK (handling_mode IN ('AI','HUMAN'));
  CREATE INDEX IF NOT EXISTS idx_conversations_handling_mode ON conversations(handling_mode, visible_in_inbox);
  CREATE TABLE IF NOT EXISTS messages (
    id BIGSERIAL PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES conversations(chat_id) ON DELETE CASCADE,
    event_id TEXT NOT NULL, sender_type TEXT NOT NULL, author_id TEXT, text TEXT NOT NULL, normalized_text TEXT,
    intent TEXT, created_at TIMESTAMPTZ NOT NULL, ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(chat_id,event_id)
  );
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;
  CREATE INDEX IF NOT EXISTS idx_messages_chat_created ON messages(chat_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS outbound_messages (
    id BIGSERIAL PRIMARY KEY, chat_id TEXT NOT NULL, text TEXT NOT NULL, livechat_event_id TEXT, text_hash TEXT,
    status TEXT NOT NULL DEFAULT 'sent', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_outbound_chat_created ON outbound_messages(chat_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS ai_logs (
    id BIGSERIAL PRIMARY KEY, chat_id TEXT, source_event_id TEXT, intent TEXT, action TEXT, confidence DOUBLE PRECISION,
    reply TEXT, reason TEXT, prompt_tokens INT, output_tokens INT, total_tokens INT, error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS knowledge_base (
    id BIGSERIAL PRIMARY KEY, category TEXT NOT NULL DEFAULT 'GENERAL', title TEXT NOT NULL, content TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS bot_promo_rules (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
    min_deposit TEXT,
    max_bonus TEXT,
    turnover TEXT,
    claim_limit TEXT,
    active_hours TEXT,
    game_scope TEXT,
    rules TEXT,
    reply_template TEXT,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_bot_promo_active ON bot_promo_rules(active,updated_at DESC);
  CREATE TABLE IF NOT EXISTS bot_important_info (
    id BIGSERIAL PRIMARY KEY,
    item_type TEXT NOT NULL DEFAULT 'INFO_PENTING',
    item_key TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
    meta JSONB NOT NULL DEFAULT '{}'::jsonb,
    priority INT NOT NULL DEFAULT 100,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(item_type,item_key)
  );
  CREATE INDEX IF NOT EXISTS idx_bot_important_active ON bot_important_info(active,item_type,priority DESC,updated_at DESC);
  CREATE TABLE IF NOT EXISTS livechat_canned_responses (
    source_id TEXT PRIMARY KEY, shortcut TEXT, content TEXT NOT NULL, tags JSONB NOT NULL DEFAULT '[]'::jsonb, scope TEXT,
    source_updated_at TIMESTAMPTZ, active BOOLEAN NOT NULL DEFAULT true, raw JSONB,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT now(), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE livechat_canned_responses ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'api';
  ALTER TABLE livechat_canned_responses ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'GENERAL';
  ALTER TABLE livechat_canned_responses ADD COLUMN IF NOT EXISTS response_mode TEXT NOT NULL DEFAULT 'FLEXIBLE';
  ALTER TABLE livechat_canned_responses ADD COLUMN IF NOT EXISTS title TEXT;
  CREATE INDEX IF NOT EXISTS idx_lc_canned_active ON livechat_canned_responses(active, updated_at DESC);
  CREATE TABLE IF NOT EXISTS human_requests (
    id BIGSERIAL PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES conversations(chat_id) ON DELETE CASCADE,
    source_event_id TEXT, intent TEXT, member_message TEXT NOT NULL, ai_question TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN', human_answer TEXT, final_reply TEXT, save_as_knowledge BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), answered_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_human_requests_status ON human_requests(status, created_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_human_requests_one_open_chat ON human_requests(chat_id) WHERE status='OPEN';
  CREATE TABLE IF NOT EXISTS telegram_bridge_settings (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK(id=1), bot_token_enc TEXT, bot_username TEXT, default_chat_id TEXT,
    routes JSONB NOT NULL DEFAULT '{}'::jsonb, enabled BOOLEAN NOT NULL DEFAULT false, last_update_id BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  INSERT INTO telegram_bridge_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
  CREATE TABLE IF NOT EXISTS human_bridge_tickets (
    id BIGSERIAL PRIMARY KEY, ticket_code TEXT UNIQUE NOT NULL, human_request_id BIGINT UNIQUE NOT NULL REFERENCES human_requests(id) ON DELETE CASCADE,
    chat_id TEXT NOT NULL REFERENCES conversations(chat_id) ON DELETE CASCADE, category TEXT NOT NULL,
    telegram_chat_id TEXT, telegram_topic_id TEXT, telegram_message_id TEXT, telegram_reply_message_id TEXT,
    human_answer TEXT, status TEXT NOT NULL DEFAULT 'OPEN', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at TIMESTAMPTZ, answered_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_tg_ticket ON human_bridge_tickets(telegram_chat_id,telegram_message_id) WHERE telegram_message_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_bridge_status ON human_bridge_tickets(status,created_at DESC);
  ALTER TABLE human_bridge_tickets ADD COLUMN IF NOT EXISTS last_delivery_error TEXT;
  ALTER TABLE human_bridge_tickets ADD COLUMN IF NOT EXISTS delivery_attempts INT NOT NULL DEFAULT 0;
  CREATE TABLE IF NOT EXISTS ai_rules (
    id BIGSERIAL PRIMARY KEY, category TEXT NOT NULL DEFAULT 'GLOBAL', rule_type TEXT NOT NULL DEFAULT 'FORBID',
    content TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS learning_examples (
    id BIGSERIAL PRIMARY KEY, source_type TEXT NOT NULL DEFAULT 'HUMAN_CHAT', intent TEXT NOT NULL DEFAULT 'GENERAL',
    member_text TEXT NOT NULL, response_text TEXT NOT NULL, correction_text TEXT, status TEXT NOT NULL DEFAULT 'PENDING',
    occurrences INT NOT NULL DEFAULT 1, chat_id TEXT, source_event_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), approved_at TIMESTAMPTZ
  );
  ALTER TABLE learning_examples ADD COLUMN IF NOT EXISTS context_snapshot TEXT;
  ALTER TABLE learning_examples ADD COLUMN IF NOT EXISTS style_only BOOLEAN NOT NULL DEFAULT false;
  CREATE INDEX IF NOT EXISTS idx_learning_status ON learning_examples(status,updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_learning_intent ON learning_examples(intent,status);
  CREATE TABLE IF NOT EXISTS cs_learning_patterns (
    id BIGSERIAL PRIMARY KEY, intent TEXT NOT NULL DEFAULT 'GENERAL', response_signature TEXT NOT NULL,
    sample_member TEXT, sample_response TEXT NOT NULL, occurrences INT NOT NULL DEFAULT 1,
    safe_for_reply BOOLEAN NOT NULL DEFAULT false, first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(intent,response_signature)
  );
  CREATE INDEX IF NOT EXISTS idx_cs_learning_patterns_intent ON cs_learning_patterns(intent,safe_for_reply,occurrences DESC,last_seen_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_learning_source_event ON learning_examples(chat_id,source_event_id) WHERE source_event_id IS NOT NULL;
  CREATE TABLE IF NOT EXISTS ai_message_feedback (
    id BIGSERIAL PRIMARY KEY, chat_id TEXT NOT NULL, event_id TEXT NOT NULL, rating TEXT NOT NULL,
    note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(chat_id,event_id)
  );
  CREATE INDEX IF NOT EXISTS idx_ai_message_feedback_rating ON ai_message_feedback(rating,updated_at DESC);
  CREATE TABLE IF NOT EXISTS errors (
    id BIGSERIAL PRIMARY KEY, source TEXT NOT NULL, code TEXT, message TEXT NOT NULL, details JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  INSERT INTO app_settings(key,value) VALUES('system_enabled', 'true'::jsonb) ON CONFLICT DO NOTHING;
  INSERT INTO app_settings(key,value) VALUES('auto_reply', to_jsonb(${config.autoReplyDefault}::boolean)) ON CONFLICT DO NOTHING;
  INSERT INTO app_settings(key,value) VALUES('greeting_enabled', to_jsonb(${config.greetingEnabled}::boolean)) ON CONFLICT DO NOTHING;
  INSERT INTO app_settings(key,value) VALUES('human_ask_enabled', to_jsonb(${config.humanAskEnabled}::boolean)) ON CONFLICT DO NOTHING;
  INSERT INTO app_settings(key,value) VALUES('reply_style', '"NATURAL_CS"'::jsonb) ON CONFLICT DO NOTHING;
  INSERT INTO app_settings(key,value) VALUES('reply_length', '"SHORT"'::jsonb) ON CONFLICT DO NOTHING;
  INSERT INTO app_settings(key,value) VALUES('bosku_usage', '"MODERATE"'::jsonb) ON CONFLICT DO NOTHING;
  INSERT INTO app_settings(key,value) VALUES('emoji_usage', '"LIGHT"'::jsonb) ON CONFLICT DO NOTHING;
  INSERT INTO app_settings(key,value) VALUES('formal_language', 'false'::jsonb) ON CONFLICT DO NOTHING;
  INSERT INTO app_settings(key,value) VALUES('reply_style_note', '""'::jsonb) ON CONFLICT DO NOTHING;
  INSERT INTO livechat_canned_responses(source_id,shortcut,title,category,content,tags,scope,source_kind,response_mode,active,raw,synced_at,updated_at)
  SELECT 'system:wd_antrian','#WD_ANTRIAN','WD Sedang Dalam Antrian','WITHDRAW_PROBLEM','WD-nya masih dalam antrian proses ya bosku 🙏 Mohon ditunggu sebentar, nanti akan diproses sesuai urutan.','["wd","antrian","withdraw"]'::jsonb,'system','manual','FLEXIBLE',true,'{}'::jsonb,now(),now()
  WHERE NOT EXISTS (SELECT 1 FROM livechat_canned_responses WHERE shortcut ILIKE '#WD_ANTRIAN');
  INSERT INTO livechat_canned_responses(source_id,shortcut,title,category,content,tags,scope,source_kind,response_mode,active,raw,synced_at,updated_at)
  SELECT 'system:minta_rek_valid','#MINTA_REK_VALID','Minta Rekening Valid','WITHDRAW_PROBLEM','Boleh bantu kirim rekening yang valid ya bosku 🙏 Sertakan jenis rekening/bank atau e-wallet, nama pemilik rekening, dan nomor rekening/nomor akun.','["wd","rekening","valid"]'::jsonb,'system','manual','FLEXIBLE',true,'{}'::jsonb,now(),now()
  WHERE NOT EXISTS (SELECT 1 FROM livechat_canned_responses WHERE shortcut ILIKE '#MINTA_REK_VALID');
  INSERT INTO livechat_canned_responses(source_id,shortcut,title,category,content,tags,scope,source_kind,response_mode,active,raw,synced_at,updated_at)
  SELECT 'system:dana_limit','#DANA_LIMIT','DANA Limit','WITHDRAW_PROBLEM','DANA tujuan sedang terkena limit ya bosku. Boleh bantu kirim rekening/e-wallet lain dengan nama pemilik yang sama, lengkap dengan jenis rekening, nama pemilik, dan nomor rekening/nomor akun 🙏','["wd","dana","limit"]'::jsonb,'system','manual','FLEXIBLE',true,'{}'::jsonb,now(),now()
  WHERE NOT EXISTS (SELECT 1 FROM livechat_canned_responses WHERE shortcut ILIKE '#DANA_LIMIT');
  UPDATE livechat_canned_responses
  SET content='Withdraw bosku sedang kami proses ya 😊🙏
Mohon ditunggu beberapa saat. Jika bosku ingin meninggalkan akun terlebih dahulu juga tidak masalah, withdraw tetap akan kami proses sampai selesai ya bosku ☺️❤️', updated_at=now()
  WHERE source_id='system:wd_antrian'
    AND content='WD-nya masih dalam antrian proses ya bosku 🙏 Mohon ditunggu sebentar, nanti akan diproses sesuai urutan.';
  UPDATE livechat_canned_responses
  SET content='Di sini kami cek rekening bosku sedang limit. Silakan dibantu rekening dengan atas nama yang sama ya bosku, tarik dana akan kami alihkan ke rekening tersebut karena kendala tarik dana bosku sedang limit.

Nama rek :
Nomor rek :
Jenis rek :', updated_at=now()
  WHERE source_id='system:dana_limit'
    AND content='DANA tujuan sedang terkena limit ya bosku. Boleh bantu kirim rekening/e-wallet lain dengan nama pemilik yang sama, lengkap dengan jenis rekening, nama pemilik, dan nomor rekening/nomor akun 🙏';
  INSERT INTO livechat_canned_responses(source_id,shortcut,title,category,content,tags,scope,source_kind,response_mode,active,raw,synced_at,updated_at)
  SELECT 'system:reset_deposit_first','#RESET_DEPOSIT_DULU','Reset - Deposit Dahulu','FORGOT_PASSWORD','Untuk proses reset password, silakan lakukan deposit terlebih dahulu ya bosku 🙏 Setelah itu kabari kami lagi agar bisa kami bantu lanjutkan.','["reset","password","deposit"]'::jsonb,'system','manual','FLEXIBLE',true,'{}'::jsonb,now(),now()
  WHERE NOT EXISTS (SELECT 1 FROM livechat_canned_responses WHERE shortcut ILIKE '#RESET_DEPOSIT_DULU');
  INSERT INTO livechat_canned_responses(source_id,shortcut,title,category,content,tags,scope,source_kind,response_mode,active,raw,synced_at,updated_at)
  SELECT 'system:checking','#SEDANG_DICEK','Sedang Dicek','GENERAL','Mohon tunggu sebentar ya bosku 😊
Kami cek terlebih dahulu permintaannya. Terima kasih atas kesabarannya 🙏','["cek","tunggu","proses"]'::jsonb,'system','manual','FLEXIBLE',true,'{}'::jsonb,now(),now()
  WHERE NOT EXISTS (SELECT 1 FROM livechat_canned_responses WHERE shortcut ILIKE '#SEDANG_DICEK');
  INSERT INTO livechat_canned_responses(source_id,shortcut,title,category,content,tags,scope,source_kind,response_mode,active,raw,synced_at,updated_at)
  SELECT 'system:bonus_done','#BONUS_DONE','Bonus Done','BONUS','Bonusnya sudah selesai diproses ya bosku 😊 Silakan cek kembali akun bosku.','["bonus","done"]'::jsonb,'system','manual','FLEXIBLE',true,'{}'::jsonb,now(),now()
  WHERE NOT EXISTS (SELECT 1 FROM livechat_canned_responses WHERE shortcut ILIKE '#BONUS_DONE');
  INSERT INTO livechat_canned_responses(source_id,shortcut,title,category,content,tags,scope,source_kind,response_mode,active,raw,synced_at,updated_at)
  SELECT 'system:bonus_deposit_first','#BONUS_DEPOSIT_DULU','Bonus - Deposit Dahulu','BONUS','Silakan melakukan deposit terlebih dahulu ya bosku 🙏 Setelah deposit selesai, kabari kami lagi supaya bisa dibantu cek bonusnya.','["bonus","deposit"]'::jsonb,'system','manual','FLEXIBLE',true,'{}'::jsonb,now(),now()
  WHERE NOT EXISTS (SELECT 1 FROM livechat_canned_responses WHERE shortcut ILIKE '#BONUS_DEPOSIT_DULU');
  INSERT INTO livechat_canned_responses(source_id,shortcut,title,category,content,tags,scope,source_kind,response_mode,active,raw,synced_at,updated_at)
  SELECT 'system:complaint','#KOMPLAIN','Keluhan Member','COMPLAINT','Kami paham bosku lagi kecewa. Kalau ada kendala teknis atau transaksi yang mau dicek, kirim detailnya ya, kami bantu cek satu-satu 🙏','["komplain","kecewa","kendala"]'::jsonb,'system','manual','FLEXIBLE',true,'{}'::jsonb,now(),now()
  WHERE NOT EXISTS (SELECT 1 FROM livechat_canned_responses WHERE shortcut ILIKE '#KOMPLAIN');
  INSERT INTO livechat_canned_responses(source_id,shortcut,title,category,content,tags,scope,source_kind,response_mode,active,raw,synced_at,updated_at)
  SELECT 'system:reset_not_registered','#RESET_TIDAK_TERDAFTAR','Reset - Rekening Tidak Terdaftar','FORGOT_PASSWORD','Mohon maaf ya, bosku. Setelah kami cek, data yang diberikan belum terdaftar di situs kami 🙏😊

Jika bosku berminat, kami bisa bantu proses pendaftaran akun baru. Atau bosku juga bisa daftar langsung melalui link berikut:

🔗 LINK PENDAFTARAN:
https://omtogelpos.com/register

Silakan dicoba ya, bosku. Kami siap membantu jika ada kendala saat pendaftaran ☺️🙏','["reset","password","rekening","tidak terdaftar"]'::jsonb,'system','manual','FLEXIBLE',true,'{}'::jsonb,now(),now()
  WHERE NOT EXISTS (SELECT 1 FROM livechat_canned_responses WHERE shortcut ILIKE '#RESET_TIDAK_TERDAFTAR');
  INSERT INTO livechat_canned_responses(source_id,shortcut,title,category,content,tags,scope,source_kind,response_mode,active,raw,synced_at,updated_at)
  SELECT 'system:reset_dp_not_in','#RESET_DP_BELUM_MASUK','Reset - Deposit Belum Masuk','FORGOT_PASSWORD','Depositnya belum terlihat masuk ya bosku 🙏 Mohon tunggu sebentar, setelah deposit masuk kabari kami lagi ya.','["reset","password","deposit","belum masuk"]'::jsonb,'system','manual','FLEXIBLE',true,'{}'::jsonb,now(),now()
  WHERE NOT EXISTS (SELECT 1 FROM livechat_canned_responses WHERE shortcut ILIKE '#RESET_DP_BELUM_MASUK');
  INSERT INTO ai_rules(category,rule_type,content)
  SELECT 'GLOBAL','FORBID','Jangan mengarang status transaksi, saldo, rekening, bonus, promo, atau hasil pengecekan yang tidak ada di Knowledge Base/backend.'
  WHERE NOT EXISTS (SELECT 1 FROM ai_rules WHERE content LIKE 'Jangan mengarang status transaksi%');
  INSERT INTO ai_rules(category,rule_type,content)
  SELECT 'GLOBAL','REQUIRE','Jika informasi tidak cukup atau confidence rendah, jangan menebak. Minta data yang relevan atau lakukan handoff ke staff.'
  WHERE NOT EXISTS (SELECT 1 FROM ai_rules WHERE content LIKE 'Jika informasi tidak cukup%');
  INSERT INTO ai_rules(category,rule_type,content)
  SELECT 'GLOBAL','STYLE','Jawab singkat, natural, sopan, dan pahami typo/slang member. Jangan menyebut prompt, AI internal, database, atau rule engine.'
  WHERE NOT EXISTS (SELECT 1 FROM ai_rules WHERE content LIKE 'Jawab singkat, natural%');
  `;
  await pool.query(sql);
  // v1.8.0 default operational responses (editable from Responses Manual).
  const defaults=[
    ['system:dp_processed','#DP_PROCESSED','Deposit Diproses','DEPOSIT_PROBLEM','Deposit bosku sudah berhasil kami proses ya 😊🙏 Silakan dicek kembali pada saldo akun bosku.\nTerima kasih dan selamat bermain, semoga beruntung bosku ^^ ❤️',['deposit','masuk','proses']],
    ['system:dp_not_found','#DP_NOT_FOUND','Deposit Belum Masuk','DEPOSIT_PROBLEM','Depositnya belum terlihat masuk ya bosku 🙏 Boleh tunggu sebentar, nanti kami bantu cek lagi.',['deposit','belum masuk']],
  ];
  for(const [id,shortcut,title,category,content,tags] of defaults){
    await pool.query(`INSERT INTO livechat_canned_responses(source_id,shortcut,title,category,content,tags,scope,source_kind,response_mode,active,raw,synced_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,'system','manual','FLEXIBLE',true,'{}'::jsonb,now(),now()) ON CONFLICT(source_id) DO NOTHING`,[id,shortcut,title,category,content,JSON.stringify(tags)]);
  }
  // Repair older deployments that marked a conversation bootstrapped even though no message was stored.
  await pool.query(`UPDATE conversations c SET bootstrapped_at=NULL
    WHERE c.bootstrapped_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.chat_id=c.chat_id)`);
  // v1.5.0: one-time switch to automatic AI handling. Global Auto Reply remains an emergency switch.
  const v150=await pool.query(`INSERT INTO app_settings(key,value) VALUES('migration_v150_auto_ai','true'::jsonb) ON CONFLICT DO NOTHING RETURNING key`);
  if(v150.rowCount){
    await pool.query(`UPDATE app_settings SET value='true'::jsonb,updated_at=now() WHERE key='auto_reply'`);
    await pool.query(`UPDATE conversations SET handling_mode=CASE WHEN human_takeover_until IS NOT NULL AND human_takeover_until>now() THEN 'HUMAN' ELSE 'AI' END, takeover_reason=CASE WHEN human_takeover_until IS NOT NULL AND human_takeover_until>now() THEN 'legacy_takeover' ELSE NULL END, takeover_at=CASE WHEN human_takeover_until IS NOT NULL AND human_takeover_until>now() THEN now() ELSE NULL END, human_takeover_until=NULL`);
  }

  // v1.6.0: automatic LiveChat promo/welcome messages are SYSTEM events, never human takeover.
  // Repair conversations that older versions may have incorrectly marked as HUMAN because of this message.
  const v160=await pool.query(`INSERT INTO app_settings(key,value) VALUES('migration_v160_auto_greeting_trigger','true'::jsonb) ON CONFLICT DO NOTHING RETURNING key`);
  if(v160.rowCount){
    const promoLike='%Lebih Mudah Menghubungi Kami Via Telegram & Whatsapp Hanya Dengan Klik Link%';
    await pool.query(`UPDATE messages SET sender_type='system',intent='GREETING_TRIGGER'
      WHERE sender_type='agent' AND text ILIKE $1`,[promoLike]).catch(()=>{});
    await pool.query(`UPDATE conversations c SET handling_mode='AI',takeover_reason=NULL,takeover_at=NULL,human_takeover_until=NULL,updated_at=now()
      WHERE c.takeover_reason='agent_reply_livechat'
        AND EXISTS (SELECT 1 FROM messages m WHERE m.chat_id=c.chat_id AND m.text ILIKE $1)
        AND NOT EXISTS (
          SELECT 1 FROM messages h WHERE h.chat_id=c.chat_id AND h.sender_type='agent' AND h.text NOT ILIKE $1
            AND h.created_at >= COALESCE(c.takeover_at, now()-interval '1 hour')
        )`,[promoLike]).catch(()=>{});
  }

  // v1.9.0: bonus clarification, calm complaint handling, panel-only unknown cases,
  // and Telegram routing limited to Reset Password / WD / Bonus.
  const v190=await pool.query(`INSERT INTO app_settings(key,value) VALUES('migration_v190_behavior','true'::jsonb) ON CONFLICT DO NOTHING RETURNING key`);
  if(v190.rowCount){
    const defaults190=[
      ['system:bonus_ask_type','#BONUS_TANYA','Tanya Jenis Bonus','BONUS','Bonus apa yang mau diklaim ya bosku? 😊',['bonus','claim','jenis bonus']],
      ['system:complaint_abuse','#KOMPLAIN_MAKI','Komplain / Maki','COMPLAINT','Mohon maaf ya bosku 🙏 Ada kendala apa yang bisa kami bantu cek?',['komplain','marah','maki']],
      ['system:complaint_repeat','#KOMPLAIN_MAKI_ULANG','Komplain Berulang','COMPLAINT','Mohon maaf bosku 🙏 Oke bosku, kalau ada kendala yang mau dibantu cek kabari kami ya.',['komplain','maki','berulang']],
      ['system:complaint_loss','#KOMPLAIN_KALAH','Keluhan Kalah','COMPLAINT','Mohon maaf ya bosku 🙏 Kalau ada kendala di permainan atau transaksi, bilang bagian mana yang bermasalah biar kami bantu cek.',['kalah','rungkad','rugi']]
    ];
    for(const [id,shortcut,title,category,content,tags] of defaults190){
      await pool.query(`INSERT INTO livechat_canned_responses(source_id,shortcut,title,category,content,tags,scope,source_kind,response_mode,active,raw,synced_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,'system','manual','FLEXIBLE',true,'{}'::jsonb,now(),now())
        ON CONFLICT(source_id) DO UPDATE SET shortcut=EXCLUDED.shortcut,title=EXCLUDED.title,category=EXCLUDED.category,content=EXCLUDED.content,tags=EXCLUDED.tags,updated_at=now()`,
        [id,shortcut,title,category,content,JSON.stringify(tags)]);
    }
    await pool.query(`UPDATE livechat_canned_responses SET content='Mohon maaf ya bosku 🙏 Ada kendala apa yang bisa kami bantu cek?',updated_at=now()
      WHERE source_id='system:complaint'`).catch(()=>{});
    const rules190=[
      ['GLOBAL','REQUIRE','Jika member meminta bonus tanpa menyebut jenis bonus, tanyakan dulu bonus apa yang ingin diklaim.'],
      ['GLOBAL','REQUIRE','Jika member marah atau berkata kasar, tetap tenang dan minta maaf. Jangan membalas kasar atau berdebat.'],
      ['GLOBAL','FORBID','Jangan menjanjikan kemenangan, keuntungan, atau menyuruh member mengejar kekalahan. Informasi RTP/permainan hanya boleh diberikan sebagai informasi tanpa jaminan hasil.'],
      ['GLOBAL','REQUIRE','Jika tidak memahami maksud member atau data tidak cukup untuk jawaban pasti, jangan menebak dan jangan kirim balasan asal. Buat Tanya Staff di panel.'],
      ['GLOBAL','REQUIRE','Telegram Human Bridge hanya untuk Reset Password, WD, dan Bonus. Kasus lain tetap di Tanya Staff panel.']
    ];
    for(const [category,ruleType,content] of rules190){
      await pool.query(`INSERT INTO ai_rules(category,rule_type,content) SELECT $1,$2,$3 WHERE NOT EXISTS(SELECT 1 FROM ai_rules WHERE content=$3)`,[category,ruleType,content]);
    }
  }

  // v1.16.0: official weekly OMTOGEL promotion knowledge + claim routing semantics.
  const v1160=await pool.query(`INSERT INTO app_settings(key,value) VALUES('migration_v1160_weekly_bonus','true'::jsonb) ON CONFLICT DO NOTHING RETURNING key`);
  if(v1160.rowCount){
    await pool.query(`INSERT INTO livechat_canned_responses(source_id,shortcut,title,category,content,tags,scope,source_kind,response_mode,active,raw,synced_at,updated_at)
      VALUES('system:bonus_mingguan','#BONUS_MINGGUAN','Bonus Mingguan Spektakuler','BONUS',
      $1,'["bonus","mingguan","cashback","turnover","rollingan","senin","selasa","kamis"]'::jsonb,'system','manual','EXACT',true,'{}'::jsonb,now(),now())
      ON CONFLICT(source_id) DO UPDATE SET shortcut=EXCLUDED.shortcut,title=EXCLUDED.title,category=EXCLUDED.category,content=EXCLUDED.content,tags=EXCLUDED.tags,response_mode='EXACT',active=true,updated_at=now()`,[
`💰 BONUS MINGGUAN SPEKTAKULER 💰

Hallo Bosku,
Untuk Bonus di OMTOGEL dibagi menjadi 3x bosku dalam satu minggu yaitu :

💸 Bonus Cashback Live Games & Slot 5% up to 10% ( Hari Senin )
💸 Bonus Event Lomba Turnover Live Games & Slot ( Hari Selasa )
💸 Bonus Rollingan Slot & Live Games 1% ( Hari Kamis )

Note: Bonus mingguan akan langsung masuk ke dalam akun secara otomatis jika akun anda mencapai syarat dan ketentuan bosku 😘😘`
    ]);

    const promos1160=[
      ['Bonus Cashback Live Games & Slot 5% up to 10%',['bonus cashback','cashback live games','cashback slot','bonus senin','cashback senin'],'5% up to 10%','Hari Senin','Live Games & Slot'],
      ['Bonus Event Lomba Turnover Live Games & Slot',['event turnover','lomba turnover','bonus selasa','turnover live games','turnover slot'],null,'Hari Selasa','Live Games & Slot'],
      ['Bonus Rollingan Slot & Live Games 1%',['bonus rollingan','rollingan slot','rollingan live games','bonus kamis','rollingan kamis'],'1%','Hari Kamis','Slot & Live Games']
    ];
    for(const [name,keywords,rate,day,scope] of promos1160){
      await pool.query(`INSERT INTO bot_promo_rules(name,keywords,max_bonus,claim_limit,game_scope,rules,reply_template,active)
        SELECT $1,$2::jsonb,$3,$4,$5,$6,$7,true
        WHERE NOT EXISTS(SELECT 1 FROM bot_promo_rules WHERE lower(name)=lower($1))`,[
        name,JSON.stringify(keywords),rate,day,scope,
        `Promo mingguan OMTOGEL. Jadwal: ${day}. Bonus masuk otomatis jika akun memenuhi syarat dan ketentuan. Jika member meminta claim atau bonus belum masuk, minta User ID bila belum ada lalu konfirmasi ke grup Bonus Telegram untuk pengecekan CS. Jangan mengarang status kelayakan atau hasil claim.`,
        `Jika menanyakan promo, jelaskan jadwal dan jenis bonus sesuai data resmi. Jika member claim, teruskan ke CS setelah User ID tersedia.`
      ]);
    }
    const rules1160=[
      ['BONUS_INFO','REQUIRE','Pertanyaan tentang jadwal, jenis, persentase, atau ketentuan bonus harus dijawab dari Bonus Mingguan / Promo Rules yang aktif dan tidak boleh membuka tiket Telegram jika member belum meminta claim.'],
      ['BONUS_REQUEST','REQUIRE','Jika member meminta claim bonus atau mengatakan bonus yang seharusnya diterima belum masuk, minta User ID jika belum tersedia lalu kirim permintaan ke grup Bonus Telegram.'],
      ['BONUS_REQUEST','FORBID','Jangan mengklaim bonus sudah masuk, member memenuhi syarat, atau claim sudah selesai sebelum ada konfirmasi staff/backend.']
    ];
    for(const [category,ruleType,content] of rules1160){
      await pool.query(`INSERT INTO ai_rules(category,rule_type,content) SELECT $1,$2,$3 WHERE NOT EXISTS(SELECT 1 FROM ai_rules WHERE category=$1 AND rule_type=$2 AND content=$3)`,[category,ruleType,content]);
    }
  }

  // v1.17.0: Menu Penting — single source of truth for frequently changed operational data.
  const v1170=await pool.query(`INSERT INTO app_settings(key,value) VALUES('migration_v1170_important_menu','true'::jsonb) ON CONFLICT DO NOTHING RETURNING key`);
  if(v1170.rowCount){
    await pool.query(`INSERT INTO bot_important_info(item_type,item_key,title,content,aliases,meta,priority,active) VALUES('PROMO',$1,$2,$3,$4::jsonb,$5::jsonb,100,true) ON CONFLICT(item_type,item_key) DO UPDATE SET title=EXCLUDED.title,content=EXCLUDED.content,aliases=EXCLUDED.aliases,meta=EXCLUDED.meta,updated_at=now()`,["BONUS_NEW_MEMBER","Bonus New Member 10%","Bonus New Member 10% dengan minimal deposit Rp50.000.","[\"bonus new member\", \"new member 10%\", \"bonus member baru\"]","{\"min_deposit\": \"Rp50.000\", \"rate\": \"10%\"}"]);
    await pool.query(`INSERT INTO bot_important_info(item_type,item_key,title,content,aliases,meta,priority,active) VALUES('PROMO',$1,$2,$3,$4::jsonb,$5::jsonb,100,true) ON CONFLICT(item_type,item_key) DO UPDATE SET title=EXCLUDED.title,content=EXCLUDED.content,aliases=EXCLUDED.aliases,meta=EXCLUDED.meta,updated_at=now()`,["BONUS_HARIAN_TOGEL","Bonus Deposit Harian Togel Rp5.000","Bonus Deposit Harian Togel Rp5.000 dengan minimal deposit Rp100.000.","[\"bonus harian togel\", \"bonus togel 5000\"]","{\"min_deposit\": \"Rp100.000\", \"bonus\": \"Rp5.000\"}"]);
    await pool.query(`INSERT INTO bot_important_info(item_type,item_key,title,content,aliases,meta,priority,active) VALUES('PROMO',$1,$2,$3,$4::jsonb,$5::jsonb,100,true) ON CONFLICT(item_type,item_key) DO UPDATE SET title=EXCLUDED.title,content=EXCLUDED.content,aliases=EXCLUDED.aliases,meta=EXCLUDED.meta,updated_at=now()`,["BONUS_HARIAN_LIVEGAME","Bonus Deposit Harian LiveGames Casino 5%","Bonus Deposit Harian LiveGames Casino 5% dengan minimal deposit Rp100.000.","[\"bonus harian livegames\", \"bonus livegame 5%\"]","{\"min_deposit\": \"Rp100.000\", \"rate\": \"5%\"}"]);
    await pool.query(`INSERT INTO bot_important_info(item_type,item_key,title,content,aliases,meta,priority,active) VALUES('PROMO',$1,$2,$3,$4::jsonb,$5::jsonb,100,true) ON CONFLICT(item_type,item_key) DO UPDATE SET title=EXCLUDED.title,content=EXCLUDED.content,aliases=EXCLUDED.aliases,meta=EXCLUDED.meta,updated_at=now()`,["BONUS_HARIAN_SLOT","Bonus Deposit Harian SlotGames 5%","Bonus Deposit Harian SlotGames 5% dengan minimal deposit Rp100.000.","[\"bonus harian slot\", \"bonus slot 5%\"]","{\"min_deposit\": \"Rp100.000\", \"rate\": \"5%\"}"]);
    await pool.query(`INSERT INTO bot_important_info(item_type,item_key,title,content,aliases,meta,priority,active) VALUES('PROMO',$1,$2,$3,$4::jsonb,$5::jsonb,100,true) ON CONFLICT(item_type,item_key) DO UPDATE SET title=EXCLUDED.title,content=EXCLUDED.content,aliases=EXCLUDED.aliases,meta=EXCLUDED.meta,updated_at=now()`,["CASHBACK_LIVEGAME_SENIN","Bonus Cashback Live Games Casino 5%","Bonus Cashback Live Games Casino 5% setiap Senin.","[\"cashback live games\", \"cashback livegame\", \"bonus senin livegame\"]","{\"day\": \"Senin\", \"rate\": \"5%\"}"]);
    await pool.query(`INSERT INTO bot_important_info(item_type,item_key,title,content,aliases,meta,priority,active) VALUES('PROMO',$1,$2,$3,$4::jsonb,$5::jsonb,100,true) ON CONFLICT(item_type,item_key) DO UPDATE SET title=EXCLUDED.title,content=EXCLUDED.content,aliases=EXCLUDED.aliases,meta=EXCLUDED.meta,updated_at=now()`,["CASHBACK_SLOT_SENIN","Bonus Cashback Slot Games 5% Up to 10%","Bonus Cashback Slot Games 5% up to 10% setiap Senin.","[\"cashback slot\", \"bonus senin slot\"]","{\"day\": \"Senin\", \"rate\": \"5% up to 10%\"}"]);
    await pool.query(`INSERT INTO bot_important_info(item_type,item_key,title,content,aliases,meta,priority,active) VALUES('PROMO',$1,$2,$3,$4::jsonb,$5::jsonb,100,true) ON CONFLICT(item_type,item_key) DO UPDATE SET title=EXCLUDED.title,content=EXCLUDED.content,aliases=EXCLUDED.aliases,meta=EXCLUDED.meta,updated_at=now()`,["CASHBACK_ELOTTERY_SENIN","Bonus Cashback Elottery Games 5% Up to 10%","Bonus Cashback Elottery Games 5% up to 10% setiap Senin.","[\"cashback elottery\", \"bonus senin elottery\"]","{\"day\": \"Senin\", \"rate\": \"5% up to 10%\"}"]);
    await pool.query(`INSERT INTO bot_important_info(item_type,item_key,title,content,aliases,meta,priority,active) VALUES('PROMO',$1,$2,$3,$4::jsonb,$5::jsonb,100,true) ON CONFLICT(item_type,item_key) DO UPDATE SET title=EXCLUDED.title,content=EXCLUDED.content,aliases=EXCLUDED.aliases,meta=EXCLUDED.meta,updated_at=now()`,["CASHBACK_ARCADE_SENIN","Bonus Cashback Arcade Mini Games 5% Up to 10%","Bonus Cashback Arcade Mini Games 5% up to 10% setiap Senin.","[\"cashback arcade\", \"cashback mini games\", \"bonus senin arcade\"]","{\"day\": \"Senin\", \"rate\": \"5% up to 10%\"}"]);
    await pool.query(`INSERT INTO bot_important_info(item_type,item_key,title,content,aliases,meta,priority,active) VALUES('PROMO',$1,$2,$3,$4::jsonb,$5::jsonb,100,true) ON CONFLICT(item_type,item_key) DO UPDATE SET title=EXCLUDED.title,content=EXCLUDED.content,aliases=EXCLUDED.aliases,meta=EXCLUDED.meta,updated_at=now()`,["ROLLINGAN_LIVEGAME_KAMIS","Bonus Rollingan LiveGames Casino 1%","Bonus Rollingan LiveGames Casino 1% setiap Kamis.","[\"rollingan livegames\", \"rollingan livegame\"]","{\"day\": \"Kamis\", \"rate\": \"1%\"}"]);
    await pool.query(`INSERT INTO bot_important_info(item_type,item_key,title,content,aliases,meta,priority,active) VALUES('PROMO',$1,$2,$3,$4::jsonb,$5::jsonb,100,true) ON CONFLICT(item_type,item_key) DO UPDATE SET title=EXCLUDED.title,content=EXCLUDED.content,aliases=EXCLUDED.aliases,meta=EXCLUDED.meta,updated_at=now()`,["ROLLINGAN_SLOT_KAMIS","Bonus Rollingan SlotGames 1%","Bonus Rollingan SlotGames 1% setiap Kamis.","[\"rollingan slot\"]","{\"day\": \"Kamis\", \"rate\": \"1%\"}"]);
    await pool.query(`INSERT INTO bot_important_info(item_type,item_key,title,content,aliases,meta,priority,active) VALUES('PROMO',$1,$2,$3,$4::jsonb,$5::jsonb,100,true) ON CONFLICT(item_type,item_key) DO UPDATE SET title=EXCLUDED.title,content=EXCLUDED.content,aliases=EXCLUDED.aliases,meta=EXCLUDED.meta,updated_at=now()`,["ROLLINGAN_ELOTTERY_KAMIS","Bonus Rollingan Elottery Games 1%","Bonus Rollingan Elottery Games 1% setiap Kamis.","[\"rollingan elottery\"]","{\"day\": \"Kamis\", \"rate\": \"1%\"}"]);
    await pool.query(`INSERT INTO bot_important_info(item_type,item_key,title,content,aliases,meta,priority,active) VALUES('PROMO',$1,$2,$3,$4::jsonb,$5::jsonb,100,true) ON CONFLICT(item_type,item_key) DO UPDATE SET title=EXCLUDED.title,content=EXCLUDED.content,aliases=EXCLUDED.aliases,meta=EXCLUDED.meta,updated_at=now()`,["ROLLINGAN_ARCADE_KAMIS","Bonus Rollingan Arcade Mini Games 1%","Bonus Rollingan Arcade Mini Games 1% setiap Kamis.","[\"rollingan arcade\", \"rollingan mini games\"]","{\"day\": \"Kamis\", \"rate\": \"1%\"}"]);
    await pool.query(`INSERT INTO bot_important_info(item_type,item_key,title,content,aliases,meta,priority,active) VALUES('PROMO',$1,$2,$3,$4::jsonb,$5::jsonb,100,true) ON CONFLICT(item_type,item_key) DO UPDATE SET title=EXCLUDED.title,content=EXCLUDED.content,aliases=EXCLUDED.aliases,meta=EXCLUDED.meta,updated_at=now()`,["EVENT_TURNOVER_SELASA","Event Lomba TurnOver Mingguan","Event Lomba TurnOver Mingguan setiap Selasa.","[\"event turnover\", \"lomba turnover\", \"turnover mingguan\"]","{\"day\": \"Selasa\"}"]);
    await pool.query(`INSERT INTO bot_important_info(item_type,item_key,title,content,aliases,meta,priority,active) VALUES('PROMO',$1,$2,$3,$4::jsonb,$5::jsonb,100,true) ON CONFLICT(item_type,item_key) DO UPDATE SET title=EXCLUDED.title,content=EXCLUDED.content,aliases=EXCLUDED.aliases,meta=EXCLUDED.meta,updated_at=now()`,["BONUS_REFERRAL","Bonus Referral 1%","Bonus Referral sebesar 1%.","[\"referral\", \"bonus referral\"]","{\"rate\": \"1%\"}"]);
    await pool.query(`INSERT INTO bot_important_info(item_type,item_key,title,content,aliases,meta,priority,active) VALUES('PROMO',$1,$2,$3,$4::jsonb,$5::jsonb,100,true) ON CONFLICT(item_type,item_key) DO UPDATE SET title=EXCLUDED.title,content=EXCLUDED.content,aliases=EXCLUDED.aliases,meta=EXCLUDED.meta,updated_at=now()`,["GARANSI_SLOT","Garansi Slot 100%","Program Garansi Slot 100%. Detail syarat mengikuti ketentuan promo aktif yang ditetapkan admin.","[\"garansi slot\"]","{\"rate\": \"100%\"}"]);
    await pool.query(`INSERT INTO bot_important_info(item_type,item_key,title,content,aliases,meta,priority,active) VALUES('PROMO',$1,$2,$3,$4::jsonb,$5::jsonb,100,true) ON CONFLICT(item_type,item_key) DO UPDATE SET title=EXCLUDED.title,content=EXCLUDED.content,aliases=EXCLUDED.aliases,meta=EXCLUDED.meta,updated_at=now()`,["BONUS_APK","Bonus Download APK OMTOGEL","Bonus Download APK OMTOGEL. Detail nominal dan syarat mengikuti data promo aktif yang ditetapkan admin.","[\"bonus apk\", \"download apk\"]","{}"]);
    await pool.query(`INSERT INTO bot_important_info(item_type,item_key,title,content,aliases,meta,priority,active) VALUES('PROMO',$1,$2,$3,$4::jsonb,$5::jsonb,100,true) ON CONFLICT(item_type,item_key) DO UPDATE SET title=EXCLUDED.title,content=EXCLUDED.content,aliases=EXCLUDED.aliases,meta=EXCLUDED.meta,updated_at=now()`,["FREESPIN","Bonus FreeSpin Murni + BuyFree Spin 20% + 10%","Bonus FreeSpin Murni + BuyFree Spin 20% + 10%.","[\"freespin\", \"free spin\", \"buyfree spin\"]","{\"rate\": \"20% + 10%\"}"]);
    await pool.query(`INSERT INTO bot_important_info(item_type,item_key,title,content,aliases,meta,priority,active) VALUES('PROMO',$1,$2,$3,$4::jsonb,$5::jsonb,100,true) ON CONFLICT(item_type,item_key) DO UPDATE SET title=EXCLUDED.title,content=EXCLUDED.content,aliases=EXCLUDED.aliases,meta=EXCLUDED.meta,updated_at=now()`,["MAXWIN","Bonus Maxwin ++++","Bonus Maxwin ++++ untuk Zeus, Starlight Princess, dan Sweet Bonanza. Detail syarat mengikuti ketentuan promo aktif.","[\"maxwin\", \"zeus\", \"starlight princess\", \"sweet bonanza\"]","{}"]);
    await pool.query(`INSERT INTO bot_important_info(item_type,item_key,title,content,aliases,meta,priority,active) VALUES('PROMO',$1,$2,$3,$4::jsonb,$5::jsonb,100,true) ON CONFLICT(item_type,item_key) DO UPDATE SET title=EXCLUDED.title,content=EXCLUDED.content,aliases=EXCLUDED.aliases,meta=EXCLUDED.meta,updated_at=now()`,["KOI_GATE","Event Koi Gate Habanero","Event Koi Gate Habanero dengan extra bonus jutaan rupiah. Detail syarat mengikuti ketentuan aktif.","[\"koi gate\", \"habanero\"]","{}"]);
    await pool.query(`INSERT INTO bot_important_info(item_type,item_key,title,content,aliases,meta,priority,active) VALUES('PROMO',$1,$2,$3,$4::jsonb,$5::jsonb,100,true) ON CONFLICT(item_type,item_key) DO UPDATE SET title=EXCLUDED.title,content=EXCLUDED.content,aliases=EXCLUDED.aliases,meta=EXCLUDED.meta,updated_at=now()`,["SPACEMAN","Event Terbang ke Bulan Spaceman","Event Terbang ke Bulan Spaceman Extra Bonus +++. Detail syarat mengikuti ketentuan aktif.","[\"spaceman\", \"terbang ke bulan\"]","{}"]);
    await pool.query(`INSERT INTO bot_important_info(item_type,item_key,title,content,aliases,meta,priority,active) VALUES('PROMO',$1,$2,$3,$4::jsonb,$5::jsonb,100,true) ON CONFLICT(item_type,item_key) DO UPDATE SET title=EXCLUDED.title,content=EXCLUDED.content,aliases=EXCLUDED.aliases,meta=EXCLUDED.meta,updated_at=now()`,["JOKER_JEWELS","Event Pragmatic Play Joker Jewels","Event Pragmatic Play Joker Jewels extra bonus hingga 100%. Detail syarat mengikuti ketentuan aktif.","[\"joker jewels\", \"pragmatic joker\"]","{\"rate\": \"hingga 100%\"}"]);
    await pool.query(`INSERT INTO bot_important_info(item_type,item_key,title,content,aliases,meta,priority,active) VALUES('PROMO',$1,$2,$3,$4::jsonb,$5::jsonb,100,true) ON CONFLICT(item_type,item_key) DO UPDATE SET title=EXCLUDED.title,content=EXCLUDED.content,aliases=EXCLUDED.aliases,meta=EXCLUDED.meta,updated_at=now()`,["BONUS_BULANAN","Event Bonus Bulanan Slot & LiveGame Casino","Event bonus bulanan Slot & LiveGame Casino. Jadwal dan syarat mengikuti ketentuan aktif.","[\"bonus bulanan\", \"event bulanan\"]","{}"]);
    await pool.query(`INSERT INTO bot_important_info(item_type,item_key,title,content,aliases,meta,priority,active) VALUES('PROMO',$1,$2,$3,$4::jsonb,$5::jsonb,100,true) ON CONFLICT(item_type,item_key) DO UPDATE SET title=EXCLUDED.title,content=EXCLUDED.content,aliases=EXCLUDED.aliases,meta=EXCLUDED.meta,updated_at=now()`,["RONDA_50","Event Ronda Pagi & Malam 50%","Event Ronda Pagi & Malam 50%. Detail jam dan syarat mengikuti ketentuan aktif.","[\"ronda\", \"ronda pagi\", \"ronda malam\"]","{\"rate\": \"50%\"}"]);
    await pool.query(`INSERT INTO bot_important_info(item_type,item_key,title,content,aliases,meta,priority,active) VALUES('PROMO',$1,$2,$3,$4::jsonb,$5::jsonb,100,true) ON CONFLICT(item_type,item_key) DO UPDATE SET title=EXCLUDED.title,content=EXCLUDED.content,aliases=EXCLUDED.aliases,meta=EXCLUDED.meta,updated_at=now()`,["FREEBET_50","FreeBet 50%","Promo FreeBet 50%. Detail syarat mengikuti ketentuan aktif.","[\"freebet\", \"free bet\"]","{\"rate\": \"50%\"}"]);
    await pool.query(`INSERT INTO bot_important_info(item_type,item_key,title,content,aliases,meta,priority,active) VALUES('PROMO',$1,$2,$3,$4::jsonb,$5::jsonb,100,true) ON CONFLICT(item_type,item_key) DO UPDATE SET title=EXCLUDED.title,content=EXCLUDED.content,aliases=EXCLUDED.aliases,meta=EXCLUDED.meta,updated_at=now()`,["SCATTER_HITAM","Event Scatter Hitam","Event Scatter Hitam dengan hadiah hingga Rp20 juta. Detail syarat mengikuti ketentuan aktif.","[\"scatter hitam\", \"event scatter\"]","{\"max_reward\": \"Rp20.000.000\"}"]);
    const rules1170=[
      ['GLOBAL','REQUIRE','MENU PENTING adalah sumber fakta operasional dengan prioritas tertinggi untuk Promo/Event, Link Akses, RTP, Prediksi Togel, dan Rekening/Wallet. Jika data aktif di Menu Penting bertentangan dengan history lama, gunakan data Menu Penting terbaru.'],
      ['GLOBAL','FORBID','Jangan pernah mengarang link akses, nomor rekening/wallet, RTP, prediksi togel, nominal promo, jadwal promo, atau status promo yang tidak tersedia sebagai data aktif di Menu Penting/Responses resmi.'],
      ['BONUS_REQUEST','REQUIRE','Claim promo/bonus selalu diteruskan ke CS sesuai workflow; informasi promo aktif boleh dijelaskan otomatis dari Menu Penting tanpa membuka ticket jika member hanya bertanya.']
    ];
    for(const [category,ruleType,content] of rules1170){
      await pool.query(`INSERT INTO ai_rules(category,rule_type,content) SELECT $1,$2,$3 WHERE NOT EXISTS(SELECT 1 FROM ai_rules WHERE category=$1 AND rule_type=$2 AND content=$3)`,[category,ruleType,content]);
    }
  }

  // v1.10.4: DP verification is stateful across separate member messages and routed to Telegram after ID + proof are complete.
  const v1104=await pool.query(`INSERT INTO app_settings(key,value) VALUES('migration_v1104_deposit_bridge','true'::jsonb) ON CONFLICT DO NOTHING RETURNING key`);
  if(v1104.rowCount){
    await pool.query(`UPDATE livechat_canned_responses SET content=$1,updated_at=now() WHERE source_id='system:dp_processed'`,['Deposit bosku sudah berhasil kami proses ya 😊🙏 Silakan dicek kembali pada saldo akun bosku.\nTerima kasih dan selamat bermain, semoga beruntung bosku ^^ ❤️']).catch(()=>{});
  }
}

export async function healthDb(){ const r=await pool.query('SELECT 1 AS ok'); return r.rows[0].ok===1; }
export async function getSetting(key, fallback=null){ const r=await pool.query('SELECT value FROM app_settings WHERE key=$1',[key]); return r.rows[0]?.value ?? fallback; }
export async function setSetting(key,value){ await pool.query(`INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,[key,JSON.stringify(value)]); }
export async function hideAllInboxConversations(){ await pool.query(`UPDATE conversations SET visible_in_inbox=false WHERE visible_in_inbox=true`); }
export async function reconcileInboxVisibility(chatIds=[],graceSeconds=25){
  const ids=[...new Set((chatIds||[]).map(String).filter(Boolean))];
  const grace=Math.max(5,Math.min(Number(graceSeconds)||25,300));
  if(ids.length){
    await pool.query(`UPDATE conversations SET visible_in_inbox=false,lc_inbox_rank=NULL,updated_at=now()
      WHERE visible_in_inbox=true AND NOT (chat_id = ANY($1::text[]))
        AND COALESCE(inbox_last_seen_at,updated_at) < now() - ($2::text || ' seconds')::interval`,[ids,String(grace)]);
  }else{
    await pool.query(`UPDATE conversations SET visible_in_inbox=false,lc_inbox_rank=NULL,updated_at=now()
      WHERE visible_in_inbox=true AND COALESCE(inbox_last_seen_at,updated_at) < now() - ($1::text || ' seconds')::interval`,[String(grace)]);
  }
}

export async function getConversationState(chatId){ const r=await pool.query(`SELECT c.chat_id,c.bootstrapped_at,c.human_takeover_until,c.handling_mode,c.takeover_reason,c.takeover_at,c.last_event_at,c.greeting_sent_at,c.workflow_type,c.workflow_state,c.workflow_data,c.member_typing,c.member_typing_updated_at,c.conversation_digest,c.digest_message_count,c.digest_updated_at,c.case_brain,c.brain_message_count,c.brain_updated_at,(SELECT count(*)::int FROM messages m WHERE m.chat_id=c.chat_id) AS message_count FROM conversations c WHERE c.chat_id=$1`,[chatId]); return r.rows[0]||null; }
export async function markBootstrapped(chatId){ await pool.query(`UPDATE conversations SET bootstrapped_at=COALESCE(bootstrapped_at,now()),updated_at=now() WHERE chat_id=$1`,[chatId]); }
export async function clearBootstrapped(chatId){ await pool.query(`UPDATE conversations SET bootstrapped_at=NULL,updated_at=now() WHERE chat_id=$1`,[chatId]); }
export async function upsertConversation(chat,{visible=true,state={}}={}){
  const users=chat?.users||[]; const customer=users.find(u=>u.type==='customer')||users[0]||{};
  const rank=Number.isFinite(Number(state.rank))?Number(state.rank):null;
  await pool.query(`INSERT INTO conversations(chat_id,customer_name,customer_email,last_event_at,updated_at,visible_in_inbox,lc_is_followed,lc_active,lc_routing_status,lc_summary,lc_inbox_rank,inbox_last_seen_at)
    VALUES($1,$2,$3,now(),now(),$4,$5,$6,$7,$8::jsonb,$9,CASE WHEN $4 THEN now() ELSE NULL END)
    ON CONFLICT(chat_id) DO UPDATE SET customer_name=COALESCE(EXCLUDED.customer_name,conversations.customer_name),customer_email=COALESCE(EXCLUDED.customer_email,conversations.customer_email),updated_at=now(),
      visible_in_inbox=CASE WHEN conversations.status='closed' AND conversations.ended_at IS NOT NULL AND conversations.ended_at>now()-interval '2 minutes' THEN false ELSE EXCLUDED.visible_in_inbox END,
      lc_is_followed=EXCLUDED.lc_is_followed,lc_active=EXCLUDED.lc_active,lc_routing_status=EXCLUDED.lc_routing_status,lc_summary=EXCLUDED.lc_summary,lc_inbox_rank=COALESCE(EXCLUDED.lc_inbox_rank,conversations.lc_inbox_rank),
      inbox_last_seen_at=CASE WHEN EXCLUDED.visible_in_inbox THEN now() ELSE conversations.inbox_last_seen_at END,
      status=CASE WHEN conversations.status='closed' AND conversations.ended_at IS NOT NULL AND conversations.ended_at<=now()-interval '2 minutes' AND COALESCE(EXCLUDED.lc_active,true)=true THEN 'active' ELSE conversations.status END`,
    [String(chat.id), customer.name||customer.email||null, customer.email||null, Boolean(visible), state.followed ?? null, state.active ?? null, state.routingStatus||null, JSON.stringify(chat||{}), rank]);
}
export async function messageExists(chatId,eventId){ const r=await pool.query(`SELECT 1 FROM messages WHERE chat_id=$1 AND event_id=$2 LIMIT 1`,[chatId,String(eventId)]); return r.rowCount>0; }
export async function insertMessage({chatId,eventId,senderType,authorId,text,normalizedText,intent,createdAt,attachments=[]}){
  const safeAttachments=Array.isArray(attachments)?attachments.slice(0,8):[];
  const r=await pool.query(`INSERT INTO messages(chat_id,event_id,sender_type,author_id,text,normalized_text,intent,created_at,attachments) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
    ON CONFLICT(chat_id,event_id) DO NOTHING RETURNING id`,[chatId,eventId,senderType,authorId||null,text||'',normalizedText||null,intent||null,createdAt,JSON.stringify(safeAttachments)]);
  if (r.rowCount) {
    await pool.query(`UPDATE conversations SET last_event_at=GREATEST(COALESCE(last_event_at,$2::timestamptz),$2::timestamptz), last_member_event_at=CASE WHEN $3='customer' THEN GREATEST(COALESCE(last_member_event_at,$2::timestamptz),$2::timestamptz) ELSE last_member_event_at END, updated_at=now() WHERE chat_id=$1`,[chatId,createdAt,senderType]);
  }
  return r.rowCount>0;
}
export async function getContext(chatId, limit=24){ const r=await pool.query(`SELECT id,event_id,sender_type,author_id,text,normalized_text,intent,attachments,created_at FROM messages WHERE chat_id=$1 ORDER BY created_at DESC LIMIT $2`,[chatId,limit]); return r.rows.reverse(); }
export async function getFullContext(chatId, limit=10000){ const r=await pool.query(`SELECT id,event_id,sender_type,author_id,text,normalized_text,intent,attachments,created_at FROM messages WHERE chat_id=$1 ORDER BY created_at ASC,id ASC LIMIT $2`,[chatId,Math.max(1,Math.min(Number(limit)||10000,20000))]); return r.rows; }
export async function getMessageCount(chatId){ const r=await pool.query(`SELECT count(*)::int AS n FROM messages WHERE chat_id=$1`,[chatId]); return Number(r.rows[0]?.n||0); }
export async function getConversationDigest(chatId){ const r=await pool.query(`SELECT conversation_digest,digest_message_count,digest_updated_at FROM conversations WHERE chat_id=$1`,[chatId]); return r.rows[0]||{conversation_digest:null,digest_message_count:0,digest_updated_at:null}; }
export async function saveConversationDigest(chatId,digest,messageCount){ await pool.query(`UPDATE conversations SET conversation_digest=$2,digest_message_count=$3,digest_updated_at=now(),updated_at=now() WHERE chat_id=$1`,[chatId,String(digest||'').slice(0,12000),Number(messageCount||0)]); }
export async function getConversationBrain(chatId){ const r=await pool.query(`SELECT case_brain,brain_message_count,brain_updated_at FROM conversations WHERE chat_id=$1`,[chatId]); return r.rows[0]||{case_brain:{},brain_message_count:0,brain_updated_at:null}; }
export async function saveConversationBrain(chatId,brain,messageCount){ await pool.query(`UPDATE conversations SET case_brain=$2::jsonb,brain_message_count=$3,brain_updated_at=now(),updated_at=now() WHERE chat_id=$1`,[chatId,JSON.stringify(brain||{}),Number(messageCount||0)]); }
export async function getContextSlice(chatId,offset=0,limit=120){ const r=await pool.query(`SELECT * FROM messages WHERE chat_id=$1 ORDER BY created_at ASC,id ASC OFFSET $2 LIMIT $3`,[chatId,Math.max(0,Number(offset)||0),Math.max(1,Math.min(Number(limit)||120,300))]); return r.rows; }
export async function getHumanStyleExamples(limit=30){ const r=await pool.query(`SELECT response_text,intent,occurrences FROM learning_examples WHERE source_type='HUMAN_CHAT' AND status='APPROVED' AND length(trim(response_text))>0 ORDER BY occurrences DESC,updated_at DESC LIMIT $1`,[limit]); return r.rows; }
export async function getRules(intent){ const r=await pool.query(`SELECT category,rule_type,content FROM ai_rules WHERE active=true AND (category='GLOBAL' OR category=$1) ORDER BY id`,[intent]); return r.rows; }
export async function getKnowledge(intent){ const r=await pool.query(`SELECT category,title,content FROM knowledge_base WHERE active=true AND (category='GENERAL' OR category=$1) ORDER BY id LIMIT 30`,[intent]); return r.rows; }
export async function isHumanTakeover(chatId){ const r=await pool.query(`SELECT handling_mode FROM conversations WHERE chat_id=$1`,[chatId]); return r.rows[0]?.handling_mode==='HUMAN'; }
export async function setHumanTakeover(chatId, reason='manual'){ await pool.query(`UPDATE conversations SET handling_mode='HUMAN',takeover_reason=$2,takeover_at=now(),human_takeover_until=NULL,updated_at=now() WHERE chat_id=$1`,[chatId,String(reason||'manual')]); }
export async function clearHumanTakeover(chatId){ await pool.query(`UPDATE conversations SET handling_mode='AI',takeover_reason=NULL,takeover_at=NULL,human_takeover_until=NULL,updated_at=now() WHERE chat_id=$1`,[chatId]); }
export async function withChatLock(chatId, fn){ const client=await pool.connect(); try{ await client.query('SELECT pg_advisory_lock(hashtext($1))',[String(chatId)]); return await fn(); } finally { try{await client.query('SELECT pg_advisory_unlock(hashtext($1))',[String(chatId)]);}catch{} client.release(); } }
export async function saveOutbound(chatId,text,eventId=null){ const hash=Buffer.from(text).toString('base64').slice(0,64); await pool.query(`INSERT INTO outbound_messages(chat_id,text,livechat_event_id,text_hash) VALUES($1,$2,$3,$4)`,[chatId,text,eventId?String(eventId):null,hash]); await pool.query(`UPDATE conversations SET last_ai_event_at=now(),updated_at=now() WHERE chat_id=$1`,[chatId]); }
export async function outboundLooksLikeOurs(chatId,eventId,text){ const hash=Buffer.from(text).toString('base64').slice(0,64); const r=await pool.query(`SELECT 1 FROM outbound_messages WHERE chat_id=$1 AND created_at>now()-interval '5 minutes' AND ((livechat_event_id IS NOT NULL AND livechat_event_id=$2) OR text_hash=$3) LIMIT 1`,[chatId,String(eventId||''),hash]); return r.rowCount>0; }
export async function logAI(row){ const u=row.usage||{}; await pool.query(`INSERT INTO ai_logs(chat_id,source_event_id,intent,action,confidence,reply,reason,prompt_tokens,output_tokens,total_tokens,error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[row.chatId||null,row.sourceEventId||null,row.intent||null,row.action||null,row.confidence??null,row.reply||null,row.reason||null,u.input_tokens||u.prompt_tokens||null,u.output_tokens||u.completion_tokens||null,u.total_tokens||null,row.error||null]); }

export async function syncCannedResponses(items){
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const seen=[];
    let upserted=0;
    for(const item of items){
      const id=String(item.id||'').trim(); const content=String(item.text||'').trim();
      if(!id||!content) continue;
      seen.push(id);
      await client.query(`INSERT INTO livechat_canned_responses(source_id,shortcut,content,tags,scope,source_updated_at,active,raw,synced_at,updated_at,source_kind)
        VALUES($1,$2,$3,$4::jsonb,$5,$6,true,$7::jsonb,now(),now(),'api')
        ON CONFLICT(source_id) DO UPDATE SET shortcut=EXCLUDED.shortcut,content=EXCLUDED.content,tags=EXCLUDED.tags,scope=EXCLUDED.scope,
          source_updated_at=EXCLUDED.source_updated_at,active=true,raw=EXCLUDED.raw,synced_at=now(),updated_at=now()`,
        [id,item.shortcut||null,content,JSON.stringify(item.tags||[]),item.scope||null,item.updatedAt||null,JSON.stringify(item.raw||{})]);
      upserted++;
    }
    // Responses removed from LiveChat are disabled, never deleted, so audit/history stays intact.
    if(seen.length) await client.query(`UPDATE livechat_canned_responses SET active=false,updated_at=now() WHERE source_kind='api' AND NOT (source_id = ANY($1::text[]))`,[seen]);
    await client.query(`INSERT INTO app_settings(key,value) VALUES('canned_last_sync',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,[JSON.stringify({at:new Date().toISOString(),count:upserted})]);
    await client.query('COMMIT');
    return {upserted};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
export async function listCannedResponses(limit=500){ const r=await pool.query(`SELECT source_id,shortcut,title,category,content,tags,scope,source_kind,response_mode,active,source_updated_at,synced_at,updated_at FROM livechat_canned_responses ORDER BY active DESC,updated_at DESC LIMIT $1`,[limit]); return r.rows; }
function cannedTokens(s){ return String(s||'').toLowerCase().normalize('NFKD').replace(/[^a-z0-9#]+/g,' ').split(/\s+/).filter(x=>x.length>1); }
export async function getRelevantCanned(query, limit=8){
  const r=await pool.query(`SELECT source_id,shortcut,title,category,content,tags,scope,source_kind,response_mode,updated_at FROM livechat_canned_responses WHERE active=true ORDER BY updated_at DESC LIMIT 1000`);
  const qTokens=new Set(cannedTokens(query));
  const scored=r.rows.map(row=>{
    const shortcut=String(row.shortcut||'').toLowerCase();
    const hayTokens=cannedTokens(`${shortcut} ${row.title||''} ${row.category||''} ${row.content} ${(row.tags||[]).join(' ')}`);
    let score=0;
    for(const t of hayTokens) if(qTokens.has(t)) score+=1;
    for(const q of qTokens) if(shortcut && (shortcut.includes(q)||q.includes(shortcut.replace(/^#/,'')))) score+=4;
    const exactShortcut=[...qTokens].some(q=>q===shortcut.replace(/^#/,'')); if(exactShortcut) score+=10;
    return {...row,_score:score};
  }).filter(x=>x._score>0).sort((a,b)=>b._score-a._score || new Date(b.updated_at)-new Date(a.updated_at));
  return scored.slice(0,limit);
}
export async function cannedStats(){ const r=await pool.query(`SELECT count(*)::int total,count(*) FILTER(WHERE active)::int active,max(synced_at) last_sync FROM livechat_canned_responses`); return r.rows[0]||{total:0,active:0,last_sync:null}; }
export async function logError(source,code,message,details=null){ await pool.query(`INSERT INTO errors(source,code,message,details) VALUES($1,$2,$3,$4::jsonb)`,[source,code||null,String(message).slice(0,2000),JSON.stringify(details||{})]).catch(()=>{}); }

export async function claimGreeting(chatId, {onlyIfNew=false}={}){
  const r=await pool.query(`UPDATE conversations SET greeting_sent_at=now(),updated_at=now()
    WHERE chat_id=$1 AND greeting_sent_at IS NULL
      AND ($2::boolean=false OR (SELECT count(*) FROM messages m WHERE m.chat_id=$1) <= 1)
    RETURNING greeting_sent_at`,[chatId,Boolean(onlyIfNew)]);
  return r.rowCount>0;
}

// LiveChat can reuse the same chat_id for a later thread/session.  The greeting
// therefore needs an idempotency key per thread instead of one permanent flag
// per chat.  This function atomically claims that thread so polling/reconnects
// cannot emit duplicate greetings.
export async function claimGreetingForThread(chatId, threadId){
  const key=String(threadId||'').trim();
  if(!key) return false;
  const r=await pool.query(`UPDATE conversations
    SET greeting_sent_at=now(),greeting_thread_id=$2,updated_at=now()
    WHERE chat_id=$1 AND greeting_thread_id IS DISTINCT FROM $2
    RETURNING greeting_sent_at`,[chatId,key]);
  return r.rowCount>0;
}
export async function setAiWaitingHuman(chatId, waiting=true){
  await pool.query(`UPDATE conversations SET ai_waiting_human=$2,updated_at=now() WHERE chat_id=$1`,[chatId,Boolean(waiting)]);
}
export async function createHumanRequest({chatId,sourceEventId,intent,memberMessage,question}){
  const existing=await pool.query(`SELECT * FROM human_requests WHERE chat_id=$1 AND status='OPEN' ORDER BY id DESC LIMIT 1`,[chatId]);
  if(existing.rowCount) return existing.rows[0];
  try {
    const r=await pool.query(`INSERT INTO human_requests(chat_id,source_event_id,intent,member_message,ai_question) VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [chatId,sourceEventId||null,intent||'GENERAL',memberMessage,question]);
    await setAiWaitingHuman(chatId,true);
    return r.rows[0];
  } catch(e) {
    if(e.code!=='23505') throw e;
    const concurrent=await pool.query(`SELECT * FROM human_requests WHERE chat_id=$1 AND status='OPEN' ORDER BY id DESC LIMIT 1`,[chatId]);
    if(concurrent.rowCount) return concurrent.rows[0];
    throw e;
  }
}
export async function listHumanRequests(status='OPEN',limit=200){
  const r=await pool.query(`SELECT h.*,c.customer_name,c.customer_email FROM human_requests h JOIN conversations c ON c.chat_id=h.chat_id
    WHERE ($1='ALL' OR h.status=$1) ORDER BY h.created_at DESC LIMIT $2`,[status,limit]); return r.rows;
}
export async function getHumanRequest(id){ const r=await pool.query(`SELECT * FROM human_requests WHERE id=$1`,[id]); return r.rows[0]||null; }
export async function getBridgeTicketById(id){ const r=await pool.query(`SELECT * FROM human_bridge_tickets WHERE id=$1 LIMIT 1`,[id]); return r.rows[0]||null; }
export async function claimBridgeTicketAction(id,action=''){ const r=await pool.query(`UPDATE human_bridge_tickets SET status='PROCESSING',human_answer=$2,last_delivery_error=NULL,updated_at=now() WHERE id=$1 AND status='OPEN' RETURNING *`,[id,`PROCESSING:${String(action||'').slice(0,120)}`]); return r.rows[0]||null; }
export async function reopenBridgeTicket(id,error=''){ const r=await pool.query(`UPDATE human_bridge_tickets SET status='OPEN',last_delivery_error=$2,updated_at=now() WHERE id=$1 AND status='PROCESSING' RETURNING *`,[id,String(error||'').slice(0,1000)]); return r.rows[0]||null; }
export async function recoverStaleBridgeProcessing(seconds=120){ const sec=Math.max(30,Math.min(Number(seconds)||120,3600)); const r=await pool.query(`UPDATE human_bridge_tickets SET status='OPEN',last_delivery_error=COALESCE(last_delivery_error,'Recovered stale Telegram action'),updated_at=now() WHERE status='PROCESSING' AND updated_at < now() - ($1::text || ' seconds')::interval RETURNING id`,[sec]); return r.rowCount; }
export async function answerHumanRequest(id,{answer,finalReply,saveAsKnowledge=false}){
  const r=await pool.query(`UPDATE human_requests SET status='ANSWERED',human_answer=$2,final_reply=$3,save_as_knowledge=$4,answered_at=now(),updated_at=now() WHERE id=$1 AND status='OPEN' RETURNING *`,[id,answer,finalReply,Boolean(saveAsKnowledge)]);
  if(r.rowCount) await setAiWaitingHuman(r.rows[0].chat_id,false);
  return r.rows[0]||null;
}
export async function cancelHumanRequest(id){ const r=await pool.query(`UPDATE human_requests SET status='CANCELLED',updated_at=now() WHERE id=$1 AND status='OPEN' RETURNING chat_id`,[id]); if(r.rowCount) await setAiWaitingHuman(r.rows[0].chat_id,false); return r.rowCount>0; }

export async function createManualResponse({shortcut,title,category='GENERAL',content,tags=[],mode='FLEXIBLE'}){
  const id=`manual:${crypto.randomUUID()}`;
  const r=await pool.query(`INSERT INTO livechat_canned_responses(source_id,shortcut,title,category,content,tags,scope,source_kind,response_mode,active,raw,synced_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,'manual','manual',$7,true,'{}'::jsonb,now(),now()) RETURNING *`,
    [id,shortcut||null,title||null,String(category||'GENERAL').toUpperCase(),content,JSON.stringify(tags||[]),String(mode||'FLEXIBLE').toUpperCase()]);
  return r.rows[0];
}
export async function updateManualResponse(id,{shortcut,title,category,content,tags,mode,active}){
  const r=await pool.query(`UPDATE livechat_canned_responses SET shortcut=COALESCE($2,shortcut),title=COALESCE($3,title),category=COALESCE($4,category),content=COALESCE($5,content),tags=COALESCE($6::jsonb,tags),response_mode=COALESCE($7,response_mode),active=COALESCE($8,active),updated_at=now()
    WHERE source_id=$1 AND source_kind='manual' RETURNING *`,[id,shortcut??null,title??null,category?String(category).toUpperCase():null,content??null,tags?JSON.stringify(tags):null,mode?String(mode).toUpperCase():null,active??null]); return r.rows[0]||null;
}
export async function deleteManualResponse(id){ const r=await pool.query(`DELETE FROM livechat_canned_responses WHERE source_id=$1 AND source_kind='manual'`,[id]); return r.rowCount>0; }
export async function importManualResponses(items){
  const out=[]; for(const item of items){ if(!String(item.content||'').trim()) continue; out.push(await createManualResponse(item)); } return out;
}
export async function getOpenHumanRequest(chatId){ const r=await pool.query(`SELECT * FROM human_requests WHERE chat_id=$1 AND status='OPEN' ORDER BY id DESC LIMIT 1`,[chatId]); return r.rows[0]||null; }



export async function findDepositResponseForBank(bank=''){
  const b=String(bank||'').trim().toLowerCase();
  // v1.17: Rekening/Wallet from Menu Penting wins over old Responses/history.
  // Admin can replace/disable one destination and the next reset flow immediately follows it.
  const ir=await pool.query(`SELECT * FROM bot_important_info WHERE active=true AND item_type='REKENING' ORDER BY priority DESC,updated_at DESC,id DESC LIMIT 500`).catch(()=>({rows:[]}));
  const bankMatch=(x)=>{
    const aliases=Array.isArray(x.aliases)?x.aliases:[];
    const hay=`${x.item_key||''} ${x.title||''} ${x.content||''} ${aliases.join(' ')}`.toLowerCase();
    if(!b)return false;
    const clean=b.replace(/[^a-z0-9]/g,'');
    return hay.includes(b) || (clean && hay.replace(/[^a-z0-9]/g,'').includes(clean));
  };
  const importantExact=ir.rows.find(bankMatch);
  if(importantExact) return {...importantExact,source_kind:'important',shortcut:`#IMPORTANT_${importantExact.item_key}`};

  const r=await pool.query(`SELECT * FROM livechat_canned_responses WHERE active=true AND source_kind IN ('manual','api') ORDER BY CASE WHEN source_kind='manual' THEN 0 ELSE 1 END,updated_at DESC LIMIT 1000`);
  const looksDeposit=(x)=>/deposit|depo|rekening|bank|dana|bca|bri|bni|mandiri|seabank|cimb|jago/i.test(`${x.shortcut||''} ${x.title||''} ${x.category||''} ${(x.tags||[]).join(' ')} ${x.content||''}`);
  const rows=r.rows.filter(looksDeposit);
  const exact=b ? rows.find(x=>new RegExp(`(^|[^a-z0-9])${b.replace(/[^a-z0-9]/g,'')}([^a-z0-9]|$)`,'i').test(`${x.shortcut||''} ${x.title||''} ${x.category||''} ${(x.tags||[]).join(' ')} ${x.content||''}`.toLowerCase())) : null;
  if(exact) return exact;
  // Compatibility fallback: if an older install has no dedicated Menu Penting records yet,
  // retain the established BCA manual response rather than inventing a destination.
  const bca=rows.find(x=>/\bbca\b/i.test(`${x.shortcut||''} ${x.title||''} ${x.category||''} ${(x.tags||[]).join(' ')} ${x.content||''}`));
  return bca||null;
}
export async function getCannedByShortcut(shortcut){
  const key=String(shortcut||'').trim().replace(/^#?/,'#');
  const r=await pool.query(`SELECT * FROM livechat_canned_responses WHERE active=true AND lower(COALESCE(shortcut,''))=lower($1) ORDER BY CASE WHEN source_kind='manual' THEN 0 ELSE 1 END,updated_at DESC LIMIT 1`,[key]);
  return r.rows[0]||null;
}
export async function setConversationWorkflow(chatId,{type=null,state=null,data={}}={}){
  const r=await pool.query(`UPDATE conversations SET workflow_type=$2,workflow_state=$3,workflow_data=$4::jsonb,updated_at=now() WHERE chat_id=$1 RETURNING workflow_type,workflow_state,workflow_data`,[chatId,type||null,state||null,JSON.stringify(data||{})]);
  return r.rows[0]||null;
}
export async function getConversationWorkflow(chatId){
  const r=await pool.query(`SELECT workflow_type,workflow_state,workflow_data FROM conversations WHERE chat_id=$1`,[chatId]);
  return r.rows[0]||{workflow_type:null,workflow_state:null,workflow_data:{}};
}
export async function clearConversationWorkflow(chatId){
  await pool.query(`UPDATE conversations SET workflow_type=NULL,workflow_state=NULL,workflow_data='{}'::jsonb,updated_at=now() WHERE chat_id=$1`,[chatId]);
}
export async function findOpenBridgeTicketByCode(code){
  const r=await pool.query(`SELECT * FROM human_bridge_tickets WHERE upper(ticket_code)=upper($1) AND status='OPEN' LIMIT 1`,[String(code||'')]);
  return r.rows[0]||null;
}
export async function recordBridgeDeliveryFailure(id,error){
  await pool.query(`UPDATE human_bridge_tickets SET delivery_attempts=delivery_attempts+1,last_delivery_error=$2,updated_at=now() WHERE id=$1`,[id,String(error||'').slice(0,1000)]);
}
export async function clearBridgeDeliveryFailure(id){
  await pool.query(`UPDATE human_bridge_tickets SET delivery_attempts=delivery_attempts+1,last_delivery_error=NULL,updated_at=now() WHERE id=$1`,[id]);
}
export async function updateTypingFromSummary(chatId,summary={}){
  const candidates=[summary?.is_typing,summary?.typing,summary?.customer_typing,summary?.last_thread_summary?.is_typing,summary?.last_thread?.is_typing];
  const typing=candidates.find(v=>typeof v==='boolean');
  if(typeof typing!=='boolean') return null;
  await pool.query(`UPDATE conversations SET member_typing=$2,member_typing_updated_at=now() WHERE chat_id=$1`,[chatId,typing]);
  return typing;
}



function safeHumanAutoLearn(text=''){ return isSafeHistoryExample(text); }

export async function captureHumanReplyLearning({chatId,eventId,responseText}){
  const eventTime=(await pool.query(`SELECT created_at FROM messages WHERE chat_id=$1 AND event_id=$2 LIMIT 1`,[chatId,String(eventId||'')])).rows[0]?.created_at || new Date();
  const prev=await pool.query(`SELECT text,intent,event_id FROM messages WHERE chat_id=$1 AND sender_type='customer' AND created_at <= $2 ORDER BY created_at DESC LIMIT 1`,[chatId,eventTime]);
  const member=prev.rows[0];
  if(!member?.text || !String(responseText||'').trim()) return null;
  const intent=String(member.intent||'GENERAL').toUpperCase();
  const ctx=await pool.query(`SELECT sender_type,text FROM messages WHERE chat_id=$1 AND created_at <= $2 ORDER BY created_at DESC LIMIT 14`,[chatId,eventTime]);
  const contextSnapshot=ctx.rows.reverse().map(x=>`${x.sender_type}: ${String(x.text||'').trim()}`).join('\n').slice(0,7000);
  const sig=learningSignature(responseText);
  if(sig){
    await pool.query(`INSERT INTO cs_learning_patterns(intent,response_signature,sample_member,sample_response,occurrences,safe_for_reply) VALUES($1,$2,$3,$4,1,false)
      ON CONFLICT(intent,response_signature) DO UPDATE SET occurrences=cs_learning_patterns.occurrences+1,sample_member=EXCLUDED.sample_member,sample_response=EXCLUDED.sample_response,safe_for_reply=((cs_learning_patterns.occurrences+1)>=3 AND $5::boolean=true),last_seen_at=now()`,
      [intent,sig,String(member.text).trim().slice(0,1200),String(responseText).trim().slice(0,1200),safeHumanAutoLearn(responseText)]).catch(()=>{});
  }
  const existing=await pool.query(`SELECT id FROM learning_examples WHERE source_type='HUMAN_CHAT' AND intent=$1 AND lower(member_text)=lower($2) AND lower(response_text)=lower($3) LIMIT 1`,[intent,String(member.text).trim(),String(responseText).trim()]);
  if(existing.rowCount){
    const r=await pool.query(`UPDATE learning_examples SET occurrences=occurrences+1,context_snapshot=COALESCE(context_snapshot,$2),style_only=false,
      status=CASE WHEN occurrences+1>=3 AND $3::boolean=true AND status='PENDING' THEN 'APPROVED' ELSE status END,
      approved_at=CASE WHEN occurrences+1>=3 AND $3::boolean=true AND status='PENDING' THEN now() ELSE approved_at END,
      updated_at=now() WHERE id=$1 RETURNING *`,[existing.rows[0].id,contextSnapshot,safeHumanAutoLearn(responseText)]);
    return r.rows[0];
  }
  const r=await pool.query(`INSERT INTO learning_examples(source_type,intent,member_text,response_text,status,chat_id,source_event_id,context_snapshot,style_only) VALUES('HUMAN_CHAT',$1,$2,$3,'PENDING',$4,$5,$6,false) ON CONFLICT(chat_id,source_event_id) DO NOTHING RETURNING *`,[intent,String(member.text).trim(),String(responseText).trim(),chatId,String(eventId||''),contextSnapshot]);
  return r.rows[0]||null;
}

export async function backfillHumanLearning(limit=5000){
  const rows=await pool.query(`SELECT m.chat_id,m.event_id,m.text,m.created_at
    FROM messages m
    LEFT JOIN learning_examples l ON l.chat_id=m.chat_id AND l.source_event_id=m.event_id
    WHERE m.sender_type='agent' AND length(trim(COALESCE(m.text,'')))>0 AND l.id IS NULL
      AND EXISTS(SELECT 1 FROM messages c WHERE c.chat_id=m.chat_id AND c.sender_type='customer' AND c.created_at<=m.created_at)
    ORDER BY m.created_at ASC LIMIT $1`,[Math.max(1,Math.min(Number(limit)||5000,20000))]);
  let scanned=0,created=0,skipped=0;
  for(const m of rows.rows){
    scanned++;
    const r=await captureHumanReplyLearning({chatId:m.chat_id,eventId:m.event_id,responseText:m.text}).catch(()=>null);
    if(r) created++; else skipped++;
  }
  return {scanned,created,skipped};
}

export async function backfillHumanLearningAll({batchSize=2000,maxRows=100000}={}){
  let scanned=0,created=0,skipped=0,batches=0;
  while(scanned<maxRows){
    const r=await backfillHumanLearning(Math.min(batchSize,maxRows-scanned));
    batches++; scanned+=Number(r.scanned||0); created+=Number(r.created||0); skipped+=Number(r.skipped||0);
    if(!r.scanned || r.scanned<batchSize) break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  return {scanned,created,skipped,batches};
}

export async function addAiCorrection({chatId,aiEventId,correction}){
  const aiMsg=await pool.query(`SELECT * FROM messages WHERE chat_id=$1 AND event_id=$2 AND sender_type='ai' LIMIT 1`,[chatId,String(aiEventId)]);
  if(!aiMsg.rowCount) throw new Error('AI_MESSAGE_NOT_FOUND');
  const a=aiMsg.rows[0];
  const prev=await pool.query(`SELECT text,intent FROM messages WHERE chat_id=$1 AND sender_type='customer' AND created_at <= $2 ORDER BY created_at DESC LIMIT 1`,[chatId,a.created_at]);
  const member=prev.rows[0]||{};
  const intent=String(a.intent||member.intent||'GENERAL').toUpperCase();
  const r=await pool.query(`INSERT INTO learning_examples(source_type,intent,member_text,response_text,correction_text,status,occurrences,chat_id,source_event_id,approved_at) VALUES('AI_FEEDBACK',$1,$2,$3,$4,'APPROVED',1,$5,$6,now())
    ON CONFLICT (chat_id,source_event_id) WHERE source_event_id IS NOT NULL DO UPDATE SET source_type='AI_FEEDBACK',intent=EXCLUDED.intent,member_text=EXCLUDED.member_text,response_text=EXCLUDED.response_text,correction_text=EXCLUDED.correction_text,status='APPROVED',occurrences=learning_examples.occurrences+1,approved_at=now(),updated_at=now() RETURNING *`,[intent,String(member.text||'').trim()||'(konteks chat)',String(a.text||'').trim(),String(correction||'').trim(),chatId,String(aiEventId)]);
  return r.rows[0];
}
export async function listLearningExamples(status='ALL',limit=300){
  const r=await pool.query(`SELECT * FROM learning_examples WHERE ($1='ALL' OR status=$1) ORDER BY CASE status WHEN 'PENDING' THEN 0 WHEN 'APPROVED' THEN 1 ELSE 2 END, updated_at DESC LIMIT $2`,[String(status).toUpperCase(),limit]);
  return r.rows;
}
export async function setLearningStatus(id,status){
  const st=String(status||'').toUpperCase(); if(!['APPROVED','REJECTED','PENDING'].includes(st)) throw new Error('INVALID_LEARNING_STATUS');
  const r=await pool.query(`UPDATE learning_examples SET status=$2,approved_at=CASE WHEN $2='APPROVED' THEN now() ELSE approved_at END,updated_at=now() WHERE id=$1 RETURNING *`,[id,st]); return r.rows[0]||null;
}
export async function promoteLearningToKnowledge(id){
  const x=(await pool.query(`SELECT * FROM learning_examples WHERE id=$1`,[id])).rows[0]; if(!x) throw new Error('LEARNING_NOT_FOUND');
  const content=String(x.correction_text||x.response_text||'').trim(); if(!content) throw new Error('LEARNING_EMPTY');
  await pool.query(`INSERT INTO knowledge_base(category,title,content) VALUES($1,$2,$3)`,[x.intent||'GENERAL',`Belajar dari CS #${x.id}`,`Jika member berkata: ${x.member_text}\nJawaban yang benar: ${content}`]);
  return setLearningStatus(id,'APPROVED');
}
export async function promoteLearningToResponse(id){
  const x=(await pool.query(`SELECT * FROM learning_examples WHERE id=$1`,[id])).rows[0]; if(!x) throw new Error('LEARNING_NOT_FOUND');
  const content=String(x.correction_text||x.response_text||'').trim(); if(!content) throw new Error('LEARNING_EMPTY');
  await createManualResponse({shortcut:'',title:`Belajar CS #${x.id}`,category:x.intent||'GENERAL',content,tags:['belajar-cs'],mode:'FLEXIBLE'});
  return setLearningStatus(id,'APPROVED');
}
export async function getRelevantLearning(query,intent,limit=6){
  const r=await pool.query(`SELECT * FROM learning_examples WHERE status='APPROVED' AND (intent=$1 OR intent='GENERAL') ORDER BY updated_at DESC LIMIT 240`,[String(intent||'GENERAL').toUpperCase()]);
  const scored=r.rows.map(x=>{
    const target=`${x.member_text||''} ${x.context_snapshot||''}`;
    let score=semanticScore(query,target)*10;
    if(x.source_type==='AI_FEEDBACK') score+=1.6;
    score+=Math.min(1.8,Math.log2(Math.max(1,Number(x.occurrences||1))+1)*.35);
    return {x,score};
  }).sort((a,b)=>b.score-a.score||new Date(b.x.updated_at)-new Date(a.x.updated_at));
  return scored.filter(z=>z.score>=1.75).slice(0,Math.max(1,limit)).map(z=>({...z.x,semantic_score:Number((z.score/10).toFixed(3))}));
}

export async function getAutoHistoryLearning(query,intent,limit=8){
  const it=String(intent||'GENERAL').toUpperCase();
  const r=await pool.query(`SELECT intent,sample_member,sample_response,occurrences,safe_for_reply,last_seen_at FROM cs_learning_patterns WHERE (intent=$1 OR intent='GENERAL') AND safe_for_reply=true ORDER BY occurrences DESC,last_seen_at DESC LIMIT 700`,[it]);
  const scored=r.rows.map(x=>{
    const sem=semanticScore(query,x.sample_member||'');
    const repetition=Math.min(1.2,Math.log2(Math.max(1,Number(x.occurrences||1))+1)*.22);
    return {x,score:(sem*10)+repetition,sem};
  }).sort((a,b)=>b.score-a.score||Number(b.x.occurrences)-Number(a.x.occurrences));
  return scored.filter(z=>z.sem>=.16).slice(0,Math.max(1,limit)).map(z=>({...z.x,semantic_score:Number(z.sem.toFixed(3))}));
}

export async function markAiMessageFeedback({chatId,eventId,rating,note=''}){
  const rt=String(rating||'').toUpperCase(); if(!['GOOD','BAD'].includes(rt)) throw new Error('INVALID_FEEDBACK_RATING');
  const exists=await pool.query(`SELECT 1 FROM messages WHERE chat_id=$1 AND event_id=$2 AND sender_type='ai' LIMIT 1`,[chatId,String(eventId||'')]);
  if(!exists.rowCount) throw new Error('AI_MESSAGE_NOT_FOUND');
  const r=await pool.query(`INSERT INTO ai_message_feedback(chat_id,event_id,rating,note) VALUES($1,$2,$3,$4)
    ON CONFLICT(chat_id,event_id) DO UPDATE SET rating=EXCLUDED.rating,note=EXCLUDED.note,updated_at=now() RETURNING *`,[chatId,String(eventId),rt,String(note||'').slice(0,1000)]);
  return r.rows[0];
}
export async function aiFeedbackStats(){
  const r=await pool.query(`SELECT count(*) FILTER (WHERE rating='GOOD')::int good,count(*) FILTER (WHERE rating='BAD')::int bad FROM ai_message_feedback`);
  return r.rows[0]||{good:0,bad:0};
}

export async function learningStats(){
  const r=await pool.query(`SELECT (SELECT count(*)::int FROM learning_examples WHERE source_type='HUMAN_CHAT') human_examples,(SELECT count(*)::int FROM learning_examples WHERE status='APPROVED') approved_examples,(SELECT count(*)::int FROM cs_learning_patterns) patterns,(SELECT count(*)::int FROM cs_learning_patterns WHERE safe_for_reply=true) safe_patterns`);
  return r.rows[0]||{human_examples:0,approved_examples:0,patterns:0,safe_patterns:0};
}

// Telegram Human Bridge settings/tickets. Bot token is stored encrypted by server-side helper.
export async function getTelegramSettingsInternal(){
  const r=await pool.query(`SELECT bot_token_enc AS "botToken",bot_username AS "botUsername",default_chat_id AS "defaultChatId",routes,enabled,last_update_id AS "lastUpdateId",updated_at AS "updatedAt" FROM telegram_bridge_settings WHERE id=1`);
  return r.rows[0]||{botToken:'',botUsername:null,defaultChatId:'',routes:{},enabled:false,lastUpdateId:0};
}
export async function saveTelegramSettings({botTokenEnc,botUsername=null,defaultChatId='',routes={},enabled=null}){
  const r=await pool.query(`UPDATE telegram_bridge_settings SET
    bot_token_enc=CASE WHEN $1::text IS NULL THEN bot_token_enc ELSE $1 END,
    bot_username=COALESCE($2,bot_username),default_chat_id=$3,routes=$4::jsonb,
    enabled=COALESCE($5::boolean,enabled),updated_at=now() WHERE id=1
    RETURNING bot_token_enc AS "botToken",bot_username AS "botUsername",default_chat_id AS "defaultChatId",routes,enabled,last_update_id AS "lastUpdateId",updated_at AS "updatedAt"`,
    [botTokenEnc??null,botUsername||null,String(defaultChatId||''),JSON.stringify(routes||{}),enabled==null?null:Boolean(enabled)]);
  return r.rows[0];
}
export async function setTelegramEnabled(enabled){ const r=await pool.query(`UPDATE telegram_bridge_settings SET enabled=$1,updated_at=now() WHERE id=1 RETURNING enabled`,[Boolean(enabled)]);return Boolean(r.rows[0]?.enabled); }
export async function setTelegramLastUpdateId(id){ await pool.query(`UPDATE telegram_bridge_settings SET last_update_id=GREATEST(last_update_id,$1::bigint),updated_at=now() WHERE id=1`,[String(id||0)]); }
export async function ensureBridgeTicket(request,{category,telegramChatId,telegramTopicId=null}){
  const existing=await pool.query(`SELECT * FROM human_bridge_tickets WHERE human_request_id=$1 LIMIT 1`,[request.id]); if(existing.rowCount)return existing.rows[0];
  for(let i=0;i<4;i++){
    const prefix={RESET_PASSWORD:'RST',WD_PROBLEM:'WD',DEPOSIT_PROBLEM:'DP',BONUS:'BON',CUSTOM:'CUS'}[category]||'CUS';
    const suffix=Math.random().toString(36).slice(2,7).toUpperCase(); const code=`${prefix}-${new Date().toISOString().slice(0,10).replaceAll('-','')}-${suffix}`;
    try{const r=await pool.query(`INSERT INTO human_bridge_tickets(ticket_code,human_request_id,chat_id,category,telegram_chat_id,telegram_topic_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[code,request.id,request.chat_id,category,String(telegramChatId||''),telegramTopicId?String(telegramTopicId):null]);return r.rows[0];}catch(e){if(e.code!=='23505')throw e;}
  }
  throw new Error('BRIDGE_TICKET_CODE_GENERATION_FAILED');
}
export async function markBridgeTicketSent(id,{messageId,telegramChatId,topicId=null}){const r=await pool.query(`UPDATE human_bridge_tickets SET telegram_message_id=$2,telegram_chat_id=$3,telegram_topic_id=COALESCE($4,telegram_topic_id),sent_at=now(),updated_at=now() WHERE id=$1 RETURNING *`,[id,String(messageId),String(telegramChatId),topicId?String(topicId):null]);return r.rows[0];}
export async function findOpenBridgeTicketByTelegram(chatId,messageId){const r=await pool.query(`SELECT * FROM human_bridge_tickets WHERE telegram_chat_id=$1 AND telegram_message_id=$2 AND status='OPEN' LIMIT 1`,[String(chatId),String(messageId)]);return r.rows[0]||null;}
export async function findBridgeTicketByTelegram(chatId,messageId){const r=await pool.query(`SELECT * FROM human_bridge_tickets WHERE telegram_chat_id=$1 AND telegram_message_id=$2 ORDER BY id DESC LIMIT 1`,[String(chatId),String(messageId)]);return r.rows[0]||null;}
export async function listOpenBridgeTicketsForTelegram(chatId,{category=null,topicId=null,limit=50}={}){
  const params=[String(chatId)];
  let where=`telegram_chat_id=$1 AND status='OPEN'`;
  if(category){ params.push(String(category)); where+=` AND category=$${params.length}`; }
  if(topicId){ params.push(String(topicId)); where+=` AND COALESCE(telegram_topic_id,'')=$${params.length}`; }
  params.push(Math.max(1,Math.min(Number(limit||50),200)));
  const r=await pool.query(`SELECT * FROM human_bridge_tickets WHERE ${where} ORDER BY sent_at DESC NULLS LAST,id DESC LIMIT $${params.length}`,params);
  return r.rows;
}
export async function closeBridgeTicket(id,status='ANSWERED',{telegramReplyMessageId=null,humanAnswer=null}={}){const r=await pool.query(`UPDATE human_bridge_tickets SET status=$2,telegram_reply_message_id=COALESCE($3,telegram_reply_message_id),human_answer=COALESCE($4,human_answer),answered_at=CASE WHEN $2='ANSWERED' THEN now() ELSE answered_at END,updated_at=now() WHERE id=$1 RETURNING *`,[id,status,telegramReplyMessageId?String(telegramReplyMessageId):null,humanAnswer]);return r.rows[0]||null;}
export async function listBridgeTickets(limit=200){const r=await pool.query(`SELECT t.*,h.intent,h.member_message,h.ai_question,c.customer_name FROM human_bridge_tickets t JOIN human_requests h ON h.id=t.human_request_id JOIN conversations c ON c.chat_id=t.chat_id ORDER BY t.id DESC LIMIT $1`,[limit]);return r.rows;}
export async function closeBridgeTicketByRequest(requestId,status='ANSWERED'){const r=await pool.query(`UPDATE human_bridge_tickets SET status=$2,answered_at=CASE WHEN $2='ANSWERED' THEN now() ELSE answered_at END,updated_at=now() WHERE human_request_id=$1 AND status='OPEN' RETURNING *`,[requestId,status]);return r.rows[0]||null;}

export async function markConversationEnded(chatId){
  const r=await pool.query(`UPDATE conversations SET status='closed',visible_in_inbox=false,lc_active=false,lc_routing_status='closed',ended_at=now(),workflow_type=NULL,workflow_state=NULL,workflow_data='{}'::jsonb,ai_waiting_human=false,updated_at=now() WHERE chat_id=$1 RETURNING chat_id,status,visible_in_inbox`,[chatId]);
  await pool.query(`UPDATE human_requests SET status='CANCELLED',updated_at=now() WHERE chat_id=$1 AND status='OPEN'`,[chatId]);
  await pool.query(`UPDATE human_bridge_tickets SET status='CANCELLED',updated_at=now() WHERE chat_id=$1 AND status='OPEN'`,[chatId]);
  return r.rows[0]||null;
}

export async function listPromoRules({activeOnly=false,limit=500}={}){
  const r=await pool.query(`SELECT * FROM bot_promo_rules ${activeOnly?"WHERE active=true":""} ORDER BY active DESC,updated_at DESC,id DESC LIMIT $1`,[Math.max(1,Math.min(Number(limit||500),1000))]);
  return r.rows;
}
export async function createPromoRule(data={}){
  const name=String(data.name||'').trim(); if(!name) throw new Error('PROMO_NAME_REQUIRED');
  const keywords=Array.isArray(data.keywords)?data.keywords:String(data.keywords||'').split(',').map(x=>x.trim()).filter(Boolean);
  const r=await pool.query(`INSERT INTO bot_promo_rules(name,keywords,min_deposit,max_bonus,turnover,claim_limit,active_hours,game_scope,rules,reply_template,active) VALUES($1,$2::jsonb,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[name,JSON.stringify(keywords),String(data.minDeposit||'').trim()||null,String(data.maxBonus||'').trim()||null,String(data.turnover||'').trim()||null,String(data.claimLimit||'').trim()||null,String(data.activeHours||'').trim()||null,String(data.gameScope||'').trim()||null,String(data.rules||'').trim()||null,String(data.replyTemplate||'').trim()||null,data.active!==false]);
  return r.rows[0];
}
export async function updatePromoRule(id,data={}){
  const current=(await pool.query(`SELECT * FROM bot_promo_rules WHERE id=$1`,[id])).rows[0]; if(!current) return null;
  const keywords=data.keywords===undefined?current.keywords:(Array.isArray(data.keywords)?data.keywords:String(data.keywords||'').split(',').map(x=>x.trim()).filter(Boolean));
  const vals={name:data.name===undefined?current.name:String(data.name||'').trim(),keywords,minDeposit:data.minDeposit===undefined?current.min_deposit:String(data.minDeposit||'').trim()||null,maxBonus:data.maxBonus===undefined?current.max_bonus:String(data.maxBonus||'').trim()||null,turnover:data.turnover===undefined?current.turnover:String(data.turnover||'').trim()||null,claimLimit:data.claimLimit===undefined?current.claim_limit:String(data.claimLimit||'').trim()||null,activeHours:data.activeHours===undefined?current.active_hours:String(data.activeHours||'').trim()||null,gameScope:data.gameScope===undefined?current.game_scope:String(data.gameScope||'').trim()||null,rules:data.rules===undefined?current.rules:String(data.rules||'').trim()||null,replyTemplate:data.replyTemplate===undefined?current.reply_template:String(data.replyTemplate||'').trim()||null,active:data.active===undefined?current.active:Boolean(data.active)};
  if(!vals.name) throw new Error('PROMO_NAME_REQUIRED');
  const r=await pool.query(`UPDATE bot_promo_rules SET name=$2,keywords=$3::jsonb,min_deposit=$4,max_bonus=$5,turnover=$6,claim_limit=$7,active_hours=$8,game_scope=$9,rules=$10,reply_template=$11,active=$12,updated_at=now() WHERE id=$1 RETURNING *`,[id,vals.name,JSON.stringify(vals.keywords),vals.minDeposit,vals.maxBonus,vals.turnover,vals.claimLimit,vals.activeHours,vals.gameScope,vals.rules,vals.replyTemplate,vals.active]);
  return r.rows[0]||null;
}
export async function deletePromoRule(id){ const r=await pool.query(`DELETE FROM bot_promo_rules WHERE id=$1`,[id]); return r.rowCount>0; }


export async function listImportantInfo({activeOnly=false,type='',limit=1000}={}){
  const vals=[]; const where=[];
  if(activeOnly) where.push('active=true');
  if(String(type||'').trim()){vals.push(String(type).trim().toUpperCase());where.push(`item_type=$${vals.length}`);}
  vals.push(Math.max(1,Math.min(Number(limit)||1000,2000)));
  const r=await pool.query(`SELECT * FROM bot_important_info ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY active DESC,priority DESC,updated_at DESC,id DESC LIMIT $${vals.length}`,vals);
  return r.rows;
}
export async function getRelevantImportantInfo(query='',limit=20){
  const rows=await listImportantInfo({activeOnly:true,limit:1500});
  const q=String(query||'').toLowerCase();
  const tokens=q.replace(/[^a-z0-9%]+/gi,' ').split(/\s+/).filter(x=>x.length>=2);
  const scored=rows.map(r=>{const aliases=Array.isArray(r.aliases)?r.aliases:[];const hay=`${r.item_type} ${r.item_key} ${r.title} ${r.content} ${aliases.join(' ')}`.toLowerCase();let score=0;for(const t of tokens)if(hay.includes(t))score++;for(const a of aliases){const x=String(a||'').toLowerCase().trim();if(x&&q.includes(x))score+=6;}if(String(r.title||'').trim()&&q.includes(String(r.title).toLowerCase()))score+=8;return {r,score};}).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||Number(b.r.priority||0)-Number(a.r.priority||0));
  return scored.slice(0,Math.max(1,Math.min(Number(limit)||20,100))).map(x=>x.r);
}
export async function createImportantInfo(data={}){
  const type=String(data.itemType||data.item_type||'INFO_PENTING').trim().toUpperCase().replace(/[\s-]+/g,'_');
  const key=String(data.itemKey||data.item_key||'').trim().toUpperCase().replace(/[^A-Z0-9_]+/g,'_').replace(/^_+|_+$/g,'');
  const title=String(data.title||'').trim(),content=String(data.content||'').trim();
  if(!key||!title||!content) throw new Error('KEY_TITLE_CONTENT_REQUIRED');
  const aliases=Array.isArray(data.aliases)?data.aliases.map(x=>String(x).trim()).filter(Boolean):String(data.aliases||'').split(',').map(x=>x.trim()).filter(Boolean);
  const meta=data.meta&&typeof data.meta==='object'&&!Array.isArray(data.meta)?data.meta:{};
  const priority=Math.max(0,Math.min(Number(data.priority)||100,1000));
  const r=await pool.query(`INSERT INTO bot_important_info(item_type,item_key,title,content,aliases,meta,priority,active) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8) RETURNING *`,[type,key,title,content,JSON.stringify(aliases),JSON.stringify(meta),priority,data.active!==false]);return r.rows[0];
}
export async function updateImportantInfo(id,data={}){
  const cur=(await pool.query(`SELECT * FROM bot_important_info WHERE id=$1`,[id])).rows[0];if(!cur)return null;
  const type=String(data.itemType??data.item_type??cur.item_type).trim().toUpperCase().replace(/[\s-]+/g,'_');
  const key=String(data.itemKey??data.item_key??cur.item_key).trim().toUpperCase().replace(/[^A-Z0-9_]+/g,'_').replace(/^_+|_+$/g,'');
  const title=String(data.title??cur.title).trim(),content=String(data.content??cur.content).trim();if(!key||!title||!content)throw new Error('KEY_TITLE_CONTENT_REQUIRED');
  const aliases=Array.isArray(data.aliases)?data.aliases.map(x=>String(x).trim()).filter(Boolean):(data.aliases===undefined?cur.aliases:String(data.aliases||'').split(',').map(x=>x.trim()).filter(Boolean));
  const meta=data.meta===undefined?cur.meta:(data.meta&&typeof data.meta==='object'&&!Array.isArray(data.meta)?data.meta:{});
  const priority=Math.max(0,Math.min(Number(data.priority??cur.priority)||100,1000));
  const active=data.active===undefined?cur.active:Boolean(data.active);
  const r=await pool.query(`UPDATE bot_important_info SET item_type=$2,item_key=$3,title=$4,content=$5,aliases=$6::jsonb,meta=$7::jsonb,priority=$8,active=$9,updated_at=now() WHERE id=$1 RETURNING *`,[id,type,key,title,content,JSON.stringify(aliases),JSON.stringify(meta),priority,active]);return r.rows[0];
}
export async function deleteImportantInfo(id){const r=await pool.query(`DELETE FROM bot_important_info WHERE id=$1`,[id]);return r.rowCount>0;}
