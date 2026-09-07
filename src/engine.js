import { config } from './config.js';
import { normalizeText, detectIntent } from './normalizer.js';
import { OpenAIClient } from './ai.js';
import * as db from './db.js';
import { guardDecision } from './guard.js';
import { greetingText } from './greeting.js';
import { dispatchHumanRequest } from './human-bridge.js';

const ai = new OpenAIClient();
function formatRows(rows, fields){ return rows.map(r=>fields.map(f=>r[f]).filter(Boolean).join(' | ')).join('\n'); }
function safeHoldingReply(){ return 'Baik bosku, kami bantu cek dulu ya 😊🙏'; }

async function sendAndStore(livechat,chatId,text,intent,senderType='ai'){
  if(senderType==='ai' && await db.isHumanTakeover(chatId)) throw new Error('HUMAN_TAKEOVER_ACTIVE');
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
  const context=contextRows.map(m=>`${m.sender_type==='customer'?'MEMBER':m.sender_type==='ai'?'AI':m.sender_type==='system'?'SYSTEM':'AGENT'}: ${m.text}`).join('\n');
  const rules=formatRows(rulesRows,['category','rule_type','content']);
  const manualKnowledge=formatRows(kbRows,['category','title','content']);
  const responses=cannedRows.map(r=>`[RESPONSE ${r.shortcut||r.title||r.source_id}] [${r.response_mode||'FLEXIBLE'}] [${r.category||'GENERAL'}] ${r.content}`).join('\n');
  const attachments=contextRows.filter(m=>m.sender_type==='customer').slice(-4).flatMap(m=>Array.isArray(m.attachments)?m.attachments:[]).filter(a=>a?.isImage).slice(-3);
  return {context,rules,knowledge:[manualKnowledge,responses].filter(Boolean).join('\n'),hasKnowledge:Boolean(manualKnowledge||responses),attachments};
}

export async function processCustomerMessage({chatId,eventId,text,createdAt,livechat,attachments=[]}) {
  const beforeState=await db.getConversationState(chatId);
  const wasNew=Number(beforeState?.message_count||0)===0;
  const normalized=normalizeText(text); const intent=detectIntent(text);
  const inserted=await db.insertMessage({chatId,eventId,senderType:'customer',text,normalizedText:normalized,intent,createdAt,authorId:'',attachments});
  if (!inserted) return {skipped:'duplicate'};

  return db.withChatLock(chatId, async()=>{
    // Re-check after obtaining the per-chat lock so a human Take Over always wins
    // against an AI reply that was being prepared concurrently.
    if (await db.isHumanTakeover(chatId)) return {skipped:'human_takeover'};
    const auto=Boolean(await db.getSetting('auto_reply',config.autoReplyDefault));
    if (!auto) return {skipped:'auto_reply_off',intent,normalized};

    const openHuman=await db.getOpenHumanRequest(chatId);
    if(openHuman) return {skipped:'waiting_human',intent,humanRequestId:openHuman.id};

    const greetingEnabled=Boolean(await db.getSetting('greeting_enabled',config.greetingEnabled));
    let greeted=false;
    if(greetingEnabled && wasNew && await db.claimGreeting(chatId,{onlyIfNew:true})){
      try{ await sendAndStore(livechat,chatId,greetingText(new Date(),config.timezone),'GREETING'); greeted=true; }
      catch(e){ if(e.message==='HUMAN_TAKEOVER_ACTIVE') return {skipped:'human_takeover'}; await db.logError('engine','GREETING_SEND_FAILED',e.message,{chatId}); }
    }
    if(greeted && intent==='GREETING') return {intent,decision:{action:'AUTO_REPLY',confidence:1,reply:null,reason:'greeting_sent'},sent:true};

    const src=await buildSources(chatId,intent,normalized);
    try {
      const mergedAttachments=[...(src.attachments||[]),...(attachments||[])].filter((a,i,arr)=>a?.url&&arr.findIndex(x=>x?.url===a.url)===i).slice(-3);
      let aiAttachments=mergedAttachments;
      if(mergedAttachments.length && typeof livechat.prepareImageAttachments==='function'){
        try{ aiAttachments=await livechat.prepareImageAttachments(mergedAttachments); }catch{}
      }
      let decision=await ai.classifyAndReply({normalized,intent,context:src.context,rules:src.rules,knowledge:src.knowledge,attachments:aiAttachments});
      if (decision.confidence < config.aiConfidence && !['ASK_INFO'].includes(decision.action)) decision.action='ASK_HUMAN';
      if(['AUTO_REPLY','ASK_INFO'].includes(decision.action)) decision=guardDecision({intent,decision,hasKnowledge:src.hasKnowledge});

      // Human can press Take Over while OpenAI is thinking. Check once more before any action/send.
      if (await db.isHumanTakeover(chatId)) return {skipped:'human_takeover_after_ai'};

      if(['ASK_HUMAN','HANDOFF'].includes(decision.action)){
        const humanAsk=Boolean(await db.getSetting('human_ask_enabled',config.humanAskEnabled));
        if(humanAsk){
          const question=decision.humanQuestion || `Mohon bantu tentukan jawaban untuk member ini. Intent: ${intent}. Pesan: ${text}`;
          const req=await db.createHumanRequest({chatId,sourceEventId:eventId,intent,memberMessage:text,question});
          await dispatchHumanRequest(req);
          const holding=decision.reply?.trim() || safeHoldingReply();
          if(holding && !(await db.isHumanTakeover(chatId))) await sendAndStore(livechat,chatId,holding,intent);
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
      if (await db.isHumanTakeover(chatId)) return {skipped:'human_takeover_before_send'};
      await sendAndStore(livechat,chatId,decision.reply,intent);
      await db.logAI({chatId,sourceEventId:eventId,intent,...decision});
      return {intent,decision,sent:true};
    } catch (e) {
      if(e.message==='HUMAN_TAKEOVER_ACTIVE') return {skipped:'human_takeover'};
      await db.logAI({chatId,sourceEventId:eventId,intent,error:e.message});
      await db.logError('engine','AI_PROCESS_FAILED',e.message,{chatId,eventId,intent});
      if(Boolean(await db.getSetting('human_ask_enabled',config.humanAskEnabled)) && !(await db.isHumanTakeover(chatId))){
        const req=await db.createHumanRequest({chatId,sourceEventId:eventId,intent,memberMessage:text,question:`AI gagal menentukan jawaban (${e.message}). Mohon berikan instruksi balasan untuk member.`});
        await dispatchHumanRequest(req);
        return {intent,error:e.message,humanRequestId:req.id};
      }
      return {intent,error:e.message};
    }
  });
}



export async function processGreetingTrigger({chatId,eventId,text,createdAt,livechat}){
  return db.withChatLock(chatId, async()=>{
    if (await db.isHumanTakeover(chatId)) return {skipped:'human_takeover'};
    const auto=Boolean(await db.getSetting('auto_reply',config.autoReplyDefault));
    if(!auto) return {skipped:'auto_reply_off'};
    const greetingEnabled=Boolean(await db.getSetting('greeting_enabled',config.greetingEnabled));
    if(!greetingEnabled) return {skipped:'greeting_off'};
    if(!(await db.claimGreeting(chatId,{onlyIfNew:false}))) return {skipped:'greeting_already_sent'};
    try{
      const reply=greetingText(new Date(),config.timezone);
      await sendAndStore(livechat,chatId,reply,'GREETING');
      await db.logAI({chatId,sourceEventId:eventId||null,intent:'GREETING',action:'AUTO_GREETING_TRIGGER',confidence:1,reply,reason:'LiveChat automatic promo/welcome trigger'});
      return {sent:true,reply};
    }catch(e){
      await db.logError('engine','AUTO_GREETING_TRIGGER_FAILED',e.message,{chatId,eventId});
      return {error:e.message};
    }
  });
}

function criticalHumanFacts(text=''){
  const s=String(text||''); const facts=new Set();
  const patterns=[/https?:\/\/\S+/gi,/\b\d{6,}\b/g,/\b(?:userid|user id|username|password|psw|link login|rekening|nominal)\s*[:=]\s*([^\n]{2,160})/gi];
  for(const re of patterns){let m;while((m=re.exec(s))){facts.add(String(m[1]||m[0]).trim().replace(/[.,;]+$/,''));}}
  return [...facts].filter(Boolean).slice(0,20);
}
function exactHumanFallback(answer,intent){
  const a=String(answer||'').trim();
  if(String(intent||'').toUpperCase()==='FORGOT_PASSWORD' && /(?:password|psw)\s*[:=]/i.test(a)) return `Siap bosku 😊🙏\n${a}\n\nSilakan dicoba terlebih dahulu ya bosku.`.slice(0,1200);
  return `Baik bosku 😊🙏\n${a}`.slice(0,1200);
}

export async function answerHumanRequest({request,humanAnswer,saveAsKnowledge=false,livechat}){
  return db.withChatLock(request.chat_id, async()=>{
  if(await db.isHumanTakeover(request.chat_id)) throw new Error('HUMAN_TAKEOVER_ACTIVE');
  const src=await buildSources(request.chat_id,request.intent||'GENERAL',normalizeText(request.member_message));
  const composed=await ai.composeFromHuman({memberMessage:request.member_message,intent:request.intent||'GENERAL',humanAnswer,context:src.context,rules:src.rules,knowledge:src.knowledge});
  if(!composed.text) throw new Error('AI_EMPTY_HUMAN_COMPOSE_REPLY');
  const facts=criticalHumanFacts(humanAnswer); let finalText=String(composed.text||'').trim();
  if(facts.some(f=>!finalText.includes(f))) finalText=exactHumanFallback(humanAnswer,request.intent||'GENERAL');
  await sendAndStore(livechat,request.chat_id,finalText,request.intent||'GENERAL');
  const answered=await db.answerHumanRequest(request.id,{answer:humanAnswer,finalReply:finalText,saveAsKnowledge});
  if(saveAsKnowledge){
    await db.pool.query(`INSERT INTO knowledge_base(category,title,content) VALUES($1,$2,$3)`,[request.intent||'GENERAL',`Belajar dari Human Request #${request.id}`,humanAnswer]);
  }
  await db.logAI({chatId:request.chat_id,sourceEventId:request.source_event_id,intent:request.intent,action:'HUMAN_ASSISTED',confidence:1,reply:finalText,reason:`Human Request #${request.id}`,usage:composed.usage});
  return answered;
  });
}
