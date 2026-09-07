import { config } from './config.js';
import { normalizeText, detectIntent } from './normalizer.js';
import { OpenAIClient } from './ai.js';
import * as db from './db.js';
import { guardDecision } from './guard.js';
import { greetingText } from './greeting.js';

const ai = new OpenAIClient();
function formatRows(rows, fields){ return rows.map(r=>fields.map(f=>r[f]).filter(Boolean).join(' | ')).join('\n'); }
function safeHoldingReply(){ return 'Baik bosku, kami bantu cek dulu ya 😊🙏'; }

async function sendAndStore(livechat,chatId,text,intent,senderType='ai'){
  const sent=await livechat.sendMessage(chatId,text);
  const sentEventId=sent?.event_id || sent?.id || null;
  await db.saveOutbound(chatId,text,sentEventId);
  if(sentEventId) await db.insertMessage({chatId,eventId:String(sentEventId),senderType,authorId:'',text,normalizedText:normalizeText(text),intent,createdAt:new Date().toISOString()});
  return sent;
}

async function buildSources(chatId,intent,normalized){
  const contextRows=await db.getContext(chatId,config.aiMaxContext);
  const rulesRows=await db.getRules(intent); const kbRows=await db.getKnowledge(intent);
  const query=`${normalized} ${contextRows.filter(m=>m.sender_type==='customer').slice(-3).map(m=>m.text).join(' ')}`;
  const cannedRows=await db.getRelevantCanned(query,8);
  const context=contextRows.map(m=>`${m.sender_type==='customer'?'MEMBER':m.sender_type==='ai'?'AI':'AGENT'}: ${m.text}`).join('\n');
  const rules=formatRows(rulesRows,['category','rule_type','content']);
  const manualKnowledge=formatRows(kbRows,['category','title','content']);
  const responses=cannedRows.map(r=>`[RESPONSE ${r.shortcut||r.title||r.source_id}] [${r.response_mode||'FLEXIBLE'}] [${r.category||'GENERAL'}] ${r.content}`).join('\n');
  return {context,rules,knowledge:[manualKnowledge,responses].filter(Boolean).join('\n'),hasKnowledge:Boolean(manualKnowledge||responses)};
}

export async function processCustomerMessage({chatId,eventId,text,createdAt,livechat}) {
  const normalized=normalizeText(text); const intent=detectIntent(text);
  const inserted=await db.insertMessage({chatId,eventId,senderType:'customer',text,normalizedText:normalized,intent,createdAt,authorId:''});
  if (!inserted) return {skipped:'duplicate'};
  if (await db.isHumanTakeover(chatId)) return {skipped:'human_takeover'};
  const auto=Boolean(await db.getSetting('auto_reply',config.autoReplyDefault));
  if (!auto) return {skipped:'auto_reply_off',intent,normalized};

  const openHuman=await db.getOpenHumanRequest(chatId);
  if(openHuman) return {skipped:'waiting_human',intent,humanRequestId:openHuman.id};

  const greetingEnabled=Boolean(await db.getSetting('greeting_enabled',config.greetingEnabled));
  let greeted=false;
  if(greetingEnabled && await db.claimGreeting(chatId,config.greetingCooldownHours)){
    try{ await sendAndStore(livechat,chatId,greetingText(new Date(),config.timezone),'GREETING'); greeted=true; }
    catch(e){ await db.logError('engine','GREETING_SEND_FAILED',e.message,{chatId}); }
  }
  if(greeted && intent==='GREETING') return {intent,decision:{action:'AUTO_REPLY',confidence:1,reply:null,reason:'greeting_sent'},sent:true};

  const src=await buildSources(chatId,intent,normalized);
  try {
    let decision=await ai.classifyAndReply({normalized,intent,context:src.context,rules:src.rules,knowledge:src.knowledge});
    if (decision.confidence < config.aiConfidence && !['ASK_INFO'].includes(decision.action)) decision.action='ASK_HUMAN';
    if(['AUTO_REPLY','ASK_INFO'].includes(decision.action)) decision=guardDecision({intent,decision,hasKnowledge:src.hasKnowledge});

    if(['ASK_HUMAN','HANDOFF'].includes(decision.action)){
      const humanAsk=Boolean(await db.getSetting('human_ask_enabled',config.humanAskEnabled));
      if(humanAsk){
        const question=decision.humanQuestion || `Mohon bantu tentukan jawaban untuk member ini. Intent: ${intent}. Pesan: ${text}`;
        const req=await db.createHumanRequest({chatId,sourceEventId:eventId,intent,memberMessage:text,question});
        const holding=decision.reply?.trim() || safeHoldingReply();
        if(holding) await sendAndStore(livechat,chatId,holding,intent);
        await db.logAI({chatId,sourceEventId:eventId,intent,...decision,reply:holding,reason:`${decision.reason||''} | human_request:${req.id}`});
        return {intent,decision,humanRequestId:req.id,sent:Boolean(holding)};
      }
      await db.logAI({chatId,sourceEventId:eventId,intent,...decision});
      return {intent,decision};
    }

    if (!decision.reply) {
      await db.logAI({chatId,sourceEventId:eventId,intent,...decision});
      return {intent,decision};
    }
    await sendAndStore(livechat,chatId,decision.reply,intent);
    await db.logAI({chatId,sourceEventId:eventId,intent,...decision});
    return {intent,decision,sent:true};
  } catch (e) {
    await db.logAI({chatId,sourceEventId:eventId,intent,error:e.message});
    await db.logError('engine','AI_PROCESS_FAILED',e.message,{chatId,eventId,intent});
    if(Boolean(await db.getSetting('human_ask_enabled',config.humanAskEnabled))){
      const req=await db.createHumanRequest({chatId,sourceEventId:eventId,intent,memberMessage:text,question:`AI gagal menentukan jawaban (${e.message}). Mohon berikan instruksi balasan untuk member.`});
      return {intent,error:e.message,humanRequestId:req.id};
    }
    return {intent,error:e.message};
  }
}

export async function answerHumanRequest({request,humanAnswer,saveAsKnowledge=false,livechat}){
  const src=await buildSources(request.chat_id,request.intent||'GENERAL',normalizeText(request.member_message));
  const composed=await ai.composeFromHuman({memberMessage:request.member_message,intent:request.intent||'GENERAL',humanAnswer,context:src.context,rules:src.rules,knowledge:src.knowledge});
  if(!composed.text) throw new Error('AI_EMPTY_HUMAN_COMPOSE_REPLY');
  await sendAndStore(livechat,request.chat_id,composed.text,request.intent||'GENERAL');
  const answered=await db.answerHumanRequest(request.id,{answer:humanAnswer,finalReply:composed.text,saveAsKnowledge});
  if(saveAsKnowledge){
    await db.pool.query(`INSERT INTO knowledge_base(category,title,content) VALUES($1,$2,$3)`,[request.intent||'GENERAL',`Belajar dari Human Request #${request.id}`,humanAnswer]);
  }
  await db.logAI({chatId:request.chat_id,sourceEventId:request.source_event_id,intent:request.intent,action:'HUMAN_ASSISTED',confidence:1,reply:composed.text,reason:`Human Request #${request.id}`,usage:composed.usage});
  return answered;
}
