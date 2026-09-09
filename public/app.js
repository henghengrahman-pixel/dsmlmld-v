const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(url,opt={}){const r=await fetch(url,{headers:{'Content-Type':'application/json',...(opt.headers||{})},...opt});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||`HTTP_${r.status}`);return d}
let currentChat=null,currentTitle='',currentChatMode='AI',liveUiBusy=false,liveUiTimer=null,cannedCache=[],editingResponseId=null;
const humanDrafts=new Map(), humanLearnDrafts=new Map();
async function boot(){const me=await api('/api/me');if(!me.ok){$('#login').classList.remove('hidden');return}$('#app').classList.remove('hidden');await Promise.all([loadStatus(),loadChats(),loadRules(),loadKb(),loadCanned(),loadHuman(),loadBridge(),loadLearning(),loadLogs()]);startLiveUi()}
$('#loginBtn').onclick=async()=>{try{await api('/api/login',{method:'POST',body:JSON.stringify({username:$('#u').value,password:$('#p').value})});location.reload()}catch(e){$('#loginErr').textContent='Login gagal'}};
$('#logoutBtn').onclick=async()=>{await api('/api/logout',{method:'POST'});location.reload()};
$$('nav [data-tab]').forEach(b=>b.onclick=()=>{$$('nav [data-tab]').forEach(x=>x.classList.toggle('active',x===b));$$('.tab').forEach(x=>x.classList.remove('active'));$('#tab-'+b.dataset.tab).classList.add('active');if(b.dataset.tab==='human')loadHuman();if(b.dataset.tab==='bridge')loadBridge();if(b.dataset.tab==='responses')loadCanned();if(b.dataset.tab==='learning')loadLearning()});
async function loadStatus(){const d=await api('/api/status');$('#sDb').textContent=d.db?'CONNECTED':'ERROR';$('#sDb').className=d.db?'ok':'bad';$('#sLc').textContent=d.livechatConfigured?'READY':'MISSING';$('#sAi').textContent=d.openaiConfigured?'READY':'MISSING';$('#sPoll').textContent=d.poller?.paused?'PAUSED':(d.poller?.running?'SYNCING':(d.poller?.lastTick?'ACTIVE':'STARTING'));$('#systemEnabled').checked=d.systemEnabled;$('#greetingEnabled').checked=d.greetingEnabled;$('#humanAskEnabled').checked=d.humanAskEnabled;$('#timezone').textContent=d.timezone||'-';$('#model').textContent=d.model||'-';const st=d.replyStyle||{};if($('#replyStyle'))$('#replyStyle').value=st.replyStyle||'NATURAL_CS';if($('#replyLength'))$('#replyLength').value=st.replyLength||'SHORT';if($('#boskuUsage'))$('#boskuUsage').value=st.boskuUsage||'MODERATE';if($('#emojiUsage'))$('#emojiUsage').value=st.emojiUsage||'LIGHT';if($('#formalLanguage'))$('#formalLanguage').checked=Boolean(st.formalLanguage);if($('#replyStyleNote'))$('#replyStyleNote').value=st.replyStyleNote||'';$('#warnings').textContent=(d.warnings||[]).join(' · ')||'Tidak ada warning.'}
$('#systemEnabled').onchange=async e=>{const wanted=e.target.checked;try{await api('/api/settings/system-enabled',{method:'POST',body:JSON.stringify({enabled:wanted})});await loadStatus();}catch(err){e.target.checked=!wanted;alert(err.message)}};
$('#greetingEnabled').onchange=async e=>api('/api/settings/greeting',{method:'POST',body:JSON.stringify({enabled:e.target.checked})});
$('#humanAskEnabled').onchange=async e=>api('/api/settings/human-ask',{method:'POST',body:JSON.stringify({enabled:e.target.checked})});
$('#saveReplyStyle').onclick=async()=>{const btn=$('#saveReplyStyle'),msg=$('#replyStyleSaved');btn.disabled=true;msg.textContent='Menyimpan...';try{const d=await api('/api/settings/reply-style',{method:'PUT',body:JSON.stringify({replyStyle:$('#replyStyle').value,replyLength:$('#replyLength').value,boskuUsage:$('#boskuUsage').value,emojiUsage:$('#emojiUsage').value,formalLanguage:$('#formalLanguage').checked,replyStyleNote:$('#replyStyleNote').value})});msg.textContent='Gaya bahasa tersimpan. Balasan berikutnya langsung memakai setting ini.';setTimeout(()=>{msg.textContent=''},3500)}catch(e){msg.textContent='ERROR: '+e.message}finally{btn.disabled=false}};
function testBtn(sel,url){$(sel).onclick=async()=>{const out=$('#testOut');out.textContent='Testing...';try{out.textContent=JSON.stringify(await api(url,{method:'POST'}),null,2)}catch(e){out.textContent='ERROR: '+e.message}}}
testBtn('#testLc','/api/test/livechat');testBtn('#testAi','/api/test/openai');testBtn('#testSync','/api/test/sync');testBtn('#testDetail','/api/test/chat-detail');
$('#testTypo').onclick=async()=>{$('#typoOut').textContent=JSON.stringify(await api('/api/test/typo',{method:'POST',body:JSON.stringify({text:$('#typoText').value})}),null,2)};
async function loadChats(){
  const d=await api('/api/conversations');
  const active=d.items.find(x=>x.chat_id===currentChat);
  if(active){currentChatMode=active.handling_mode==='HUMAN'?'HUMAN':'AI';renderChatMode();$('#typingState').textContent=active.member_typing?'Member sedang mengetik…':''}
  $('#chatList').innerHTML=d.items.map(x=>{const human=x.handling_mode==='HUMAN';const typing=x.member_typing?'<span class="typing">sedang mengetik…</span>':'';const wf=x.workflow_state?` · ${esc(x.workflow_state)}`:'';return `<div class="chatitem" data-id="${esc(x.chat_id)}" data-mode="${human?'HUMAN':'AI'}"><b>${esc(x.customer_name||x.chat_id)}</b><small>${esc(x.customer_email||'')} · ${human?'HUMAN TAKEOVER':'AI ACTIVE'}${wf}</small>${typing}</div>`}).join('')||'<div class="chatitem">Belum ada chat aktif.</div>';
  $$('.chatitem[data-id]').forEach(el=>el.onclick=()=>{currentChatMode=el.dataset.mode||'AI';openChat(el.dataset.id,el.querySelector('b')?.textContent||el.dataset.id)})
}
async function openChat(id,title,auto=false){
  currentChat=id;currentTitle=title||currentTitle;$('#chatTitle').textContent=currentTitle;renderChatMode();
  const box=$('#messages'),near=(box.scrollHeight-box.scrollTop-box.clientHeight)<120;
  const d=await api('/api/conversations/'+encodeURIComponent(id));
  const html=d.items.map(m=>{
    const at=Array.isArray(m.attachments)?m.attachments:[];
    const media=at.map(a=>a.isImage&&a.url?`<a href="${esc(a.url)}" target="_blank" rel="noreferrer"><img class="chatimg" src="${esc(a.url)}" alt="attachment"></a>`:(a.url?`<a href="${esc(a.url)}" target="_blank" rel="noreferrer">Lihat file</a>`:'')).join('');
    const feedback=m.sender_type==='ai'&&m.event_id?`<button class="feedbackBtn" data-feedback="${esc(m.event_id)}">Tegur AI</button>`:'';
    const type=String(m.sender_type||'unknown');
    const label=type==='customer'?(currentTitle||'Member'):type==='ai'?'CS':type==='agent'?'CS':'System';
    const ts=m.created_at?new Date(m.created_at).toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'}):'';
    return `<div class="msgrow ${esc(type)}"><div class="msg ${esc(type)}"><div class="who">${esc(label)}</div><div class="msgbody">${esc(m.text)}</div>${media?`<div class="attachments">${media}</div>`:''}${feedback}${ts?`<div class="msgtime">${esc(ts)}</div>`:''}</div></div>`;
  }).join('');
  if(box.innerHTML!==html){
    box.innerHTML=html;
    $$('[data-feedback]').forEach(b=>b.onclick=async()=>{const correction=prompt('Tulis jawaban/perilaku yang benar untuk kasus ini. Teguran akan langsung dipakai AI ke depannya:');if(!correction?.trim())return;try{await api('/api/conversations/'+encodeURIComponent(currentChat)+'/feedback',{method:'POST',body:JSON.stringify({eventId:b.dataset.feedback,correction:correction.trim()})});alert('Teguran tersimpan dan langsung aktif.');await loadLearning()}catch(e){alert(e.message)}})
  }
  if(!auto||near)box.scrollTop=box.scrollHeight
}
function renderChatMode(){const human=currentChatMode==='HUMAN';$('#takeoverBtn').disabled=human;$('#enableAiBtn').disabled=!human;$('#manualText').disabled=!human;$('#sendManual').disabled=!human;$('#manualText').placeholder=human?'Balas manual sebagai human...':'Klik Take Over untuk balas manual';$('#chatMode').textContent=human?'HUMAN TAKEOVER':'AI ACTIVE';$('#chatMode').className=human?'pill warnpill':'pill okpill'}
$('#refreshChats').onclick=loadChats;
$('#takeoverBtn').onclick=async()=>{if(currentChat){await api(`/api/conversations/${encodeURIComponent(currentChat)}/takeover`,{method:'POST'});currentChatMode='HUMAN';renderChatMode();await loadChats();$('#manualText').focus()}};
$('#enableAiBtn').onclick=async()=>{if(currentChat){await api(`/api/conversations/${encodeURIComponent(currentChat)}/enable-ai`,{method:'POST'});currentChatMode='AI';renderChatMode();await loadChats()}};
async function sendManualMessage(){const t=$('#manualText').value.trim();if(!currentChat||!t)return;if(currentChatMode!=='HUMAN')return alert('Klik Take Over terlebih dahulu agar AI berhenti.');const b=$('#sendManual');b.disabled=true;try{await api(`/api/conversations/${encodeURIComponent(currentChat)}/send`,{method:'POST',body:JSON.stringify({text:t})});$('#manualText').value='';$('#manualText').style.height='auto';await openChat(currentChat,currentTitle)}catch(e){alert(e.message)}finally{b.disabled=false}}
$('#sendManual').onclick=sendManualMessage;
$('#manualText').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendManualMessage()}});
$('#manualText').addEventListener('input',e=>{e.target.style.height='auto';e.target.style.height=Math.min(140,e.target.scrollHeight)+'px'});

function humanActionButtons(x){
  const intent=String(x.intent||'GENERAL').toUpperCase();
  if(intent==='FORGOT_PASSWORD'){
    const q=String(x.ai_question||'').toLowerCase();
    if(q.includes('member sudah deposit')) return `<button class="quickaction" data-hact="RESET_DEPOSIT_NOT_IN" data-hid="${x.id}">DANA Belum Masuk</button>`;
    return `<button class="quickaction" data-hact="RESET_DEPOSIT_FIRST" data-hid="${x.id}">Suruh Deposit Dahulu</button><button class="quickaction" data-hact="RESET_NOT_REGISTERED" data-hid="${x.id}">Rekening Tidak Terdaftar</button>`;
  }
  if(intent==='WITHDRAW_PROBLEM') return `<button class="quickaction" data-hact="WD_QUEUE" data-hid="${x.id}">WD Sedang Dalam Antrian</button><button class="quickaction" data-hact="WD_REQUEST_VALID_ACCOUNT" data-hid="${x.id}">Minta Rek Valid</button><button class="quickaction" data-hact="WD_DANA_LIMIT" data-hid="${x.id}">DANA Limit</button>`;
  if(intent==='DEPOSIT_PROBLEM') return `<button class="quickaction" data-hact="DP_PROCESSED" data-hid="${x.id}">DP MASUK</button><button class="quickaction" data-hact="DP_NOT_FOUND" data-hid="${x.id}">DP BELUM MASUK</button>`;
  if(intent.includes('BONUS')) return `<button class="quickaction" data-hact="BONUS_DONE" data-hid="${x.id}">DONE</button><button class="quickaction" data-hact="BONUS_DEPOSIT_FIRST" data-hid="${x.id}">Silakan Deposit Dahulu</button>`;
  return '';
}
async function loadHuman(){
  // Preserve what staff is typing. Auto refresh must never erase drafts.
  $$('#humanList textarea[id^="ha-"]').forEach(t=>humanDrafts.set(t.id.slice(3),t.value));
  $$('#humanList input[id^="learn-"]').forEach(c=>humanLearnDrafts.set(c.id.slice(6),c.checked));
  const focused=document.activeElement?.id||'';
  const d=await api('/api/human-requests?status=OPEN');$('#humanBadge').textContent=d.items.length;
  $('#humanList').innerHTML=d.items.map(x=>`<div class="request" data-human-card="${x.id}"><div class="requesthead"><div><b>${esc(x.customer_name||x.chat_id)}</b><span class="pill">${esc(x.intent||'GENERAL')}</span></div><small>${new Date(x.created_at).toLocaleString()}</small></div><div class="requestbody"><b>Member</b><p>${esc(x.member_message)}</p><b>AI bertanya ke staff</b><p>${esc(x.ai_question)}</p>${humanActionButtons(x)?`<div class="quickactions">${humanActionButtons(x)}</div>`:''}<textarea id="ha-${x.id}" rows="3" placeholder="Tulis data/instruksi untuk AI. Untuk reset, reply bisa berisi User ID dan Password.">${esc(humanDrafts.get(String(x.id))||'')}</textarea><label class="savelearn"><input type="checkbox" id="learn-${x.id}" ${humanLearnDrafts.get(String(x.id))?'checked':''}> Simpan jawaban ini sebagai knowledge untuk kasus berikutnya</label><div class="row"><button data-answer="${x.id}">Kirim ke AI & Balas Member</button><button data-telegram="${x.id}">Kirim ke Telegram</button><button class="ghostbtn" data-cancel="${x.id}">Batalkan</button></div></div></div>`).join('')||'<div class="panel">Tidak ada pertanyaan AI ke staff.</div>';
  $$('#humanList textarea[id^="ha-"]').forEach(t=>t.addEventListener('input',()=>humanDrafts.set(t.id.slice(3),t.value)));
  $$('#humanList input[id^="learn-"]').forEach(c=>c.addEventListener('change',()=>humanLearnDrafts.set(c.id.slice(6),c.checked)));
  if(focused&&document.getElementById(focused)){const el=document.getElementById(focused);el.focus();if(el.tagName==='TEXTAREA')el.selectionStart=el.selectionEnd=el.value.length}
  $$('[data-answer]').forEach(b=>b.onclick=async()=>{const id=b.dataset.answer,answer=$('#ha-'+id).value.trim();if(!answer)return alert('Isi jawaban staff dulu.');b.disabled=true;try{await api('/api/human-requests/'+id+'/answer',{method:'POST',body:JSON.stringify({answer,saveAsKnowledge:$('#learn-'+id).checked})});humanDrafts.delete(String(id));humanLearnDrafts.delete(String(id));await Promise.all([loadHuman(),loadChats(),loadLogs()])}catch(e){alert(e.message)}finally{b.disabled=false}});
  $$('[data-hact]').forEach(b=>b.onclick=async()=>{const id=b.dataset.hid,action=b.dataset.hact;if(!confirm('Jalankan tindakan ini dan kirim balasan ke member?'))return;b.disabled=true;try{await api('/api/human-requests/'+id+'/action',{method:'POST',body:JSON.stringify({action})});humanDrafts.delete(String(id));humanLearnDrafts.delete(String(id));await Promise.all([loadHuman(),loadChats(),loadLogs()])}catch(e){alert(e.message)}finally{b.disabled=false}});
  $$('[data-telegram]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{const d=await api('/api/human-bridge/requests/'+b.dataset.telegram+'/send',{method:'POST'});alert(d.ok?'Ticket dikirim ke Telegram.':('Belum terkirim: '+(d.error||d.skipped||'unknown')));await loadBridge()}catch(e){alert(e.message)}finally{b.disabled=false}});
  $$('[data-cancel]').forEach(b=>b.onclick=async()=>{const id=b.dataset.cancel;await api('/api/human-requests/'+id+'/cancel',{method:'POST'});humanDrafts.delete(String(id));humanLearnDrafts.delete(String(id));loadHuman()})
}
$('#refreshHuman').onclick=loadHuman;
function parseBulk(txt){const chunks=String(txt||'').trim().split(/\n\s*\n+/);const out=[];for(const c of chunks){const lines=c.split(/\n/).map(x=>x.trim()).filter(Boolean);if(!lines.length)continue;let shortcut='';if(lines[0].startsWith('#'))shortcut=lines.shift();const content=lines.join('\n').trim();if(content)out.push({shortcut,title:shortcut||'Imported Response',category:'GENERAL',content,tags:[],mode:'FLEXIBLE'})}return out}
async function loadCanned(){const d=await api('/api/canned');cannedCache=d.items||[];renderCanned()}
function resetResponseForm(){editingResponseId=null;$('#respShortcut').value='';$('#respTitle').value='';$('#respCategory').value='GENERAL';$('#respMode').value='FLEXIBLE';$('#respTags').value='';$('#respContent').value='';$('#addResponse').textContent='Simpan Response';$('#cancelResponseEdit').classList.add('hidden')}
function startEditResponse(id){const x=cannedCache.find(r=>r.source_id===id);if(!x)return;editingResponseId=id;$('#respShortcut').value=x.shortcut||'';$('#respTitle').value=x.title||'';$('#respCategory').value=x.category||'GENERAL';$('#respMode').value=x.response_mode||'FLEXIBLE';$('#respTags').value=Array.isArray(x.tags)?x.tags.join(', '):'';$('#respContent').value=x.content||'';$('#addResponse').textContent='Update Response';$('#cancelResponseEdit').classList.remove('hidden');$('#respShortcut').scrollIntoView({behavior:'smooth',block:'center'})}
function renderCanned(){const q=String($('#cannedSearch')?.value||'').toLowerCase();const rows=cannedCache.filter(x=>!q||`${x.shortcut||''} ${x.title||''} ${x.category||''} ${x.content||''}`.toLowerCase().includes(q));$('#cannedList').innerHTML=rows.map(x=>`<div class="tr responseRow"><span class="pill">${esc(x.shortcut||'RESPONSE')}</span><b>${esc(x.category||'GENERAL')} · ${esc(x.response_mode||'FLEXIBLE')}</b><span><strong>${esc(x.title||'')}</strong><br>${esc(x.content)}</span>${x.source_kind==='manual'?`<div class="row"><button data-editresp="${esc(x.source_id)}">Edit</button><button data-delresp="${esc(x.source_id)}">Hapus</button></div>`:'<span>API</span>'}</div>`).join('')||'<div class="tr">Belum ada response. Tambahkan manual dari LiveChat Responses.</div>';$$('[data-editresp]').forEach(b=>b.onclick=()=>startEditResponse(b.dataset.editresp));$$('[data-delresp]').forEach(b=>b.onclick=async()=>{if(confirm('Hapus response ini?')){await api('/api/canned/manual/'+encodeURIComponent(b.dataset.delresp),{method:'DELETE'});if(editingResponseId===b.dataset.delresp)resetResponseForm();loadCanned()}})}
$('#addResponse').onclick=async()=>{const content=$('#respContent').value.trim();if(!content)return alert('Isi response wajib diisi.');const payload={shortcut:$('#respShortcut').value,title:$('#respTitle').value,category:$('#respCategory').value,mode:$('#respMode').value,tags:$('#respTags').value.split(',').map(x=>x.trim()).filter(Boolean),content};if(editingResponseId)await api('/api/canned/manual/'+encodeURIComponent(editingResponseId),{method:'PUT',body:JSON.stringify(payload)});else await api('/api/canned/manual',{method:'POST',body:JSON.stringify(payload)});resetResponseForm();await loadCanned()};
$('#cancelResponseEdit').onclick=resetResponseForm;
$('#importResponses').onclick=async()=>{const items=parseBulk($('#bulkResponses').value);if(!items.length)return alert('Format import belum terbaca.');const d=await api('/api/canned/import',{method:'POST',body:JSON.stringify({items})});$('#importResult').textContent=`${d.created} response berhasil diimport`;$('#bulkResponses').value='';loadCanned()};$('#refreshCanned').onclick=loadCanned;$('#cannedSearch').oninput=renderCanned;

const bridgeFieldMap={
  RESET_PASSWORD:['#route-reset-chat','#route-reset-topic'],
  WD_PROBLEM:['#route-wd-chat','#route-wd-topic'],
  DEPOSIT_PROBLEM:['#route-deposit-chat','#route-deposit-topic'],
  BONUS:['#route-bonus-chat','#route-bonus-topic'],
  ISSUE:['#route-issue-chat','#route-issue-topic']
};
function bridgePayload(){const routes={};for(const [k,[c,t]] of Object.entries(bridgeFieldMap))routes[k]={chatId:$(c).value.trim(),topicId:$(t).value.trim()};return{botToken:$('#tgBotToken').value.trim(),defaultChatId:$('#tgDefaultChat').value.trim(),routes}}
async function loadBridge(){
  const [d,t]=await Promise.all([api('/api/human-bridge/settings'),api('/api/human-bridge/tickets')]);
  $('#bridgeEnabled').checked=Boolean(d.enabled);$('#tgDefaultChat').value=d.defaultChatId||'';$('#tgBotToken').value='';$('#tgBotToken').placeholder=d.configured?`Tersimpan: ${d.botTokenMasked||'••••••••'} — kosongkan jika tidak ganti`:'Isi Bot Token Telegram';
  $('#tgBotStatus').textContent=d.configured?`@${d.botUsername||d.status?.botUsername||'-'} · ${d.enabled?'ENABLED':'DISABLED'} · ${d.status?.running?'poller aktif':'poller standby'}`:'Belum dikonfigurasi';
  for(const [k,[c,tp]] of Object.entries(bridgeFieldMap)){const r=d.routes?.[k]||{};$(c).value=r.chatId||'';$(tp).value=r.topicId||'';}
  $('#bridgeTickets').innerHTML=(t.items||[]).map(x=>`<div class="tr"><span class="pill">${esc(x.ticket_code)}</span><b>${esc(x.category)}</b><span>${esc(x.customer_name||x.chat_id)}<br><small>${esc(x.status)} · TG ${esc(x.telegram_chat_id||'-')} / msg ${esc(x.telegram_message_id||'-')}</small></span><span>${new Date(x.created_at).toLocaleString()}</span></div>`).join('')||'<div class="tr">Belum ada ticket Human Bridge.</div>';
}
$('#saveBridge').onclick=async()=>{try{const d=await api('/api/human-bridge/settings',{method:'PUT',body:JSON.stringify(bridgePayload())});$('#bridgeOut').textContent=JSON.stringify(d,null,2);await loadBridge()}catch(e){$('#bridgeOut').textContent='ERROR: '+e.message}};
$('#testBridge').onclick=async()=>{try{$('#bridgeOut').textContent=JSON.stringify(await api('/api/human-bridge/test',{method:'POST'}),null,2)}catch(e){$('#bridgeOut').textContent='ERROR: '+e.message}};
$('#testBridgeMsg').onclick=async()=>{try{$('#bridgeOut').textContent=JSON.stringify(await api('/api/human-bridge/test-message',{method:'POST',body:JSON.stringify({chatId:$('#tgDefaultChat').value.trim()})}),null,2)}catch(e){$('#bridgeOut').textContent='ERROR: '+e.message}};
$('#bridgeEnabled').onchange=async e=>{try{await api('/api/human-bridge/enabled',{method:'POST',body:JSON.stringify({enabled:e.target.checked})});await loadBridge()}catch(err){e.target.checked=false;alert(err.message)}};
$('#refreshBridge').onclick=loadBridge;


let learningFilter='PENDING';
async function loadLearning(){
  if(!$('#learningList')) return;
  const d=await api('/api/learning?status='+encodeURIComponent(learningFilter));
  $('#learningList').innerHTML=(d.items||[]).map(x=>`<div class="request"><div class="requesthead"><div><b>${esc(x.source_type==='AI_FEEDBACK'?'Teguran AI':'Chat CS')}</b><span class="pill">${esc(x.intent||'GENERAL')}</span><span class="pill">${esc(x.status)}</span></div><small>${new Date(x.updated_at).toLocaleString()}</small></div><div class="requestbody"><b>Member</b><p>${esc(x.member_text)}</p><b>${x.source_type==='AI_FEEDBACK'?'Jawaban AI yang salah':'Balasan CS'}</b><p>${esc(x.response_text)}</p>${x.correction_text?`<b>Koreksi admin</b><p>${esc(x.correction_text)}</p>`:''}<div class="row wrap">${x.status==='PENDING'?`<button data-learnkb="${x.id}">Approve → Knowledge</button><button data-learnresp="${x.id}">Approve → Response</button><button class="ghostbtn" data-learnreject="${x.id}">Tolak</button>`:`<span class="muted">Dipakai AI sebagai contoh pembelajaran. Kemunculan: ${esc(x.occurrences||1)}x</span>`}</div></div></div>`).join('')||'<div class="panel">Belum ada kandidat pembelajaran.</div>';
  $$('[data-learnkb]').forEach(b=>b.onclick=async()=>{await api('/api/learning/'+b.dataset.learnkb+'/promote-knowledge',{method:'POST'});loadLearning();loadKb()});
  $$('[data-learnresp]').forEach(b=>b.onclick=async()=>{await api('/api/learning/'+b.dataset.learnresp+'/promote-response',{method:'POST'});loadLearning();loadCanned()});
  $$('[data-learnreject]').forEach(b=>b.onclick=async()=>{await api('/api/learning/'+b.dataset.learnreject+'/status',{method:'POST',body:JSON.stringify({status:'REJECTED'})});loadLearning()});
}
if($('#scanLearning'))$('#scanLearning').onclick=async()=>{const b=$('#scanLearning');b.disabled=true;try{const d=await api('/api/learning/backfill',{method:'POST',body:JSON.stringify({limit:50000})});alert(`Scan selesai. Dicek: ${d.scanned||0}, kandidat baru: ${d.created||0}, dilewati: ${d.skipped||0}`);await loadLearning()}catch(e){alert('Scan gagal: '+e.message)}finally{b.disabled=false}};
if($('#refreshLearning'))$('#refreshLearning').onclick=loadLearning;
if($('#learningPending'))$('#learningPending').onclick=()=>{learningFilter='PENDING';loadLearning()};
if($('#learningApproved'))$('#learningApproved').onclick=()=>{learningFilter='APPROVED';loadLearning()};
if($('#learningAll'))$('#learningAll').onclick=()=>{learningFilter='ALL';loadLearning()};

async function loadRules(){const d=await api('/api/rules');$('#rulesList').innerHTML=d.items.map(x=>`<div class="tr"><span class="pill">${esc(x.category)}</span><b>${esc(x.rule_type)}</b><span>${esc(x.content)}</span><button data-delrule="${x.id}">Hapus</button></div>`).join('')||'<div class="tr">Belum ada rule.</div>';$$('[data-delrule]').forEach(b=>b.onclick=async()=>{await api('/api/rules/'+b.dataset.delrule,{method:'DELETE'});loadRules()})}
$('#addRule').onclick=async()=>{await api('/api/rules',{method:'POST',body:JSON.stringify({category:$('#ruleCategory').value,ruleType:$('#ruleType').value,content:$('#ruleContent').value})});$('#ruleContent').value='';loadRules()};
async function loadKb(){const d=await api('/api/knowledge');$('#kbList').innerHTML=d.items.map(x=>`<div class="tr"><span class="pill">${esc(x.category)}</span><b>${esc(x.title)}</b><span>${esc(x.content)}</span><button data-delkb="${x.id}">Hapus</button></div>`).join('')||'<div class="tr">Belum ada knowledge.</div>';$$('[data-delkb]').forEach(b=>b.onclick=async()=>{await api('/api/knowledge/'+b.dataset.delkb,{method:'DELETE'});loadKb()})}
$('#addKb').onclick=async()=>{await api('/api/knowledge',{method:'POST',body:JSON.stringify({category:$('#kbCategory').value,title:$('#kbTitle').value,content:$('#kbContent').value})});$('#kbTitle').value='';$('#kbContent').value='';loadKb()};
async function loadLogs(){const [a,e]=await Promise.all([api('/api/logs/ai'),api('/api/logs/errors')]);$('#aiLogs').innerHTML=a.items.map(x=>`<div class="tr"><span>${esc(x.intent||'-')}</span><span>${esc(x.action||'-')} ${(x.confidence??'')}</span><span>${esc(x.reply||x.error||'-')}</span><span>${new Date(x.created_at).toLocaleString()}</span></div>`).join('')||'Belum ada AI log.';$('#errLogs').innerHTML=e.items.map(x=>`<div class="tr"><span>${esc(x.source)}</span><span>${esc(x.code||'-')}</span><span>${esc(x.message)}</span><span>${new Date(x.created_at).toLocaleString()}</span></div>`).join('')||'Belum ada error.'}
$('#refreshLogs').onclick=loadLogs;
async function liveUiTick(){if(liveUiBusy)return;liveUiBusy=true;try{const tab=$('#tab-chats');if(tab.classList.contains('active')){await loadChats();if(currentChat)await openChat(currentChat,currentTitle,true)}await loadHuman()}catch{}finally{liveUiBusy=false}}
function startLiveUi(){if(!liveUiTimer)liveUiTimer=setInterval(liveUiTick,750)}
boot().catch(e=>{document.body.innerHTML='<pre style="color:#fff">BOOT UI ERROR: '+esc(e.message)+'</pre>'});
