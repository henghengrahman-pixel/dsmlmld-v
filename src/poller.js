import crypto from 'node:crypto';
import { config } from './config.js';
import { extractChatEvents } from './livechat.js';
import { normalizeText, detectIntent } from './normalizer.js';
import { processCustomerMessage } from './engine.js';
import * as db from './db.js';

let running=false, timer=null, lastTick=null, lastError=null, lastResult=null;
const summaryFingerprints = new Map();
export function pollerStatus(){ return {running,lastTick,lastError,lastResult,mode:config.lcSyncMode,pollMs:config.lcPollMs,trackedChats:summaryFingerprints.size}; }

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

function summaryFingerprint(summary){ return crypto.createHash('sha1').update(JSON.stringify(summary||{})).digest('hex'); }
function ageSeconds(iso){ const t=Date.parse(iso||''); return Number.isFinite(t) ? Math.max(0,(Date.now()-t)/1000) : Infinity; }

async function ingestAgentEvent(chatId, ev, chat, {allowTakeover=true}={}) {
  const ours=await db.outboundLooksLikeOurs(chatId,ev.eventId,ev.text);
  const inserted=await db.insertMessage({chatId,eventId:ev.eventId,senderType:ours?'ai':'agent',authorId:ev.authorId,text:ev.text,normalizedText:normalizeText(ev.text),intent:detectIntent(ev.text),createdAt:ev.createdAt});
  if (inserted && allowTakeover && !ours && ageSeconds(ev.createdAt) <= config.humanTakeoverMinutes*60) {
    await db.setHumanTakeover(chatId,config.humanTakeoverMinutes);
  }
  return inserted;
}

async function bootstrapChat(chatId, chat, events, livechat) {
  let inserted=0, processed=0;
  const latest=events.at(-1);
  for (const ev of events.slice(0,-1)) {
    const type=senderType(ev,chat);
    if (type==='customer') {
      if (await db.insertMessage({chatId,eventId:ev.eventId,senderType:'customer',authorId:ev.authorId,text:ev.text,normalizedText:normalizeText(ev.text),intent:detectIntent(ev.text),createdAt:ev.createdAt})) inserted++;
    } else if (type==='agent') {
      if (await ingestAgentEvent(chatId,ev,chat,{allowTakeover:true})) inserted++;
    }
  }
  if (latest) {
    const type=senderType(latest,chat);
    if (type==='customer' && ageSeconds(latest.createdAt) <= config.bootstrapReplyMaxAgeSeconds) {
      const r=await processCustomerMessage({chatId,eventId:latest.eventId,text:latest.text,createdAt:latest.createdAt,livechat});
      if (!r?.skipped) processed++;
      if (r?.skipped!=='duplicate') inserted++;
    } else if (type==='customer') {
      if (await db.insertMessage({chatId,eventId:latest.eventId,senderType:'customer',authorId:latest.authorId,text:latest.text,normalizedText:normalizeText(latest.text),intent:detectIntent(latest.text),createdAt:latest.createdAt})) inserted++;
    } else if (type==='agent') {
      if (await ingestAgentEvent(chatId,latest,chat,{allowTakeover:true})) inserted++;
    }
  }
  await db.markBootstrapped(chatId);
  return {inserted,processed};
}

export async function syncOnce(livechat){
  if (running) return {skipped:'already_running'};
  running=true; lastError=null;
  try {
    const data=await livechat.listChats();
    const rawChats=data?._normalizedChats || data?.chats_summary || data?.chats || [];
    const chats=livechat.filterInbox(rawChats);
    await db.hideAllInboxConversations();
    let newMessages=0, processed=0, fetched=0, unchanged=0, fetchErrors=0, bootstrapped=0;

    for (const summary of chats) {
      if (!summary?.id) continue;
      const chatId=String(summary.id);
      const fp=summaryFingerprint(summary);
      const oldFp=summaryFingerprints.get(chatId);
      const state=livechat.chatState(summary);
      await db.upsertConversation(summary,{visible:true,state});
      const dbState=await db.getConversationState(chatId);

      // If already bootstrapped and summary unchanged, no API detail fetch is needed.
      if (dbState?.bootstrapped_at && oldFp === fp) { unchanged++; continue; }

      let chat=summary;
      if (!Array.isArray(chat?.threads) || chat.threads.length===0) {
        try { chat=await livechat.getChat(chatId); fetched++; }
        catch (e) { fetchErrors++; await db.logError('poller','GET_CHAT_FAILED',e.message,{chatId}); continue; }
      }
      if (!chat?.id) continue;
      await db.upsertConversation(chat,{visible:true,state});
      const events=extractChatEvents(chat);

      if (!dbState?.bootstrapped_at) {
        const b=await bootstrapChat(chatId,chat,events,livechat);
        newMessages+=b.inserted; processed+=b.processed; bootstrapped++;
        summaryFingerprints.set(chatId,fp);
        continue;
      }

      // Coalesce message bursts: ingest every newly seen event, but invoke AI only for
      // the newest customer event when it is also the newest event in the chat. This
      // prevents 2-4 AI replies when a member sends several short fragments quickly.
      const unseen=[];
      for (const ev of events) if (!(await db.messageExists(chatId,ev.eventId))) unseen.push(ev);
      const newest=unseen.at(-1) || null;
      for (const ev of unseen) {
        const type=senderType(ev,chat);
        const isNewest = newest && ev.eventId===newest.eventId;
        if (type==='customer' && isNewest) {
          const result=await processCustomerMessage({chatId,eventId:ev.eventId,text:ev.text,createdAt:ev.createdAt,livechat});
          if (!result?.skipped) processed++;
          if (result?.skipped!=='duplicate') newMessages++;
        } else if (type==='customer') {
          if (await db.insertMessage({chatId,eventId:ev.eventId,senderType:'customer',authorId:ev.authorId,text:ev.text,normalizedText:normalizeText(ev.text),intent:detectIntent(ev.text),createdAt:ev.createdAt})) newMessages++;
        } else if (type==='agent') {
          if (await ingestAgentEvent(chatId,ev,chat,{allowTakeover:true})) newMessages++;
        }
      }
      summaryFingerprints.set(chatId,fp);
    }
    lastTick=new Date().toISOString();
    lastResult={ok:true,listSource:data?._listSource||'unknown',rawChats:rawChats.length,chats:chats.length,fetched,unchanged,fetchErrors,bootstrapped,newMessages,processed};
    return lastResult;
  } catch(e){ lastError=e.message; await db.logError('poller','SYNC_FAILED',e.message); throw e; }
  finally { running=false; }
}

export function startPoller(livechat){
  if (config.lcSyncMode!=='polling') return;
  const run=async()=>{ try{await syncOnce(livechat);}catch{} finally{timer=setTimeout(run,config.lcPollMs);} };
  timer=setTimeout(run,1200);
}
export function stopPoller(){ if(timer) clearTimeout(timer); timer=null; }
