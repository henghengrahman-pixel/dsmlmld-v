import crypto from 'node:crypto';
import { config } from './config.js';
import { extractChatEvents } from './livechat.js';
import { normalizeText, detectIntent } from './normalizer.js';
import { processCustomerMessage } from './engine.js';
import * as db from './db.js';

let running=false, timer=null, lastTick=null, lastError=null;
const summaryFingerprints = new Map();
export function pollerStatus(){ return {running,lastTick,lastError,mode:config.lcSyncMode,pollMs:config.lcPollMs,trackedChats:summaryFingerprints.size}; }

function senderType(ev, chat){
  const t=String(ev.authorType||'').toLowerCase();
  if (t.includes('customer')) return 'customer';
  if (t.includes('agent')) return 'agent';
  const u=(chat?.users||[]).find(x=>String(x.id||'')===String(ev.authorId||''));
  const ut=String(u?.type||'').toLowerCase();
  if (ut.includes('customer')) return 'customer';
  if (ut.includes('agent')) return 'agent';
  return 'unknown';
}

function summaryFingerprint(summary){
  // Hash only the summary. LiveChat updates last thread/event data in the summary
  // when the conversation changes, so unchanged chats do not require get_chat again.
  return crypto.createHash('sha1').update(JSON.stringify(summary||{})).digest('hex');
}

export async function syncOnce(livechat){
  if (running) return {skipped:'already_running'};
  running=true; lastError=null;
  try {
    const data=await livechat.listChats();
    const chats=data?._normalizedChats || data?.chats_summary || data?.chats || [];
    let newMessages=0, processed=0, fetched=0, unchanged=0, fetchErrors=0;

    for (const summary of chats) {
      if (!summary?.id) continue;
      const chatId=String(summary.id);
      const fp=summaryFingerprint(summary);
      const oldFp=summaryFingerprints.get(chatId);

      // Always create/update the conversation row from summary data first.
      await db.upsertConversation(summary);

      // Fetch full chat only on first sight or when its summary changes.
      if (oldFp === fp) { unchanged++; continue; }

      let chat=summary;
      if (!Array.isArray(chat?.threads) || chat.threads.length===0) {
        try {
          chat=await livechat.getChat(chatId);
          fetched++;
        } catch (e) {
          fetchErrors++;
          await db.logError('poller','GET_CHAT_FAILED',e.message,{chatId});
          continue;
        }
      }
      if (!chat?.id) continue;
      await db.upsertConversation(chat);

      for (const ev of extractChatEvents(chat)) {
        const type=senderType(ev, chat);
        if (type==='customer') {
          const result=await processCustomerMessage({chatId:String(chat.id),eventId:ev.eventId,text:ev.text,createdAt:ev.createdAt,livechat});
          if (!result?.skipped) processed++;
          if (result?.skipped!=='duplicate') newMessages++;
        } else {
          const ours=await db.outboundLooksLikeOurs(String(chat.id),ev.eventId,ev.text);
          const inserted=await db.insertMessage({chatId:String(chat.id),eventId:ev.eventId,senderType:ours?'ai':'agent',authorId:ev.authorId,text:ev.text,normalizedText:normalizeText(ev.text),intent:detectIntent(ev.text),createdAt:ev.createdAt});
          if (inserted && !ours && type==='agent') await db.setHumanTakeover(String(chat.id),config.humanTakeoverMinutes);
        }
      }
      summaryFingerprints.set(chatId, fp);
    }
    lastTick=new Date().toISOString();
    return {
      ok:true,
      listSource:data?._listSource || 'unknown',
      foundChats:Number(data?.found_chats ?? chats.length),
      chats:chats.length,
      fetched,
      unchanged,
      fetchErrors,
      newMessages,
      processed
    };
  } catch(e){ lastError=e.message; await db.logError('poller','SYNC_FAILED',e.message); throw e; }
  finally { running=false; }
}

export function startPoller(livechat){
  if (config.lcSyncMode!=='polling') return;
  const run=async()=>{ try{await syncOnce(livechat);}catch{} finally{timer=setTimeout(run,config.lcPollMs);} };
  timer=setTimeout(run,1500);
}
export function stopPoller(){ if(timer) clearTimeout(timer); timer=null; }
