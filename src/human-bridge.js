import { TelegramClient } from './telegram.js';
import { decryptSecret } from './secure-store.js';
import * as db from './db.js';
import { CATEGORIES, bridgeCategory } from './bridge-category.js';
let running=false, stop=false, answerHandler=null, currentBotUser=null;
let lastError=null,lastPollAt=null,lastHandledAt=null;

function routeFor(settings,category){
  const routes=settings.routes&&typeof settings.routes==='object'?settings.routes:{};
  const r=routes[category]||{};
  return {chatId:String(r.chatId||settings.defaultChatId||'').trim(),topicId:String(r.topicId||'').trim()||null};
}
function clean(s,max=1200){ return String(s??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,' ').trim().slice(0,max); }
function ticketText(ticket,request,attachmentUrls=[]){
  const icon={RESET_PASSWORD:'🔐',WD_PROBLEM:'💸',DEPOSIT_PROBLEM:'💰',BONUS:'🎁',CUSTOM:'🧑‍💻'}[ticket.category]||'🧑‍💻';
  const files=attachmentUrls.length?`\n\nBukti/lampiran terbaru:\n${attachmentUrls.slice(0,3).map((u,i)=>`${i+1}. ${u}`).join('\n')}`:'';
  return `${icon} HUMAN BRIDGE — ${ticket.category}\nTicket: ${ticket.ticket_code}\nMember: ${clean(request.customer_name||request.chat_id,120)}\nLiveChat ID: ${clean(request.chat_id,160)}\nIntent: ${clean(request.intent||'GENERAL',80)}\n\nPesan member:\n${clean(request.member_message,1400)}\n\nAI butuh bantuan:\n${clean(request.ai_question,1400)}${files}\n\n↩️ WAJIB reply langsung ke pesan ticket ini. Balasan akan diteruskan hanya ke member yang terikat pada ticket ini.`;
}

export async function dispatchHumanRequest(request){
  try{
    const settings=await db.getTelegramSettingsInternal();
    if(!settings.enabled||!settings.botToken) return {ok:false,skipped:'telegram_disabled'};
    const category=bridgeCategory(request.intent); const route=routeFor(settings,category);
    if(!route.chatId) return {ok:false,skipped:'route_missing'};
    const ticket=await db.ensureBridgeTicket(request,{category,telegramChatId:route.chatId,telegramTopicId:route.topicId});
    if(ticket.telegram_message_id) return {ok:true,existing:true,ticket};
    const tg=new TelegramClient(decryptSecret(settings.botToken));
    const ctx=await db.getContext(request.chat_id,8); const attachmentUrls=ctx.flatMap(m=>Array.isArray(m.attachments)?m.attachments:[]).map(a=>a?.url).filter(u=>/^https?:\/\//i.test(String(u||''))).slice(-3);
    const msg=await tg.sendMessage(route.chatId,ticketText(ticket,request,attachmentUrls),{topicId:route.topicId});
    const saved=await db.markBridgeTicketSent(ticket.id,{messageId:String(msg.message_id),telegramChatId:String(msg.chat.id),topicId:msg.message_thread_id?String(msg.message_thread_id):route.topicId});
    return {ok:true,ticket:saved};
  }catch(e){ lastError=e.message; await db.logError('human_bridge','DISPATCH_FAILED',e.message,{humanRequestId:request?.id}); return {ok:false,error:e.message}; }
}

async function handleUpdate(u,livechat){
  const m=u?.message; if(!m||m.from?.is_bot) return;
  const replyId=m.reply_to_message?.message_id; if(!replyId) return;
  const chatId=String(m.chat?.id||''); if(!chatId) return;
  const ticket=await db.findOpenBridgeTicketByTelegram(chatId,String(replyId)); if(!ticket) return;
  const answer=String(m.text||m.caption||'').trim(); if(!answer) return;
  const request=await db.getHumanRequest(ticket.human_request_id);
  if(!request||request.status!=='OPEN') { await db.closeBridgeTicket(ticket.id,'CANCELLED'); return; }
  try{
    if(!answerHandler) throw new Error('BRIDGE_ANSWER_HANDLER_NOT_READY');
    await answerHandler({request,humanAnswer:answer,saveAsKnowledge:false,livechat});
    await db.closeBridgeTicket(ticket.id,'ANSWERED',{telegramReplyMessageId:String(m.message_id),humanAnswer:answer});
    const settings=await db.getTelegramSettingsInternal(); const tg=new TelegramClient(decryptSecret(settings.botToken));
    await tg.sendMessage(chatId,`✅ ${ticket.ticket_code} sudah diteruskan ke member LiveChat yang benar.`,{replyTo:m.message_id,topicId:m.message_thread_id||null}).catch(()=>{});
    lastHandledAt=new Date().toISOString();
  }catch(e){
    lastError=e.message; await db.logError('human_bridge','TELEGRAM_REPLY_FAILED',e.message,{ticketId:ticket.id,updateId:u.update_id});
    const settings=await db.getTelegramSettingsInternal(); if(settings.botToken){ const tg=new TelegramClient(decryptSecret(settings.botToken)); await tg.sendMessage(chatId,`❌ ${ticket.ticket_code} gagal diteruskan: ${String(e.message).slice(0,300)}. Ticket tetap OPEN.`,{replyTo:m.message_id,topicId:m.message_thread_id||null}).catch(()=>{}); }
  }
}

export function bridgeStatus(){ return {running,lastError,lastPollAt,lastHandledAt,botUsername:currentBotUser?.username||null}; }
export async function startHumanBridge({livechat,onAnswer}){
  if(running) return; running=true;stop=false;answerHandler=onAnswer;
  (async()=>{
    while(!stop){
      try{
        const settings=await db.getTelegramSettingsInternal();
        if(!settings.enabled||!settings.botToken){ await new Promise(r=>setTimeout(r,3000)); continue; }
        const tg=new TelegramClient(decryptSecret(settings.botToken));
        if(!tg.ready()) throw new Error('TELEGRAM_BOT_TOKEN_INVALID');
        if(!currentBotUser){ currentBotUser=await tg.getMe(); }
        const offset=Number(settings.lastUpdateId||0)+1;
        const updates=await tg.getUpdates({offset,timeout:20}); lastPollAt=new Date().toISOString();
        let max=Number(settings.lastUpdateId||0);
        for(const u of updates||[]){ max=Math.max(max,Number(u.update_id||0)); await handleUpdate(u,livechat); }
        if(max>Number(settings.lastUpdateId||0)) await db.setTelegramLastUpdateId(max);
        lastError=null;
      }catch(e){ lastError=e.message; await db.logError('human_bridge','POLL_FAILED',e.message).catch(()=>{}); await new Promise(r=>setTimeout(r,5000)); }
    }
    running=false;
  })();
}
export function stopHumanBridge(){stop=true}
export {CATEGORIES};
