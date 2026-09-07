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
  CREATE TABLE IF NOT EXISTS messages (
    id BIGSERIAL PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES conversations(chat_id) ON DELETE CASCADE,
    event_id TEXT NOT NULL, sender_type TEXT NOT NULL, author_id TEXT, text TEXT NOT NULL, normalized_text TEXT,
    intent TEXT, created_at TIMESTAMPTZ NOT NULL, ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(chat_id,event_id)
  );
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
  CREATE TABLE IF NOT EXISTS ai_rules (
    id BIGSERIAL PRIMARY KEY, category TEXT NOT NULL DEFAULT 'GLOBAL', rule_type TEXT NOT NULL DEFAULT 'FORBID',
    content TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS errors (
    id BIGSERIAL PRIMARY KEY, source TEXT NOT NULL, code TEXT, message TEXT NOT NULL, details JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  INSERT INTO app_settings(key,value) VALUES('auto_reply', to_jsonb(${config.autoReplyDefault}::boolean)) ON CONFLICT DO NOTHING;
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
  // Repair older deployments that marked a conversation bootstrapped even though no message was stored.
  await pool.query(`UPDATE conversations c SET bootstrapped_at=NULL
    WHERE c.bootstrapped_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.chat_id=c.chat_id)`);
}

export async function healthDb(){ const r=await pool.query('SELECT 1 AS ok'); return r.rows[0].ok===1; }
export async function getSetting(key, fallback=null){ const r=await pool.query('SELECT value FROM app_settings WHERE key=$1',[key]); return r.rows[0]?.value ?? fallback; }
export async function setSetting(key,value){ await pool.query(`INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,[key,JSON.stringify(value)]); }
export async function hideAllInboxConversations(){ await pool.query(`UPDATE conversations SET visible_in_inbox=false WHERE visible_in_inbox=true`); }
export async function getConversationState(chatId){ const r=await pool.query(`SELECT c.chat_id,c.bootstrapped_at,c.human_takeover_until,c.last_event_at,(SELECT count(*)::int FROM messages m WHERE m.chat_id=c.chat_id) AS message_count FROM conversations c WHERE c.chat_id=$1`,[chatId]); return r.rows[0]||null; }
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
export async function insertMessage({chatId,eventId,senderType,authorId,text,normalizedText,intent,createdAt}){
  const r=await pool.query(`INSERT INTO messages(chat_id,event_id,sender_type,author_id,text,normalized_text,intent,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT(chat_id,event_id) DO NOTHING RETURNING id`,[chatId,eventId,senderType,authorId||null,text,normalizedText||null,intent||null,createdAt]);
  if (r.rowCount) {
    await pool.query(`UPDATE conversations SET last_event_at=GREATEST(COALESCE(last_event_at,$2::timestamptz),$2::timestamptz), last_member_event_at=CASE WHEN $3='customer' THEN GREATEST(COALESCE(last_member_event_at,$2::timestamptz),$2::timestamptz) ELSE last_member_event_at END, updated_at=now() WHERE chat_id=$1`,[chatId,createdAt,senderType]);
  }
  return r.rowCount>0;
}
export async function getContext(chatId, limit=24){ const r=await pool.query(`SELECT sender_type,text,created_at FROM messages WHERE chat_id=$1 ORDER BY created_at DESC LIMIT $2`,[chatId,limit]); return r.rows.reverse(); }
export async function getRules(intent){ const r=await pool.query(`SELECT category,rule_type,content FROM ai_rules WHERE active=true AND (category='GLOBAL' OR category=$1) ORDER BY id`,[intent]); return r.rows; }
export async function getKnowledge(intent){ const r=await pool.query(`SELECT category,title,content FROM knowledge_base WHERE active=true AND (category='GENERAL' OR category=$1) ORDER BY id LIMIT 30`,[intent]); return r.rows; }
export async function isHumanTakeover(chatId){ const r=await pool.query(`SELECT human_takeover_until FROM conversations WHERE chat_id=$1`,[chatId]); const d=r.rows[0]?.human_takeover_until; return Boolean(d && new Date(d)>new Date()); }
export async function setHumanTakeover(chatId, minutes){ await pool.query(`UPDATE conversations SET human_takeover_until=now()+($2||' minutes')::interval,updated_at=now() WHERE chat_id=$1`,[chatId,String(minutes)]); }
export async function clearHumanTakeover(chatId){ await pool.query(`UPDATE conversations SET human_takeover_until=NULL,updated_at=now() WHERE chat_id=$1`,[chatId]); }
export async function saveOutbound(chatId,text,eventId=null){ const hash=Buffer.from(text).toString('base64').slice(0,64); await pool.query(`INSERT INTO outbound_messages(chat_id,text,livechat_event_id,text_hash) VALUES($1,$2,$3,$4)`,[chatId,text,eventId?String(eventId):null,hash]); await pool.query(`UPDATE conversations SET last_ai_event_at=now(),updated_at=now() WHERE chat_id=$1`,[chatId]); }
export async function outboundLooksLikeOurs(chatId,eventId,text){ const hash=Buffer.from(text).toString('base64').slice(0,64); const r=await pool.query(`SELECT 1 FROM outbound_messages WHERE chat_id=$1 AND created_at>now()-interval '5 minutes' AND ((livechat_event_id IS NOT NULL AND livechat_event_id=$2) OR text_hash=$3) LIMIT 1`,[chatId,String(eventId||''),hash]); return r.rowCount>0; }
export async function logAI(row){ const u=row.usage||{}; await pool.query(`INSERT INTO ai_logs(chat_id,source_event_id,intent,action,confidence,reply,reason,prompt_tokens,output_tokens,total_tokens,error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[row.chatId||null,row.sourceEventId||null,row.intent||null,row.action||null,row.confidence??null,row.reply||null,row.reason||null,u.input_tokens||u.prompt_tokens||null,u.output_tokens||u.completion_tokens||null,u.total_tokens||null,row.error||null]); }
export async function logError(source,code,message,details=null){ await pool.query(`INSERT INTO errors(source,code,message,details) VALUES($1,$2,$3,$4::jsonb)`,[source,code||null,String(message).slice(0,2000),JSON.stringify(details||{})]).catch(()=>{}); }
