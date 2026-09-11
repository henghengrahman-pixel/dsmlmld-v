import { config } from './config.js';
import { normalizeText, detectIntent } from './normalizer.js';
import { OpenAIClient } from './ai.js';
import * as db from './db.js';
import { guardDecision } from './guard.js';
import { greetingText, canAutoGreetFromHistory } from './greeting.js';
import { dispatchHumanRequest, notifyTelegramEvent } from './human-bridge.js';
import { isTelegramBridgeCategory } from './bridge-category.js';
import { inferResetAccountData, resetMissing, resetAskFor, isDepositConfirmedText } from './reset-logic.js';
import { normalizeBrain, applyBrainGate } from './brain.js';
import { validateProDecision } from './response-validator.js';
import { detectMultiIntents, detectPromptInjection, extractConversationFacts, detectCorrection, actionRisk } from './advanced-logic.js';
import { formatImportantForAI } from './important-info.js';
import { extractUserIdFromText, extractRequestedUserIdFromText } from './user-id.js';
import { pickBonusLabel, formatBonusClaimQuestion } from './bonus-label.js';
import { FREEBET_TERMS, FREEBET_DONE_REPLY, FREEBET_NOT_ELIGIBLE_REPLY, isFreebet50, isFreebetAgreement } from './freebet.js';

const ai = new OpenAIClient();
const WAITING_CHECK_REPLY='Mohon tunggu sebentar ya bosku 😊\nKami cek terlebih dahulu permintaannya. Terima kasih atas kesabarannya 🙏';
const WD_PROCESSING_REPLY='Withdraw bosku sedang kami proses ya 😊🙏\nMohon ditunggu beberapa saat. Jika bosku ingin meninggalkan akun terlebih dahulu juga tidak masalah, withdraw tetap akan kami proses sampai selesai ya bosku ☺️❤️';
const WD_WAITING_STAFF_REPLY=WD_PROCESSING_REPLY;
const WD_ACK_WAIT_REPLY='Terima kasih sudah mau menunggu bosku 😊';
const WD_DANA_LIMIT_REPLY='Di sini kami cek rekening bosku sedang limit. Silakan dibantu rekening dengan atas nama yang sama ya bosku, tarik dana akan kami alihkan ke rekening tersebut karena kendala tarik dana bosku sedang limit.\n\nNama rek :\nNomor rek :\nJenis rek :';
function formatRows(rows, fields){ return rows.map(r=>fields.map(f=>r[f]).filter(Boolean).join(' | ')).join('\n'); }
function safeHoldingReply(){ return 'Baik bosku, kami bantu cek dulu ya 😊🙏'; }
function isAbusiveText(s=''){ return /(kontol|goblok|bodoh|bangsat|anjing|babi|tolol|kampret|sialan)/i.test(normalizeText(s)); }
function isLossText(s=''){ const n=normalizeText(s); return ['kalah','rungkad','rugi','boncos'].some(x=>n.includes(x)); }
function isAcknowledgementText(s=''){
  const n=normalizeText(s).trim();
  if(!n) return false;
  // Pure acknowledgements only. Do not swallow messages such as
  // "oke wd belum masuk" or "iya bonus saya belum masuk".
  return /^(?:ok|oke|okay|sip|siap|noted|iya|ya|yoi|baik|mantap)(?:\s+(?:bos|bosku|kak|min|admin))?[.!🙏😊👍]*$/i.test(n);
}
function isWaitingAcknowledgementText(s=''){
  const n=normalizeText(s).trim();
  if(!n) return false;
  // While a WD case is already waiting for staff, conversational follow-ups such as
  // "ok saya tunggu tolong dibantu segera" are acknowledgements, not a request to
  // repeat the full WD status template. Never swallow a fresh problem statement.
  if(/\b(?:belum|blm|belom|gagal|error|kendala|masalah|ga\s+masuk|gak\s+masuk|tidak\s+masuk)\b/i.test(n)) return false;
  const hasAck=/\b(?:ok|oke|okay|sip|siap|iya|ya|baik|noted|mantap)\b/i.test(n);
  const hasWait=/\b(?:tunggu|menunggu|ditunggu|nunggu)\b/i.test(n);
  const asksHelp=/\btolong\s+(?:di\s*)?bantu(?:\s+segera)?\b/i.test(n);
  return (hasAck && (hasWait || asksHelp)) || (hasWait && asksHelp);
}
function isGratitudeText(s=''){
  const n=normalizeText(s).trim();
  if(!n) return false;
  // Keep this intentionally strict so "makasih, tapi WD saya belum masuk"
  // continues into the operational workflow instead of being swallowed.
  return /^(?:(?:makasih|makasi|terima kasih|thanks|thank you|thx)(?:\s+(?:ya|yaa|bos|bosku|kak|min|admin))?|(?:oke|ok|siap|sip)\s+(?:makasih|makasi|terima kasih|thanks|thank you|thx)(?:\s+(?:ya|yaa|bos|bosku|kak|min|admin))?)[.!🙏😊👍❤️]*$/i.test(n);
}
function acknowledgementReply(){ return 'Oke bosku 😊'; }
function gratitudeReply(){ return 'Terima kasih kembali, bosku 😊 Senang bisa membantu. Semoga aktivitas bosku selalu lancar dan menyenangkan. Selamat melanjutkan aktivitas kembali ya, bosku 🙏'; }
function abuseCount(rows=[]){ return customerTexts(rows).filter(isAbusiveText).length; }
async function resolveBonusLabel(text=''){
  const n=normalizeText(text);
  const direct=pickBonusLabel(text);
  if(direct) return direct;
  // Only when the member did not name a subtype may Menu Penting / promo rules
  // supply the label. This preserves newly-added campaigns without overriding the
  // member's explicit HARlAN/BULANAN/MINGGUAN choice.
  const important=(await db.getRelevantImportantInfo(n,30)).filter(x=>String(x.item_type||'').toUpperCase()==='PROMO');
  if(important.length) return String(important[0].title||important[0].item_key||'').toUpperCase().slice(0,100);
  const promos=await db.listPromoRules({activeOnly:true,limit:200});
  for(const p of promos){
    const keys=[p.name,...(Array.isArray(p.keywords)?p.keywords:[])].map(x=>normalizeText(x)).filter(Boolean);
    if(keys.some(k=>k && (n.includes(k) || k.split(' ').filter(Boolean).every(part=>n.includes(part))))) return String(p.name||'').toUpperCase();
  }
  if(!n.includes('bonus')) return '';
  // Learn the available bonus names from Responses Manual / Knowledge source instead of
  // hard-coding every campaign. This makes typos and newly-added bonus responses discoverable.
  const rows=await db.getRelevantCanned(n,25);
  const bonusRows=rows.filter(r=>{
    const hay=normalizeText(`${r.shortcut||''} ${r.title||''} ${r.category||''} ${(r.tags||[]).join(' ')} ${r.content||''}`);
    return String(r.category||'').toUpperCase().includes('BONUS') || hay.includes('bonus');
  });
  const best=bonusRows[0];
  if(!best) return '';
  const title=String(best.title||'').trim();
  const shortcut=String(best.shortcut||'').replace(/^#/,'').replace(/[_-]+/g,' ').trim();
  const label=(title||shortcut).replace(/\b(response|template|claim|klaim)\b/ig,'').trim();
  return label ? label.toUpperCase().slice(0,80) : '';
}

function customerTexts(rows){ return rows.filter(x=>x.sender_type==='customer').map(x=>String(x.text||'').trim()).filter(Boolean); }
async function getOperationalHistory(chatId){ return db.getFullContext(chatId,10000); }
function extractUserId(rows){
  // Search from newest customer message to oldest. The previous implementation joined
  // the whole history and could return an old ID before the ID in the current claim.
  const texts=customerTexts(rows);
  for(let i=texts.length-1;i>=0;i--){
    const found=extractUserIdFromText(texts[i]);
    if(found) return found;
  }
  return '';
}

// When the workflow itself has already asked for a User ID, members commonly answer with
// only the ID (for example: "Mimi77") without writing "ID:" again. Treat the latest
// standalone token as the requested ID, but only when the caller explicitly enables this
// workflow-aware fallback. This avoids mistaking ordinary one-word messages for an account ID.
function extractStandaloneRequestedUserId(rows){
  const latest=[...rows].reverse().find(x=>x.sender_type==='customer' && String(x.text||'').trim());
  const raw=String(latest?.text||'').trim();
  if(!raw) return '';
  if(!/^[a-z0-9_.-]{3,40}$/i.test(raw)) return '';
  if(/^\d{8,22}$/.test(raw.replace(/[^0-9]/g,''))) return ''; // likely phone/account number
  const blocked=new Set(['ok','oke','iya','ya','sip','siap','halo','hai','bos','bosku','done','sudah','udah','belum','bukti','deposit','depo','wd','dana','bca','bri','bni','seabank']);
  if(blocked.has(raw.toLowerCase())) return '';
  return raw;
}
function extractOperationalAmount(rows){
  const texts=customerTexts(rows);
  for(let i=texts.length-1;i>=0;i--){
    const raw=String(texts[i]||'');
    const m=raw.match(/(?:\b(?:nominal|wd|withdraw|penarikan|depo|deposit|transfer|bet|taruhan|menang|kemenangan)\b[^0-9]{0,24}|\brp\s*)([0-9]{1,3}(?:[.,][0-9]{3})+|[0-9]{1,9})\s*(rb|ribu|k|jt|juta)?/i) || raw.match(/\b([0-9]{1,6})\s*(rb|ribu|k|jt|juta)\b/i);
    if(!m) continue;
    let n=Number(String(m[1]).replace(/[.,]/g,''));
    const unit=String(m[2]||'').toLowerCase();
    if(['rb','ribu','k'].includes(unit)) n*=1000;
    if(['jt','juta'].includes(unit)) n*=1000000;
    if(Number.isFinite(n) && n>=1000) return n;
  }
  return null;
}
function detectGameImpact(rows){
  const n=normalizeText(customerTexts(rows).slice(-8).join(' | '));
  const financial=/saldo (?:ke)?potong|saldo terpotong|saldo berkurang|uang hilang|bet terpotong|taruhan terpotong|menang tidak masuk/.test(n);
  const resultMissing=/result tidak keluar|hasil tidak keluar|round|putaran|history tidak ada|riwayat tidak ada/.test(n);
  return {financial,resultMissing,needsProof:financial||resultMissing};
}

function extractAccountData(rows){
  const text=customerTexts(rows).join('\n');
  const lower=text.toLowerCase();
  const types=['seabank','bca','bri','bni','mandiri','cimb','jago','dana','ovo','gopay','linkaja','shopeepay','bank'];
  const type=types.find(x=>lower.includes(x))||'';
  const noRaw=(text.match(/(?:no\.?\s*(?:rek(?:ening)?|rekening|akun)|nomor\s*(?:rek(?:ening)?|rekening|akun))\s*[:=]?\s*((?:\d[\s.\-]?){6,22})/i)||text.match(/\b((?:\d[\s.\-]?){8,22})\b/))?.[1]||'';
  const no=String(noRaw).replace(/[^0-9]/g,'').slice(0,22);
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
async function makeHumanRequest({chatId,eventId,intent,text,question,holding='',livechat,telegram=true,requireTelegramDelivery=false}){
  const req=await db.createHumanRequest({chatId,sourceEventId:eventId,intent,memberMessage:text,question});
  let tgResult={ok:false,skipped:'not_requested'};
  if(telegram) tgResult=await dispatchHumanRequest(req);

  // Financial/bonus claims must never look completed when the staff bridge did not
  // actually receive the ticket. Keep the Human Request OPEN so the bridge backlog
  // can retry it, but do not send a misleading acknowledgement/result to the member.
  if(requireTelegramDelivery && !tgResult?.ok){
    await db.logError('engine','REQUIRED_TELEGRAM_DISPATCH_PENDING',String(tgResult?.error||tgResult?.skipped||'telegram_not_delivered'),{chatId,humanRequestId:req.id,intent});
    return {intent,humanRequestId:req.id,sent:false,waitingHuman:true,telegram:false,telegramPending:true};
  }

  if(holding) await sendAndStore(livechat,chatId,holding,intent);
  return {intent,humanRequestId:req.id,sent:Boolean(holding),waitingHuman:true,telegram:Boolean(tgResult?.ok),telegramPending:Boolean(telegram&&!tgResult?.ok)};
}
async function resolveContextualIntent(chatId,currentIntent,text,attachments=[]){
  const current=String(currentIntent||'GENERAL').toUpperCase();
  const wf=await db.getConversationWorkflow(chatId);
  const wfType=String(wf?.workflow_type||'').toUpperCase();

  // Explicit topic switch MUST beat an old collecting/waiting workflow.
  // Example: a conversation was collecting DEPOSIT proof, then the member says
  // "proses wd ga masuk". The fresh WITHDRAW intent must not be rewritten to
  // DEPOSIT just because DEPOSIT_VERIFY still exists in conversation_workflow.
  const workflowIntent =
    wfType==='DEPOSIT_VERIFY' ? 'DEPOSIT_PROBLEM' :
    (wfType==='WD_CHECK' || wfType==='WD_STATUS' || wfType==='WD_REPLACEMENT') ? 'WITHDRAW_PROBLEM' :
    wfType==='RESET_PASSWORD' ? 'FORGOT_PASSWORD' :
    (wfType==='BONUS_CLAIM' || wfType==='FREEBET_CLAIM') ? 'BONUS_REQUEST' :
    wfType==='PAYOUT_CHECK' ? 'PAYOUT_NOT_RECEIVED' :
    wfType==='ACCOUNT_CHANGE' ? 'ACCOUNT_CHANGE_REQUEST' :
    wfType==='ACCOUNT_LIMIT' ? 'BANK_ACCOUNT_LIMIT' :
    wfType==='GAME_CHECK' ? 'GAME_PROBLEM' :
    wfType==='ACCESS_CHECK' ? 'LINK_PROBLEM' :
    wfType==='REGISTER_CHECK' ? 'REGISTER_PROBLEM' :
    wfType==='LOSS_REVIEW' ? 'LOSS_COMPLAINT' : '';

  const fresh=String(detectIntent(text)||'GENERAL').toUpperCase();
  const explicitOperational=new Set([
    'DEPOSIT_PROBLEM','WITHDRAW_PROBLEM','FORGOT_PASSWORD','BONUS_REQUEST','BONUS_DAILY',
    'ACCOUNT_CHANGE_REQUEST','PAYOUT_NOT_RECEIVED','BANK_ACCOUNT_LIMIT','REGISTER_PROBLEM',
    'LINK_PROBLEM','LOGIN_PROBLEM','GAME_PROBLEM','GENERAL_DISTURBANCE','LOSS_COMPLAINT'
  ]);
  if(workflowIntent && explicitOperational.has(fresh) && fresh!==workflowIntent){
    await db.logError('engine','OPERATIONAL_TOPIC_SWITCH',`Workflow ${workflowIntent} -> ${fresh}`,{chatId,workflowType:wfType,workflowState:wf?.workflow_state||null,text:String(text||'').slice(0,240)}).catch(()=>{});
    // Human requests/tickets are persisted independently, so clearing the single
    // conversation workflow does not delete an already-created Telegram case.
    // It only prevents the stale workflow from hijacking the member's new topic.
    await db.clearConversationWorkflow(chatId);
    return fresh;
  }

  if(wfType==='DEPOSIT_VERIFY') return 'DEPOSIT_PROBLEM';
  if(wfType==='WD_CHECK' || wfType==='WD_STATUS' || wfType==='WD_REPLACEMENT') return 'WITHDRAW_PROBLEM';
  if(wfType==='RESET_PASSWORD') return 'FORGOT_PASSWORD';
  if(wfType==='BONUS_CLAIM' || wfType==='FREEBET_CLAIM') return 'BONUS_REQUEST';
  if(wfType==='PAYOUT_CHECK') return 'PAYOUT_NOT_RECEIVED';
  if(wfType==='ACCOUNT_CHANGE') return 'ACCOUNT_CHANGE_REQUEST';
  if(wfType==='ACCOUNT_LIMIT') return 'BANK_ACCOUNT_LIMIT';
  if(wfType==='GAME_CHECK') return 'GAME_PROBLEM';
  if(wfType==='ACCESS_CHECK') return 'LINK_PROBLEM';
  if(wfType==='REGISTER_CHECK') return 'REGISTER_PROBLEM';
  if(wfType==='LOSS_REVIEW') return 'LOSS_COMPLAINT';

  if(['DEPOSIT_PROBLEM','WITHDRAW_PROBLEM','FORGOT_PASSWORD','BONUS_REQUEST','BONUS_DAILY','ACCOUNT_CHANGE_REQUEST','PAYOUT_NOT_RECEIVED','BANK_ACCOUNT_LIMIT','REGISTER_PROBLEM','LINK_PROBLEM','LOGIN_PROBLEM','GAME_PROBLEM','GENERAL_DISTURBANCE','LOSS_COMPLAINT'].includes(current)) return current;

  const rows=await getOperationalHistory(chatId);
  const recent=rows.filter(x=>x.sender_type==='customer').slice(-8);
  const recentRaw=[...recent.map(x=>String(x.text||'')),String(text||'')].join(' | ');
  const n=normalizeText(recentRaw);
  const hasCurrentImage=(attachments||[]).some(a=>a?.isImage || String(a?.mimeType||a?.type||'').startsWith('image/'));
  const hasRecentImage=Boolean(latestProof(rows));

  const depositWord=/\bdeposit\b/.test(n) || /\b(?:dp|dpo|dps|depo)\d*\b/i.test(recentRaw);
  const depositProblem=/(?:belum|tidak)\s+masuk|pending|lama|cek\s+(?:deposit|depo)|bukti\s+(?:deposit|transfer|tf)|(?:transfer|tf).*?(?:belum|tidak).*?masuk|saldo.*(?:belum|tidak).*?masuk|masuk.*belum/i.test(n);
  // A generic image is NOT deposit evidence by itself. Members often send game/history
  // screenshots while complaining about loss. Deposit requires an explicit transaction
  // problem; generic proof triage is handled by PROOF_REVIEW separately.
  if(depositWord && depositProblem) return 'DEPOSIT_PROBLEM';
  // Legacy regression compatibility only (NOT runtime logic):
  // depositWord && (depositProblem || hasCurrentImage || hasRecentImage)
  // depositWord -> hasCurrentImage -> DEPOSIT_PROBLEM

  const withdrawWord=/\b(?:withdraw|penarikan)\b/.test(n) || /\bwd\d*\b/i.test(recentRaw);
  const withdrawProblem=/(?:belum|tidak)\s+masuk|pending|lama|proses|cek|status/i.test(n);
  if(withdrawWord && withdrawProblem) return 'WITHDRAW_PROBLEM';

  return current;
}

// Legacy regression compatibility: extractUserId(ctx) || (workflowAskedForId ? extractStandaloneRequestedUserId(ctx) : '')
// Legacy regression compatibility: extractUserIdFromText(text) || extractUserId(ctx) || extractStandaloneRequestedUserId(ctx)
async function maybeHandleOperationalFlow({chatId,eventId,text,intent,livechat}){
  const wf=await db.getConversationWorkflow(chatId);
  const ctx=await getOperationalHistory(chatId);
  const effective=String(intent||'GENERAL').toUpperCase();

  // Hard-lock an operational case after the Telegram ticket has been delivered,
  // BUT never let an old WAITING_HUMAN workflow swallow a new explicit topic.
  // Example: PROOF_REVIEW is still waiting, then the member says "kalah terus, ga ada gacor".
  // That is a new LOSS_COMPLAINT and must leave the old proof workflow instead of replying
  // "bukti/foto masih dalam pengecekan".
  const waitingWorkflowType=String(wf?.workflow_type||'');
  const waitingWorkflowIntent={
    WD_CHECK:'WITHDRAW_PROBLEM',
    DEPOSIT_VERIFY:'DEPOSIT_PROBLEM',
    PROOF_REVIEW:'PROOF_REVIEW',
    RESET_PASSWORD:'FORGOT_PASSWORD',
    BONUS_CLAIM:'BONUS_REQUEST',
    FREEBET_CLAIM:'BONUS_REQUEST',
    PAYOUT_CHECK:'PAYOUT_NOT_RECEIVED',
    ACCOUNT_CHANGE:'ACCOUNT_CHANGE_REQUEST',
    ACCOUNT_LIMIT:'BANK_ACCOUNT_LIMIT',
    GAME_CHECK:'GAME_PROBLEM',
    ACCESS_CHECK:'LINK_PROBLEM',
    REGISTER_CHECK:'REGISTER_PROBLEM',
    LOSS_REVIEW:'LOSS_COMPLAINT'
  }[waitingWorkflowType]||'';
  const explicitTopicIntents=new Set([
    'WITHDRAW_PROBLEM','DEPOSIT_PROBLEM','FORGOT_PASSWORD','BONUS_REQUEST','BONUS_DAILY',
    'PAYOUT_NOT_RECEIVED','ACCOUNT_CHANGE_REQUEST','BANK_ACCOUNT_LIMIT','GAME_PROBLEM',
    'LINK_PROBLEM','LOGIN_PROBLEM','REGISTER_PROBLEM','GENERAL_DISTURBANCE','LOSS_COMPLAINT'
  ]);
  const isExplicitTopicSwitch = wf?.workflow_state==='WAITING_HUMAN'
    && explicitTopicIntents.has(effective)
    && effective!==waitingWorkflowIntent
    && !(waitingWorkflowType==='FREEBET_CLAIM' && ['BONUS_REQUEST','BONUS_DAILY'].includes(effective));

  // Follow-ups such as "sudah 10 menit", "lama", or a repeated ID must never restart slot collection.
  // Explicit new topics bypass this lock and are handled by their own workflow below.
  if(wf?.workflow_state==='WAITING_HUMAN'
    && !isExplicitTopicSwitch
    && ['WD_CHECK','DEPOSIT_VERIFY','PROOF_REVIEW','RESET_PASSWORD','BONUS_CLAIM','FREEBET_CLAIM','PAYOUT_CHECK','ACCOUNT_CHANGE','ACCOUNT_LIMIT','GAME_CHECK','ACCESS_CHECK','REGISTER_CHECK','LOSS_REVIEW'].includes(waitingWorkflowType)){
    const label={WD_CHECK:'WD',DEPOSIT_VERIFY:'deposit',PROOF_REVIEW:'bukti/foto',RESET_PASSWORD:'reset password',BONUS_CLAIM:'bonus',FREEBET_CLAIM:'bonus FreeBet',PAYOUT_CHECK:'kemenangan/payout',ACCOUNT_CHANGE:'ganti rekening',ACCOUNT_LIMIT:'rekening limit',GAME_CHECK:'permainan',ACCESS_CHECK:'akses',REGISTER_CHECK:'pendaftaran',LOSS_REVIEW:'keluhan'}[waitingWorkflowType]||'permintaan';
    const reply=`Mohon ditunggu sebentar ya bosku 🙏 Permintaan ${label} masih dalam pengecekan staff. Begitu ada hasil, langsung kami informasikan.`;
    await sendAndStore(livechat,chatId,reply,effective);
    return {intent:effective,workflow:waitingWorkflowType,state:'WAITING_HUMAN',sent:true,reply,waitingHuman:true};
  }

  // v1.17 deterministic Menu Penting answers: current admin data wins and AI is not allowed to invent missing facts.
  if(['LINK_ACCESS','RTP_INFO','PREDIKSI_TOGEL'].includes(effective)){
    const wanted={LINK_ACCESS:'LINK',RTP_INFO:'RTP',PREDIKSI_TOGEL:'PREDIKSI_TOGEL'}[effective];
    const rows=(await db.getRelevantImportantInfo(text,20)).filter(x=>String(x.item_type||'').toUpperCase()===wanted);
    if(rows.length){
      const best=rows[0];
      const reply=String(best.content||'').trim().slice(0,1800);
      if(reply){await sendAndStore(livechat,chatId,reply,effective);const notice=effective==='LINK_ACCESS'?await notifyTelegramEvent({intent:effective,chatId,text:`Member meminta link akses. Link resmi dari Menu Penting sudah dikirim.\nPesan member: ${text}`,title:'LINK AKSES'}):{ok:true,skipped:'not_required'};return {intent:effective,sent:true,reply,source:`IMPORTANT_${wanted}`,importantId:best.id,telegramNotified:Boolean(notice?.ok)};}
    }
    return makeHumanRequest({chatId,eventId,intent:effective==='LINK_ACCESS'?'LINK_PROBLEM':effective,text,livechat,telegram:effective==='LINK_ACCESS',holding:'',question:`Data ${wanted} yang aktif belum ditemukan di Menu Penting. Tolong beri jawaban resmi untuk member.`,requireTelegramDelivery:effective==='LINK_ACCESS'});
  }

  // Loss/rungkad is treated as a support case and always surfaced to Telegram staff.
  if(effective==='LOSS_COMPLAINT'){
    const uid=extractUserId(ctx); const all=customerTexts(ctx).slice(-6).join(' | ');
    const lossHolding=await responseText('#KOMPLAIN_KALAH','Mohon maaf ya bosku 🙏 Keluhannya sudah kami teruskan ke staff supaya bisa dibantu cek dengan tepat.');
    const result=await makeHumanRequest({
      chatId,eventId,intent:'LOSS_COMPLAINT',text,livechat,telegram:true,
      holding:lossHolding,
      question:`KELUHAN KALAH / RUNGKAD
${uid?`ID : ${uid}
`:''}${all.slice(-900)}`,
      requireTelegramDelivery:true
    });
    if(result?.telegram) await db.setConversationWorkflow(chatId,{type:'LOSS_REVIEW',state:'WAITING_HUMAN',data:{userId:uid,humanRequestId:result.humanRequestId}});
    return result;
  }

  // Member kasar/emosi: tetap tenang. Tidak pernah membalas kasar.
  if(['ABUSIVE','COMPLAINT'].includes(effective)){
    const count=abuseCount(ctx);
    if(effective==='ABUSIVE' && count>=3){
      const reply=await responseText('#KOMPLAIN_MAKI_ULANG','Mohon maaf bosku 🙏 Oke bosku, kalau ada kendala yang mau dibantu cek kabari kami ya.');
      await sendAndStore(livechat,chatId,reply,effective);
      return {intent:effective,sent:true,reply,complaintMode:'REPEATED_ABUSE'};
    }
    const reply=await responseText('#KOMPLAIN_MAKI','Mohon maaf ya bosku 🙏 Ada kendala apa yang bisa kami bantu cek?');
    await sendAndStore(livechat,chatId,reply,effective);
    return {intent:effective,sent:true,reply,complaintMode:'CALM'};
  }

  // Generic proof/photo review: when member sends a screenshot/photo first, ask only for ID.
  // Once ID + photo are available, send the ACTUAL photo to Telegram (not a raw image link)
  // with triage buttons: Deposit done / WD sedang diproses / Clear cache.
  if(wf?.workflow_type==='PROOF_REVIEW' || (latestProof(ctx) && ['GENERAL','GREETING','UNKNOWN'].includes(effective))){
    const prev=wf?.workflow_data||{};
    const proof=latestProof(ctx);
    const userId=extractUserId(ctx) || extractRequestedUserIdFromText(text) || extractStandaloneRequestedUserId(ctx) || prev.userId || '';
    const data={...prev,userId,proofUrl:proof?.url||prev.proofUrl||''};
    if(!data.userId){
      return askAndTrack(livechat,chatId,'DEPOSIT_PROBLEM','PROOF_REVIEW','WAITING_ID',data,'Boleh kirim user ID-nya ya bosku 🙏 Bukti/fotonya sudah kami terima.');
    }
    if(data.proofUrl){
      const result=await makeHumanRequest({
        chatId,eventId,intent:'DEPOSIT_PROBLEM',text,livechat,telegram:true,holding:WAITING_CHECK_REPLY,
        question:`📷 CEK BUKTI MEMBER\n\nUser ID : ${data.userId}\n\nSilakan cek foto/bukti member.`,
        requireTelegramDelivery:true
      });
      if(result?.telegram) await db.setConversationWorkflow(chatId,{type:'PROOF_REVIEW',state:'WAITING_HUMAN',data:{...data,humanRequestId:result.humanRequestId}});
      return result;
    }
  }

  // Deposit complaint: member may send ID and proof separately. Persist/merge both, then send one verification ticket to Telegram CS.
  if(['DEPOSIT_PROBLEM','DEPOSIT_REQUEST'].includes(effective) || wf?.workflow_type==='DEPOSIT_VERIFY'){
    const workflowAskedForId = wf?.workflow_type==='DEPOSIT_VERIFY' && !wf?.workflow_data?.userId;
    const userId=extractUserId(ctx) || (workflowAskedForId ? (extractRequestedUserIdFromText(text) || extractStandaloneRequestedUserId(ctx)) : '');
    const proof=latestProof(ctx);
    const mustBeNewProof=['WAITING_DETAIL_PROOF','WAITING_CLEAR_PROOF'].includes(String(wf?.workflow_state||''));
    const proofIsNew=Boolean(proof?.url && (!mustBeNewProof || proof.url!==wf?.workflow_data?.previousProofUrl));
    const data={...(wf?.workflow_data||{}),userId:userId||wf?.workflow_data?.userId||'',proofUrl:proofIsNew?proof.url:(mustBeNewProof?'':(wf?.workflow_data?.proofUrl||''))};
    const missing=[]; if(!data.userId)missing.push('user ID'); if(!data.proofUrl)missing.push('bukti transfer');
    if(missing.length){
      const reply=missing.length===2?'Boleh kirim user ID sama bukti transfernya ya bosku 🙏 Biar kami bantu cek depositnya.':missing[0]==='user ID'?'Boleh kirim user ID-nya ya bosku 🙏 Bukti transfernya sudah kami terima.':'Boleh kirim bukti transfernya ya bosku 🙏 User ID-nya sudah kami terima.';
      return askAndTrack(livechat,chatId,'DEPOSIT_PROBLEM','DEPOSIT_VERIFY','COLLECTING',data,reply);
    }
    const depositAmount=extractOperationalAmount(ctx);
    const depositAmountLine=depositAmount?`
Nominal : Rp${depositAmount.toLocaleString('id-ID')}`:'';
    const result=await makeHumanRequest({
      chatId,eventId,intent:'DEPOSIT_PROBLEM',text,livechat,telegram:true,holding:WAITING_CHECK_REPLY,
      question:`💰 DEPOSIT PROBLEM

User ID : ${data.userId}${depositAmountLine}

Bukti transfer ikut terlampir.
Silakan cek deposit member.`,
      requireTelegramDelivery:true
    });
    if(result?.telegram) await db.setConversationWorkflow(chatId,{type:'DEPOSIT_VERIFY',state:'WAITING_HUMAN',data:{...data,humanRequestId:result.humanRequestId}});
    return result;
  }

  // Reset password: NEVER ask user ID. Collect registered account data one slot at a time.
  // Required fields: jenis rekening/bank/e-wallet, nama rekening, nomor rekening.
  // Member may send name -> bank/e-wallet -> account number in separate messages; we persist and merge them.
  if(effective==='FORGOT_PASSWORD' || wf?.workflow_type==='RESET_PASSWORD'){
    const prev=wf?.workflow_data||{};
    const data=inferResetAccountData(ctx,prev);

    // Staff previously asked member to deposit first. Once member confirms deposit, re-open a fresh reset ticket.
    if(wf?.workflow_type==='RESET_PASSWORD' && wf?.workflow_state==='WAITING_DEPOSIT'){
      const proof=latestProof(ctx);
      const proofIsNew=Boolean(proof?.url && proof.url!==prev.previousProofUrl);
      const merged={...data,proofUrl:proofIsNew?proof.url:(prev.proofUrl||'')};
      await db.setConversationWorkflow(chatId,{type:'RESET_PASSWORD',state:'WAITING_DEPOSIT',data:merged});
      const depositConfirmed=isDepositConfirmedText(text) || proofIsNew;
      if(depositConfirmed && !merged.proofUrl){
        return askAndTrack(livechat,chatId,'FORGOT_PASSWORD','RESET_PASSWORD','WAITING_DEPOSIT_PROOF',merged,'Boleh kirim bukti deposit verifikasinya ya bosku 🙏 Setelah bukti kami terima, langsung kami lanjutkan pengecekan reset password.');
      }
      if(depositConfirmed && merged.proofUrl){
        const result=await makeHumanRequest({
          chatId,eventId,intent:'FORGOT_PASSWORD',text,livechat,telegram:true,holding:WAITING_CHECK_REPLY,
          question:`🔐 RESET PASSWORD — VERIFIKASI DEPOSIT

DATA REKENING/WALLET YANG MAU DI RESET
Nama Rekening : ${merged.name||'-'}
No Rek/Wallet : ${merged.no||'-'}
Jenis         : ${merged.type||'-'}

✅ Member sudah deposit untuk verifikasi kepemilikan akun.
Bukti verifikasi ikut terlampir.

Silakan cek apakah deposit masuk. Jika sudah masuk, REPLY ticket ini dengan:
USER ID
PASSWORD
LINK`,
          requireTelegramDelivery:true
        });
        if(result?.telegram) await db.setConversationWorkflow(chatId,{type:'RESET_PASSWORD',state:'WAITING_HUMAN',data:{...merged,humanRequestId:result.humanRequestId}});
        return result;
      }
      return {intent:'FORGOT_PASSWORD',workflow:'RESET_PASSWORD',state:'WAITING_DEPOSIT',sent:false,waitingDeposit:true};
    }
    if(wf?.workflow_type==='RESET_PASSWORD' && wf?.workflow_state==='WAITING_DEPOSIT_PROOF'){
      const proof=latestProof(ctx);
      const merged={...data,proofUrl:proof?.url||prev.proofUrl||''};
      if(!merged.proofUrl){
        return askAndTrack(livechat,chatId,'FORGOT_PASSWORD','RESET_PASSWORD','WAITING_DEPOSIT_PROOF',merged,'Boleh kirim bukti deposit verifikasinya ya bosku 🙏');
      }
      const result=await makeHumanRequest({
        chatId,eventId,intent:'FORGOT_PASSWORD',text,livechat,telegram:true,holding:WAITING_CHECK_REPLY,
        question:`🔐 RESET PASSWORD — VERIFIKASI DEPOSIT

DATA REKENING/WALLET YANG MAU DI RESET
Nama Rekening : ${merged.name||'-'}
No Rek/Wallet : ${merged.no||'-'}
Jenis         : ${merged.type||'-'}

✅ Bukti deposit verifikasi sudah diterima dan ikut terlampir.
Silakan cek apakah deposit masuk. Jika sudah masuk, REPLY ticket ini dengan:
USER ID
PASSWORD
LINK`,
        requireTelegramDelivery:true
      });
      if(result?.telegram) await db.setConversationWorkflow(chatId,{type:'RESET_PASSWORD',state:'WAITING_HUMAN',data:{...merged,humanRequestId:result.humanRequestId}});
      return result;
    }

    const missing=resetMissing(data);
    if(missing.length){
      const field=missing[0];
      return askAndTrack(livechat,chatId,'FORGOT_PASSWORD','RESET_PASSWORD','COLLECTING',data,resetAskFor(field,missing));
    }
    const result=await makeHumanRequest({chatId,eventId,intent:'FORGOT_PASSWORD',text,livechat,telegram:true,holding:WAITING_CHECK_REPLY,question:`NO REK ${data.no}
a/n ${data.name}
JENIS REK : ${data.type||'-'}

reset password ko`,requireTelegramDelivery:true});
    if(result?.telegram) await db.setConversationWorkflow(chatId,{type:'RESET_PASSWORD',state:'WAITING_HUMAN',data:{...data,humanRequestId:result.humanRequestId}});
    return result;
  }

  // Every WD problem goes to Telegram staff. Ask member ID only if it is not already present. // kendala wd
  // Continue an active WD ID collection BEFORE relying on the current-message intent.
  // Members often answer only `CHAGE` or `id. CHAGE`, which normalizes to GENERAL.
  // Once an ID is present, Telegram delivery is mandatory before acknowledging the check.
  if(wf?.workflow_type==='WD_CHECK' && wf?.workflow_state==='WAITING_ID'){
    const uid=extractUserIdFromText(text) || extractRequestedUserIdFromText(text);
    if(!uid) return askAndTrack(livechat,chatId,'WITHDRAW_PROBLEM','WD_CHECK','WAITING_ID',{},'Boleh kirim ID akunnya ya bosku 🙏');
    const all=customerTexts(ctx).slice(-5).join(' | ');
    const result=await makeHumanRequest({
      chatId,eventId,intent:'WITHDRAW_PROBLEM',text,livechat,telegram:true,
      holding:WD_WAITING_STAFF_REPLY,
      question:`💸 CEK WITHDRAW\nID : ${uid}${extractOperationalAmount(ctx)?`\nNominal : Rp${extractOperationalAmount(ctx).toLocaleString('id-ID')}`:''}\n\ncek kepastian wd\n${all.slice(-500)}`,
      requireTelegramDelivery:true
    });
    // Keep workflow state if Telegram is temporarily unavailable so the pending request
    // remains recoverable and the member is never told that WD is already processing.
    if(result?.telegram) await db.setConversationWorkflow(chatId,{type:'WD_CHECK',state:'WAITING_HUMAN',data:{...(wf?.workflow_data||{}),userId:uid,humanRequestId:result.humanRequestId}});
    return result;
  }

  if(['WITHDRAW_PROBLEM','WITHDRAW_REQUEST'].includes(effective)){
    const uid=extractUserIdFromText(text) || extractRequestedUserIdFromText(text);
    if(!uid){
      return askAndTrack(livechat,chatId,'WITHDRAW_PROBLEM','WD_CHECK','WAITING_ID',{},'Boleh kirim ID akunnya ya bosku 🙏 Biar kami bantu cek kepastian WD-nya.');
    }
    const all=customerTexts(ctx).slice(-5).join(' | ');
    const result=await makeHumanRequest({
      chatId,eventId,intent:'WITHDRAW_PROBLEM',text,livechat,telegram:true,
      holding:WD_WAITING_STAFF_REPLY,
      question:`💸 CEK WITHDRAW\nID : ${uid}${extractOperationalAmount(ctx)?`\nNominal : Rp${extractOperationalAmount(ctx).toLocaleString('id-ID')}`:''}\n\ncek kepastian wd\n${all.slice(-500)}`,
      requireTelegramDelivery:true
    });
    if(result?.telegram) await db.setConversationWorkflow(chatId,{type:'WD_CHECK',state:'WAITING_HUMAN',data:{userId:uid,humanRequestId:result.humanRequestId}});
    return result;
  }

  // Informational bonus questions are answered from the official weekly-promo
  // response. They never create a Telegram ticket unless the member actually claims
  // or reports a missing bonus.
  if(effective==='BONUS_INFO'){
    const matched=(await db.getRelevantImportantInfo(text,12)).filter(x=>String(x.item_type||'').toUpperCase()==='PROMO');
    const n=normalizeText(text);
    let reply=''; let source='IMPORTANT_PROMO';
    if(matched.length && !/^(bonus|promo|event)( apa| apa saja| apa aja| apa yang ada| saja| aja)?$/i.test(n)){
      // Specific campaign: return the newest official record exactly, not an old chat example.
      reply=String(matched[0].content||'').trim();
    }else{
      const all=await db.listImportantInfo({activeOnly:true,type:'PROMO',limit:100});
      if(all.length){
        reply=`Promo & event yang sedang aktif ya bosku 😊\n\n${all.map(x=>`🔥 ${x.title}`).join('\n')}\n\nKalau bosku mau tahu detail salah satunya, sebutkan nama promonya ya.`;
      }else{
        reply=await responseText('#BONUS_MINGGUAN','Untuk informasi promo terbaru, boleh tunggu sebentar ya bosku. Kami cek dulu promo yang sedang aktif.');
        source='APPROVED_BONUS_KNOWLEDGE';
      }
    }
    reply=String(reply||'').slice(0,3000);
    await sendAndStore(livechat,chatId,reply,'BONUS_INFO');
    return {intent:'BONUS_INFO',sent:true,reply,source};
  }

  // Generic bonus claim: ask which bonus first, then ensure member ID exists before Telegram.
  if(effective==='BONUS_REQUEST' && wf?.workflow_type!=='BONUS_CLAIM'){
    const bonusType=await resolveBonusLabel(text);
    if(isFreebet50(text,bonusType)){
      const uid=extractUserIdFromText(text) || extractRequestedUserIdFromText(text) || extractUserId(ctx);
      return startFreebetTerms({chatId,text,livechat,userId:uid});
    }
    if(!bonusType){
      return askAndTrack(livechat,chatId,'BONUS_REQUEST','BONUS_CLAIM','ASK_TYPE',{},await responseText('#BONUS_TANYA','Bonus apa yang mau diklaim ya bosku? 😊'));
    }
    // If the claim type is already known but the account ID is not, enter the explicit
    // WAITING_ID state now. This lets terse follow-up replies be parsed deterministically.
    const uid=extractUserIdFromText(text) || extractRequestedUserIdFromText(text) || extractUserId(ctx);
    if(!uid){
      return askAndTrack(livechat,chatId,'BONUS_REQUEST','BONUS_CLAIM','WAITING_ID',{bonusType},'Boleh kirim ID akunnya ya bosku 🙏');
    }
    // Legacy regression marker: claim bonus ${String(bonusType).toLowerCase()} — requireTelegramDelivery:true
    const result=await makeHumanRequest({chatId,eventId,intent:'BONUS_REQUEST',text,livechat,telegram:true,holding:WAITING_CHECK_REPLY,question:formatBonusClaimQuestion(uid,bonusType),requireTelegramDelivery:true});
    if(result?.telegram) await db.setConversationWorkflow(chatId,{type:'BONUS_CLAIM',state:'WAITING_HUMAN',data:{bonusType,userId:uid,humanRequestId:result.humanRequestId}});
    return result;
  }
  if(wf?.workflow_type==='BONUS_CLAIM' && wf?.workflow_state==='ASK_TYPE'){
    const bonusType=await resolveBonusLabel(text) || String(text||'').trim().slice(0,120);
    const uid=extractUserIdFromText(text) || extractRequestedUserIdFromText(text) || extractUserId(ctx);
    if(!uid) return askAndTrack(livechat,chatId,'BONUS_REQUEST','BONUS_CLAIM','WAITING_ID',{bonusType},'Boleh kirim ID akunnya ya bosku 🙏');
    // Legacy regression marker: claim bonus ${String(bonusType).toLowerCase()} — requireTelegramDelivery:true
    const result=await makeHumanRequest({chatId,eventId,intent:'BONUS_REQUEST',text,livechat,telegram:true,holding:WAITING_CHECK_REPLY,question:formatBonusClaimQuestion(uid,bonusType),requireTelegramDelivery:true});
    if(result?.telegram) await db.setConversationWorkflow(chatId,{type:'BONUS_CLAIM',state:'WAITING_HUMAN',data:{bonusType,userId:uid,humanRequestId:result.humanRequestId}});
    return result;
  }
  if(wf?.workflow_type==='BONUS_CLAIM' && wf?.workflow_state==='WAITING_ID'){
    const uid=extractUserIdFromText(text) || extractRequestedUserIdFromText(text);
    const bonusType=String(wf?.workflow_data?.bonusType||'bonus').trim();
    if(!uid) return askAndTrack(livechat,chatId,'BONUS_REQUEST','BONUS_CLAIM','WAITING_ID',{bonusType},'Boleh kirim ID akunnya ya bosku 🙏');
    const result=await makeHumanRequest({chatId,eventId,intent:'BONUS_REQUEST',text,livechat,telegram:true,holding:WAITING_CHECK_REPLY,question:formatBonusClaimQuestion(uid,bonusType),requireTelegramDelivery:true});
    if(result?.telegram) await db.setConversationWorkflow(chatId,{type:'BONUS_CLAIM',state:'WAITING_HUMAN',data:{bonusType,userId:uid,humanRequestId:result.humanRequestId}});
    return result;
  }

  // Specific bonus (contoh: bonus harian). Pastikan ID ada sebelum lempar ke grup Bonus.
  if(effective.includes('BONUS')){
    const bonusType=await resolveBonusLabel(text) || effective.replace(/^BONUS_?/,'').replaceAll('_',' ');
    if(isFreebet50(text,bonusType)){
      const freebetUid=extractUserIdFromText(text) || extractRequestedUserIdFromText(text) || extractUserId(ctx);
      return startFreebetTerms({chatId,text,livechat,userId:freebetUid});
    }
    // A specific bonus intent (BONUS_DAILY, BONUS_MONTHLY, etc.) already gives us
    // enough context to safely parse an inline member ID from the *first* message.
    // Example: `Bonus deposit harian Safa01` must capture Safa01 immediately instead
    // of entering WAITING_ID and asking for the same ID again.
    const uid=extractUserIdFromText(text) || extractRequestedUserIdFromText(text) || extractUserId(ctx) || (wf?.workflow_type==='BONUS_CLAIM' ? extractStandaloneRequestedUserId(ctx) : '');
    if(!uid) return askAndTrack(livechat,chatId,effective,'BONUS_CLAIM','WAITING_ID',{bonusType},'Boleh kirim ID akunnya ya bosku 🙏');
    const result=await makeHumanRequest({chatId,eventId,intent:effective,text,livechat,telegram:true,holding:WAITING_CHECK_REPLY,question:formatBonusClaimQuestion(uid,bonusType),requireTelegramDelivery:true});
    if(result?.telegram) await db.setConversationWorkflow(chatId,{type:'BONUS_CLAIM',state:'WAITING_HUMAN',data:{bonusType,userId:uid,humanRequestId:result.humanRequestId}});
    return result;
  }

  // Kemenangan/payout belum dibayar: kumpulkan ID + bukti/riwayat, lalu WAJIB Telegram.
  if(effective==='PAYOUT_NOT_RECEIVED' || wf?.workflow_type==='PAYOUT_CHECK'){
    const workflowAskedForId=wf?.workflow_type==='PAYOUT_CHECK' && !wf?.workflow_data?.userId;
    const uid=extractUserIdFromText(text) || (workflowAskedForId?extractRequestedUserIdFromText(text):'') || extractUserId(ctx) || (workflowAskedForId?extractStandaloneRequestedUserId(ctx):'');
    const proof=latestProof(ctx);
    const data={...(wf?.workflow_data||{}),userId:uid||wf?.workflow_data?.userId||'',proofUrl:proof?.url||wf?.workflow_data?.proofUrl||''};
    const missing=[]; if(!data.userId) missing.push('ID akun'); if(!data.proofUrl) missing.push('screenshot kemenangan / riwayat permainan');
    if(missing.length){
      const reply=missing.length===2?'Boleh kirim ID akun dan screenshot kemenangan/riwayat permainannya ya bosku 🙏 Biar kami bantu cek pembayarannya.':missing[0]==='ID akun'?'Boleh kirim ID akunnya ya bosku 🙏 Bukti kemenangannya sudah kami terima.':'Boleh kirim screenshot kemenangan atau riwayat permainannya ya bosku 🙏 ID akun sudah kami terima.';
      return askAndTrack(livechat,chatId,'PAYOUT_NOT_RECEIVED','PAYOUT_CHECK','COLLECTING',data,reply);
    }
    const all=customerTexts(ctx).slice(-8).join(' | ');
    const result=await makeHumanRequest({chatId,eventId,intent:'PAYOUT_NOT_RECEIVED',text,livechat,telegram:true,holding:WAITING_CHECK_REPLY,question:`💰 KEMENANGAN / PAYOUT BELUM DIBAYAR
ID : ${data.userId}
Bukti/riwayat ikut terlampir.
${all.slice(-700)}`,requireTelegramDelivery:true});
    if(result?.telegram) await db.setConversationWorkflow(chatId,{type:'PAYOUT_CHECK',state:'WAITING_HUMAN',data:{...data,humanRequestId:result.humanRequestId}});
    return result;
  }

  // Ganti rekening adalah perubahan sensitif: kumpulkan ID + rekening/wallet baru lalu WAJIB Telegram.
  if(effective==='ACCOUNT_CHANGE_REQUEST' || wf?.workflow_type==='ACCOUNT_CHANGE'){
    const workflowAskedForId=wf?.workflow_type==='ACCOUNT_CHANGE' && !wf?.workflow_data?.userId;
    const uid=extractUserIdFromText(text) || (workflowAskedForId?extractRequestedUserIdFromText(text):'') || extractUserId(ctx) || (workflowAskedForId?extractStandaloneRequestedUserId(ctx):'');
    const account=extractAccountData(ctx); const prev=wf?.workflow_data||{};
    const data={...prev,userId:uid||prev.userId||'',type:account.type||prev.type||'',name:account.name||prev.name||'',no:account.no||prev.no||''};
    const missing=[]; if(!data.userId) missing.push('ID akun'); if(!data.type) missing.push('jenis rekening/e-wallet'); if(!data.name) missing.push('atas nama'); if(!data.no) missing.push('nomor rekening/e-wallet');
    if(missing.length){
      const reply=`Boleh dibantu ${missing.join(', ')} ya bosku 🙏 Data ini diperlukan untuk meneruskan permintaan ganti rekening.`;
      return askAndTrack(livechat,chatId,'ACCOUNT_CHANGE_REQUEST','ACCOUNT_CHANGE','COLLECTING',data,reply);
    }
    const result=await makeHumanRequest({chatId,eventId,intent:'ACCOUNT_CHANGE_REQUEST',text,livechat,telegram:true,holding:WAITING_CHECK_REPLY,question:`🏦 GANTI REKENING — minta ganti rekening
ID : ${data.userId}
Jenis : ${data.type}
Atas nama : ${data.name}
No rek/wallet : ${data.no}
Mohon verifikasi kepemilikan sebelum perubahan.`,requireTelegramDelivery:true});
    if(result?.telegram) await db.setConversationWorkflow(chatId,{type:'ACCOUNT_CHANGE',state:'WAITING_HUMAN',data:{...data,humanRequestId:result.humanRequestId}});
    return result;
  }

  // Rekening/e-wallet limit: perlu ID agar staff dapat menentukan penanganan yang benar.
  if(effective==='BANK_ACCOUNT_LIMIT' || wf?.workflow_type==='ACCOUNT_LIMIT'){
    const workflowAskedForId=wf?.workflow_type==='ACCOUNT_LIMIT' && !wf?.workflow_data?.userId;
    const uid=extractUserIdFromText(text) || (workflowAskedForId?extractRequestedUserIdFromText(text):'') || extractUserId(ctx) || (workflowAskedForId?extractStandaloneRequestedUserId(ctx):'');
    const account=extractAccountData(ctx); const data={...(wf?.workflow_data||{}),userId:uid||wf?.workflow_data?.userId||'',type:account.type||wf?.workflow_data?.type||'',name:account.name||wf?.workflow_data?.name||'',no:account.no||wf?.workflow_data?.no||''};
    if(!data.userId) return askAndTrack(livechat,chatId,'BANK_ACCOUNT_LIMIT','ACCOUNT_LIMIT','WAITING_ID',data,'Boleh kirim ID akunnya ya bosku 🙏 Biar kendala rekening limitnya kami teruskan untuk dicek.');
    const all=customerTexts(ctx).slice(-6).join(' | ');
    const result=await makeHumanRequest({chatId,eventId,intent:'BANK_ACCOUNT_LIMIT',text,livechat,telegram:true,holding:WAITING_CHECK_REPLY,question:`🏦 REKENING / E-WALLET LIMIT
ID : ${data.userId}
${data.type?`Jenis : ${data.type}
`:''}${data.name?`Atas nama : ${data.name}
`:''}${data.no?`Nomor : ${data.no}
`:''}${all.slice(-600)}`,requireTelegramDelivery:true});
    if(result?.telegram) await db.setConversationWorkflow(chatId,{type:'ACCOUNT_LIMIT',state:'WAITING_HUMAN',data:{...data,humanRequestId:result.humanRequestId}});
    return result;
  }

  // Permintaan daftar biasa: kirim link resmi terbaru. Bila tidak tersedia, eskalasi ke Telegram.
  if(effective==='REGISTER_REQUEST'){
    const rows=(await db.getRelevantImportantInfo(text,20)).filter(x=>String(x.item_type||'').toUpperCase()==='LINK');
    const candidate=rows.find(x=>/daftar|register|registr/i.test(`${x.title||''} ${x.content||''}`)) || rows[0];
    const reply=String(candidate?.content||'').trim().slice(0,1800);
    if(reply){ await sendAndStore(livechat,chatId,reply,effective); const notice=await notifyTelegramEvent({intent:'REGISTER_PROBLEM',chatId,text:`Member meminta pendaftaran. Link resmi sudah dikirim.\nPesan member: ${text}`,title:'PERMINTAAN DAFTAR'}); return {intent:effective,sent:true,reply,source:'IMPORTANT_REGISTER_LINK',telegramNotified:Boolean(notice?.ok)}; }
    return makeHumanRequest({chatId,eventId,intent:'REGISTER_PROBLEM',text,livechat,telegram:true,holding:'',question:'Member meminta link/pendaftaran tetapi link daftar resmi tidak ditemukan di Menu Penting. Mohon kirim link resmi.',requireTelegramDelivery:true});
  }

  // Gangguan operasional selalu dilaporkan ke Telegram dan baru diakui setelah Telegram berhasil.
  if(['LOGIN_PROBLEM','LINK_PROBLEM','REGISTER_PROBLEM','GENERAL_DISTURBANCE'].includes(effective)){
    const uid=extractUserId(ctx); const all=customerTexts(ctx).slice(-6).join(' | ');
    const label={LOGIN_PROBLEM:'tidak bisa login / masuk',LINK_PROBLEM:'link / website tidak bisa diakses',REGISTER_PROBLEM:'pendaftaran gagal / tidak bisa daftar',GENERAL_DISTURBANCE:'gangguan umum / maintenance'}[effective]||'gangguan';
    const result=await makeHumanRequest({chatId,eventId,intent:effective,text,livechat,telegram:true,holding:'Siap bosku, kendalanya kami teruskan untuk dicek ya 🙏',question:`${uid?`ID : ${uid}

`:''}${label}
${all.slice(-900)}`,requireTelegramDelivery:true});
    if(result?.telegram) await db.setConversationWorkflow(chatId,{type:effective==='REGISTER_PROBLEM'?'REGISTER_CHECK':'ACCESS_CHECK',state:'WAITING_HUMAN',data:{userId:uid,humanRequestId:result.humanRequestId}});
    return result;
  }

  // Game macet/error: minta ID. Jika saldo/result bermasalah, bukti/riwayat wajib supaya staff tidak menebak.
  if(effective==='GAME_PROBLEM' || wf?.workflow_type==='GAME_CHECK'){
    const workflowAskedForId=wf?.workflow_type==='GAME_CHECK' && !wf?.workflow_data?.userId;
    const uid=extractUserIdFromText(text) || (workflowAskedForId?extractRequestedUserIdFromText(text):'') || extractUserId(ctx) || (workflowAskedForId?extractStandaloneRequestedUserId(ctx):'');
    const proof=latestProof(ctx); const impact=detectGameImpact(ctx); const prev=wf?.workflow_data||{};
    const data={...prev,userId:uid||prev.userId||'',proofUrl:proof?.url||prev.proofUrl||'',financialImpact:Boolean(prev.financialImpact||impact.financial),resultMissing:Boolean(prev.resultMissing||impact.resultMissing)};
    if(!data.userId) return askAndTrack(livechat,chatId,'GAME_PROBLEM','GAME_CHECK','WAITING_ID',data,'Boleh kirim ID akunnya ya bosku 🙏 Biar kendala gamenya kami teruskan ke staff untuk dicek.');
    if((data.financialImpact||data.resultMissing) && !data.proofUrl) return askAndTrack(livechat,chatId,'GAME_PROBLEM','GAME_CHECK','WAITING_PROOF',data,'Boleh kirim screenshot game/riwayat permainannya ya bosku 🙏 Karena ada kendala saldo atau hasil permainan, bukti diperlukan untuk pengecekan.');
    const all=customerTexts(ctx).slice(-8).join(' | '); const amount=extractOperationalAmount(ctx);
    const amountLine=amount?`\nNominal terkait : Rp${amount.toLocaleString('id-ID')}`:'';
    const financialLine=data.financialImpact?'\nDampak : saldo/taruhan terpotong':'';
    const resultLine=data.resultMissing?'\nDampak : hasil/riwayat tidak muncul':'';
    const proofLine=data.proofUrl?'\nBukti/riwayat ikut terlampir.':'';
    const result=await makeHumanRequest({chatId,eventId,intent:'GAME_PROBLEM',text,livechat,telegram:true,holding:'Siap bosku, kendala gamenya kami teruskan untuk dicek ya 🙏',question:`🎮 GAME MACET / ERROR\nID : ${data.userId}${amountLine}${financialLine}${resultLine}${proofLine}\n${all.slice(-900)}`,requireTelegramDelivery:true});
    if(result?.telegram) await db.setConversationWorkflow(chatId,{type:'GAME_CHECK',state:'WAITING_HUMAN',data:{...data,humanRequestId:result.humanRequestId}});
    return result;
  }
  return null;
}

function normalizeShortcut(s=''){ return String(s||'').trim().replace(/^#?/,'#'); }
async function responseText(shortcut,fallback){
  const r=await db.getCannedByShortcut(normalizeShortcut(shortcut));
  return String(r?.content||fallback||'').trim().slice(0,1200);
}
function parseResetCredentialReply(text=''){
  const s=String(text||'').trim();
  if(!s) return null;
  // Telegram staff often writes the whole reset answer on ONE line, e.g.
  // `UserID : abc Password : q123 Link Login : https://...`.
  // Stop each labelled field at the next known label instead of greedily taking
  // the rest of the line. This prevents malformed credentials and guarantees the
  // reply can be delivered back to the correct LiveChat member.
  const user=(s.match(/(?:user\s*id|userid|username)\s*[:=]\s*(.+?)(?=\s+(?:password|psw|pass|link(?:\s*login)?)\s*[:=]|$)/i)||[])[1]?.trim()||'';
  const password=(s.match(/(?:password|psw|pass)\s*[:=]\s*(.+?)(?=\s+(?:user\s*id|userid|username|link(?:\s*login)?)\s*[:=]|$)/i)||[])[1]?.trim()||'';
  const labelledLink=(s.match(/(?:link(?:\s*login)?)\s*[:=]\s*(https?:\/\/[^\s]+)/i)||[])[1]?.trim()||'';
  const anyLink=(s.match(/https?:\/\/[^\s]+/i)||[])[0]?.trim()||'';
  const link=labelledLink||anyLink;
  if(user && password && link){
    const linkPos=s.indexOf(link); const tail=linkPos>=0?s.slice(linkPos+link.length).trim():'';
    const note=tail.replace(/^[\s|,;:.\-]+/,'').slice(0,600);
    return {userId:user,password,link,note};
  }
  // Normal CS shorthand: line 1 = USER ID, line 2 = PASSWORD, line 3 = LOGIN LINK.
  const lines=s.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  if(lines.length>=3 && !/^(?:done|belum|pending)$/i.test(lines[0])){
    const possibleLink=lines.find((x,i)=>i>=2 && /^https?:\/\//i.test(x))||'';
    if(possibleLink && lines[0].length<=120 && lines[1].length<=160){
      const idx=lines.indexOf(possibleLink); const note=idx>=0?lines.slice(idx+1).join(' ').slice(0,600):'';
      return {userId:lines[0],password:lines[1],link:possibleLink,note};
    }
  }
  return null;
}
function resetReplyComplete(text=''){ return Boolean(parseResetCredentialReply(text)); }
function resetCredentialMemberReply(parsed){
  return [
    'Reset passwordnya sudah selesai ya bosku 😊',
    '',
    `User ID: ${parsed.userId}`,
    `Password: ${parsed.password}`,
    parsed.link?`Link: ${parsed.link}`:'',
    parsed.note?`\n${parsed.note}`:'',
    '',
    'Silakan login kembali menggunakan data tersebut ya bosku.'
  ].filter((x,i,a)=>x!=='' || (i>0 && a[i-1]!=='' )).join('\n').trim();
}
async function escalateFreebetAgreement({chatId,eventId,text,livechat,wf}){
  const ctx=await getOperationalHistory(chatId);
  const prev=wf?.workflow_data||{};
  const uid=extractUserIdFromText(text) || extractRequestedUserIdFromText(text) || prev.userId || extractUserId(ctx) || extractStandaloneRequestedUserId(ctx);
  if(!uid){
    await db.setConversationWorkflow(chatId,{type:'FREEBET_CLAIM',state:'WAITING_ID_AFTER_AGREEMENT',data:{...prev,agreed:true}});
    const reply='Oke bosku 😊 Syarat FreeBet sudah disetujui. Boleh kirim ID akunnya ya bosku 🙏';
    await sendAndStore(livechat,chatId,reply,'BONUS_REQUEST');
    return {intent:'BONUS_REQUEST',workflow:'FREEBET_CLAIM',state:'WAITING_ID_AFTER_AGREEMENT',sent:true,reply};
  }
  const question=`🎁 FREEBET 50% - MEMBER SUDAH SETUJU\n\nID : ${uid}\n\nMember sudah membaca dan menyetujui syarat Bonus FreeBet 50%.\nSilakan cek kelayakan claim member.`;
  const result=await makeHumanRequest({chatId,eventId,intent:'BONUS_REQUEST',text,livechat,telegram:true,holding:WAITING_CHECK_REPLY,question,requireTelegramDelivery:true});
  if(result?.telegram) await db.setConversationWorkflow(chatId,{type:'FREEBET_CLAIM',state:'WAITING_HUMAN',data:{...prev,agreed:true,userId:uid,humanRequestId:result.humanRequestId}});
  return result;
}

async function maybeHandleFreebetWorkflow({chatId,eventId,text,livechat}){
  const wf=await db.getConversationWorkflow(chatId);
  if(wf?.workflow_type!=='FREEBET_CLAIM') return null;
  if(wf.workflow_state==='WAITING_AGREEMENT'){
    if(!isFreebetAgreement(text)) return null;
    return escalateFreebetAgreement({chatId,eventId,text,livechat,wf});
  }
  if(wf.workflow_state==='WAITING_ID_AFTER_AGREEMENT'){
    return escalateFreebetAgreement({chatId,eventId,text,livechat,wf});
  }
  return null;
}

async function startFreebetTerms({chatId,text,livechat,userId=''}){
  await db.setConversationWorkflow(chatId,{type:'FREEBET_CLAIM',state:'WAITING_AGREEMENT',data:{bonusType:'BONUS FREEBET 50%',userId:userId||''}});
  await sendAndStore(livechat,chatId,FREEBET_TERMS,'BONUS_REQUEST');
  return {intent:'BONUS_REQUEST',workflow:'FREEBET_CLAIM',state:'WAITING_AGREEMENT',sent:true,reply:FREEBET_TERMS};
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

  const ctx=await getOperationalHistory(chatId);
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
  const promoRows=await db.listPromoRules({activeOnly:true,limit:200});
  const query=`${normalized} ${recentRows.filter(m=>m.sender_type==='customer').slice(-8).map(m=>m.text).join(' ')}`;
  const importantRows=await db.getRelevantImportantInfo(query,24);
  const cannedRows=await db.getRelevantCanned(query,10);
  const learningRows=await db.getRelevantLearning(query,intent,10);
  const historyRows=await db.getAutoHistoryLearning(query,intent,12);
  const styleRows=await db.getHumanStyleExamples(30);
  let digestRow=await db.getConversationDigest(chatId);
  let digest=String(digestRow?.conversation_digest||'');
  let digested=Math.max(0,Number(digestRow?.digest_message_count||0));
  // Cerna seluruh history yang sudah tersimpan, bukan hanya pesan terbaru. History lama diringkas
  // bertahap dari paling awal hingga tepat sebelum jendela 60 pesan terbaru.
  const target=Math.max(0,total-recentLimit);
  if(target>digested){
    let loops=0;
    while(digested<target && loops<30){
      const take=Math.min(160,target-digested);
      const chunkRows=await db.getContextSlice(chatId,digested,take);
      if(!chunkRows.length) break;
      const history=chunkRows.map(m=>`${m.sender_type==='customer'?'MEMBER':m.sender_type==='ai'?'AI':m.sender_type==='system'?'SYSTEM':'CS'}: ${String(m.text||'').trim()}`).join('\n');
      try{
        const d=await ai.digestConversation({history,previousDigest:digest});
        digest=d.digest; digested+=chunkRows.length; await db.saveConversationDigest(chatId,digest,digested);
      }catch(e){ await db.logError('engine','CONTEXT_DIGEST_FAILED',e.message,{chatId,total,digested,target}); break; }
      loops++;
    }
  }
  const context=recentRows.map(m=>`${m.sender_type==='customer'?'MEMBER':m.sender_type==='ai'?'AI':m.sender_type==='system'?'SYSTEM':'CS'}: ${m.text}`).join('\n');
  const rules=formatRows(rulesRows,['category','rule_type','content']);
  const manualKnowledge=formatRows(kbRows,['category','title','content']);
  const importantKnowledge=formatImportantForAI(importantRows);
  const promoKnowledge=promoRows.map(r=>`[PROMO AKTIF] ${r.name} | keyword:${(r.keywords||[]).join(', ')} | min deposit:${r.min_deposit||'-'} | max bonus:${r.max_bonus||'-'} | turnover:${r.turnover||'-'} | batas klaim:${r.claim_limit||'-'} | jam:${r.active_hours||'-'} | game:${r.game_scope||'-'} | rules:${r.rules||'-'} | template:${r.reply_template||'-'}`).join('\n');
  const responses=cannedRows.map(r=>`[RESPONSE ${r.shortcut||r.title||r.source_id}] [${r.response_mode||'FLEXIBLE'}] [${r.category||'GENERAL'}] ${r.content}`).join('\n');
  const learning=learningRows.map(r=>`[BELAJAR ${r.source_type}] [${r.intent}] [similarity:${r.semantic_score??'-'}] Member: ${r.member_text} => Jawaban benar: ${r.correction_text||r.response_text}${r.context_snapshot?` | Konteks: ${String(r.context_snapshot).slice(0,500)}`:''}`).join('\n');
  const csStyleExamples=styleRows.map(r=>`- ${String(r.response_text||'').trim()}`).filter(Boolean).join('\n').slice(0,9000);
  const historyLearning=historyRows.map(r=>`[${r.intent}] [similarity:${r.semantic_score??'-'}] Member: ${r.sample_member||'-'} => Pola CS: ${r.sample_response} (dipakai ${r.occurrences}x)`).join('\n').slice(0,10000);
  const attachments=recentRows.filter(m=>m.sender_type==='customer').slice(-10).flatMap(m=>Array.isArray(m.attachments)?m.attachments:[]).filter(a=>a?.isImage).slice(-3);
  const brainRow=await db.getConversationBrain(chatId);
  const caseBrain=normalizeBrain(brainRow?.case_brain||{},intent);
  return {context,rules,knowledge:[importantKnowledge,promoKnowledge,manualKnowledge,responses,learning].filter(Boolean).join('\n'),hasKnowledge:Boolean(importantKnowledge||promoKnowledge||manualKnowledge||responses||learning),attachments,conversationDigest:digest,csStyleExamples,historyLearning,totalMessages:total,caseBrain,digestCovered:digested,digestTarget:target,importantRows};
}

export async function processCustomerMessage({chatId,eventId,threadId=null,text,createdAt,livechat,attachments=[],skipInsert=false,resumeReason=''}) {
  const beforeState=await db.getConversationState(chatId);
  // A system promo can be stored before the first customer message. message_count alone
  // therefore cannot decide whether this is a fresh conversation. Ignore system rows
  // and detect whether any meaningful customer/agent/AI conversation existed before it.
  const priorRows=!skipInsert ? await db.getContext(chatId,120) : [];
  const wasNewConversation=!skipInsert && canAutoGreetFromHistory(priorRows,null);
  const threadKey=String(threadId||'').trim();
  const normalized=normalizeText(text); let intent=detectIntent(text);
  if(!skipInsert){
    const inserted=await db.insertMessage({chatId,eventId,senderType:'customer',text,normalizedText:normalized,intent,createdAt,authorId:'',attachments});
    if (!inserted) return {skipped:'duplicate'};
  }else{
    await db.logAI({chatId,sourceEventId:eventId||null,intent,action:'RESUME_AFTER_HUMAN',confidence:1,reply:'',reason:resumeReason||'resume_existing_customer_message'}).catch(()=>{});
  }

  return db.withChatLock(chatId, async()=>{
    // Re-check after obtaining the per-chat lock so a human Take Over always wins
    // against an AI reply that was being prepared concurrently.
    if (await db.isHumanTakeover(chatId)) return {skipped:'human_takeover'};
    const systemEnabled=Boolean(await db.getSetting('system_enabled',true));
    if (!systemEnabled) return {skipped:'system_off',intent,normalized};
    const auto=Boolean(await db.getSetting('auto_reply',config.autoReplyDefault));
    if (!auto) return {skipped:'auto_reply_off',intent,normalized};

    // Greeting must happen before any operational return (Deposit/WD/Reset/Bonus).
    // Otherwise a member whose first message is already a problem never gets welcomed.
    // For reused chat_id, a known previous greeting_thread_id lets us safely identify
    // a genuinely new LiveChat thread. A fresh install with old history does not greet
    // mid-conversation merely because greeting_thread_id is still null.
    const greetingEnabled=Boolean(await db.getSetting('greeting_enabled',config.greetingEnabled));
    let greeted=false;
    if(greetingEnabled && !skipInsert){
      const eventAge=(()=>{const t=Date.parse(createdAt||'');return Number.isFinite(t)?Math.max(0,(Date.now()-t)/1000):Infinity;})();
      const knownThread=String(beforeState?.greeting_thread_id||'').trim();
      const newKnownThread=Boolean(threadKey && knownThread && threadKey!==knownThread);
      const eligibleFresh=eventAge<=Math.max(config.greetingTriggerMaxAgeSeconds,config.bootstrapReplyMaxAgeSeconds);
      let claimed=false;
      if(eligibleFresh && threadKey && (wasNewConversation || newKnownThread)){
        claimed=await db.claimGreetingForThread(chatId,threadKey);
      }else if(eligibleFresh && wasNewConversation){
        claimed=await db.claimGreeting(chatId,{onlyIfNew:false});
      }
      if(claimed){
        try{ await sendAndStore(livechat,chatId,greetingText(new Date(),config.timezone),'GREETING'); greeted=true; }
        catch(e){ if(e.message==='HUMAN_TAKEOVER_ACTIVE') return {skipped:'human_takeover'}; await db.logError('engine','GREETING_SEND_FAILED',e.message,{chatId,threadId:threadKey||null}); }
      }
    }

    intent=await resolveContextualIntent(chatId,intent,text,attachments);
    // Advanced case intelligence: persist secondary intents and structured facts.
    // Member text is always untrusted data; prompt-like instructions never become internal commands.
    const multiIntents=detectMultiIntents(text);
    const secondary=multiIntents.filter(x=>x!==String(intent||'').toUpperCase());
    if(secondary.length) await db.enqueueSecondaryIntents(chatId,eventId,secondary);
    const extractedFacts=extractConversationFacts(text);
    if(extractedFacts.length) await db.upsertConversationFacts(chatId,extractedFacts);
    if(detectPromptInjection(text)) await db.logError('security','PROMPT_INJECTION_ATTEMPT','Untrusted member instruction detected',{chatId,eventId});
    if(detectCorrection(text)) await db.logError('engine','MEMBER_CORRECTION_DETECTED','Member corrected prior understanding',{chatId,eventId});

    // FreeBet agreement is a stateful acknowledgement and must be handled before
    // the generic `oke -> Oke bosku` shortcut. Otherwise the claim never reaches Telegram.
    const freebetWorkflowResult=await maybeHandleFreebetWorkflow({chatId,eventId,text,livechat});
    if(freebetWorkflowResult) return freebetWorkflowResult;

    // Pure conversational acknowledgements are terminal for this turn. They must
    // never fall through into an old WD/DP/bonus workflow and repeat a status message.
    // Examples: "Ok" -> "Oke bosku 😊"; "makasih" -> gratitude reply.
    // The workflow/ticket itself stays untouched so real follow-up messages can continue it.
    if(isGratitudeText(text)){
      const reply=gratitudeReply();
      await sendAndStore(livechat,chatId,reply,'GRATITUDE');
      await db.logAI({chatId,sourceEventId:eventId,intent:'GRATITUDE',action:'AUTO_REPLY',confidence:1,reply,reason:'pure_gratitude_does_not_retrigger_operational_workflow'}).catch(()=>{});
      return {intent:'GRATITUDE',sent:true,reply,workflowPreserved:true};
    }
    if(isAcknowledgementText(text)){
      const activeWorkflow=await db.getConversationWorkflow(chatId);
      const waitingWd=Boolean(activeWorkflow && ['WD_CHECK','WD_STATUS'].includes(String(activeWorkflow.workflow_type||'')) && ['WAITING_HUMAN','PENDING','PENDING_FOLLOWUP'].includes(String(activeWorkflow.workflow_state||'')));
      const reply=waitingWd ? WD_ACK_WAIT_REPLY : acknowledgementReply();
      await sendAndStore(livechat,chatId,reply,'ACKNOWLEDGEMENT');
      await db.logAI({chatId,sourceEventId:eventId,intent:'ACKNOWLEDGEMENT',action:'AUTO_REPLY',confidence:1,reply,reason:waitingWd?'wd_waiting_acknowledgement':'short_ack_does_not_retrigger_operational_workflow'}).catch(()=>{});
      return {intent:'ACKNOWLEDGEMENT',sent:true,reply,workflowPreserved:true};
    }
    {
      const activeWorkflow=await db.getConversationWorkflow(chatId);
      const waitingWd=Boolean(activeWorkflow && ['WD_CHECK','WD_STATUS'].includes(String(activeWorkflow.workflow_type||'')) && ['WAITING_HUMAN','PENDING','PENDING_FOLLOWUP'].includes(String(activeWorkflow.workflow_state||'')));
      if(waitingWd && isWaitingAcknowledgementText(text)){
        const reply=WD_ACK_WAIT_REPLY;
        await sendAndStore(livechat,chatId,reply,'ACKNOWLEDGEMENT');
        await db.logAI({chatId,sourceEventId:eventId,intent:'ACKNOWLEDGEMENT',action:'AUTO_REPLY',confidence:1,reply,reason:'wd_waiting_natural_acknowledgement'}).catch(()=>{});
        return {intent:'ACKNOWLEDGEMENT',sent:true,reply,workflowPreserved:true};
      }
    }

    const workflowResult=await maybeHandleWorkflow({chatId,eventId,text,intent,livechat});
    if(workflowResult) return workflowResult;

    const operationalResult=await maybeHandleOperationalFlow({chatId,eventId,text,intent,livechat});
    if(operationalResult) return operationalResult;

    const openHuman=await db.getOpenHumanRequest(chatId);
    if(openHuman) return {skipped:'waiting_human',intent,humanRequestId:openHuman.id};

    if(greeted && intent==='GREETING') return {intent,decision:{action:'AUTO_REPLY',confidence:1,reply:null,reason:'greeting_sent'},sent:true};

    const src=await buildSources(chatId,intent,normalized);
    try {
      const mergedAttachments=[...(src.attachments||[]),...(attachments||[])].filter((a,i,arr)=>a?.url&&arr.findIndex(x=>x?.url===a.url)===i).slice(-3);
      let aiAttachments=mergedAttachments;
      if(mergedAttachments.length && typeof livechat.prepareImageAttachments==='function'){
        try{ aiAttachments=await livechat.prepareImageAttachments(mergedAttachments); }catch{}
      }
      const style=await getReplyStyle();
      let decision=await ai.classifyAndReply({normalized:`${normalized}\n[internal-risk:${actionRisk(intent)}][member-content-untrusted:true]`,intent,context:src.context,rules:src.rules,knowledge:src.knowledge,attachments:aiAttachments,style,conversationDigest:src.conversationDigest,csStyleExamples:src.csStyleExamples,historyLearning:src.historyLearning,caseBrain:src.caseBrain});
      const updatedBrain=normalizeBrain({...decision.brain,understanding:decision.understanding||decision.brain?.understanding},intent);
      await db.saveConversationBrain(chatId,updatedBrain,src.totalMessages);
      decision=applyBrainGate({intent,decision,brain:updatedBrain,hasKnowledge:src.hasKnowledge});
      if (decision.confidence < config.aiConfidence && !['ASK_INFO'].includes(decision.action)) { decision.action='ASK_HUMAN'; decision.reply=''; decision.reason=`low_confidence:${decision.reason||''}`; }
      if(['AUTO_REPLY','ASK_INFO'].includes(decision.action)) decision=guardDecision({intent,decision,hasKnowledge:src.hasKnowledge});
      decision=validateProDecision({decision,history:await db.getContext(chatId,80),brain:updatedBrain,intent,hasKnowledge:src.hasKnowledge});

      // If a member sends transfer proof first, AI vision may be the first component that
      // recognizes it as a deposit case. Persist that understanding as a workflow so a later
      // User ID is merged with the existing proof instead of being treated as a new question.
      if(mergedAttachments.length){
        const hint=normalizeText(`${decision.understanding||''} ${decision.goal||''} ${decision.reply||''} ${decision.reason||''}`);
        const currentWf=await db.getConversationWorkflow(chatId);
        if(!currentWf?.workflow_type && /(?:deposit|depo|transfer|bukti\s*(?:tf|transfer))/i.test(hint)){
          const recent=await getOperationalHistory(chatId);
          const uid=extractUserId(recent);
          const proof=latestProof(recent);
          const data={userId:uid||'',proofUrl:proof?.url||mergedAttachments.slice(-1)[0]?.url||''};
          if(data.userId && data.proofUrl){
            const depositAmount=extractOperationalAmount(recent); const depositAmountLine=depositAmount?`
Nominal : Rp${depositAmount.toLocaleString('id-ID')}`:'';
            const result=await makeHumanRequest({chatId,eventId,intent:'DEPOSIT_PROBLEM',text,livechat,telegram:true,holding:WAITING_CHECK_REPLY,question:`💰 DEPOSIT PROBLEM

User ID : ${data.userId}${depositAmountLine}

Bukti transfer ikut terlampir.
Silakan cek deposit member.`,requireTelegramDelivery:true});
            if(result?.telegram) await db.setConversationWorkflow(chatId,{type:'DEPOSIT_VERIFY',state:'WAITING_HUMAN',data:{...data,humanRequestId:result.humanRequestId}});
            return result;
          }
          await db.setConversationWorkflow(chatId,{type:'DEPOSIT_VERIFY',state:'COLLECTING',data});
        }
      }

      // Human can press Take Over while OpenAI is thinking. Check once more before any action/send.
      if (await db.isHumanTakeover(chatId)) return {skipped:'human_takeover_after_ai'};

      if(['ASK_HUMAN','HANDOFF'].includes(decision.action)){
        const humanAsk=Boolean(await db.getSetting('human_ask_enabled',config.humanAskEnabled));
        if(humanAsk){
          const brain=normalizeBrain(decision.brain||src.caseBrain,intent);
          const question=decision.humanQuestion || `Mohon bantu tentukan jawaban untuk member ini. Intent: ${intent}. Masalah: ${decision.understanding||brain.understanding||'-'}. Tahap: ${brain.stage}. Data yang masih kurang: ${brain.missingInfo.join(', ')||'-'}. Pesan terbaru: ${text}`;
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


export async function resumeConversationAfterHumanTakeover({chatId,livechat}){
  const pending=await db.withChatLock(chatId, async()=>{
    if(await db.isHumanTakeover(chatId)) return {skipped:'human_takeover_still_active'};
    const rows=await db.getContext(chatId,240);
    if(!rows.length) return {skipped:'no_history'};
    let customerIndex=-1;
    for(let i=rows.length-1;i>=0;i--){
      if(String(rows[i]?.sender_type||'').toLowerCase()==='customer' && String(rows[i]?.text||'').trim()){ customerIndex=i; break; }
    }
    if(customerIndex<0) return {skipped:'no_customer_message'};
    const later=rows.slice(customerIndex+1);
    if(later.some(m=>['ai','agent'].includes(String(m?.sender_type||'').toLowerCase()) && String(m?.text||'').trim())){
      return {skipped:'latest_customer_already_answered'};
    }
    const last=rows[customerIndex];
    return {resume:{eventId:last.event_id,text:last.text,createdAt:last.created_at,attachments:last.attachments||[]}};
  });
  if(!pending?.resume) return pending;
  const r=pending.resume;
  return processCustomerMessage({chatId,eventId:r.eventId,text:r.text,createdAt:r.createdAt,attachments:r.attachments,livechat,skipInsert:true,resumeReason:'operator_returned_conversation_to_ai'});
}



export async function processGreetingTrigger({chatId,eventId,threadId=null,text,createdAt,livechat}){
  return db.withChatLock(chatId, async()=>{
    if (await db.isHumanTakeover(chatId)) return {skipped:'human_takeover'};
    const systemEnabled=Boolean(await db.getSetting('system_enabled',true));
    if(!systemEnabled) return {skipped:'system_off'};
    const auto=Boolean(await db.getSetting('auto_reply',config.autoReplyDefault));
    if(!auto) return {skipped:'auto_reply_off'};
    const greetingEnabled=Boolean(await db.getSetting('greeting_enabled',config.greetingEnabled));
    if(!greetingEnabled) return {skipped:'greeting_off'};

    // LiveChat can reuse one chat_id across multiple threads/sessions. When the
    // platform welcome/promo message appears in a NEW thread, greet again even if
    // the same chat_id has old history. claimGreetingForThread is atomic, so a poll
    // retry cannot send the greeting twice. For providers that do not expose a
    // thread id, retain the conservative legacy history check.
    const threadKey=String(threadId||'').trim();
    if(threadKey){
      if(!(await db.claimGreetingForThread(chatId,threadKey))) return {skipped:'greeting_already_sent_for_thread'};
    }else{
      const priorContext=await db.getContext(chatId,200);
      if(!canAutoGreetFromHistory(priorContext,eventId)){
        await db.claimGreeting(chatId,{onlyIfNew:false});
        await db.logAI({chatId,sourceEventId:eventId||null,intent:'GREETING',action:'GREETING_SUPPRESSED',confidence:1,reply:'',reason:'existing_conversation_history_no_thread_id'});
        return {skipped:'existing_conversation_history'};
      }
      if(!(await db.claimGreeting(chatId,{onlyIfNew:false}))) return {skipped:'greeting_already_sent'};
    }
    // A delayed/replayed promo must never create a greeting in the middle of an
    // existing conversation or immediately after Kembalikan ke AI.
    const triggerAt=Date.parse(createdAt||'');
    if(Number.isFinite(triggerAt)){
      const rows=await db.getContext(chatId,240);
      const hasConversationAfterTrigger=rows.some(m=>{
        if(String(m?.event_id||'')===String(eventId||'')) return false;
        const type=String(m?.sender_type||'').toLowerCase();
        if(!['customer','agent','ai'].includes(type)) return false;
        const at=Date.parse(m?.created_at||'');
        return Number.isFinite(at) && at>=triggerAt && Boolean(String(m?.text||'').trim());
      });
      if(hasConversationAfterTrigger){
        await db.logAI({chatId,sourceEventId:eventId||null,intent:'GREETING',action:'GREETING_SUPPRESSED',confidence:1,reply:'',reason:'conversation_already_started_after_trigger'});
        return {skipped:'conversation_already_started'};
      }
    }
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
    if(intent==='FORGOT_PASSWORD'){
      const credentials=parseResetCredentialReply(humanAnswer);
      if(!credentials){
        const e=new Error('RESET_REPLY_INCOMPLETE: reply ticket dengan USER ID, PASSWORD, dan LINK LOGIN lengkap.'); e.code='RESET_REPLY_INCOMPLETE'; throw e;
      }
      const finalText=resetCredentialMemberReply(credentials);
      await sendAndStore(livechat,request.chat_id,finalText,intent);
      await db.clearConversationWorkflow(request.chat_id);
      const answered=await db.answerHumanRequest(request.id,{answer:humanAnswer,finalReply:finalText,saveAsKnowledge:false});
      await db.logAI({chatId:request.chat_id,sourceEventId:request.source_event_id,intent,action:'HUMAN_RESET_CREDENTIALS',confidence:1,reply:finalText,reason:`Human Request #${request.id}: exact Telegram reply-to-ticket credentials`});
      return answered;
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
    await db.clearConversationWorkflow(request.chat_id);
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
      const prior=(await db.getConversationWorkflow(request.chat_id))?.workflow_data||{};
      const data=inferResetAccountData(ctx,prior);
      const previousProofUrl=latestProof(ctx)?.url||prior.previousProofUrl||'';
      const deposit=await db.findDepositResponseForBank(data.type||'');
      const intro=await responseText('#RESET_DEPOSIT_DULU','Untuk verifikasi kepemilikan akun, silakan melakukan deposit melalui rekening tujuan di bawah ini ya bosku 🙏 Setelah deposit selesai, kirim bukti transfernya kembali kepada kami agar proses reset password dapat dilanjutkan.');
      const reply=[intro,deposit?.content||''].filter(Boolean).join('\n\n').slice(0,1800);
      await sendAndStore(livechat,request.chat_id,reply,request.intent||'FORGOT_PASSWORD');
      await db.setConversationWorkflow(request.chat_id,{type:'RESET_PASSWORD',state:'WAITING_DEPOSIT',data:{...data,proofUrl:'',previousProofUrl}});
      const answered=await db.answerHumanRequest(request.id,{answer:'ACTION:RESET_DEPOSIT_FIRST',finalReply:reply,saveAsKnowledge:false});
      await db.logAI({chatId:request.chat_id,sourceEventId:request.source_event_id,intent:request.intent,action:'HUMAN_ACTION_RESET_DEPOSIT_FIRST',confidence:1,reply,reason:`Human Request #${request.id} | deposit_response:${deposit?.shortcut||deposit?.title||'fallback'}`});
      return answered;
    }
    if(code==='RESET_DEPOSIT_NOT_IN'){
      const reply=await responseText('#RESET_DP_BELUM_MASUK','Deposit verifikasinya belum terlihat masuk ya bosku 🙏 Mohon cek kembali transfernya. Jika sudah, kirim kembali bukti verifikasi yang terbaru kepada kami.');
      await sendAndStore(livechat,request.chat_id,reply,request.intent||'FORGOT_PASSWORD');
      const ctx=await db.getContext(request.chat_id,40); const data=inferResetAccountData(ctx,{}); const previousProofUrl=latestProof(ctx)?.url||'';
      await db.setConversationWorkflow(request.chat_id,{type:'RESET_PASSWORD',state:'WAITING_DEPOSIT',data:{...data,proofUrl:'',previousProofUrl}});
      const answered=await db.answerHumanRequest(request.id,{answer:'ACTION:RESET_DEPOSIT_NOT_IN',finalReply:reply,saveAsKnowledge:false});
      await db.logAI({chatId:request.chat_id,sourceEventId:request.source_event_id,intent:request.intent,action:'HUMAN_ACTION_RESET_DEPOSIT_NOT_IN',confidence:1,reply,reason:`Human Request #${request.id}`});
      return answered;
    }


    if(code==='DP_DETAIL_PROOF'){
      const reply=await responseText('#DP_DETAIL_PROOF','Silakan dibantu dengan Detail Bukti transfernya ya bosku 😊 Pastikan terlihat jelas waktu transaksi, tanggal transaksi, nominal, dan RRN / nomor referensi. Setelah itu kirim kembali kepada kami ya bosku.');
      await sendAndStore(livechat,request.chat_id,reply,request.intent||'DEPOSIT_PROBLEM');
      const ctx=await db.getContext(request.chat_id,80); const userId=extractUserId(ctx); const previousProofUrl=latestProof(ctx)?.url||'';
      await db.setConversationWorkflow(request.chat_id,{type:'DEPOSIT_VERIFY',state:'WAITING_DETAIL_PROOF',data:{userId,proofUrl:'',previousProofUrl,sourceHumanRequestId:request.id}});
      const answered=await db.answerHumanRequest(request.id,{answer:'ACTION:DP_DETAIL_PROOF',finalReply:reply,saveAsKnowledge:false});
      await db.logAI({chatId:request.chat_id,sourceEventId:request.source_event_id,intent:request.intent,action:'HUMAN_ACTION_DP_DETAIL_PROOF',confidence:1,reply,reason:`Human Request #${request.id}`});
      return answered;
    }
    if(code==='DP_UNCLEAR_PROOF'){
      const reply=await responseText('#DP_UNCLEAR_PROOF','Bukti yang dikirim belum terlihat jelas ya bosku 🙏 Mohon difoto ulang atau screenshot kembali dengan jelas supaya detail transaksinya dapat kami bantu cek.');
      await sendAndStore(livechat,request.chat_id,reply,request.intent||'DEPOSIT_PROBLEM');
      const ctx=await db.getContext(request.chat_id,80); const userId=extractUserId(ctx); const previousProofUrl=latestProof(ctx)?.url||'';
      await db.setConversationWorkflow(request.chat_id,{type:'DEPOSIT_VERIFY',state:'WAITING_CLEAR_PROOF',data:{userId,proofUrl:'',previousProofUrl,sourceHumanRequestId:request.id}});
      const answered=await db.answerHumanRequest(request.id,{answer:'ACTION:DP_UNCLEAR_PROOF',finalReply:reply,saveAsKnowledge:false});
      await db.logAI({chatId:request.chat_id,sourceEventId:request.source_event_id,intent:request.intent,action:'HUMAN_ACTION_DP_UNCLEAR_PROOF',confidence:1,reply,reason:`Human Request #${request.id}`});
      return answered;
    }

    if(code==='BONUS_FREEBET_DONE' || code==='BONUS_FREEBET_NOT_ELIGIBLE'){
      const reply=code==='BONUS_FREEBET_DONE'
        ? await responseText('#BONUS_FREEBET_DONE',FREEBET_DONE_REPLY)
        : await responseText('#BONUS_FREEBET_TIDAK_BISA',FREEBET_NOT_ELIGIBLE_REPLY);
      await sendAndStore(livechat,request.chat_id,reply,request.intent||'BONUS_REQUEST');
      await db.clearConversationWorkflow(request.chat_id);
      const answered=await db.answerHumanRequest(request.id,{answer:`ACTION:${code}`,finalReply:reply,saveAsKnowledge:false});
      await db.logAI({chatId:request.chat_id,sourceEventId:request.source_event_id,intent:request.intent,action:`HUMAN_ACTION_${code}`,confidence:1,reply,reason:`Human Request #${request.id}`});
      return answered;
    }

    const map={
      WD_QUEUE:['#WD_ANTRIAN',WD_PROCESSING_REPLY],
      WD_REQUEST_VALID_ACCOUNT:['#MINTA_REK_VALID','Boleh kirim rekening yang valid ya bosku 🙏 Sertakan jenis rekening, nama pemilik, dan nomor rekening/nomor akun.'],
      WD_DANA_LIMIT:['#DANA_LIMIT',WD_DANA_LIMIT_REPLY],
      BONUS_DONE:['#BONUS_DONE','Bonusnya sudah selesai diproses ya bosku 😊 Silakan cek kembali akun bosku.'],
      BONUS_DEPOSIT_FIRST:['#BONUS_DEPOSIT_DULU','Silakan melakukan deposit terlebih dahulu ya bosku 🙏 Setelah itu kabari kami lagi supaya bisa dibantu cek bonusnya.'],
      DP_PROCESSED:['#DP_PROCESSED','Deposit bosku sudah berhasil kami proses ya 😊🙏\nSilakan dicek kembali pada saldo akun bosku.\n\nTerima kasih dan selamat bermain, semoga beruntung bosku ^^ ❤️'],
      CLEAR_CACHE:['#CLEAR_CACHE','SIlahkan dicoba clear history browser anda kemudian dicoba login kembali ya bosku ☺️\n\nCARA CLEAR CACHE DI HP:\n1️⃣ Buka browser kamu (Chrome, dll)\n2️⃣ Klik titik 3 di pojok kanan atas\n3️⃣ Pilih “Riwayat” atau “History”\n4️⃣ Klik “Hapus data penjelajahan”\n5️⃣ Centang semua (cache, cookies, histori)\n6️⃣ Klik “Hapus Data” atau “Clear”\n\nLOGIN MENGGUNAKAN LINK : https://omtogelxml.com/\n\nContoh Gambar : https://layanancsomtogel.live/CLEARCACHE_OMTOGEL.jpg'],
      DP_NOT_FOUND:['#DP_NOT_FOUND','Depositnya belum terlihat masuk ya bosku 🙏 Boleh tunggu sebentar, nanti kami bantu cek lagi.']
    };
    if(!map[code]) throw new Error('UNKNOWN_HUMAN_ACTION');
    const [shortcut,fallback]=map[code]; const reply=await responseText(shortcut,fallback);
    await sendAndStore(livechat,request.chat_id,reply,request.intent||'GENERAL');
    if(['WD_REQUEST_VALID_ACCOUNT','WD_DANA_LIMIT'].includes(code)){
      await db.setConversationWorkflow(request.chat_id,{type:'WD_REPLACEMENT',state:'WAITING_MEMBER_ACCOUNT',data:{sourceAction:code,humanRequestId:request.id}});
    }else if(code==='WD_QUEUE'){
      await db.setConversationWorkflow(request.chat_id,{type:'WD_STATUS',state:'PENDING',data:{humanRequestId:request.id}});
    }else{
      await db.clearConversationWorkflow(request.chat_id);
    }
    const answered=await db.answerHumanRequest(request.id,{answer:`ACTION:${code}`,finalReply:reply,saveAsKnowledge:false});
    await db.logAI({chatId:request.chat_id,sourceEventId:request.source_event_id,intent:request.intent,action:`HUMAN_ACTION_${code}`,confidence:1,reply,reason:`Human Request #${request.id}`});
    return answered;
  });
}

