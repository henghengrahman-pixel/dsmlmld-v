import { config } from './config.js';
import { normalizeText, detectIntent } from './normalizer.js';
import { OpenAIClient } from './ai.js';
import * as db from './db.js';
import { guardDecision } from './guard.js';
import { greetingText, canAutoGreetFromHistory } from './greeting.js';
import { dispatchHumanRequest } from './human-bridge.js';
import { isTelegramBridgeCategory } from './bridge-category.js';
import { inferResetAccountData, resetMissing, resetAskFor, isDepositConfirmedText } from './reset-logic.js';
import { normalizeBrain, applyBrainGate } from './brain.js';
import { formatImportantForAI } from './important-info.js';
import { extractUserIdFromText, extractClaimUserIdFromText } from './user-id.js';

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
  const known=['harian','new member','newmember','cashback','rollingan','freebet','free bet','slot','livegames','live games','ronda','welcome','reload','deposit','kekalahan'];
  const found=known.find(x=>n.includes(x));
  return found ? found.replace(/newmember/i,'new member').replace(/livegames/i,'live games').toUpperCase() : '';
}
async function resolveBonusLabel(text=''){
  const n=normalizeText(text);
  // Menu Penting is the newest source and supports promo names added by admin without code changes.
  const important=(await db.getRelevantImportantInfo(n,30)).filter(x=>String(x.item_type||'').toUpperCase()==='PROMO');
  if(important.length) return String(important[0].title||important[0].item_key||'').toUpperCase().slice(0,100);
  const promos=await db.listPromoRules({activeOnly:true,limit:200});
  for(const p of promos){
    const keys=[p.name,...(Array.isArray(p.keywords)?p.keywords:[])].map(x=>normalizeText(x)).filter(Boolean);
    if(keys.some(k=>k && (n.includes(k) || k.split(' ').filter(Boolean).every(part=>n.includes(part))))) return String(p.name||'').toUpperCase();
  }
  const direct=pickBonusLabel(text);
  if(direct) return direct;
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
  const label=(title||shortcut).replace(/(response|template|claim|klaim)/ig,'').trim();
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
async function makeHumanRequest({chatId,eventId,intent,text,question,holding='',livechat,telegram=true}){
  const req=await db.createHumanRequest({chatId,sourceEventId:eventId,intent,memberMessage:text,question});
  if(telegram) await dispatchHumanRequest(req);
  if(holding) await sendAndStore(livechat,chatId,holding,intent);
  return {intent,humanRequestId:req.id,sent:Boolean(holding),waitingHuman:true,telegram:Boolean(telegram)};
}
async function maybeHandleOperationalFlow({chatId,eventId,text,intent,livechat}){
  const wf=await db.getConversationWorkflow(chatId);
  const ctx=await getOperationalHistory(chatId);
  const effective=String(intent||'GENERAL').toUpperCase();

  // v1.17 deterministic Menu Penting answers: current admin data wins and AI is not allowed to invent missing facts.
  if(['LINK_ACCESS','RTP_INFO','PREDIKSI_TOGEL'].includes(effective)){
    const wanted={LINK_ACCESS:'LINK',RTP_INFO:'RTP',PREDIKSI_TOGEL:'PREDIKSI_TOGEL'}[effective];
    const rows=(await db.getRelevantImportantInfo(text,20)).filter(x=>String(x.item_type||'').toUpperCase()===wanted);
    if(rows.length){
      const best=rows[0];
      const reply=String(best.content||'').trim().slice(0,1800);
      if(reply){await sendAndStore(livechat,chatId,reply,effective);return {intent:effective,sent:true,reply,source:`IMPORTANT_${wanted}`,importantId:best.id};}
    }
    return makeHumanRequest({chatId,eventId,intent:effective,text,livechat,telegram:false,holding:'',question:`Data ${wanted} yang aktif belum ditemukan di Menu Penting. Tolong beri jawaban resmi untuk member.`});
  }

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
  if(['DEPOSIT_PROBLEM','DEPOSIT_REQUEST'].includes(effective) || wf?.workflow_type==='DEPOSIT_VERIFY'){
    const workflowAskedForId = wf?.workflow_type==='DEPOSIT_VERIFY' && !wf?.workflow_data?.userId;
    const userId=extractUserId(ctx) || (workflowAskedForId ? extractStandaloneRequestedUserId(ctx) : '');
    const proof=latestProof(ctx);
    const mustBeNewProof=['WAITING_DETAIL_PROOF','WAITING_CLEAR_PROOF'].includes(String(wf?.workflow_state||''));
    const proofIsNew=Boolean(proof?.url && (!mustBeNewProof || proof.url!==wf?.workflow_data?.previousProofUrl));
    const data={...(wf?.workflow_data||{}),userId:userId||wf?.workflow_data?.userId||'',proofUrl:proofIsNew?proof.url:(mustBeNewProof?'':(wf?.workflow_data?.proofUrl||''))};
    const missing=[]; if(!data.userId)missing.push('user ID'); if(!data.proofUrl)missing.push('bukti transfer');
    if(missing.length){
      const reply=missing.length===2?'Boleh kirim user ID sama bukti transfernya ya bosku 🙏 Biar kami bantu cek depositnya.':missing[0]==='user ID'?'Boleh kirim user ID-nya ya bosku 🙏 Bukti transfernya sudah kami terima.':'Boleh kirim bukti transfernya ya bosku 🙏 User ID-nya sudah kami terima.';
      return askAndTrack(livechat,chatId,'DEPOSIT_PROBLEM','DEPOSIT_VERIFY','COLLECTING',data,reply);
    }
    await db.clearConversationWorkflow(chatId);
    return makeHumanRequest({
      chatId,eventId,intent:'DEPOSIT_PROBLEM',text,livechat,telegram:true,holding:WAITING_CHECK_REPLY,
      question:`💰 DEPOSIT PROBLEM

User ID : ${data.userId}

Bukti transfer ikut terlampir.
Silakan cek deposit member.`
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
      const proof=latestProof(ctx);
      const proofIsNew=Boolean(proof?.url && proof.url!==prev.previousProofUrl);
      const merged={...data,proofUrl:proofIsNew?proof.url:(prev.proofUrl||'')};
      await db.setConversationWorkflow(chatId,{type:'RESET_PASSWORD',state:'WAITING_DEPOSIT',data:merged});
      const depositConfirmed=isDepositConfirmedText(text) || proofIsNew;
      if(depositConfirmed && !merged.proofUrl){
        return askAndTrack(livechat,chatId,'FORGOT_PASSWORD','RESET_PASSWORD','WAITING_DEPOSIT_PROOF',merged,'Boleh kirim bukti deposit verifikasinya ya bosku 🙏 Setelah bukti kami terima, langsung kami lanjutkan pengecekan reset password.');
      }
      if(depositConfirmed && merged.proofUrl){
        return makeHumanRequest({
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
LINK`
        });
      }
      return {intent:'FORGOT_PASSWORD',workflow:'RESET_PASSWORD',state:'WAITING_DEPOSIT',sent:false,waitingDeposit:true};
    }
    if(wf?.workflow_type==='RESET_PASSWORD' && wf?.workflow_state==='WAITING_DEPOSIT_PROOF'){
      const proof=latestProof(ctx);
      const merged={...data,proofUrl:proof?.url||prev.proofUrl||''};
      if(!merged.proofUrl){
        return askAndTrack(livechat,chatId,'FORGOT_PASSWORD','RESET_PASSWORD','WAITING_DEPOSIT_PROOF',merged,'Boleh kirim bukti deposit verifikasinya ya bosku 🙏');
      }
      return makeHumanRequest({
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
LINK`
      });
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
  if(['WITHDRAW_PROBLEM','WITHDRAW_REQUEST'].includes(effective)){
    const uid=extractUserIdFromText(text) || extractUserId(ctx) || (wf?.workflow_type==='WD_CHECK' && wf?.workflow_state==='WAITING_ID' ? extractStandaloneRequestedUserId(ctx) : '');
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
    // The member is answering our previous ID question. A bare token such as HOKII123456
    // is a valid answer here and must not trigger the same question again.
    const uid=extractUserIdFromText(text) || extractUserId(ctx) || extractStandaloneRequestedUserId(ctx);
    if(!uid) return askAndTrack(livechat,chatId,'WITHDRAW_PROBLEM','WD_CHECK','WAITING_ID',{},'Boleh kirim ID akunnya ya bosku 🙏');
    await db.clearConversationWorkflow(chatId);
    return makeHumanRequest({
      chatId,eventId,intent:'WITHDRAW_PROBLEM',text,livechat,telegram:true,
      holding:WD_PROCESSING_REPLY,
      question:`ID : ${uid}\n\ncek kepastian wd`
    });
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
    if(!bonusType){
      return askAndTrack(livechat,chatId,'BONUS_REQUEST','BONUS_CLAIM','ASK_TYPE',{},await responseText('#BONUS_TANYA','Bonus apa yang mau diklaim ya bosku? 😊'));
    }
  }
  if(wf?.workflow_type==='BONUS_CLAIM' && wf?.workflow_state==='ASK_TYPE'){
    const bonusType=await resolveBonusLabel(text) || String(text||'').trim().slice(0,120);
    const uid=extractUserIdFromText(text) || extractClaimUserIdFromText(text) || extractUserId(ctx);
    if(!uid) return askAndTrack(livechat,chatId,'BONUS_REQUEST','BONUS_CLAIM','WAITING_ID',{bonusType},'Boleh kirim ID akunnya ya bosku 🙏');
    await db.clearConversationWorkflow(chatId);
    return makeHumanRequest({chatId,eventId,intent:'BONUS_REQUEST',text,livechat,telegram:true,holding:WAITING_CHECK_REPLY,question:`ID : ${uid}\n\nclaim bonus ${String(bonusType).toLowerCase()}`});
  }
  if(wf?.workflow_type==='BONUS_CLAIM' && wf?.workflow_state==='WAITING_ID'){
    const uid=extractUserIdFromText(text) || extractClaimUserIdFromText(text) || extractUserId(ctx) || extractStandaloneRequestedUserId(ctx);
    const bonusType=String(wf?.workflow_data?.bonusType||'bonus').trim();
    if(!uid) return askAndTrack(livechat,chatId,'BONUS_REQUEST','BONUS_CLAIM','WAITING_ID',{bonusType},'Boleh kirim ID akunnya ya bosku 🙏');
    await db.clearConversationWorkflow(chatId);
    return makeHumanRequest({chatId,eventId,intent:'BONUS_REQUEST',text,livechat,telegram:true,holding:WAITING_CHECK_REPLY,question:`ID : ${uid}\n\nclaim bonus ${String(bonusType).toLowerCase()}`});
  }

  // Specific bonus (contoh: bonus harian). Pastikan ID ada sebelum lempar ke grup Bonus.
  if(effective.includes('BONUS')){
    const bonusType=await resolveBonusLabel(text) || effective.replace(/^BONUS_?/,'').replaceAll('_',' ');
    const uid=extractUserIdFromText(text) || extractClaimUserIdFromText(text) || extractUserId(ctx);
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
function parseResetCredentialReply(text=''){
  const s=String(text||'').trim();
  if(!s) return null;
  const user=(s.match(/(?:user\s*id|userid|username)\s*[:=]\s*([^\n]{2,120})/i)||[])[1]?.trim()||'';
  const password=(s.match(/(?:password|psw|pass)\s*[:=]\s*([^\n]{2,160})/i)||[])[1]?.trim()||'';
  const labelledLink=(s.match(/(?:link(?:\s*login)?)\s*[:=]\s*(https?:\/\/\S+)/i)||[])[1]?.trim()||'';
  const anyLink=(s.match(/https?:\/\/\S+/i)||[])[0]?.trim()||'';
  const link=labelledLink||anyLink;
  // Reset credentials are sensitive. Require the complete triplet so an ordinary
  // two-line CS comment can never be mistaken for UserID + Password.
  if(user && password && link) return {userId:user,password,link};
  // Normal CS shorthand: line 1 = USER ID, line 2 = PASSWORD, line 3 = LOGIN LINK.
  const lines=s.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  if(lines.length>=3 && !/^(?:done|belum|pending)$/i.test(lines[0])){
    const possibleLink=lines.find((x,i)=>i>=2 && /^https?:\/\//i.test(x))||'';
    if(possibleLink && lines[0].length<=120 && lines[1].length<=160) return {userId:lines[0],password:lines[1],link:possibleLink};
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
    '',
    'Silakan login kembali menggunakan data tersebut ya bosku.'
  ].filter((x,i,a)=>x!=='' || (i>0 && a[i-1]!=='' )).join('\n').trim();
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
  const learning=learningRows.map(r=>`[BELAJAR ${r.source_type}] [${r.intent}] Member: ${r.member_text} => Jawaban benar: ${r.correction_text||r.response_text}${r.context_snapshot?` | Konteks: ${String(r.context_snapshot).slice(0,500)}`:''}`).join('\n');
  const csStyleExamples=styleRows.map(r=>`- ${String(r.response_text||'').trim()}`).filter(Boolean).join('\n').slice(0,9000);
  const historyLearning=historyRows.map(r=>`[${r.intent}] Member: ${r.sample_member||'-'} => Pola CS: ${r.sample_response} (dipakai ${r.occurrences}x)`).join('\n').slice(0,10000);
  const attachments=recentRows.filter(m=>m.sender_type==='customer').slice(-10).flatMap(m=>Array.isArray(m.attachments)?m.attachments:[]).filter(a=>a?.isImage).slice(-3);
  const brainRow=await db.getConversationBrain(chatId);
  const caseBrain=normalizeBrain(brainRow?.case_brain||{},intent);
  return {context,rules,knowledge:[importantKnowledge,promoKnowledge,manualKnowledge,responses,learning].filter(Boolean).join('\n'),hasKnowledge:Boolean(importantKnowledge||promoKnowledge||manualKnowledge||responses||learning),attachments,conversationDigest:digest,csStyleExamples,historyLearning,totalMessages:total,caseBrain,digestCovered:digested,digestTarget:target,importantRows};
}

export async function processCustomerMessage({chatId,eventId,text,createdAt,livechat,attachments=[],reprocessExisting=false}) {
  const beforeState=await db.getConversationState(chatId);
  const wasNew=Number(beforeState?.message_count||0)===0;
  const normalized=normalizeText(text); const intent=detectIntent(text);
  const inserted=await db.insertMessage({chatId,eventId,senderType:'customer',text,normalizedText:normalized,intent,createdAt,authorId:'',attachments});
  if (!inserted && !reprocessExisting) return {skipped:'duplicate'};

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
      let decision=await ai.classifyAndReply({normalized,intent,context:src.context,rules:src.rules,knowledge:src.knowledge,attachments:aiAttachments,style,conversationDigest:src.conversationDigest,csStyleExamples:src.csStyleExamples,historyLearning:src.historyLearning,caseBrain:src.caseBrain});
      const updatedBrain=normalizeBrain({...decision.brain,understanding:decision.understanding||decision.brain?.understanding},intent);
      await db.saveConversationBrain(chatId,updatedBrain,src.totalMessages);
      decision=applyBrainGate({intent,decision,brain:updatedBrain,hasKnowledge:src.hasKnowledge});
      if (decision.confidence < config.aiConfidence && !['ASK_INFO'].includes(decision.action)) { decision.action='ASK_HUMAN'; decision.reply=''; decision.reason=`low_confidence:${decision.reason||''}`; }
      if(['AUTO_REPLY','ASK_INFO'].includes(decision.action)) decision=guardDecision({intent,decision,hasKnowledge:src.hasKnowledge});

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
            return makeHumanRequest({chatId,eventId,intent:'DEPOSIT_PROBLEM',text,livechat,telegram:true,holding:WAITING_CHECK_REPLY,question:`💰 DEPOSIT PROBLEM

User ID : ${data.userId}

Bukti transfer ikut terlampir.
Silakan cek deposit member.`});
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



export async function processGreetingTrigger({chatId,eventId,text,createdAt,livechat}){
  return db.withChatLock(chatId, async()=>{
    if (await db.isHumanTakeover(chatId)) return {skipped:'human_takeover'};
    const systemEnabled=Boolean(await db.getSetting('system_enabled',true));
    if(!systemEnabled) return {skipped:'system_off'};
    const auto=Boolean(await db.getSetting('auto_reply',config.autoReplyDefault));
    if(!auto) return {skipped:'auto_reply_off'};
    const greetingEnabled=Boolean(await db.getSetting('greeting_enabled',config.greetingEnabled));
    if(!greetingEnabled) return {skipped:'greeting_off'};

    // Never greet in the middle of an existing conversation. This matters when
    // LIVECHAT AI is enabled after staff already handled the member, or when the
    // automatic promo/welcome message fires again in an old chat. In that case
    // we consume the greeting flag silently so the same old chat cannot trigger
    // a greeting later.
    const priorContext=await db.getContext(chatId,200);
    if(!canAutoGreetFromHistory(priorContext,eventId)){
      await db.claimGreeting(chatId,{onlyIfNew:false});
      await db.logAI({chatId,sourceEventId:eventId||null,intent:'GREETING',action:'GREETING_SUPPRESSED',confidence:1,reply:'',reason:'existing_conversation_history'});
      return {skipped:'existing_conversation_history'};
    }

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

