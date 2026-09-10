import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, validateConfig, assertBootConfig } from './config.js';
import { migrate, healthDb, pool, getSetting, setSetting, getContext, setHumanTakeover, clearHumanTakeover, withChatLock, isHumanTakeover, logError, insertMessage, addAiCorrection, backfillHumanLearning, backfillHumanLearningAll, getConversationBrain, listLearningExamples, setLearningStatus, promoteLearningToKnowledge, promoteLearningToResponse, captureHumanReplyLearning, markConversationEnded, learningStats, getConversationState, markAiMessageFeedback, aiFeedbackStats } from './db.js';
import { LiveChatClient } from './livechat.js';
import { OpenAIClient } from './ai.js';
import { normalizeText, detectIntent } from './normalizer.js';
import { createSession, parseCookies, verifySession, requireAdmin } from './auth.js';
import { startPoller, pollerStatus, syncOnce } from './poller.js';
import { processCustomerMessage, answerHumanRequest, applyHumanAction } from './engine.js';
import { cannedClient, startCannedSync, syncCannedNow, cannedSyncStatus } from './canned-sync.js';
import { cannedStats, listCannedResponses, createManualResponse, updateManualResponse, deleteManualResponse, importManualResponses, listHumanRequests, getHumanRequest, cancelHumanRequest, getTelegramSettingsInternal, saveTelegramSettings, setTelegramEnabled, listBridgeTickets, closeBridgeTicketByRequest, listPromoRules, createPromoRule, updatePromoRule, deletePromoRule, listImportantInfo, createImportantInfo, updateImportantInfo, deleteImportantInfo } from './db.js';
import { TelegramClient } from './telegram.js';
import { encryptSecret, decryptSecret, maskSecret } from './secure-store.js';
import { startHumanBridge, bridgeStatus, dispatchHumanRequest, CATEGORIES } from './human-bridge.js';
import { sanitizeCorrection } from './learning.js';

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
  const tg=await getTelegramSettingsInternal();
  res.json({ok:true,db:dbOk,livechatConfigured:lc.ready(),openaiConfigured:ai.ready(),systemEnabled:Boolean(await getSetting('system_enabled',true)),autoReply:Boolean(await getSetting('auto_reply',false)),greetingEnabled:Boolean(await getSetting('greeting_enabled',config.greetingEnabled)),humanAskEnabled:Boolean(await getSetting('human_ask_enabled',config.humanAskEnabled)),replyStyle:{replyStyle:String(await getSetting('reply_style','NATURAL_CS')||'NATURAL_CS'),replyLength:String(await getSetting('reply_length','SHORT')||'SHORT'),boskuUsage:String(await getSetting('bosku_usage','MODERATE')||'MODERATE'),emojiUsage:String(await getSetting('emoji_usage','LIGHT')||'LIGHT'),formalLanguage:Boolean(await getSetting('formal_language',false)),replyStyleNote:String(await getSetting('reply_style_note','')||'')},poller:pollerStatus(),cannedSync:cannedSyncStatus(),canned:await cannedStats(),humanBridge:{configured:Boolean(tg.botToken),enabled:Boolean(tg.enabled),...bridgeStatus()},model:config.openaiModel,timezone:config.timezone,warnings:validateConfig()});
});
app.post('/api/test/livechat',requireAdmin,async(req,res)=>{try{res.json(await lc.test());}catch(e){await logError('livechat','TEST_FAILED',e.message);res.status(502).json({ok:false,error:e.message});}});
app.post('/api/test/chat-detail',requireAdmin,async(req,res)=>{try{const list=await lc.listChats();const raw=list?._normalizedChats||[];const chats=lc.filterInbox(raw);if(!chats.length)return res.json({ok:true,chatCount:0,detail:null});const summary=chats[0];const chat=await lc.getChat(String(summary.id),summary);res.json({ok:true,chatId:String(summary.id),diagnostics:lc.chatDiagnostics(chat)});}catch(e){await logError('livechat','CHAT_DETAIL_TEST_FAILED',e.message);res.status(502).json({ok:false,error:e.message});}});
app.post('/api/test/openai',requireAdmin,async(req,res)=>{try{res.json(await ai.test());}catch(e){await logError('openai','TEST_FAILED',e.message);res.status(502).json({ok:false,error:e.message});}});
app.post('/api/test/sync',requireAdmin,async(req,res)=>{try{res.json(await syncOnce(lc,{manual:true}));}catch(e){res.status(502).json({ok:false,error:e.message});}});
app.post('/api/test/canned',requireAdmin,async(req,res)=>{try{res.json(await cannedClient.test());}catch(e){await logError('canned','TEST_FAILED',e.message);res.status(502).json({ok:false,error:e.message,hint:e.status===403?'PAT belum memiliki izin membaca canned responses/Responses List. Tambahkan read scope untuk canned responses di Text Developer Console.':null});}});
app.post('/api/canned/sync',requireAdmin,async(req,res)=>{try{res.json(await syncCannedNow({manual:true}));}catch(e){res.status(502).json({ok:false,error:e.message,hint:e.status===403?'Tambahkan read scope canned responses ke PAT, lalu buat PAT baru dan update LIVECHAT_PAT.':null});}});
app.get('/api/canned',requireAdmin,async(req,res)=>{res.json({ok:true,stats:await cannedStats(),items:await listCannedResponses(1000)});});
app.post('/api/canned/manual',requireAdmin,async(req,res)=>{try{const {shortcut='',title='',category='GENERAL',content='',tags=[],mode='FLEXIBLE'}=req.body||{};if(!String(content).trim())return res.status(400).json({ok:false,error:'CONTENT_REQUIRED'});const item=await createManualResponse({shortcut:String(shortcut).trim(),title:String(title).trim(),category,content:String(content).trim(),tags:Array.isArray(tags)?tags:String(tags||'').split(',').map(x=>x.trim()).filter(Boolean),mode});res.json({ok:true,item});}catch(e){res.status(500).json({ok:false,error:e.message});}});
app.put('/api/canned/manual/:id',requireAdmin,async(req,res)=>{try{const item=await updateManualResponse(req.params.id,req.body||{});if(!item)return res.status(404).json({ok:false,error:'RESPONSE_NOT_FOUND'});res.json({ok:true,item});}catch(e){res.status(500).json({ok:false,error:e.message});}});
app.delete('/api/canned/manual/:id',requireAdmin,async(req,res)=>{res.json({ok:await deleteManualResponse(req.params.id)});});
app.post('/api/canned/import',requireAdmin,async(req,res)=>{try{const items=Array.isArray(req.body?.items)?req.body.items:[];if(!items.length)return res.status(400).json({ok:false,error:'ITEMS_REQUIRED'});const created=await importManualResponses(items.slice(0,1000));res.json({ok:true,created:created.length});}catch(e){res.status(500).json({ok:false,error:e.message});}});

app.get('/api/promos',requireAdmin,async(req,res)=>{res.json({ok:true,items:await listPromoRules({activeOnly:false,limit:500})});});
app.post('/api/promos',requireAdmin,async(req,res)=>{try{res.json({ok:true,item:await createPromoRule(req.body||{})});}catch(e){res.status(400).json({ok:false,error:e.message});}});
app.put('/api/promos/:id',requireAdmin,async(req,res)=>{try{const item=await updatePromoRule(req.params.id,req.body||{});if(!item)return res.status(404).json({ok:false,error:'PROMO_NOT_FOUND'});res.json({ok:true,item});}catch(e){res.status(400).json({ok:false,error:e.message});}});
app.delete('/api/promos/:id',requireAdmin,async(req,res)=>{res.json({ok:await deletePromoRule(req.params.id)});});


app.get('/api/important-info',requireAdmin,async(req,res)=>{try{res.json({ok:true,items:await listImportantInfo({activeOnly:false,type:String(req.query.type||''),limit:1500})});}catch(e){res.status(500).json({ok:false,error:e.message});}});
app.post('/api/important-info',requireAdmin,async(req,res)=>{try{res.json({ok:true,item:await createImportantInfo(req.body||{})});}catch(e){res.status(400).json({ok:false,error:e.message});}});
app.put('/api/important-info/:id',requireAdmin,async(req,res)=>{try{const item=await updateImportantInfo(req.params.id,req.body||{});if(!item)return res.status(404).json({ok:false,error:'IMPORTANT_INFO_NOT_FOUND'});res.json({ok:true,item});}catch(e){res.status(400).json({ok:false,error:e.message});}});
app.delete('/api/important-info/:id',requireAdmin,async(req,res)=>{res.json({ok:await deleteImportantInfo(req.params.id)});});

app.get('/api/human-requests',requireAdmin,async(req,res)=>{const status=String(req.query.status||'OPEN').toUpperCase();res.json({ok:true,items:await listHumanRequests(status,300)});});
app.post('/api/human-requests/:id/answer',requireAdmin,async(req,res)=>{try{const request=await getHumanRequest(req.params.id);if(!request)return res.status(404).json({ok:false,error:'REQUEST_NOT_FOUND'});if(request.status!=='OPEN')return res.status(409).json({ok:false,error:'REQUEST_ALREADY_CLOSED'});const answer=String(req.body?.answer||'').trim();if(!answer)return res.status(400).json({ok:false,error:'ANSWER_REQUIRED'});const item=await answerHumanRequest({request,humanAnswer:answer,saveAsKnowledge:Boolean(req.body?.saveAsKnowledge),livechat:lc});await closeBridgeTicketByRequest(request.id,'ANSWERED');res.json({ok:true,item});}catch(e){await logError('human_request','ANSWER_FAILED',e.message,{id:req.params.id});res.status(502).json({ok:false,error:e.message});}});
app.post('/api/human-requests/:id/action',requireAdmin,async(req,res)=>{try{const request=await getHumanRequest(req.params.id);if(!request)return res.status(404).json({ok:false,error:'REQUEST_NOT_FOUND'});if(request.status!=='OPEN')return res.status(409).json({ok:false,error:'REQUEST_ALREADY_CLOSED'});const action=String(req.body?.action||'').trim();if(!action)return res.status(400).json({ok:false,error:'ACTION_REQUIRED'});const item=await applyHumanAction({request,action,livechat:lc});await closeBridgeTicketByRequest(request.id,'ANSWERED');res.json({ok:true,item,action});}catch(e){await logError('human_request','ACTION_FAILED',e.message,{id:req.params.id,action:req.body?.action});res.status(502).json({ok:false,error:e.message});}});
app.post('/api/human-requests/:id/cancel',requireAdmin,async(req,res)=>{const ok=await cancelHumanRequest(req.params.id);if(ok)await closeBridgeTicketByRequest(req.params.id,'CANCELLED');res.json({ok});});


app.get('/api/human-bridge/settings',requireAdmin,async(req,res)=>{
  const x=await getTelegramSettingsInternal(); let token=''; try{token=x.botToken?decryptSecret(x.botToken):'';}catch{}
  res.json({ok:true,configured:Boolean(token),botTokenMasked:maskSecret(token),botUsername:x.botUsername||bridgeStatus().botUsername||null,defaultChatId:x.defaultChatId||'',routes:x.routes||{},enabled:Boolean(x.enabled),categories:CATEGORIES,status:bridgeStatus()});
});
app.put('/api/human-bridge/settings',requireAdmin,async(req,res)=>{
  try{
    const body=req.body||{}; const token=String(body.botToken||'').trim(); const defaultChatId=String(body.defaultChatId||'').trim();
    const routes={}; for(const c of CATEGORIES){const r=body.routes?.[c]||{};routes[c]={chatId:String(r.chatId||'').trim(),topicId:String(r.topicId||'').trim()};}
    let enc=null, username=null;
    if(token){ const tg=new TelegramClient(token); const me=await tg.getMe(); enc=encryptSecret(token); username=me.username||null; }
    const saved=await saveTelegramSettings({botTokenEnc:enc,botUsername:username,defaultChatId,routes,enabled:null});
    res.json({ok:true,configured:Boolean(saved.botToken),botUsername:saved.botUsername,defaultChatId:saved.defaultChatId,routes:saved.routes,enabled:saved.enabled});
  }catch(e){await logError('human_bridge','SETTINGS_SAVE_FAILED',e.message);res.status(400).json({ok:false,error:e.message});}
});
app.post('/api/human-bridge/test',requireAdmin,async(req,res)=>{
  try{const x=await getTelegramSettingsInternal();if(!x.botToken)return res.status(400).json({ok:false,error:'TELEGRAM_BOT_TOKEN_NOT_SET'});const tg=new TelegramClient(decryptSecret(x.botToken));const me=await tg.getMe();res.json({ok:true,bot:{id:me.id,username:me.username,firstName:me.first_name}});}catch(e){res.status(502).json({ok:false,error:e.message});}
});
app.post('/api/human-bridge/test-message',requireAdmin,async(req,res)=>{
  try{const x=await getTelegramSettingsInternal();if(!x.botToken)return res.status(400).json({ok:false,error:'TELEGRAM_BOT_TOKEN_NOT_SET'});const chatId=String(req.body?.chatId||x.defaultChatId||'').trim();if(!chatId)return res.status(400).json({ok:false,error:'TELEGRAM_CHAT_ID_REQUIRED'});const topicId=String(req.body?.topicId||'').trim()||null;const tg=new TelegramClient(decryptSecret(x.botToken));const m=await tg.sendMessage(chatId,'✅ LIVECHAT AI Human Bridge terhubung. Pesan test berhasil.',{topicId});res.json({ok:true,messageId:m.message_id,chatId:String(m.chat.id)});}catch(e){res.status(502).json({ok:false,error:e.message});}
});
app.post('/api/human-bridge/enabled',requireAdmin,async(req,res)=>{
  try{const enabled=Boolean(req.body?.enabled);const x=await getTelegramSettingsInternal();if(enabled&&!x.botToken)return res.status(400).json({ok:false,error:'TELEGRAM_BOT_TOKEN_NOT_SET'});if(enabled){const tg=new TelegramClient(decryptSecret(x.botToken));await tg.getMe();await tg.deleteWebhook();}await setTelegramEnabled(enabled);let dispatched=0;if(enabled){const opens=await listHumanRequests('OPEN',300);for(const r of opens){const d=await dispatchHumanRequest(r);if(d?.ok)dispatched++;}}res.json({ok:true,enabled,dispatched});}catch(e){res.status(502).json({ok:false,error:e.message});}
});
app.get('/api/human-bridge/tickets',requireAdmin,async(req,res)=>{res.json({ok:true,items:await listBridgeTickets(300),status:bridgeStatus()});});
app.post('/api/human-bridge/requests/:id/send',requireAdmin,async(req,res)=>{try{const request=await getHumanRequest(req.params.id);if(!request)return res.status(404).json({ok:false,error:'REQUEST_NOT_FOUND'});res.json(await dispatchHumanRequest(request));}catch(e){res.status(502).json({ok:false,error:e.message});}});
app.post('/api/test/typo',requireAdmin,(req,res)=>{const text=String(req.body?.text||'');res.json({ok:true,input:text,normalized:normalizeText(text),intent:detectIntent(text)});});

app.post('/api/settings/system-enabled',requireAdmin,async(req,res)=>{
  const enabled=Boolean(req.body?.enabled);
  if(enabled&&(!lc.ready()||!ai.ready())) return res.status(400).json({ok:false,error:'LIVECHAT_OR_OPENAI_NOT_READY'});
  await setSetting('system_enabled',enabled);
  // Keep automatic handling enabled whenever the master is ON; per-chat Human Takeover is preserved.
  if(enabled) await setSetting('auto_reply',true);
  res.json({ok:true,enabled,note:enabled?'LiveChat sync + AI aktif.':'Background LiveChat sync dan OpenAI dihentikan; tidak ada polling LiveChat selama OFF.'});
});

app.post('/api/settings/auto-reply',requireAdmin,async(req,res)=>{const enabled=Boolean(req.body?.enabled);if(enabled&&(!lc.ready()||!ai.ready()))return res.status(400).json({ok:false,error:'LIVECHAT_OR_OPENAI_NOT_READY'});await setSetting('auto_reply',enabled);res.json({ok:true,enabled,note:'Per-chat HUMAN TAKEOVER tidak diubah oleh global switch.'});});
app.post('/api/settings/greeting',requireAdmin,async(req,res)=>{const enabled=Boolean(req.body?.enabled);await setSetting('greeting_enabled',enabled);res.json({ok:true,enabled});});
app.post('/api/settings/human-ask',requireAdmin,async(req,res)=>{const enabled=Boolean(req.body?.enabled);await setSetting('human_ask_enabled',enabled);res.json({ok:true,enabled});});

app.get('/api/settings/reply-style',requireAdmin,async(req,res)=>{
  res.json({ok:true,replyStyle:String(await getSetting('reply_style','NATURAL_CS')||'NATURAL_CS'),replyLength:String(await getSetting('reply_length','SHORT')||'SHORT'),boskuUsage:String(await getSetting('bosku_usage','MODERATE')||'MODERATE'),emojiUsage:String(await getSetting('emoji_usage','LIGHT')||'LIGHT'),formalLanguage:Boolean(await getSetting('formal_language',false)),replyStyleNote:String(await getSetting('reply_style_note','')||'')});
});
app.put('/api/settings/reply-style',requireAdmin,async(req,res)=>{
  const body=req.body||{};
  const replyStyle=String(body.replyStyle||'NATURAL_CS').toUpperCase();
  const replyLength=String(body.replyLength||'SHORT').toUpperCase();
  const boskuUsage=String(body.boskuUsage||'MODERATE').toUpperCase();
  const emojiUsage=String(body.emojiUsage||'LIGHT').toUpperCase();
  const formalLanguage=Boolean(body.formalLanguage);
  const replyStyleNote=String(body.replyStyleNote||'').trim().slice(0,1000);
  if(!['NATURAL_CS','FRIENDLY','PROFESSIONAL'].includes(replyStyle)) return res.status(400).json({ok:false,error:'INVALID_REPLY_STYLE'});
  if(!['SHORT','MEDIUM'].includes(replyLength)) return res.status(400).json({ok:false,error:'INVALID_REPLY_LENGTH'});
  if(!['RARE','MODERATE','FREQUENT'].includes(boskuUsage)) return res.status(400).json({ok:false,error:'INVALID_BOSKU_USAGE'});
  if(!['NONE','LIGHT','NORMAL'].includes(emojiUsage)) return res.status(400).json({ok:false,error:'INVALID_EMOJI_USAGE'});
  await Promise.all([setSetting('reply_style',replyStyle),setSetting('reply_length',replyLength),setSetting('bosku_usage',boskuUsage),setSetting('emoji_usage',emojiUsage),setSetting('formal_language',formalLanguage),setSetting('reply_style_note',replyStyleNote)]);
  res.json({ok:true,replyStyle,replyLength,boskuUsage,emojiUsage,formalLanguage,replyStyleNote});
});

app.get('/api/conversations',requireAdmin,async(req,res)=>{const r=await pool.query(`SELECT c.chat_id,c.customer_name,c.customer_email,c.status,c.handling_mode,c.takeover_reason,c.takeover_at,c.last_event_at,c.last_member_event_at,c.last_ai_event_at,c.workflow_type,c.workflow_state,c.member_typing,c.member_typing_updated_at,c.created_at,c.updated_at,
  lm.text AS last_message,lm.sender_type AS last_sender_type,lm.created_at AS last_message_at,
  CASE WHEN c.last_member_event_at IS NOT NULL AND (c.last_ai_event_at IS NULL OR c.last_member_event_at>c.last_ai_event_at) THEN true ELSE false END AS needs_reply
  FROM conversations c
  LEFT JOIN LATERAL (SELECT m.text,m.sender_type,m.created_at FROM messages m WHERE m.chat_id=c.chat_id ORDER BY m.created_at DESC,m.id DESC LIMIT 1) lm ON true
  WHERE c.visible_in_inbox=true ORDER BY c.lc_inbox_rank ASC NULLS LAST, COALESCE(c.last_event_at,c.updated_at) DESC LIMIT 200`);res.json({ok:true,items:r.rows});});
app.get('/api/conversations/:id',requireAdmin,async(req,res)=>{const [items,state,brain]=await Promise.all([getContext(req.params.id,100),getConversationState(req.params.id),getConversationBrain(req.params.id)]);res.json({ok:true,items,state,brain:brain?.case_brain||{},feedbackStats:await aiFeedbackStats()});});
app.get('/api/conversations/:id/brain',requireAdmin,async(req,res)=>{res.json({ok:true,...await getConversationBrain(req.params.id)});});
app.post('/api/conversations/:id/takeover',requireAdmin,async(req,res)=>{await setHumanTakeover(req.params.id,'dashboard_takeover');res.json({ok:true,mode:'HUMAN'});});
app.post('/api/conversations/:id/enable-ai',requireAdmin,async(req,res)=>{const out=await withChatLock(req.params.id,async()=>{await clearHumanTakeover(req.params.id);return {ok:true,mode:'AI'};});res.json(out);});
app.post('/api/conversations/:id/end',requireAdmin,async(req,res)=>{try{const out=await withChatLock(req.params.id,async()=>{const lcResult=await lc.endChat(req.params.id);const local=await markConversationEnded(req.params.id);return {ok:true,ended:true,livechat:lcResult,local};});res.json(out);}catch(e){await logError('livechat','END_CHAT_FAILED',e.message,{chatId:req.params.id});res.status(e.status||502).json({ok:false,error:e.message});}});
app.post('/api/conversations/:id/send',requireAdmin,async(req,res)=>{const text=String(req.body?.text||'').trim();if(!text)return res.status(400).json({ok:false,error:'EMPTY_TEXT'});try{const out=await withChatLock(req.params.id,async()=>{if(!(await isHumanTakeover(req.params.id))) { const er=new Error('HUMAN_TAKEOVER_REQUIRED'); er.status=409; throw er; } const sent=await lc.sendMessage(req.params.id,text);const eventId=sent?.event_id||sent?.id||null;if(eventId){await insertMessage({chatId:req.params.id,eventId:String(eventId),senderType:'agent',authorId:'admin',text,normalizedText:normalizeText(text),intent:detectIntent(text),createdAt:new Date().toISOString()});await captureHumanReplyLearning({chatId:req.params.id,eventId:String(eventId),responseText:text}).catch(()=>{});}return {ok:true,sent};});res.json(out);}catch(e){res.status(e.status||502).json({ok:false,error:e.message});}});


app.post('/api/learning/backfill',requireAdmin,async(req,res)=>{try{const maxRows=Math.max(1000,Math.min(Number(req.body?.limit||50000),100000));res.json({ok:true,...await backfillHumanLearningAll({batchSize:2000,maxRows})});}catch(e){res.status(500).json({ok:false,error:e.message});}});
app.get('/api/learning',requireAdmin,async(req,res)=>{
  const status=String(req.query.status||'ALL').toUpperCase();
  res.json({ok:true,items:await listLearningExamples(status,400),stats:await learningStats()});
});
app.post('/api/learning/:id/status',requireAdmin,async(req,res)=>{
  try{const item=await setLearningStatus(req.params.id,String(req.body?.status||''));if(!item)return res.status(404).json({ok:false,error:'LEARNING_NOT_FOUND'});res.json({ok:true,item});}catch(e){res.status(400).json({ok:false,error:e.message});}
});
app.post('/api/learning/:id/promote-knowledge',requireAdmin,async(req,res)=>{
  try{res.json({ok:true,item:await promoteLearningToKnowledge(req.params.id)});}catch(e){res.status(400).json({ok:false,error:e.message});}
});
app.post('/api/learning/:id/promote-response',requireAdmin,async(req,res)=>{
  try{res.json({ok:true,item:await promoteLearningToResponse(req.params.id)});}catch(e){res.status(400).json({ok:false,error:e.message});}
});
app.post('/api/conversations/:id/feedback',requireAdmin,async(req,res)=>{
  try{
    const eventId=String(req.body?.eventId||'').trim(); const rating=String(req.body?.rating||'BAD').toUpperCase();
    if(!eventId)return res.status(400).json({ok:false,error:'EVENT_ID_REQUIRED'});
    if(rating==='GOOD'){
      const item=await markAiMessageFeedback({chatId:req.params.id,eventId,rating:'GOOD',note:String(req.body?.note||'')});
      return res.json({ok:true,item,note:'Jawaban ditandai bagus untuk quality score. Tidak otomatis dijadikan fakta.'});
    }
    const correction=sanitizeCorrection(req.body?.correction);
    if(!correction)return res.status(400).json({ok:false,error:'CORRECTION_REQUIRED'});
    await markAiMessageFeedback({chatId:req.params.id,eventId,rating:'BAD',note:correction}).catch(()=>{});
    const item=await addAiCorrection({chatId:req.params.id,aiEventId:eventId,correction});
    res.json({ok:true,item,note:'Koreksi langsung aktif sebagai contoh pembelajaran untuk kasus serupa.'});
  }catch(e){res.status(400).json({ok:false,error:e.message});}
});

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
    backfillHumanLearningAll({batchSize:2000,maxRows:100000}).then(r=>console.log('CS learning initial backfill',r)).catch(e=>console.warn('CS learning initial backfill failed',e.message));
    const learningWorker=async()=>{
      try{ const r=await backfillHumanLearning(2500); if(r.scanned) console.log('CS history learning batch',r); setTimeout(learningWorker,r.scanned?250:60000); }
      catch(e){ console.warn('CS history learning failed',e.message); setTimeout(learningWorker,15000); }
    };
    setTimeout(learningWorker,1500);
    const warnings=validateConfig(); if(warnings.length) console.warn('Config warnings:',warnings.join(' | '));
    app.listen(config.port,'0.0.0.0',()=>console.log(`LIVECHAT AI listening on :${config.port}`));
    startPoller(lc);
    startCannedSync();
    startHumanBridge({livechat:lc,onAnswer:answerHumanRequest,onAction:applyHumanAction});
  }catch(e){console.error('BOOT_FAILED',e);process.exit(1);}
}
boot();
