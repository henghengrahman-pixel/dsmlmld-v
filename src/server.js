import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, validateConfig, assertBootConfig } from './config.js';
import { migrate, healthDb, pool, getSetting, setSetting, getContext, setHumanTakeover, clearHumanTakeover, logError, insertMessage } from './db.js';
import { LiveChatClient } from './livechat.js';
import { OpenAIClient } from './ai.js';
import { normalizeText, detectIntent } from './normalizer.js';
import { createSession, parseCookies, verifySession, requireAdmin } from './auth.js';
import { startPoller, pollerStatus, syncOnce } from './poller.js';
import { processCustomerMessage, answerHumanRequest } from './engine.js';
import { cannedClient, startCannedSync, syncCannedNow, cannedSyncStatus } from './canned-sync.js';
import { cannedStats, listCannedResponses, createManualResponse, updateManualResponse, deleteManualResponse, importManualResponses, listHumanRequests, getHumanRequest, cancelHumanRequest } from './db.js';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const app=express(); const lc=new LiveChatClient(); const ai=new OpenAIClient();
app.disable('x-powered-by');
app.use(express.json({limit:'1mb'}));
app.use(express.urlencoded({extended:false}));
app.use('/assets',express.static(path.join(__dirname,'../public'),{maxAge:'1h'}));

app.get('/health', async(req,res)=>{
  let db=false; try{db=await healthDb();}catch{}
  res.status(db?200:503).json({ok:db,service:'livechat-ai',db,livechatConfigured:lc.ready(),openaiConfigured:ai.ready(),poller:pollerStatus(),warnings:validateConfig()});
});
app.get('/',(req,res)=>res.sendFile(path.join(__dirname,'../public/index.html')));

app.post('/api/login',(req,res)=>{
  const {username,password}=req.body||{};
  const ok=crypto.timingSafeEqual(Buffer.from(String(username||'').padEnd(config.adminUsername.length,'\0').slice(0,config.adminUsername.length)),Buffer.from(config.adminUsername)) && String(password||'')===config.adminPassword;
  if(!ok) return res.status(401).json({ok:false,error:'LOGIN_FAILED'});
  const token=createSession(username);
  res.setHeader('Set-Cookie',`lcai_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${config.nodeEnv==='production'?'; Secure':''}`);
  res.json({ok:true});
});
app.post('/api/logout',requireAdmin,(req,res)=>{res.setHeader('Set-Cookie','lcai_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');res.json({ok:true});});
app.get('/api/me',(req,res)=>{const s=verifySession(parseCookies(req).lcai_session||'');res.json({ok:Boolean(s),user:s?.u||null});});

app.get('/api/status',requireAdmin,async(req,res)=>{
  let dbOk=false;try{dbOk=await healthDb();}catch{}
  res.json({ok:true,db:dbOk,livechatConfigured:lc.ready(),openaiConfigured:ai.ready(),autoReply:Boolean(await getSetting('auto_reply',false)),greetingEnabled:Boolean(await getSetting('greeting_enabled',config.greetingEnabled)),humanAskEnabled:Boolean(await getSetting('human_ask_enabled',config.humanAskEnabled)),poller:pollerStatus(),cannedSync:cannedSyncStatus(),canned:await cannedStats(),model:config.openaiModel,timezone:config.timezone,warnings:validateConfig()});
});
app.post('/api/test/livechat',requireAdmin,async(req,res)=>{try{res.json(await lc.test());}catch(e){await logError('livechat','TEST_FAILED',e.message);res.status(502).json({ok:false,error:e.message});}});
app.post('/api/test/chat-detail',requireAdmin,async(req,res)=>{try{const list=await lc.listChats();const raw=list?._normalizedChats||[];const chats=lc.filterInbox(raw);if(!chats.length)return res.json({ok:true,chatCount:0,detail:null});const summary=chats[0];const chat=await lc.getChat(String(summary.id),summary);res.json({ok:true,chatId:String(summary.id),diagnostics:lc.chatDiagnostics(chat)});}catch(e){await logError('livechat','CHAT_DETAIL_TEST_FAILED',e.message);res.status(502).json({ok:false,error:e.message});}});
app.post('/api/test/openai',requireAdmin,async(req,res)=>{try{res.json(await ai.test());}catch(e){await logError('openai','TEST_FAILED',e.message);res.status(502).json({ok:false,error:e.message});}});
app.post('/api/test/sync',requireAdmin,async(req,res)=>{try{res.json(await syncOnce(lc));}catch(e){res.status(502).json({ok:false,error:e.message});}});
app.post('/api/test/canned',requireAdmin,async(req,res)=>{try{res.json(await cannedClient.test());}catch(e){await logError('canned','TEST_FAILED',e.message);res.status(502).json({ok:false,error:e.message,hint:e.status===403?'PAT belum memiliki izin membaca canned responses/Responses List. Tambahkan read scope untuk canned responses di Text Developer Console.':null});}});
app.post('/api/canned/sync',requireAdmin,async(req,res)=>{try{res.json(await syncCannedNow());}catch(e){res.status(502).json({ok:false,error:e.message,hint:e.status===403?'Tambahkan read scope canned responses ke PAT, lalu buat PAT baru dan update LIVECHAT_PAT.':null});}});
app.get('/api/canned',requireAdmin,async(req,res)=>{res.json({ok:true,stats:await cannedStats(),items:await listCannedResponses(1000)});});
app.post('/api/canned/manual',requireAdmin,async(req,res)=>{try{const {shortcut='',title='',category='GENERAL',content='',tags=[],mode='FLEXIBLE'}=req.body||{};if(!String(content).trim())return res.status(400).json({ok:false,error:'CONTENT_REQUIRED'});const item=await createManualResponse({shortcut:String(shortcut).trim(),title:String(title).trim(),category,content:String(content).trim(),tags:Array.isArray(tags)?tags:String(tags||'').split(',').map(x=>x.trim()).filter(Boolean),mode});res.json({ok:true,item});}catch(e){res.status(500).json({ok:false,error:e.message});}});
app.put('/api/canned/manual/:id',requireAdmin,async(req,res)=>{try{const item=await updateManualResponse(req.params.id,req.body||{});if(!item)return res.status(404).json({ok:false,error:'RESPONSE_NOT_FOUND'});res.json({ok:true,item});}catch(e){res.status(500).json({ok:false,error:e.message});}});
app.delete('/api/canned/manual/:id',requireAdmin,async(req,res)=>{res.json({ok:await deleteManualResponse(req.params.id)});});
app.post('/api/canned/import',requireAdmin,async(req,res)=>{try{const items=Array.isArray(req.body?.items)?req.body.items:[];if(!items.length)return res.status(400).json({ok:false,error:'ITEMS_REQUIRED'});const created=await importManualResponses(items.slice(0,1000));res.json({ok:true,created:created.length});}catch(e){res.status(500).json({ok:false,error:e.message});}});

app.get('/api/human-requests',requireAdmin,async(req,res)=>{const status=String(req.query.status||'OPEN').toUpperCase();res.json({ok:true,items:await listHumanRequests(status,300)});});
app.post('/api/human-requests/:id/answer',requireAdmin,async(req,res)=>{try{const request=await getHumanRequest(req.params.id);if(!request)return res.status(404).json({ok:false,error:'REQUEST_NOT_FOUND'});if(request.status!=='OPEN')return res.status(409).json({ok:false,error:'REQUEST_ALREADY_CLOSED'});const answer=String(req.body?.answer||'').trim();if(!answer)return res.status(400).json({ok:false,error:'ANSWER_REQUIRED'});const item=await answerHumanRequest({request,humanAnswer:answer,saveAsKnowledge:Boolean(req.body?.saveAsKnowledge),livechat:lc});res.json({ok:true,item});}catch(e){await logError('human_request','ANSWER_FAILED',e.message,{id:req.params.id});res.status(502).json({ok:false,error:e.message});}});
app.post('/api/human-requests/:id/cancel',requireAdmin,async(req,res)=>{res.json({ok:await cancelHumanRequest(req.params.id)});});
app.post('/api/test/typo',requireAdmin,(req,res)=>{const text=String(req.body?.text||'');res.json({ok:true,input:text,normalized:normalizeText(text),intent:detectIntent(text)});});
app.post('/api/settings/auto-reply',requireAdmin,async(req,res)=>{const enabled=Boolean(req.body?.enabled);if(enabled&&(!lc.ready()||!ai.ready()))return res.status(400).json({ok:false,error:'LIVECHAT_OR_OPENAI_NOT_READY'});await setSetting('auto_reply',enabled);if(enabled&&config.takeoverOnEnable)await pool.query(`UPDATE conversations SET human_takeover_until=NULL,updated_at=now() WHERE visible_in_inbox=true`);res.json({ok:true,enabled,takeoverCleared:enabled&&config.takeoverOnEnable});});
app.post('/api/settings/greeting',requireAdmin,async(req,res)=>{const enabled=Boolean(req.body?.enabled);await setSetting('greeting_enabled',enabled);res.json({ok:true,enabled});});
app.post('/api/settings/human-ask',requireAdmin,async(req,res)=>{const enabled=Boolean(req.body?.enabled);await setSetting('human_ask_enabled',enabled);res.json({ok:true,enabled});});

app.get('/api/conversations',requireAdmin,async(req,res)=>{const r=await pool.query(`SELECT chat_id,customer_name,customer_email,status,human_takeover_until,last_event_at,last_member_event_at,last_ai_event_at,updated_at FROM conversations WHERE visible_in_inbox=true ORDER BY COALESCE(last_event_at,updated_at) DESC LIMIT 200`);res.json({ok:true,items:r.rows});});
app.get('/api/conversations/:id',requireAdmin,async(req,res)=>{const items=await getContext(req.params.id,100);res.json({ok:true,items});});
app.post('/api/conversations/:id/takeover',requireAdmin,async(req,res)=>{await setHumanTakeover(req.params.id,config.humanTakeoverMinutes);res.json({ok:true});});
app.post('/api/conversations/:id/enable-ai',requireAdmin,async(req,res)=>{await clearHumanTakeover(req.params.id);res.json({ok:true});});
app.post('/api/conversations/:id/send',requireAdmin,async(req,res)=>{const text=String(req.body?.text||'').trim();if(!text)return res.status(400).json({ok:false,error:'EMPTY_TEXT'});try{await setHumanTakeover(req.params.id,config.humanTakeoverMinutes);const sent=await lc.sendMessage(req.params.id,text);const eventId=sent?.event_id||sent?.id||null;if(eventId)await insertMessage({chatId:req.params.id,eventId:String(eventId),senderType:'agent',authorId:'admin',text,normalizedText:normalizeText(text),intent:detectIntent(text),createdAt:new Date().toISOString()});res.json({ok:true,sent});}catch(e){res.status(502).json({ok:false,error:e.message});}});

app.get('/api/rules',requireAdmin,async(req,res)=>{const r=await pool.query(`SELECT * FROM ai_rules ORDER BY id DESC`);res.json({ok:true,items:r.rows});});
app.post('/api/rules',requireAdmin,async(req,res)=>{const {category='GLOBAL',ruleType='FORBID',content}=req.body||{};if(!content)return res.status(400).json({ok:false,error:'CONTENT_REQUIRED'});const r=await pool.query(`INSERT INTO ai_rules(category,rule_type,content) VALUES($1,$2,$3) RETURNING *`,[category,ruleType,content]);res.json({ok:true,item:r.rows[0]});});
app.delete('/api/rules/:id',requireAdmin,async(req,res)=>{await pool.query('DELETE FROM ai_rules WHERE id=$1',[req.params.id]);res.json({ok:true});});
app.get('/api/knowledge',requireAdmin,async(req,res)=>{const r=await pool.query(`SELECT * FROM knowledge_base ORDER BY id DESC`);res.json({ok:true,items:r.rows});});
app.post('/api/knowledge',requireAdmin,async(req,res)=>{const {category='GENERAL',title,content}=req.body||{};if(!title||!content)return res.status(400).json({ok:false,error:'TITLE_CONTENT_REQUIRED'});const r=await pool.query(`INSERT INTO knowledge_base(category,title,content) VALUES($1,$2,$3) RETURNING *`,[category,title,content]);res.json({ok:true,item:r.rows[0]});});
app.delete('/api/knowledge/:id',requireAdmin,async(req,res)=>{await pool.query('DELETE FROM knowledge_base WHERE id=$1',[req.params.id]);res.json({ok:true});});
app.get('/api/logs/ai',requireAdmin,async(req,res)=>{const r=await pool.query(`SELECT * FROM ai_logs ORDER BY id DESC LIMIT 200`);res.json({ok:true,items:r.rows});});
app.get('/api/logs/errors',requireAdmin,async(req,res)=>{const r=await pool.query(`SELECT * FROM errors ORDER BY id DESC LIMIT 200`);res.json({ok:true,items:r.rows});});

// Optional webhook ingress. If a secret is configured, expect x-livechat-signature = HMAC-SHA256 hex of raw JSON body.
app.post('/webhooks/livechat',async(req,res)=>{
  try{
    if(config.lcWebhookSecret){
      const sig=String(req.headers['x-livechat-signature']||'');
      const body=JSON.stringify(req.body||{});
      const expected=crypto.createHmac('sha256',config.lcWebhookSecret).update(body).digest('hex');
      if(!sig || sig.length!==expected.length || !crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected))) return res.status(401).json({ok:false,error:'BAD_SIGNATURE'});
    }
    const p=req.body||{}; const chatId=String(p.chat_id||p.chat?.id||''); const ev=p.event||p;
    if(!chatId || !ev?.text) return res.status(202).json({ok:true,ignored:true});
    await pool.query(`INSERT INTO conversations(chat_id,updated_at) VALUES($1,now()) ON CONFLICT(chat_id) DO UPDATE SET updated_at=now()`,[chatId]);
    const type=String(ev.author_type||'').toLowerCase().includes('customer')?'customer':'agent';
    if(type==='customer') await processCustomerMessage({chatId,eventId:String(ev.id||crypto.randomUUID()),text:String(ev.text),createdAt:ev.created_at||new Date().toISOString(),livechat:lc});
    res.json({ok:true});
  }catch(e){await logError('webhook','WEBHOOK_FAILED',e.message);res.status(500).json({ok:false,error:'WEBHOOK_FAILED'});}
});

app.use((err,req,res,next)=>{console.error(err);res.status(500).json({ok:false,error:'INTERNAL_ERROR'});});

async function boot(){
  try{
    assertBootConfig();
    await migrate();
    console.log('Migration complete');
    const warnings=validateConfig(); if(warnings.length) console.warn('Config warnings:',warnings.join(' | '));
    app.listen(config.port,'0.0.0.0',()=>console.log(`LIVECHAT AI listening on :${config.port}`));
    startPoller(lc);
    startCannedSync();
  }catch(e){console.error('BOOT_FAILED',e);process.exit(1);}
}
boot();
