import crypto from 'node:crypto';
import pg from 'pg';
import { config } from './config.js';
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
  CREATE UNIQUE INDEX IF NOT EXISTS idx_learning_source_event ON learning_examples(chat_id,source_event_id) WHERE source_event_id IS NOT NULL;
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
  INSERT INTO livechat_canned_responses(source_id,shortcut,title,category,content,tags,scope,source_kind,response_mode,active,raw,synced_at,updated_at)
  SELECT 'system:reset_deposit_first','#RESET_DEPOSIT_DULU','Reset - Deposit Dahulu','FORGOT_PASSWORD','Untuk proses reset password, silakan lakukan deposit terlebih dahulu ya bosku 🙏 Setelah itu kabari kami lagi agar bisa kami bantu lanjutkan.','["reset","password","deposit"]'::jsonb,'system','manual','FLEXIBLE',true,'{}'::jsonb,now(),now()
  WHERE NOT EXISTS (SELECT 1 FROM livechat_canned_responses WHERE shortcut ILIKE '#RESET_DEPOSIT_DULU');
  INSERT INTO livechat_canned_responses(source_id,shortcut,title,category,content,tags,scope,source_kind,response_mode,active,raw,synced_at,updated_at)
  SELECT 'system:bonus_done','#BONUS_DONE','Bonus Done','BONUS','Bonusnya sudah selesai diproses ya bosku 😊 Silakan cek kembali akun bosku.','["bonus","done"]'::jsonb,'system','manual','FLEXIBLE',true,'{}'::jsonb,now(),now()
  WHERE NOT EXISTS (SELECT 1 FROM livechat_canned_responses WHERE shortcut ILIKE '#BONUS_DONE');
  INSERT INTO livechat_canned_responses(source_id,shortcut,title,category,content,tags,scope,source_kind,response_mode,active,raw,synced_at,updated_at)
  SELECT 'system:bonus_deposit_first','#BONUS_DEPOSIT_DULU','Bonus - Deposit Dahulu','BONUS','Silakan melakukan deposit terlebih dahulu ya bosku 🙏 Setelah deposit selesai, kabari kami lagi supaya bisa dibantu cek bonusnya.','["bonus","deposit"]'::jsonb,'system','manual','FLEXIBLE',true,'{}'::jsonb,now(),now()
  WHERE NOT EXISTS (SELECT 1 FROM livechat_canned_responses WHERE shortcut ILIKE '#BONUS_DEPOSIT_DULU');
  INSERT INTO livechat_canned_responses(source_id,shortcut,title,category,content,tags,scope,source_kind,response_mode,active,raw,synced_at,updated_at)
  SELECT 'system:complaint','#KOMPLAIN','Keluhan Member','COMPLAINT','Kami paham bosku lagi kecewa. Kalau ada kendala teknis atau transaksi yang mau dicek, kirim detailnya ya, kami bantu cek satu-satu 🙏','["komplain","kecewa","kendala"]'::jsonb,'system','manual','FLEXIBLE',true,'{}'::jsonb,now(),now()
  WHERE NOT EXISTS (SELECT 1 FROM livechat_canned_responses WHERE shortcut ILIKE '#KOMPLAIN');
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
    ['system:dp_processed','#DP_PROCESSED','Deposit Diproses','DEPOSIT_PROBLEM','Depositnya sudah berhasil diproses ya bosku 😊 Silakan refresh saldo akun bosku.',['deposit','masuk','proses']],
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
}

export async function healthDb(){ const r=await pool.query('SELECT 1 AS ok'); return r.rows[0].ok===1; }
export async function getSetting(key, fallback=null){ const r=await pool.query('SELECT value FROM app_settings WHERE key=$1',[key]); return r.rows[0]?.value ?? fallback; }
export async function setSetting(key,value){ await pool.query(`INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,[key,JSON.stringify(value)]); }
export async function hideAllInboxConversations(){ await pool.query(`UPDATE conversations SET visible_in_inbox=false WHERE visible_in_inbox=true`); }
export async function getConversationState(chatId){ const r=await pool.query(`SELECT c.chat_id,c.bootstrapped_at,c.human_takeover_until,c.handling_mode,c.takeover_reason,c.takeover_at,c.last_event_at,c.greeting_sent_at,c.workflow_type,c.workflow_state,c.workflow_data,c.member_typing,c.member_typing_updated_at,c.conversation_digest,c.digest_message_count,c.digest_updated_at,(SELECT count(*)::int FROM messages m WHERE m.chat_id=c.chat_id) AS message_count FROM conversations c WHERE c.chat_id=$1`,[chatId]); return r.rows[0]||null; }
export async function markBootstrapped(chatId){ await pool.query(`UPDATE conversations SET bootstrapped_at=COALESCE(bootstrapped_at,now()),updated_at=now() WHERE chat_id=$1`,[chatId]); }
export async function clearBootstrapped(chatId){ await pool.query(`UPDATE conversations SET bootstrapped_at=NULL,updated_at=now() WHERE chat_id=$1`,[chatId]); }
export async function upsertConversation(chat,{visible=true,state={}}={}){
  const users=chat?.users||[]; const customer=users.find(u=>u.type==='customer')||users[0]||{};
  await pool.query(`INSERT INTO conversations(chat_id,customer_name,customer_email,last_event_at,updated_at,visible_in_inbox,lc_is_followed,lc_active,lc_routing_status,lc_summary)
    VALUES($1,$2,$3,now(),now(),$4,$5,$6,$7,$8::jsonb)
    ON CONFLICT(chat_id) DO UPDATE SET customer_name=COALESCE(EXCLUDED.customer_name,conversations.customer_name),customer_email=COALESCE(EXCLUDED.customer_email,conversations.customer_email),updated_at=now(),visible_in_inbox=EXCLUDED.visible_in_inbox,lc_is_followed=EXCLUDED.lc_is_followed,lc_active=EXCLUDED.lc_active,lc_routing_status=EXCLUDED.lc_routing_status,lc_summary=EXCLUDED.lc_summary`,
    [String(chat.id), customer.name||customer.email||null, customer.email||null, Boolean(visible), state.followed ?? null, state.active ?? null, state.routingStatus||null, JSON.stringify(chat||{})]);
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
export async function getMessageCount(chatId){ const r=await pool.query(`SELECT count(*)::int AS n FROM messages WHERE chat_id=$1`,[chatId]); return Number(r.rows[0]?.n||0); }
export async function getConversationDigest(chatId){ const r=await pool.query(`SELECT conversation_digest,digest_message_count,digest_updated_at FROM conversations WHERE chat_id=$1`,[chatId]); return r.rows[0]||{conversation_digest:null,digest_message_count:0,digest_updated_at:null}; }
export async function saveConversationDigest(chatId,digest,messageCount){ await pool.query(`UPDATE conversations SET conversation_digest=$2,digest_message_count=$3,digest_updated_at=now(),updated_at=now() WHERE chat_id=$1`,[chatId,String(digest||'').slice(0,12000),Number(messageCount||0)]); }
export async function getHumanStyleExamples(limit=30){ const r=await pool.query(`SELECT response_text,intent,occurrences FROM learning_examples WHERE source_type='HUMAN_CHAT' AND length(trim(response_text))>0 ORDER BY updated_at DESC LIMIT $1`,[limit]); return r.rows; }
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
export async function setAiWaitingHuman(chatId, waiting=true){
  await pool.query(`UPDATE conversations SET ai_waiting_human=$2,updated_at=now() WHERE chat_id=$1`,[chatId,Boolean(waiting)]);
}
export async function createHumanRequest({chatId,sourceEventId,intent,memberMessage,question}){
  const existing=await pool.query(`SELECT * FROM human_requests WHERE chat_id=$1 AND status='OPEN' ORDER BY id DESC LIMIT 1`,[chatId]);
  if(existing.rowCount) return existing.rows[0];
  const r=await pool.query(`INSERT INTO human_requests(chat_id,source_event_id,intent,member_message,ai_question) VALUES($1,$2,$3,$4,$5) RETURNING *`,
    [chatId,sourceEventId||null,intent||'GENERAL',memberMessage,question]);
  await setAiWaitingHuman(chatId,true);
  return r.rows[0];
}
export async function listHumanRequests(status='OPEN',limit=200){
  const r=await pool.query(`SELECT h.*,c.customer_name,c.customer_email FROM human_requests h JOIN conversations c ON c.chat_id=h.chat_id
    WHERE ($1='ALL' OR h.status=$1) ORDER BY h.created_at DESC LIMIT $2`,[status,limit]); return r.rows;
}
export async function getHumanRequest(id){ const r=await pool.query(`SELECT * FROM human_requests WHERE id=$1`,[id]); return r.rows[0]||null; }
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



function safeHumanAutoLearn(text=''){
  const v=String(text||'').trim();
  if(v.length<3 || v.length>500) return false;
  // Jangan auto-jadikan fakta jawaban yang berisi credential, rekening, link, nominal/status transaksi sensitif.
  if(/(?:password|psw|user\s*id|userid|username|rekening|no\.?\s*rek|nomor\s*rek|https?:\/\/|deposit\s+(?:sudah|telah)|withdraw\s+(?:sudah|telah)|bonus\s+(?:sudah|telah))/i.test(v)) return false;
  if(/\b\d{6,}\b/.test(v)) return false;
  return true;
}

export async function captureHumanReplyLearning({chatId,eventId,responseText}){
  const eventTime=(await pool.query(`SELECT created_at FROM messages WHERE chat_id=$1 AND event_id=$2 LIMIT 1`,[chatId,String(eventId||'')])).rows[0]?.created_at || new Date();
  const prev=await pool.query(`SELECT text,intent,event_id FROM messages WHERE chat_id=$1 AND sender_type='customer' AND created_at <= $2 ORDER BY created_at DESC LIMIT 1`,[chatId,eventTime]);
  const member=prev.rows[0];
  if(!member?.text || !String(responseText||'').trim()) return null;
  const intent=String(member.intent||'GENERAL').toUpperCase();
  const ctx=await pool.query(`SELECT sender_type,text FROM messages WHERE chat_id=$1 AND created_at <= $2 ORDER BY created_at DESC LIMIT 14`,[chatId,eventTime]);
  const contextSnapshot=ctx.rows.reverse().map(x=>`${x.sender_type}: ${String(x.text||'').trim()}`).join('\n').slice(0,7000);
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
  const r=await pool.query(`SELECT * FROM learning_examples WHERE status='APPROVED' AND (intent=$1 OR intent='GENERAL') ORDER BY updated_at DESC LIMIT 120`,[String(intent||'GENERAL').toUpperCase()]);
  const toks=new Set(String(query||'').toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(x=>x.length>2));
  const scored=r.rows.map(x=>{const text=`${x.member_text} ${x.response_text} ${x.correction_text||''}`.toLowerCase();let score=0;for(const t of toks)if(text.includes(t))score++;if(x.source_type==='AI_FEEDBACK')score+=2;score+=Math.min(3,Number(x.occurrences||1)/3);return {x,score};}).sort((a,b)=>b.score-a.score||new Date(b.x.updated_at)-new Date(a.x.updated_at));
  return scored.filter(z=>z.score>0).slice(0,limit).map(z=>z.x);
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
export async function closeBridgeTicket(id,status='ANSWERED',{telegramReplyMessageId=null,humanAnswer=null}={}){const r=await pool.query(`UPDATE human_bridge_tickets SET status=$2,telegram_reply_message_id=COALESCE($3,telegram_reply_message_id),human_answer=COALESCE($4,human_answer),answered_at=CASE WHEN $2='ANSWERED' THEN now() ELSE answered_at END,updated_at=now() WHERE id=$1 RETURNING *`,[id,status,telegramReplyMessageId?String(telegramReplyMessageId):null,humanAnswer]);return r.rows[0]||null;}
export async function listBridgeTickets(limit=200){const r=await pool.query(`SELECT t.*,h.intent,h.member_message,h.ai_question,c.customer_name FROM human_bridge_tickets t JOIN human_requests h ON h.id=t.human_request_id JOIN conversations c ON c.chat_id=t.chat_id ORDER BY t.id DESC LIMIT $1`,[limit]);return r.rows;}
export async function closeBridgeTicketByRequest(requestId,status='ANSWERED'){const r=await pool.query(`UPDATE human_bridge_tickets SET status=$2,answered_at=CASE WHEN $2='ANSWERED' THEN now() ELSE answered_at END,updated_at=now() WHERE human_request_id=$1 AND status='OPEN' RETURNING *`,[requestId,status]);return r.rows[0]||null;}
