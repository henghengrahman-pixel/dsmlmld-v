import { config } from './config.js';
import { normalizeText, detectIntent } from './normalizer.js';
import { OpenAIClient } from './ai.js';
import * as db from './db.js';
import { guardDecision } from './guard.js';
import { greetingText } from './greeting.js';
import { dispatchHumanRequest } from './human-bridge.js';
import { isTelegramBridgeCategory } from './bridge-category.js';
import { inferResetAccountData, resetMissing, resetAskFor, isDepositConfirmedText } from './reset-logic.js';

const ai = new OpenAIClient();
const WAITING_CHECK_REPLY='Mohon tunggu sebentar ya bosku 😊\nKami cek terlebih dahulu permintaannya. Terima kasih atas kesabarannya 🙏';
const WD_PROCESSING_REPLY='Withdraw bosku sedang kami proses ya 😊🙏\nMohon ditunggu beberapa saat. Jika bosku ingin meninggalkan akun terlebih dahulu juga tidak masalah, withdraw tetap akan kami proses sampai selesai ya bosku ☺️❤️';
const WD_DANA_LIMIT_REPLY='Di sini kami cek rekening bosku sedang limit. Silakan dibantu rekening dengan atas nama yang sama ya bosku, tarik dana akan kami alihkan ke rekening tersebut karena kendala tarik dana bosku sedang limit.\n\nNama rek :\nNomor rek :\nJenis rek :';
function formatRows(rows, fields){ return rows.map(r=>fields.map(f=>r[f]).filter(Boolean).join(' | ')).join('\n'); }
function safeHoldingReply(){ return 'Baik bosku, kami bantu cek dulu ya 😊🙏'; }
function isAbusiveText(s=''){ return /(kontol|goblok|bodoh|bangsat|anjing|babi|tolol|kampret|sialan)/i.test(normalizeText(s)); }
function isLossText(s=''){ const n=normalizeText(s); return ['kalah','rungkad','rugi','boncos'].some(x=>n.includes(x)); }
function abuseCount(rows=[]){ return customerTexts(rows).filter(isAbusiveText).length; }
function pickBonusLabel(text=''){
  const n=normalizeText(text);
  const known=['harian','new member','cashback','rollingan','freebet','slot','livegames','ronda'];
  const found=known.find(x=>n.includes(x));
  return found ? found.toUpperCase() : '';
}

function customerTexts(rows){ return rows.filter(x=>x.sender_type==='customer').map(x=>String(x.text||'').trim()).filter(Boolean); }
function extractUserId(rows){
  const text=customerTexts(rows).join('\n');
  const pats=[/(?:user\s*id|userid|username|id\s*(?:saya|akun)?)\s*[:=]?\s*([a-z0-9_.-]{3,40})/i,/\b(?:id)\s*[:=]\s*([a-z0-9_.-]{3,40})/i];
  for(const re of pats){const m=text.match(re);if(m?.[1])return m[1];}
  return '';
}
function extractAccountData(rows){
  const text=customerTexts(rows).join('\n');
  const lower=text.toLowerCase();
  const types=['seabank','bca','bri','bni','mandiri','cimb','jago','dana','ovo','gopay','linkaja','shopeepay','bank'];
  const type=types.find(x=>lower.includes(x))||'';
  const no=(text.match(/(?:no\.?\s*(?:rek(?:ening)?|rekening|akun)|nomor\s*(?:rek(?:ening)?|rekening|akun))\s*[:=]?\s*(\d{6,22})/i)||text.match(/\b(\d{8,22})\b/))?.[1]||'';
  const name=(text.match(/(?:nama\s*(?:rek(?:ening)?|rekening)?|atas\s*nama|a\.?n\.?)\s*[:=]?\s*([a-z][a-z .'-]{2,60})/i))?.[1]?.trim()||'';
  return {type,name,no};
}

function latestProof(rows){
  const all=rows.filter(x=>x.sender_type==='customer').flatMap(x=>Array.isArray(x.attachments)?x.attachments:[]);
  return all.reverse().find(a=>a?.isImage||String(a?.mimeType||a?.type||'').startsWith('image/'))||null;
}
async function askAndTrack(livechat,chatId,intent,type,state,data,reply){
  await db.setConversationWorkflow(chatId,{type,state,data});
  await sendAndStore(livechat,chatId,reply,intent);
  return {intent,workflow:type,state,sent:true,reply};
}
async function makeHumanRequest({chatId,eventId,intent,text,question,holding='',livechat,telegram=true}){
  const req=await db.createHumanRequest({chatId,sourceEventId:eventId,intent,memberMessage:text,question});
  if(telegram) await dispatchHumanRequest(req);
  if(holding) await sendAndStore(livechat,chatId,holding,intent);
  return {intent,humanRequestId:req.id,sent:Boolean(holding),waitingHuman:true,telegram:Boolean(telegram)};
}
async function maybeHandleOperationalFlow({chatId,eventId,text,intent,livechat}){
  const wf=await db.getConversationWorkflow(chatId);
  const ctx=await db.getContext(chatId,30);
  const effective=String(intent||'GENERAL').toUpperCase();

  // Member kasar/emosi: tetap tenang. Tidak pernah membalas kasar.
  // Jika berulang kali, jawaban dibuat makin singkat agar tidak memancing debat.
  if(['ABUSIVE','COMPLAINT','LOSS_COMPLAINT'].includes(effective)){
    const count=abuseCount(ctx);
    if(effective==='ABUSIVE' && count>=3){
      const reply=await responseText('#KOMPLAIN_MAKI_ULANG','Mohon maaf bosku 🙏 Oke bosku, kalau ada kendala yang mau dibantu cek kabari kami ya.');
      await sendAndStore(livechat,chatId,reply,effective);
      return {intent:effective,sent:true,reply,complaintMode:'REPEATED_ABUSE'};
    }
    if(effective==='LOSS_COMPLAINT'){
      const base=await responseText('#KOMPLAIN_KALAH','Mohon maaf ya bosku 🙏 Kalau ada kendala di permainan atau transaksi, bilang bagian mana yang bermasalah biar kami bantu cek.');
      const rtp=await db.getCannedByShortcut('#RTP');
      const extra=rtp?.content ? `\n\nKalau bosku memang mau lihat info RTP yang tersedia, ini infonya:\n${String(rtp.content).slice(0,700)}\nCatatan: informasi ini tidak menjamin hasil permainan.` : '';
      const reply=`${base}${extra}`.slice(0,1200);
      await sendAndStore(livechat,chatId,reply,effective);
      return {intent:effective,sent:true,reply,complaintMode:'LOSS'};
    }
    const reply=await responseText('#KOMPLAIN_MAKI','Mohon maaf ya bosku 🙏 Ada kendala apa yang bisa kami bantu cek?');
    await sendAndStore(livechat,chatId,reply,effective);
    return {intent:effective,sent:true,reply,complaintMode:'CALM'};
  }

  // Deposit complaint: member may send ID and proof separately. Persist/merge both, then send one verification ticket to Telegram CS.
  if(effective==='DEPOSIT_PROBLEM' || wf?.workflow_type==='DEPOSIT_VERIFY'){
    const userId=extractUserId(ctx); const proof=latestProof(ctx);
    const data={...(wf?.workflow_data||{}),userId:userId||wf?.workflow_data?.userId||'',proofUrl:proof?.url||wf?.workflow_data?.proofUrl||''};
    const missing=[]; if(!data.userId)missing.push('user ID'); if(!data.proofUrl)missing.push('bukti transfer');
    if(missing.length){
      const reply=missing.length===2?'Boleh kirim user ID sama bukti transfernya ya bosku 🙏 Biar kami bantu cek depositnya.':missing[0]==='user ID'?'Boleh kirim user ID-nya ya bosku 🙏 Bukti transfernya sudah kami terima.':'Boleh kirim bukti transfernya ya bosku 🙏 User ID-nya sudah kami terima.';
      return askAndTrack(livechat,chatId,'DEPOSIT_PROBLEM','DEPOSIT_VERIFY','COLLECTING',data,reply);
    }
    await db.clearConversationWorkflow(chatId);
    return makeHumanRequest({
      chatId,eventId,intent:'DEPOSIT_PROBLEM',text,livechat,telegram:true,holding:WAITING_CHECK_REPLY,
      question:`ID : ${data.userId}

cek deposit apakah sudah diproses atau belum`
    });
  }

  // Reset password: NEVER ask user ID. Collect registered account data one slot at a time.
  // Required fields: jenis rekening/bank/e-wallet, nama rekening, nomor rekening.
  // Member may send name -> bank/e-wallet -> account number in separate messages; we persist and merge them.
  if(effective==='FORGOT_PASSWORD' || wf?.workflow_type==='RESET_PASSWORD'){
    const prev=wf?.workflow_data||{};
    const data=inferResetAccountData(ctx,prev);

    // Staff previously asked member to deposit first. Once member confirms deposit, re-open a fresh reset ticket.
    if(wf?.workflow_type==='RESET_PASSWORD' && wf?.workflow_state==='WAITING_DEPOSIT'){
      await db.setConversationWorkflow(chatId,{type:'RESET_PASSWORD',state:'WAITING_DEPOSIT',data});
      if(isDepositConfirmedText(text)){
        return makeHumanRequest({
          chatId,eventId,intent:'FORGOT_PASSWORD',text,livechat,telegram:true,holding:WAITING_CHECK_REPLY,
          question:`NO REK ${data.no||'-'}
a/n${data.name||'-'}
JENIS REK : ${data.type||'-'}

member sudah deposit, silahkan dicek dan di reset`
        });
      }
      return {intent:'FORGOT_PASSWORD',workflow:'RESET_PASSWORD',state:'WAITING_DEPOSIT',sent:false,waitingDeposit:true};
    }

    const missing=resetMissing(data);
    if(missing.length){
      const field=missing[0];
      return askAndTrack(livechat,chatId,'FORGOT_PASSWORD','RESET_PASSWORD','COLLECTING',data,resetAskFor(field));
    }
    await db.clearConversationWorkflow(chatId);
    return makeHumanRequest({chatId,eventId,intent:'FORGOT_PASSWORD',text,livechat,telegram:true,holding:WAITING_CHECK_REPLY,question:`NO REK ${data.no}
a/n${data.name}
JENIS REK : ${data.type}

reset password ko`});
  }

  // Every WD problem goes to Telegram staff. Ask member ID only if it is not already present. // kendala wd
  if(effective==='WITHDRAW_PROBLEM'){
    const uid=extractUserId(ctx);
    if(!uid){
      return askAndTrack(livechat,chatId,'WITHDRAW_PROBLEM','WD_CHECK','WAITING_ID',{},'Boleh kirim ID akunnya ya bosku 🙏 Biar kami bantu cek kepastian WD-nya.');
    }
    const all=customerTexts(ctx).slice(-5).join(' | ');
    return makeHumanRequest({
      chatId,eventId,intent:'WITHDRAW_PROBLEM',text,livechat,telegram:true,
      holding:WD_PROCESSING_REPLY,
      question:`ID : ${uid}\n\ncek kepastian wd\n${all.slice(-500)}`
    });
  }
  if(wf?.workflow_type==='WD_CHECK' && wf?.workflow_state==='WAITING_ID'){
    const uid=extractUserId(ctx);
    if(!uid) return askAndTrack(livechat,chatId,'WITHDRAW_PROBLEM','WD_CHECK','WAITING_ID',{},'Boleh kirim ID akunnya ya bosku 🙏');
    await db.clearConversationWorkflow(chatId);
    return makeHumanRequest({
      chatId,eventId,intent:'WITHDRAW_PROBLEM',text,livechat,telegram:true,
      holding:WD_PROCESSING_REPLY,
      question:`ID : ${uid}\n\ncek kepastian wd`
    });
  }

  // Generic bonus claim: ask which bonus first, then ensure member ID exists before Telegram.
  if(effective==='BONUS_REQUEST' && wf?.workflow_type!=='BONUS_CLAIM'){
    const bonusType=pickBonusLabel(text);
    if(!bonusType){
      return askAndTrack(livechat,chatId,'BONUS_REQUEST','BONUS_CLAIM','ASK_TYPE',{},await responseText('#BONUS_TANYA','Bonus apa yang mau diklaim ya bosku? 😊'));
    }
  }
  if(wf?.workflow_type==='BONUS_CLAIM' && wf?.workflow_state==='ASK_TYPE'){
    const bonusType=pickBonusLabel(text) || String(text||'').trim().slice(0,120);
    const uid=extractUserId(ctx);
    if(!uid) return askAndTrack(livechat,chatId,'BONUS_REQUEST','BONUS_CLAIM','WAITING_ID',{bonusType},'Boleh kirim ID akunnya ya bosku 🙏');
    await db.clearConversationWorkflow(chatId);
    return makeHumanRequest({chatId,eventId,intent:'BONUS_REQUEST',text,livechat,telegram:true,holding:WAITING_CHECK_REPLY,question:`ID : ${uid}\n\nclaim bonus ${String(bonusType).toLowerCase()}`});
  }
  if(wf?.workflow_type==='BONUS_CLAIM' && wf?.workflow_state==='WAITING_ID'){
    const uid=extractUserId(ctx);
    const bonusType=String(wf?.workflow_data?.bonusType||'bonus').trim();
    if(!uid) return askAndTrack(livechat,chatId,'BONUS_REQUEST','BONUS_CLAIM','WAITING_ID',{bonusType},'Boleh kirim ID akunnya ya bosku 🙏');
    await db.clearConversationWorkflow(chatId);
    return makeHumanRequest({chatId,eventId,intent:'BONUS_REQUEST',text,livechat,telegram:true,holding:WAITING_CHECK_REPLY,question:`ID : ${uid}\n\nclaim bonus ${String(bonusType).toLowerCase()}`});
  }

  // Specific bonus (contoh: bonus harian). Pastikan ID ada sebelum lempar ke grup Bonus.
  if(effective.includes('BONUS')){
    const bonusType=pickBonusLabel(text) || effective.replace(/^BONUS_?/,'').replaceAll('_',' ');
    const uid=extractUserId(ctx);
    if(!uid) return askAndTrack(livechat,chatId,effective,'BONUS_CLAIM','WAITING_ID',{bonusType},'Boleh kirim ID akunnya ya bosku 🙏');
    await db.clearConversationWorkflow(chatId);
    return makeHumanRequest({chatId,eventId,intent:effective,text,livechat,telegram:true,holding:WAITING_CHECK_REPLY,question:`ID : ${uid}\n\nclaim bonus ${String(bonusType||'').toLowerCase()}`});
  }

  // Gangguan operasional selalu dilaporkan ke grup: login (bukan lupa password), link/web, game, dan gangguan umum.
  if(['LOGIN_PROBLEM','LINK_PROBLEM','GAME_PROBLEM','GENERAL_DISTURBANCE'].includes(effective)){
    const uid=extractUserId(ctx); const all=customerTexts(ctx).slice(-5).join(' | ');
    const label={LOGIN_PROBLEM:'tidak bisa login / masuk',LINK_PROBLEM:'link / website tidak bisa diakses',GAME_PROBLEM:'permainan error / keluar sendiri',GENERAL_DISTURBANCE:'gangguan'}[effective]||'gangguan';
    return makeHumanRequest({chatId,eventId,intent:effective,text,livechat,telegram:true,holding:'Siap bosku, kendalanya kami teruskan untuk dicek ya 🙏',question:`${uid?`ID : ${uid}\n\n`:''}${label}\n${all.slice(-700)}`});
  }

  // Minta ganti rekening dilempar ke grup WD/operasional secara simpel.
  if(effective==='ACCOUNT_CHANGE_REQUEST'){
    const uid=extractUserId(ctx);
    return makeHumanRequest({chatId,eventId,intent:'ACCOUNT_CHANGE_REQUEST',text,livechat,telegram:true,holding:WAITING_CHECK_REPLY,question:`${uid?`ID : ${uid}\n\n`:''}minta ganti rekening`});
  }
  return null;
}

function normalizeShortcut(s=''){ return String(s||'').trim().replace(/^#?/,'#'); }
async function responseText(shortcut,fallback){
  const r=await db.getCannedByShortcut(normalizeShortcut(shortcut));
  return String(r?.content||fallback||'').trim().slice(0,1200);
}
function resetReplyComplete(text=''){
  const s=String(text||'');
  return /(?:user\s*id|userid|username)\s*[:=]/i.test(s) && /(?:password|psw)\s*[:=]/i.test(s);
}
async function maybeHandleWorkflow({chatId,eventId,text,intent,livechat}){
  const wf=await db.getConversationWorkflow(chatId);

  // Staff said WD is pending: do not send another message immediately.
  // Wait for the member's next message, then answer with the known pending state.
  if(wf?.workflow_type==='WD_STATUS' && wf?.workflow_state==='PENDING'){
    const reply=await responseText('#WD_ANTRIAN','Withdraw bosku masih dalam proses ya 😊🙏 Mohon ditunggu beberapa saat, nanti tetap kami proses sampai selesai ya bosku.');
    await sendAndStore(livechat,chatId,reply,'WITHDRAW_PROBLEM');
    await db.clearConversationWorkflow(chatId);
    return {intent:'WITHDRAW_PROBLEM',workflow:'WD_STATUS',state:'PENDING_FOLLOWUP',sent:true,reply};
  }

  if(wf?.workflow_type!=='WD_REPLACEMENT' || wf?.workflow_state!=='WAITING_MEMBER_ACCOUNT') return null;

  const ctx=await db.getContext(chatId,40);
  const prev=wf?.workflow_data||{};
  const acc=extractAccountData(ctx);
  const data={
    type: acc.type || prev.type || '',
    name: acc.name || prev.name || '',
    no: acc.no || prev.no || ''
  };
  const missing=[];
  if(!data.name) missing.push('nama rekening');
  if(!data.no) missing.push('nomor rekening');
  if(!data.type) missing.push('jenis rekening');

  if(missing.length){
    await db.setConversationWorkflow(chatId,{type:'WD_REPLACEMENT',state:'WAITING_MEMBER_ACCOUNT',data:{...prev,...data}});
    const reply=`Boleh dilengkapi ${missing.join(', ')} ya bosku 🙏`;
    await sendAndStore(livechat,chatId,reply,'WITHDRAW_PROBLEM');
    return {intent:'WITHDRAW_PROBLEM',workflow:'WD_REPLACEMENT',state:'WAITING_MEMBER_ACCOUNT',sent:true,reply};
  }

  const req=await db.createHumanRequest({
    chatId,sourceEventId:eventId,intent:'WITHDRAW_PROBLEM',memberMessage:text,
    question:`NAMA REK : ${data.name}\\nNO REK : ${data.no}\\nJENIS REK : ${data.type}\\n\\nalihkan wd ke rekening ini`
  });
  await db.clearConversationWorkflow(chatId);
  await dispatchHumanRequest(req);
  await sendAndStore(livechat,chatId,WAITING_CHECK_REPLY,'WITHDRAW_PROBLEM');
  await db.logAI({chatId,sourceEventId:eventId,intent:'WITHDRAW_PROBLEM',action:'WORKFLOW_TO_HUMAN',confidence:1,reply:WAITING_CHECK_REPLY,reason:`WD replacement workflow -> Human Request #${req.id}`});
  return {intent:'WITHDRAW_PROBLEM',workflow:'WD_REPLACEMENT',humanRequestId:req.id,sent:true};
}

async function getReplyStyle(){
  return {
    replyStyle:String(await db.getSetting('reply_style','NATURAL_CS')||'NATURAL_CS'),
    replyLength:String(await db.getSetting('reply_length','SHORT')||'SHORT'),
    boskuUsage:String(await db.getSetting('bosku_usage','MODERATE')||'MODERATE'),
    emojiUsage:String(await db.getSetting('emoji_usage','LIGHT')||'LIGHT'),
    formalLanguage:Boolean(await db.getSetting('formal_language',false)),
    replyStyleNote:String(await db.getSetting('reply_style_note','')||'')
  };
}

async function sendAndStore(livechat,chatId,text,intent,senderType='ai'){
  if(senderType==='ai' && await db.isHumanTakeover(chatId)) throw new Error('HUMAN_TAKEOVER_ACTIVE');
  const sent=await livechat.sendMessage(chatId,text);
  const sentEventId=sent?.event_id || sent?.id || null;
  await db.saveOutbound(chatId,text,sentEventId);
  if(sentEventId) await db.insertMessage({chatId,eventId:String(sentEventId),senderType,authorId:'',text,normalizedText:normalizeText(text),intent,createdAt:new Date().toISOString()});
  return sent;
}

async function buildSources(chatId,intent,normalized){
  const total=await db.getMessageCount(chatId);
  const recentLimit=60;
  const recentRows=await db.getContext(chatId,recentLimit);
  const rulesRows=await db.getRules(intent); const kbRows=await db.getKnowledge(intent);
  const query=`${normalized} ${recentRows.filter(m=>m.sender_type==='customer').slice(-5).map(m=>m.text).join(' ')}`;
  const cannedRows=await db.getRelevantCanned(query,8);
  const learningRows=await db.getRelevantLearning(query,intent,6);
  const styleRows=await db.getHumanStyleExamples(30);
  let digestRow=await db.getConversationDigest(chatId);
  let digest=String(digestRow?.conversation_digest||'');
  const staleBy=Math.max(0,total-Number(digestRow?.digest_message_count||0));
  // For long chats, keep a cached digest of the older/full history. Refresh every 8 new messages.
  if(total>recentLimit && (!digest || staleBy>=8)){
    const historyRows=await db.getContext(chatId,250);
    const history=historyRows.map(m=>`${m.sender_type==='customer'?'MEMBER':m.sender_type==='ai'?'AI':m.sender_type==='system'?'SYSTEM':'CS'}: ${m.text}`).join('\n');
    try{
      const d=await ai.digestConversation({history,previousDigest:digest});
      digest=d.digest; await db.saveConversationDigest(chatId,digest,total);
    }catch(e){ await db.logError('engine','CONTEXT_DIGEST_FAILED',e.message,{chatId,total}); }
  }
  const context=recentRows.map(m=>`${m.sender_type==='customer'?'MEMBER':m.sender_type==='ai'?'AI':m.sender_type==='system'?'SYSTEM':'CS'}: ${m.text}`).join('\n');
  const rules=formatRows(rulesRows,['category','rule_type','content']);
  const manualKnowledge=formatRows(kbRows,['category','title','content']);
  const responses=cannedRows.map(r=>`[RESPONSE ${r.shortcut||r.title||r.source_id}] [${r.response_mode||'FLEXIBLE'}] [${r.category||'GENERAL'}] ${r.content}`).join('\n');
  const learning=learningRows.map(r=>`[BELAJAR ${r.source_type}] [${r.intent}] Member: ${r.member_text} => Jawaban benar: ${r.correction_text||r.response_text}`).join('\n');
  const csStyleExamples=styleRows.map(r=>`- ${String(r.response_text||'').trim()}`).filter(Boolean).join('\n').slice(0,5000);
  const attachments=recentRows.filter(m=>m.sender_type==='customer').slice(-6).flatMap(m=>Array.isArray(m.attachments)?m.attachments:[]).filter(a=>a?.isImage).slice(-3);
  return {context,rules,knowledge:[manualKnowledge,responses,learning].filter(Boolean).join('\n'),hasKnowledge:Boolean(manualKnowledge||responses||learning),attachments,conversationDigest:digest,csStyleExamples,totalMessages:total};
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
    const systemEnabled=Boolean(await db.getSetting('system_enabled',true));
    if (!systemEnabled) return {skipped:'system_off',intent,normalized};
    const auto=Boolean(await db.getSetting('auto_reply',config.autoReplyDefault));
    if (!auto) return {skipped:'auto_reply_off',intent,normalized};

    const workflowResult=await maybeHandleWorkflow({chatId,eventId,text,intent,livechat});
    if(workflowResult) return workflowResult;

    const openHuman=await db.getOpenHumanRequest(chatId);
    if(openHuman) return {skipped:'waiting_human',intent,humanRequestId:openHuman.id};

    const operationalResult=await maybeHandleOperationalFlow({chatId,eventId,text,intent,livechat});
    if(operationalResult) return operationalResult;

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
      const style=await getReplyStyle();
      let decision=await ai.classifyAndReply({normalized,intent,context:src.context,rules:src.rules,knowledge:src.knowledge,attachments:aiAttachments,style,conversationDigest:src.conversationDigest,csStyleExamples:src.csStyleExamples});
      if (decision.confidence < config.aiConfidence && !['ASK_INFO'].includes(decision.action)) decision.action='ASK_HUMAN';
      if(['AUTO_REPLY','ASK_INFO'].includes(decision.action)) decision=guardDecision({intent,decision,hasKnowledge:src.hasKnowledge});

      // Human can press Take Over while OpenAI is thinking. Check once more before any action/send.
      if (await db.isHumanTakeover(chatId)) return {skipped:'human_takeover_after_ai'};

      if(['ASK_HUMAN','HANDOFF'].includes(decision.action)){
        const humanAsk=Boolean(await db.getSetting('human_ask_enabled',config.humanAskEnabled));
        if(humanAsk){
          const question=decision.humanQuestion || `Mohon bantu tentukan jawaban untuk member ini. Intent: ${intent}. Yang dipahami AI: ${decision.understanding||'-'}. Pesan terbaru: ${text}`;
          const req=await db.createHumanRequest({chatId,sourceEventId:eventId,intent,memberMessage:text,question});
          // Telegram hanya untuk Reset Password, Bonus, dan WD. Kasus lain tetap di panel Tanya Staff.
          if(isTelegramBridgeCategory(intent)) await dispatchHumanRequest(req);
          // Jika AI tidak mengerti, jangan kirim jawaban tebakan/holding ke member.
          await db.logAI({chatId,sourceEventId:eventId,intent,...decision,reply:'',reason:`understanding:${decision.understanding||'-'} | ${decision.reason||''} | human_request:${req.id} | silent_wait_staff`});
          return {intent,decision,humanRequestId:req.id,sent:false,waitingHuman:true};
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
        if(isTelegramBridgeCategory(intent)) await dispatchHumanRequest(req);
        return {intent,error:e.message,humanRequestId:req.id,waitingHuman:true,sent:false};
      }
      return {intent,error:e.message};
    }
  });
}



export async function processGreetingTrigger({chatId,eventId,text,createdAt,livechat}){
  return db.withChatLock(chatId, async()=>{
    if (await db.isHumanTakeover(chatId)) return {skipped:'human_takeover'};
    const systemEnabled=Boolean(await db.getSetting('system_enabled',true));
    if(!systemEnabled) return {skipped:'system_off'};
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
    const systemEnabled=Boolean(await db.getSetting('system_enabled',true));
    if(!systemEnabled) throw new Error('LIVECHAT_AI_SYSTEM_OFF');
    if(await db.isHumanTakeover(request.chat_id)) throw new Error('HUMAN_TAKEOVER_ACTIVE');
    const intent=String(request.intent||'GENERAL').toUpperCase();
    if(intent==='FORGOT_PASSWORD' && /(?:password|psw)\s*[:=]/i.test(String(humanAnswer||'')) && !resetReplyComplete(humanAnswer)){
      const e=new Error('RESET_REPLY_INCOMPLETE: wajib sertakan User ID/Username dan Password.'); e.code='RESET_REPLY_INCOMPLETE'; throw e;
    }
    if(intent==='WITHDRAW_PROBLEM' && /\b(?:wd\s*)?pending\b|\bmasih\s+(?:dalam\s+)?proses\b/i.test(String(humanAnswer||''))){
      await db.setConversationWorkflow(request.chat_id,{type:'WD_STATUS',state:'PENDING',data:{humanAnswer:String(humanAnswer||'').trim()}});
      const answered=await db.answerHumanRequest(request.id,{answer:humanAnswer,finalReply:'',saveAsKnowledge:false});
      await db.logAI({chatId:request.chat_id,sourceEventId:request.source_event_id,intent,action:'HUMAN_STATUS_PENDING',confidence:1,reply:'',reason:`Human Request #${request.id}: pending, silent until member replies`});
      return {...answered,silent:true,silentReason:'WD_PENDING'};
    }
    if(intent==='WITHDRAW_PROBLEM' && /\bdana\b.*\blimi(?:t|d)\b|\blimi(?:t|d)\b.*\bdana\b/i.test(String(humanAnswer||''))){
      const reply=await responseText('#DANA_LIMIT',WD_DANA_LIMIT_REPLY);
      await sendAndStore(livechat,request.chat_id,reply,intent);
      await db.setConversationWorkflow(request.chat_id,{type:'WD_REPLACEMENT',state:'WAITING_MEMBER_ACCOUNT',data:{sourceAction:'WD_DANA_LIMIT',humanRequestId:request.id}});
      const answered=await db.answerHumanRequest(request.id,{answer:humanAnswer,finalReply:reply,saveAsKnowledge:false});
      await db.logAI({chatId:request.chat_id,sourceEventId:request.source_event_id,intent,action:'HUMAN_STATUS_DANA_LIMIT',confidence:1,reply,reason:`Human Request #${request.id}: DANA limit, collect replacement account`});
      return {...answered,action:'WD_DANA_LIMIT'};
    }
    const src=await buildSources(request.chat_id,intent,normalizeText(request.member_message));
    const style=await getReplyStyle();
    let composed={text:'',usage:null}; let composeError=null;
    try{
      composed=await ai.composeFromHuman({memberMessage:request.member_message,intent,humanAnswer,context:src.context,rules:src.rules,knowledge:src.knowledge,style});
    }catch(e){ composeError=e; await db.logError('engine','HUMAN_COMPOSE_FAILED',e.message,{requestId:request.id,chatId:request.chat_id}); }
    const facts=criticalHumanFacts(humanAnswer); let finalText=String(composed.text||'').trim();
    if(!finalText || facts.some(f=>!finalText.includes(f))) finalText=exactHumanFallback(humanAnswer,intent);
    await sendAndStore(livechat,request.chat_id,finalText,intent);
    const answered=await db.answerHumanRequest(request.id,{answer:humanAnswer,finalReply:finalText,saveAsKnowledge});
    if(saveAsKnowledge){
      await db.pool.query(`INSERT INTO knowledge_base(category,title,content) VALUES($1,$2,$3)`,[intent,`Belajar dari Human Request #${request.id}`,humanAnswer]);
    }
    await db.logAI({chatId:request.chat_id,sourceEventId:request.source_event_id,intent,action:'HUMAN_ASSISTED',confidence:1,reply:finalText,reason:`Human Request #${request.id}${composeError?' | fallback_exact':''}`,usage:composed.usage});
    return answered;
  });
}

export async function applyHumanAction({request,action,livechat}){
  const code=String(action||'').toUpperCase();
  return db.withChatLock(request.chat_id, async()=>{
    if(await db.isHumanTakeover(request.chat_id)) throw new Error('HUMAN_TAKEOVER_ACTIVE');
    // Reset-specific staff actions have stateful behavior, so handle them before the generic response map.
    if(code==='RESET_NOT_REGISTERED'){
      const reply=await responseText('#RESET_TIDAK_TERDAFTAR','Mohon maaf ya, bosku. Setelah kami cek, data yang diberikan belum terdaftar di situs kami 🙏😊\n\nJika bosku berminat, kami bisa bantu proses pendaftaran akun baru. Atau bosku juga bisa daftar langsung melalui link berikut:\n\n🔗 LINK PENDAFTARAN:\nhttps://omtogelpos.com/register\n\nSilakan dicoba ya, bosku. Kami siap membantu jika ada kendala saat pendaftaran ☺️🙏');
      await sendAndStore(livechat,request.chat_id,reply,request.intent||'FORGOT_PASSWORD');
      await db.clearConversationWorkflow(request.chat_id);
      const answered=await db.answerHumanRequest(request.id,{answer:'ACTION:RESET_NOT_REGISTERED',finalReply:reply,saveAsKnowledge:false});
      await db.logAI({chatId:request.chat_id,sourceEventId:request.source_event_id,intent:request.intent,action:'HUMAN_ACTION_RESET_NOT_REGISTERED',confidence:1,reply,reason:`Human Request #${request.id}`});
      return answered;
    }
    if(code==='RESET_DEPOSIT_FIRST'){
      const ctx=await db.getContext(request.chat_id,40);
      const data=inferResetAccountData(ctx,(await db.getConversationWorkflow(request.chat_id))?.workflow_data||{});
      const deposit=await db.findDepositResponseForBank(data.type||'');
      const intro=await responseText('#RESET_DEPOSIT_DULU','Silakan melakukan deposit terlebih dahulu ya bosku 🙏 Setelah deposit selesai, kabari kami lagi agar bisa kami bantu lanjutkan reset passwordnya.');
      const reply=[intro,deposit?.content||''].filter(Boolean).join('\n\n').slice(0,1800);
      await sendAndStore(livechat,request.chat_id,reply,request.intent||'FORGOT_PASSWORD');
      await db.setConversationWorkflow(request.chat_id,{type:'RESET_PASSWORD',state:'WAITING_DEPOSIT',data});
      const answered=await db.answerHumanRequest(request.id,{answer:'ACTION:RESET_DEPOSIT_FIRST',finalReply:reply,saveAsKnowledge:false});
      await db.logAI({chatId:request.chat_id,sourceEventId:request.source_event_id,intent:request.intent,action:'HUMAN_ACTION_RESET_DEPOSIT_FIRST',confidence:1,reply,reason:`Human Request #${request.id} | deposit_response:${deposit?.shortcut||deposit?.title||'fallback'}`});
      return answered;
    }
    if(code==='RESET_DEPOSIT_NOT_IN'){
      const reply=await responseText('#RESET_DP_BELUM_MASUK','Depositnya belum terlihat masuk ya bosku 🙏 Mohon tunggu sebentar, setelah deposit masuk kabari kami lagi ya.');
      await sendAndStore(livechat,request.chat_id,reply,request.intent||'FORGOT_PASSWORD');
      const ctx=await db.getContext(request.chat_id,40); const data=inferResetAccountData(ctx,{});
      await db.setConversationWorkflow(request.chat_id,{type:'RESET_PASSWORD',state:'WAITING_DEPOSIT',data});
      const answered=await db.answerHumanRequest(request.id,{answer:'ACTION:RESET_DEPOSIT_NOT_IN',finalReply:reply,saveAsKnowledge:false});
      await db.logAI({chatId:request.chat_id,sourceEventId:request.source_event_id,intent:request.intent,action:'HUMAN_ACTION_RESET_DEPOSIT_NOT_IN',confidence:1,reply,reason:`Human Request #${request.id}`});
      return answered;
    }

    const map={
      WD_QUEUE:['#WD_ANTRIAN',WD_PROCESSING_REPLY],
      WD_REQUEST_VALID_ACCOUNT:['#MINTA_REK_VALID','Boleh kirim rekening yang valid ya bosku 🙏 Sertakan jenis rekening, nama pemilik, dan nomor rekening/nomor akun.'],
      WD_DANA_LIMIT:['#DANA_LIMIT',WD_DANA_LIMIT_REPLY],
      BONUS_DONE:['#BONUS_DONE','Bonusnya sudah selesai diproses ya bosku 😊 Silakan cek kembali akun bosku.'],
      BONUS_DEPOSIT_FIRST:['#BONUS_DEPOSIT_DULU','Silakan melakukan deposit terlebih dahulu ya bosku 🙏 Setelah itu kabari kami lagi supaya bisa dibantu cek bonusnya.'],
      DP_PROCESSED:['#DP_PROCESSED','Deposit bosku sudah berhasil kami proses ya 😊🙏 Silakan dicek kembali pada saldo akun bosku.\nTerima kasih dan selamat bermain, semoga beruntung bosku ^^ ❤️'],
      DP_NOT_FOUND:['#DP_NOT_FOUND','Depositnya belum terlihat masuk ya bosku 🙏 Boleh tunggu sebentar, nanti kami bantu cek lagi.']
    };
    if(!map[code]) throw new Error('UNKNOWN_HUMAN_ACTION');
    const [shortcut,fallback]=map[code]; const reply=await responseText(shortcut,fallback);
    await sendAndStore(livechat,request.chat_id,reply,request.intent||'GENERAL');
    if(['WD_REQUEST_VALID_ACCOUNT','WD_DANA_LIMIT'].includes(code)){
      await db.setConversationWorkflow(request.chat_id,{type:'WD_REPLACEMENT',state:'WAITING_MEMBER_ACCOUNT',data:{sourceAction:code,humanRequestId:request.id}});
    }
    const answered=await db.answerHumanRequest(request.id,{answer:`ACTION:${code}`,finalReply:reply,saveAsKnowledge:false});
    await db.logAI({chatId:request.chat_id,sourceEventId:request.source_event_id,intent:request.intent,action:`HUMAN_ACTION_${code}`,confidence:1,reply,reason:`Human Request #${request.id}`});
    return answered;
  });
}

