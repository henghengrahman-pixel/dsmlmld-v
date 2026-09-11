import { TelegramClient } from './telegram.js';
import { decryptSecret } from './secure-store.js';
import * as db from './db.js';
import { CATEGORIES, bridgeCategory, isTelegramBridgeCategory } from './bridge-category.js';
import { config } from './config.js';
let running=false, stop=false, answerHandler=null, actionHandler=null, currentBotUser=null, currentBotToken='';
let lastError=null,lastPollAt=null,lastHandledAt=null,lastBacklogScanAt=0,lastSlaScanAt=0;

function routeFor(settings,category){
  const routes=settings.routes&&typeof settings.routes==='object'?settings.routes:{};
  const aliases={
    RESET_PASSWORD:['RESET_PASSWORD','RESET','PASSWORD'],
    WD_PROBLEM:['WD_PROBLEM','WD','WITHDRAW'],
    DEPOSIT_PROBLEM:['DEPOSIT_PROBLEM','DEPOSIT','DP'],
    BONUS:['BONUS'],
    ISSUE:['ISSUE','GANGGUAN']
  }[category]||[category,'ISSUE'];
  let r={};
  for(const key of aliases){
    const candidate=routes[key];
    if(candidate&&typeof candidate==='object'&&(String(candidate.chatId||'').trim()||String(candidate.topicId||'').trim())){ r=candidate; break; }
  }
  if(!String(r.chatId||'').trim() && category!=='ISSUE'){
    const issue=routes.ISSUE||routes.GANGGUAN||{};
    if(String(issue.chatId||'').trim()) r=issue;
  }
  return {chatId:String(r.chatId||settings.defaultChatId||'').trim(),topicId:String(r.topicId||'').trim()||null};
}
function clean(s,max=1200){ return String(s??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,' ').trim().slice(0,max); }
function ticketText(ticket,request,attachmentUrls=[]){
  const body=clean(request.ai_question||request.member_message||'Mohon dibantu cek.',1800);
  const files=attachmentUrls.length?`\n\nBukti:\n${attachmentUrls.slice(0,2).join('\n')}`:'';
  // Initial Telegram ticket intentionally stays simple like normal CS chat.
  // Routing safety is kept internally using telegram message_id -> ticket_id -> livechat_chat_id.
  return `🔔 ${ticket.ticket_code}
Kategori: ${ticket.category}

${body}${files}`.trim();
}

function ticketKeyboard(ticket,request=null){
  const d=(action)=>`hb:${ticket.id}:${action}`;
  const intent=String(request?.intent||'').toUpperCase();
  // Account-change tickets share the stable WD Telegram route for backward compatibility,
  // but WD queue/limit buttons are not valid actions for a bank-change request.
  if(intent==='ACCOUNT_CHANGE_REQUEST') return null;
  if(ticket.category==='RESET_PASSWORD'){
    const q=String(request?.ai_question||'').toLowerCase();
    if(q.includes('member sudah deposit') || q.includes('bukti verifikasi')) return {inline_keyboard:[[ {text:'BELUM MASUK',callback_data:d('RESET_DEPOSIT_NOT_IN')} ]]};
    return {inline_keyboard:[
      [{text:'Silakan Melakukan Deposit',callback_data:d('RESET_DEPOSIT_FIRST')}],
      [{text:'Tidak Terdaftar',callback_data:d('RESET_NOT_REGISTERED')}]
    ]};
  }
  if(ticket.category==='DEPOSIT_PROBLEM') return {inline_keyboard:[
    [{text:'Deposit Done',callback_data:d('DP_PROCESSED')}],
    [{text:'Detail Bukti',callback_data:d('DP_DETAIL_PROOF')},{text:'Bukti Tidak Jelas',callback_data:d('DP_UNCLEAR_PROOF')}]
  ]};
  if(ticket.category==='WD_PROBLEM') return {inline_keyboard:[
    [{text:'WD dalam antrian',callback_data:d('WD_QUEUE')}],
    [{text:'Minta rek valid',callback_data:d('WD_REQUEST_VALID_ACCOUNT')},{text:'DANA limit',callback_data:d('WD_DANA_LIMIT')}]
  ]};
  if(ticket.category==='BONUS') {
    const q=String(request?.ai_question||request?.member_message||'').toLowerCase();
    if(q.includes('freebet 50%') || q.includes('freebet') && q.includes('member sudah setuju')) return {inline_keyboard:[[
      {text:'DONE',callback_data:d('BONUS_FREEBET_DONE')},
      {text:'TIDAK BISA CLAIM',callback_data:d('BONUS_FREEBET_NOT_ELIGIBLE')}
    ]]};
    return {inline_keyboard:[[ {text:'DONE',callback_data:d('BONUS_DONE')},{text:'Deposit dahulu',callback_data:d('BONUS_DEPOSIT_FIRST')} ]]};
  }
  return null;
}


function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

export async function notifyTelegramEvent({intent='ISSUE',text='',chatId='',title='INFO LIVECHAT'}={}){
  try{
    const settings=await db.getTelegramSettingsInternal();
    if(!settings.enabled||!settings.botToken) return {ok:false,skipped:'telegram_disabled'};
    const mapped=bridgeCategory(intent); const category=mapped==='PANEL_ONLY'?'ISSUE':mapped;
    const route=routeFor(settings,category);
    if(!route.chatId) return {ok:false,skipped:'route_missing'};
    const tg=new TelegramClient(decryptSecret(settings.botToken));
    const body=`ℹ️ ${clean(title,80)}\nKategori: ${clean(category,40)}\nIntent: ${clean(intent,60)}${chatId?`\nChat: ${clean(chatId,120)}`:''}\n\n${clean(text,1800)}`;
    let err=null;
    for(let i=0;i<config.bridgeMaxRetries;i++){
      try{ const msg=await tg.sendMessage(route.chatId,body,{topicId:route.topicId}); return {ok:true,messageId:String(msg.message_id),chatId:String(msg.chat.id)}; }
      catch(e){ err=e; if(i<config.bridgeMaxRetries-1) await sleep(Math.min(config.bridgeRetryBaseMs*Math.pow(2,i),8000)); }
    }
    const fallback=String(config.telegramFailoverChatId||'').trim();
    if(fallback && fallback!==String(route.chatId)){
      const msg=await tg.sendMessage(fallback,`⚠️ FAILOVER\n${body}`,{topicId:config.telegramFailoverTopicId||null});
      return {ok:true,failover:true,messageId:String(msg.message_id),chatId:String(msg.chat.id)};
    }
    throw err||new Error('TELEGRAM_NOTIFY_FAILED');
  }catch(e){
    lastError=e.message; await db.logError('human_bridge','NOTIFY_FAILED',e.message,{intent,chatId}).catch(()=>{});
    return {ok:false,error:e.message};
  }
}
function authorizedTelegramUser(user){
  // Default behavior: every non-bot member in the configured Telegram group/topic
  // may use Human Bridge buttons and reply to tickets. A whitelist is enforced only
  // when TELEGRAM_OPERATOR_ACCESS_MODE=whitelist is explicitly configured. This keeps
  // legacy TELEGRAM_ALLOWED_USER_IDS values from unexpectedly blocking staff.
  const mode=String(config.telegramOperatorAccessMode||'all').toLowerCase();
  if(mode!=='whitelist') return true;
  const allowed=config.telegramAllowedUserIds||[];
  if(!allowed.length) return true;
  return allowed.includes(String(user?.id||''));
}
async function sendWithRetry(tg,chatId,text,opts,ticket){
  let lastErr=null; const max=config.bridgeMaxRetries;
  for(let i=0;i<max;i++){
    try{return await tg.sendMessage(chatId,text,opts);}catch(e){lastErr=e; const delay=config.bridgeRetryBaseMs*Math.pow(2,i); await db.scheduleBridgeRetry(ticket.id,e.message,i+1,delay).catch(()=>{}); if(i<max-1)await sleep(Math.min(delay,8000));}
  }
  throw lastErr||new Error('TELEGRAM_SEND_FAILED');
}
export async function dispatchHumanRequest(request){
  try{
    const settings=await db.getTelegramSettingsInternal();
    if(!settings.enabled||!settings.botToken) return {ok:false,skipped:'telegram_disabled'};
    if(!isTelegramBridgeCategory(request.intent)) return {ok:false,skipped:'panel_only'};
    const category=bridgeCategory(request.intent); const route=routeFor(settings,category);
    if(!route.chatId) return {ok:false,skipped:'route_missing'};
    const ticket=await db.ensureBridgeTicket(request,{category,telegramChatId:route.chatId,telegramTopicId:route.topicId});
    if(ticket.telegram_message_id) return {ok:true,existing:true,ticket};
    const tg=new TelegramClient(decryptSecret(settings.botToken));
    const ctx=await db.getContext(request.chat_id,8); const attachmentUrls=ctx.flatMap(m=>Array.isArray(m.attachments)?m.attachments:[]).map(a=>a?.url).filter(u=>/^https?:\/\//i.test(String(u||''))).slice(-3);
    if(!(await db.bridgeRetryDue(ticket.id))) return {ok:false,skipped:'retry_backoff',ticket};
    const body=ticketText(ticket,request,attachmentUrls); const opts={topicId:route.topicId,replyMarkup:ticketKeyboard(ticket,request)};
    let msg=null,usedChat=route.chatId,usedTopic=route.topicId;
    try{ msg=await sendWithRetry(tg,route.chatId,body,opts,ticket); }
    catch(primaryError){
      const fallback=String(config.telegramFailoverChatId||'').trim();
      if(fallback && fallback!==String(route.chatId)){
        usedChat=fallback; usedTopic=String(config.telegramFailoverTopicId||'').trim()||null;
        msg=await sendWithRetry(tg,usedChat,`⚠️ FAILOVER ${ticket.ticket_code}\n${body}`,{topicId:usedTopic,replyMarkup:ticketKeyboard(ticket,request)},ticket);
      }else throw primaryError;
    }
    const saved=await db.markBridgeTicketSent(ticket.id,{messageId:String(msg.message_id),telegramChatId:String(msg.chat.id),topicId:msg.message_thread_id?String(msg.message_thread_id):usedTopic});
    return {ok:true,ticket:saved};
  }catch(e){
    lastError=e.message; await db.logError('human_bridge','DISPATCH_FAILED',e.message,{humanRequestId:request?.id});
    const t=request?.id?await db.ensureBridgeTicket(request,{category:bridgeCategory(request.intent),telegramChatId:'',telegramTopicId:null}).catch(()=>null):null;
    if(t && Number(t.delivery_attempts||0)>=config.bridgeMaxRetries){
      await db.addDeadLetter({source:'telegram_bridge',eventKey:t.ticket_code,chatId:request.chat_id,payload:{humanRequestId:request.id,intent:request.intent},error:e.message,attempts:t.delivery_attempts}).catch(()=>{});
      await db.markBridgeDeadLetter(t.id).catch(()=>{});
    }
    return {ok:false,error:e.message};
  }
}

function inferCategoryFromHumanAnswer(text=''){
  const v=String(text||'').toLowerCase();
  if(/(?:user\s*id|userid|username)\s*[:=]|password\s*[:=]|link\s*login\s*[:=]/i.test(v)) return 'RESET_PASSWORD';
  if(/\b(?:dp|deposit)\b.*\b(?:sudah|masuk|belum|pending)\b|\b(?:sudah|belum)\b.*\b(?:dp|deposit)\b/i.test(v)) return 'DEPOSIT_PROBLEM';
  if(/\b(?:wd|withdraw)\b|dana\s+lim(?:it|id)|rekening\s+(?:valid|pengganti)/i.test(v)) return 'WD_PROBLEM';
  if(/\bbonus\b|claim\s+bonus|klaim\s+bonus/i.test(v)) return 'BONUS';
  return null;
}

async function tryResolveUnquotedTicket(m){
  const chatId=String(m?.chat?.id||''); if(!chatId) return null;
  const answer=String(m?.text||m?.caption||'').trim(); if(!answer) return null;
  const category=inferCategoryFromHumanAnswer(answer); if(!category) return null;
  const topicId=m?.message_thread_id?String(m.message_thread_id):null;
  let rows=await db.listOpenBridgeTicketsForTelegram(chatId,{category,topicId,limit:10});
  // Telegram groups without Topics can report no thread id; retry without topic filter.
  if(!rows.length && topicId) rows=await db.listOpenBridgeTicketsForTelegram(chatId,{category,limit:10});
  // Safety first: auto-route an unquoted staff message ONLY when there is exactly one
  // open ticket of the inferred category in this Telegram destination. If multiple
  // members are waiting, require reply-to or ticket code rather than risk mischat.
  if(rows.length===1) return rows[0];
  return null;
}

async function resolveTicketFromTelegramMessage(m){
  const chatId=String(m?.chat?.id||''); if(!chatId) return null;
  const replyId=m?.reply_to_message?.message_id;
  if(replyId){
    const exact=await db.findOpenBridgeTicketByTelegram(chatId,String(replyId));
    if(exact) return exact;

    // Reset-password continuation safety: RESET_DEPOSIT_FIRST intentionally answers
    // the first Human Request after telling the member to verify via deposit. Staff
    // often keep replying to that original Telegram ticket after verification. The
    // old v1.17 resolver only searched OPEN tickets, so the credential reply was
    // silently ignored. Allow ONLY an exact reply_to_message match to that reset
    // ticket; never infer sensitive credentials from an unquoted message.
    const prior=await db.findBridgeTicketByTelegram(chatId,String(replyId));
    const priorAction=String(prior?.human_answer||'');
    if(prior && prior.category==='RESET_PASSWORD' && (/^ACTION:RESET_DEPOSIT_FIRST$/i.test(priorAction) || /^ACTION:RESET_DEPOSIT_NOT_IN$/i.test(priorAction))){
      return {...prior,_resetContinuation:true};
    }
  }
  const own=String(m?.text||m?.caption||'');
  // Reset credentials are sensitive. Never auto-route them from an unquoted
  // Telegram message or a typed ticket code. Staff must REPLY to the exact ticket.
  const lines=own.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  const likelyReset=/password|psw|userid|user id|username|https?:\/\//i.test(own) || lines.length>=3;
  if(likelyReset) return null;
  const quoted=String(m?.reply_to_message?.text||m?.reply_to_message?.caption||'');
  const combined=`${quoted}\n${own}`;
  const code=combined.match(/\b(?:WD|DP|BON|CUS)-\d{8}-[A-Z0-9]{4,8}\b/i)?.[0];
  if(code) return db.findOpenBridgeTicketByCode(code);
  return tryResolveUnquotedTicket(m);
}

async function handleCallback(u,livechat){
  const q=u?.callback_query; if(!q||q.from?.is_bot) return false;
  const m=String(q.data||'').match(/^hb:(\d+):([A-Z0-9_]+)$/); if(!m) return false;

  // CallbackQuery MUST always be acknowledged quickly. Telegram keeps the button in
  // a loading/spinner state until answerCallbackQuery is received. v1.23.0 returned
  // early for unauthorized operators without ACK, which looked exactly like a frozen
  // BONUS DONE button. Reuse the token already loaded by the polling loop so ACK does
  // not need to wait for another DB round-trip.
  let tg=null;
  try{
    let token=currentBotToken;
    if(!token){ const settings=await db.getTelegramSettingsInternal(); token=decryptSecret(settings.botToken); }
    tg=new TelegramClient(token);
    if(!authorizedTelegramUser(q.from)){
      await tg.answerCallbackQuery(q.id,'Akun Telegram ini belum diizinkan.').catch(()=>{});
      return true;
    }
    // ACK before ticket lookup / LiveChat delivery. Any later error is reported as a
    // normal Telegram message while the button spinner is already stopped.
    await tg.answerCallbackQuery(q.id,'Sedang diproses…').catch(()=>{});
  }catch(e){
    lastError=e.message;
    await db.logError('human_bridge','CALLBACK_ACK_FAILED',e.message,{updateId:u?.update_id,userId:q.from?.id}).catch(()=>{});
  }

  const before=await db.getBridgeTicketById(m[1]);
  if(!before || (before.telegram_message_id && String(q.message?.message_id||'')!==String(before.telegram_message_id))){
    if(tg) await tg.sendMessage(String(q.message?.chat?.id||''),`⚠️ Tombol ticket sudah tidak valid.`,{replyTo:q.message?.message_id,topicId:q.message?.message_thread_id||null}).catch(()=>{});
    return true;
  }

  // Claim atomically before any slow LiveChat call. Prevents double execution when
  // operators tap the same button repeatedly or multiple bot loops overlap briefly.
  const ticket=await db.claimBridgeTicketAction(m[1],m[2]);
  if(!ticket){
    const existing=await db.getBridgeTicketById(m[1]);
    const text=existing?.status==='PROCESSING'?'Ticket sedang diproses…':'Ticket sudah selesai / tidak ditemukan';
    if(tg) await tg.sendMessage(String(q.message?.chat?.id||before.telegram_chat_id),`ℹ️ ${before.ticket_code}: ${text}`,{replyTo:q.message?.message_id,topicId:q.message?.message_thread_id||null}).catch(()=>{});
    return true;
  }

  const request=await db.getHumanRequest(ticket.human_request_id);
  if(!request||request.status!=='OPEN'){
    await db.closeBridgeTicket(ticket.id,'ANSWERED',{telegramReplyMessageId:String(q.message?.message_id||''),humanAnswer:'REQUEST_ALREADY_CLOSED'}).catch(()=>{});
    return true;
  }
  try{
    if(!actionHandler) throw new Error('BRIDGE_ACTION_HANDLER_NOT_READY');
    await actionHandler({request,action:m[2],livechat});
    await db.clearBridgeDeliveryFailure(ticket.id);
    await db.closeBridgeTicket(ticket.id,'ANSWERED',{telegramReplyMessageId:String(q.message?.message_id||''),humanAnswer:`ACTION:${m[2]}`});
    await tg.sendMessage(String(q.message?.chat?.id||ticket.telegram_chat_id),`✅ ${ticket.ticket_code}: ${m[2]} sudah dijalankan ke member yang benar.`,{replyTo:q.message?.message_id,topicId:q.message?.message_thread_id||null}).catch(()=>{});
    lastHandledAt=new Date().toISOString();
  }catch(e){
    await db.recordBridgeDeliveryFailure(ticket.id,e.message);
    await db.reopenBridgeTicket(ticket.id,e.message).catch(()=>{});
    lastError=e.message;
    await tg.sendMessage(String(q.message?.chat?.id||ticket.telegram_chat_id),`❌ ${ticket.ticket_code}: ${String(e.message).slice(0,250)}. Ticket tetap aktif, silakan tekan lagi.`,{replyTo:q.message?.message_id,topicId:q.message?.message_thread_id||null}).catch(()=>{});
  }
  return true;
}

async function handleUpdate(u,livechat){
  if(await handleCallback(u,livechat)) return;
  const m=u?.message||u?.edited_message; if(!m||m.from?.is_bot) return;
  if(!authorizedTelegramUser(m.from)) return;
  const chatId=String(m.chat?.id||''); if(!chatId) return;
  const ticket=await resolveTicketFromTelegramMessage(m); if(!ticket) return;
  const answer=String(m.text||m.caption||'').trim(); if(!answer) return;
  let request=await db.getHumanRequest(ticket.human_request_id);
  if(!request) return;
  // If CS replied to the original reset ticket after choosing deposit verification,
  // prefer the newest OPEN reset request for the SAME LiveChat chat. This covers the
  // normal flow where the member has already sent proof and a fresh verification
  // request/ticket was created. The routing key stays chat_id, so credentials cannot
  // jump to another member.
  if(ticket._resetContinuation && request.status!=='OPEN'){
    const active=await db.getOpenHumanRequest(ticket.chat_id);
    if(active && String(active.intent||'').toUpperCase()==='FORGOT_PASSWORD') request=active;
  }
  const allowAnsweredReset=Boolean(ticket._resetContinuation && String(request.intent||'').toUpperCase()==='FORGOT_PASSWORD');
  if(request.status!=='OPEN' && !allowAnsweredReset) return;
  try{
    if(!answerHandler) throw new Error('BRIDGE_ANSWER_HANDLER_NOT_READY');
    const result=await answerHandler({request,humanAnswer:answer,saveAsKnowledge:false,livechat});
    await db.clearBridgeDeliveryFailure(ticket.id);
    await db.closeBridgeTicket(ticket.id,'ANSWERED',{telegramReplyMessageId:String(m.message_id),humanAnswer:answer});
    // When a reply to the original reset ticket was redirected to a newer OPEN
    // Human Request, close that newer bridge ticket too. This prevents a second CS
    // reply from sending the same credentials twice.
    if(String(request.id)!==String(ticket.human_request_id)) await db.closeBridgeTicketByRequest(request.id,'ANSWERED').catch(()=>{});
    const settings=await db.getTelegramSettingsInternal(); const tg=new TelegramClient(decryptSecret(settings.botToken));
    const ack=result?.silent
      ? `✅ ${ticket.ticket_code}: status WD pending disimpan. Tidak ada balasan tambahan ke member; tunggu member chat lagi.`
      : `✅ ${ticket.ticket_code} sudah diteruskan ke member LiveChat yang benar.`;
    await tg.sendMessage(chatId,ack,{replyTo:m.message_id,topicId:m.message_thread_id||null}).catch(()=>{});
    lastHandledAt=new Date().toISOString();
  }catch(e){
    lastError=e.message; await db.recordBridgeDeliveryFailure(ticket.id,e.message); await db.logError('human_bridge','TELEGRAM_REPLY_FAILED',e.message,{ticketId:ticket.id,updateId:u.update_id});
    const settings=await db.getTelegramSettingsInternal(); if(settings.botToken){ const tg=new TelegramClient(decryptSecret(settings.botToken));
      const msg=String(e.message).startsWith('RESET_REPLY_INCOMPLETE')
        ? `⚠️ ${ticket.ticket_code}: data reset belum lengkap. Reply lagi ke ticket ini dengan minimal User ID/Username dan Password. Ticket tetap OPEN.`
        : `❌ ${ticket.ticket_code} belum berhasil diteruskan: ${String(e.message).slice(0,300)}. Ticket tetap OPEN, boleh reply lagi setelah diperbaiki.`;
      await tg.sendMessage(chatId,msg,{replyTo:m.message_id,topicId:m.message_thread_id||null}).catch(()=>{}); }
  }
}

export function bridgeStatus(){ return {running,lastError,lastPollAt,lastHandledAt,botUsername:currentBotUser?.username||null}; }

async function handleUpdatesConcurrent(updates,livechat,limit=8){
  const items=Array.isArray(updates)?updates:[];
  if(!items.length) return;
  let index=0;
  const worker=async()=>{
    while(true){
      const i=index++;
      if(i>=items.length) return;
      const updateId=items[i]?.update_id;
      try{
        if(updateId!=null && !(await db.claimTelegramUpdate(updateId))) continue;
        await handleUpdate(items[i],livechat);
        if(updateId!=null) await db.finishTelegramUpdate(updateId);
      }
      catch(e){
        if(updateId!=null) await db.failTelegramUpdate(updateId,e.message).catch(()=>{});
        await db.logError('human_bridge','UPDATE_FAILED',e.message,{updateId}).catch(()=>{});
      }
    }
  };
  await Promise.all(Array.from({length:Math.min(Math.max(1,limit),items.length)},worker));
}

export async function startHumanBridge({livechat,onAnswer,onAction}){
  if(running) return; running=true;stop=false;answerHandler=onAnswer;actionHandler=onAction;
  (async()=>{
    while(!stop){
      try{
        const settings=await db.getTelegramSettingsInternal();
        if(!settings.enabled||!settings.botToken){ await new Promise(r=>setTimeout(r,3000)); continue; }
        const token=decryptSecret(settings.botToken); currentBotToken=token;
        const tg=new TelegramClient(token);
        if(!tg.ready()) throw new Error('TELEGRAM_BOT_TOKEN_INVALID');
        if(!currentBotUser){ currentBotUser=await tg.getMe(); }
        // Retry OPEN Human Bridge requests that previously failed to dispatch (for example
        // because a category route was missing when the request was first created). Existing
        // tickets with telegram_message_id are idempotent and will not be sent twice.
        if(Date.now()-lastBacklogScanAt>10000){
          const opens=await db.listHumanRequests('OPEN',200);
          for(const req of opens){ if(isTelegramBridgeCategory(req.intent)) await dispatchHumanRequest(req); }
          lastBacklogScanAt=Date.now();
        }
        await db.recoverStaleBridgeProcessing(120).catch(()=>{});
        if(Date.now()-lastSlaScanAt>30000){
          const breached=await db.listSlaBreachedBridgeTickets(30).catch(()=>[]);
          const alertChat=String(config.telegramFailoverChatId||settings.defaultChatId||'').trim();
          for(const t of breached){
            if(alertChat) await tg.sendMessage(alertChat,`⚠️ SLA WARNING ${t.ticket_code}\nCase belum dijawab melewati ${config.bridgeSlaMinutes} menit.`,{topicId:config.telegramFailoverTopicId||null}).catch(()=>{});
            await db.markBridgeSlaAlerted(t.id).catch(()=>{});
          }
          lastSlaScanAt=Date.now();
        }
        const offset=Number(settings.lastUpdateId||0)+1;
        const updates=await tg.getUpdates({offset,timeout:20}); lastPollAt=new Date().toISOString();
        let max=Number(settings.lastUpdateId||0);
        for(const u of updates||[]) max=Math.max(max,Number(u.update_id||0));
        // Handle up to 8 updates concurrently. A slow DONE delivery no longer blocks
        // buttons on the tickets below it. Offset advances only after the batch settles.
        await handleUpdatesConcurrent(updates,livechat,8);
        if(max>Number(settings.lastUpdateId||0)) await db.setTelegramLastUpdateId(max);
        lastError=null;
      }catch(e){ lastError=e.message; await db.logError('human_bridge','POLL_FAILED',e.message).catch(()=>{}); await new Promise(r=>setTimeout(r,5000)); }
    }
    running=false;
  })();
}
export function stopHumanBridge(){stop=true;currentBotToken=''}
export {CATEGORIES};
