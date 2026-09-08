import { TelegramClient } from './telegram.js';
import { decryptSecret } from './secure-store.js';
import * as db from './db.js';
import { CATEGORIES, bridgeCategory, isTelegramBridgeCategory } from './bridge-category.js';
let running=false, stop=false, answerHandler=null, actionHandler=null, currentBotUser=null;
let lastError=null,lastPollAt=null,lastHandledAt=null;

function routeFor(settings,category){
  const routes=settings.routes&&typeof settings.routes==='object'?settings.routes:{};
  const r=routes[category]||{};
  return {chatId:String(r.chatId||settings.defaultChatId||'').trim(),topicId:String(r.topicId||'').trim()||null};
}
function clean(s,max=1200){ return String(s??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,' ').trim().slice(0,max); }
function ticketText(ticket,request,attachmentUrls=[]){
  const body=clean(request.ai_question||request.member_message||'Mohon dibantu cek.',1800);
  const files=attachmentUrls.length?`\n\nBukti:\n${attachmentUrls.slice(0,2).join('\n')}`:'';
  // Initial Telegram ticket intentionally stays simple like normal CS chat.
  // Routing safety is kept internally using telegram message_id -> ticket_id -> livechat_chat_id.
  return `${body}${files}`.trim();
}

function ticketKeyboard(ticket){
  const d=(action)=>`hb:${ticket.id}:${action}`;
  if(ticket.category==='RESET_PASSWORD') return {inline_keyboard:[[ {text:'Deposit dahulu',callback_data:d('RESET_DEPOSIT_FIRST')} ]]};
  if(ticket.category==='WD_PROBLEM') return {inline_keyboard:[
    [{text:'WD dalam antrian',callback_data:d('WD_QUEUE')}],
    [{text:'Minta rek valid',callback_data:d('WD_REQUEST_VALID_ACCOUNT')},{text:'DANA limit',callback_data:d('WD_DANA_LIMIT')}]
  ]};
  if(ticket.category==='BONUS') return {inline_keyboard:[[ {text:'DONE',callback_data:d('BONUS_DONE')},{text:'Deposit dahulu',callback_data:d('BONUS_DEPOSIT_FIRST')} ]]};
  return null;
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
    const msg=await tg.sendMessage(route.chatId,ticketText(ticket,request,attachmentUrls),{topicId:route.topicId,replyMarkup:ticketKeyboard(ticket)});
    const saved=await db.markBridgeTicketSent(ticket.id,{messageId:String(msg.message_id),telegramChatId:String(msg.chat.id),topicId:msg.message_thread_id?String(msg.message_thread_id):route.topicId});
    return {ok:true,ticket:saved};
  }catch(e){ lastError=e.message; await db.logError('human_bridge','DISPATCH_FAILED',e.message,{humanRequestId:request?.id}); return {ok:false,error:e.message}; }
}

async function resolveTicketFromTelegramMessage(m){
  const chatId=String(m?.chat?.id||''); if(!chatId) return null;
  const replyId=m?.reply_to_message?.message_id;
  if(replyId){
    const exact=await db.findOpenBridgeTicketByTelegram(chatId,String(replyId));
    if(exact) return exact;
  }
  const quoted=String(m?.reply_to_message?.text||m?.reply_to_message?.caption||'');
  const own=String(m?.text||m?.caption||'');
  const combined=`${quoted}\n${own}`;
  const code=combined.match(/\b(?:RST|WD|DP|BON|CUS)-\d{8}-[A-Z0-9]{4,8}\b/i)?.[0];
  if(code) return db.findOpenBridgeTicketByCode(code);
  return null;
}

async function handleCallback(u,livechat){
  const q=u?.callback_query; if(!q||q.from?.is_bot) return false;
  const m=String(q.data||'').match(/^hb:(\d+):([A-Z0-9_]+)$/); if(!m) return false;
  const settings=await db.getTelegramSettingsInternal(); const tg=new TelegramClient(decryptSecret(settings.botToken));
  const ticket=(await db.listBridgeTickets(500)).find(x=>String(x.id)===String(m[1]) && x.status==='OPEN');
  if(!ticket){ await tg.answerCallbackQuery(q.id,'Ticket sudah selesai / tidak ditemukan').catch(()=>{}); return true; }
  const request=await db.getHumanRequest(ticket.human_request_id);
  if(!request||request.status!=='OPEN'){ await tg.answerCallbackQuery(q.id,'Request sudah selesai').catch(()=>{}); return true; }
  try{
    if(!actionHandler) throw new Error('BRIDGE_ACTION_HANDLER_NOT_READY');
    await actionHandler({request,action:m[2],livechat});
    await db.clearBridgeDeliveryFailure(ticket.id);
    await db.closeBridgeTicket(ticket.id,'ANSWERED',{telegramReplyMessageId:String(q.message?.message_id||''),humanAnswer:`ACTION:${m[2]}`});
    await tg.answerCallbackQuery(q.id,'Sudah dikirim ke member').catch(()=>{});
    await tg.sendMessage(String(q.message?.chat?.id||ticket.telegram_chat_id),`✅ ${ticket.ticket_code}: ${m[2]} sudah dijalankan ke member yang benar.`,{replyTo:q.message?.message_id,topicId:q.message?.message_thread_id||null}).catch(()=>{});
    lastHandledAt=new Date().toISOString();
  }catch(e){
    await db.recordBridgeDeliveryFailure(ticket.id,e.message); lastError=e.message;
    await tg.answerCallbackQuery(q.id,'Gagal, ticket tetap OPEN').catch(()=>{});
    await tg.sendMessage(String(q.message?.chat?.id||ticket.telegram_chat_id),`❌ ${ticket.ticket_code}: ${String(e.message).slice(0,250)}`,{replyTo:q.message?.message_id,topicId:q.message?.message_thread_id||null}).catch(()=>{});
  }
  return true;
}

async function handleUpdate(u,livechat){
  if(await handleCallback(u,livechat)) return;
  const m=u?.message||u?.edited_message; if(!m||m.from?.is_bot) return;
  const chatId=String(m.chat?.id||''); if(!chatId) return;
  const ticket=await resolveTicketFromTelegramMessage(m); if(!ticket) return;
  const answer=String(m.text||m.caption||'').trim(); if(!answer) return;
  const request=await db.getHumanRequest(ticket.human_request_id);
  if(!request||request.status!=='OPEN') { await db.closeBridgeTicket(ticket.id,'CANCELLED'); return; }
  try{
    if(!answerHandler) throw new Error('BRIDGE_ANSWER_HANDLER_NOT_READY');
    const result=await answerHandler({request,humanAnswer:answer,saveAsKnowledge:false,livechat});
    await db.clearBridgeDeliveryFailure(ticket.id);
    await db.closeBridgeTicket(ticket.id,'ANSWERED',{telegramReplyMessageId:String(m.message_id),humanAnswer:answer});
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
export async function startHumanBridge({livechat,onAnswer,onAction}){
  if(running) return; running=true;stop=false;answerHandler=onAnswer;actionHandler=onAction;
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
