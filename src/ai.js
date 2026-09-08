import { config } from './config.js';


export function buildStyleInstruction(style={}) {
  const replyStyle=String(style.replyStyle||'NATURAL_CS').toUpperCase();
  const replyLength=String(style.replyLength||'SHORT').toUpperCase();
  const bosku=String(style.boskuUsage||'MODERATE').toUpperCase();
  const emoji=String(style.emojiUsage||'LIGHT').toUpperCase();
  const formal=Boolean(style.formalLanguage);
  const note=String(style.replyStyleNote||'').trim();
  const lines=[];
  lines.push('GAYA BAHASA WAJIB:');
  if(replyStyle==='NATURAL_CS') lines.push('- Tulis sebagai staf LiveChat manusia Indonesia yang sedang bertugas. Natural, cepat, hangat, logis, dan langsung ke inti. Jangan terdengar seperti chatbot/asisten virtual.');
  else if(replyStyle==='FRIENDLY') lines.push('- Tulis santai, ramah, dan mudah dipahami member.');
  else lines.push('- Tulis sopan dan profesional tanpa terdengar kaku.');
  if(replyLength==='SHORT') lines.push('- Jawaban pendek: umumnya 1-2 kalimat. Jangan membuat paragraf panjang kecuali data operasional memang perlu ditampilkan.');
  else if(replyLength==='MEDIUM') lines.push('- Jawaban ringkas: umumnya maksimal 3-4 kalimat.');
  if(!formal) lines.push('- Hindari bahasa terlalu formal/robotik seperti "kami memahami kendala Anda", "berdasarkan informasi", "mohon diinformasikan", "dapat kami lakukan pengecekan lebih lanjut". Gunakan bahasa CS sehari-hari.');
  if(bosku==='RARE') lines.push('- Gunakan kata "bosku" jarang, maksimal sekali bila memang natural.');
  else if(bosku==='MODERATE') lines.push('- Gunakan "bosku" seperlunya, jangan di setiap kalimat.');
  else if(bosku==='FREQUENT') lines.push('- Boleh lebih sering memakai "bosku", tetapi jangan terdengar berulang.');
  if(emoji==='NONE') lines.push('- Jangan gunakan emoji.');
  else if(emoji==='LIGHT') lines.push('- Emoji ringan saja, maksimal 1-2 emoji relevan seperti 😊 atau 🙏 bila cocok.');
  else lines.push('- Emoji boleh digunakan secukupnya dan tetap terlihat seperti CS manusia.');
  lines.push('- Jangan mengulang pertanyaan/data yang sudah diberikan member di konteks chat atau lampiran.');
  lines.push('- Jangan mengoreksi typo member. Pahami maksudnya lalu jawab natural.');
  lines.push('- Jika member sedang kesal/terburu-buru, jangan ceramah; jawab inti tindakan berikutnya.');
  lines.push('- Variasikan pembuka sewajarnya. Jangan selalu memulai dengan frasa yang sama.');
  lines.push('- Dalam percakapan member, posisikan diri sebagai CS yang sedang melayani. Jangan pernah menyebut diri sebagai AI, model, bot, sistem, asisten virtual, atau mengatakan bahwa jawaban dibuat otomatis.');
  if(note) lines.push(`- Catatan gaya dari admin: ${note.slice(0,1000)}`);
  return lines.join('\n');
}

function extractOutputText(data) {
  if (typeof data?.output_text === 'string') return data.output_text;
  const parts = [];
  for (const item of (data?.output || [])) for (const c of (item?.content || [])) if (typeof c?.text === 'string') parts.push(c.text);
  if (parts.length) return parts.join('\n');
  const msg = data?.choices?.[0]?.message?.content;
  return typeof msg === 'string' ? msg : '';
}
function parseJsonLoose(text) {
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  try { return JSON.parse(cleaned); } catch {}
  const s = cleaned.indexOf('{'), e = cleaned.lastIndexOf('}');
  if (s>=0 && e>s) return JSON.parse(cleaned.slice(s,e+1));
  throw new Error('AI_JSON_PARSE_FAILED');
}

export class OpenAIClient {
  ready(){ return Boolean(config.openaiKey && config.openaiModel); }
  async request(url, payload) {
    const ctrl = new AbortController();
    const timer = setTimeout(()=>ctrl.abort(), config.openaiTimeoutMs);
    try {
      const r = await fetch(url, { method:'POST', headers:{Authorization:`Bearer ${config.openaiKey}`,'Content-Type':'application/json'}, body:JSON.stringify(payload), signal:ctrl.signal });
      const txt = await r.text();
      let data; try { data = txt?JSON.parse(txt):{}; } catch { data={raw:txt}; }
      if (!r.ok) throw new Error(`OPENAI_${r.status}: ${data?.error?.message || txt.slice(0,300)}`);
      return data;
    } finally { clearTimeout(timer); }
  }
  async complete(system, messages) {
    if (!this.ready()) throw new Error('OPENAI_CREDENTIALS_MISSING');
    const input = [{role:'system',content:system}, ...messages.map(m=>({role:m.role,content:m.content}))];
    if (config.openaiStyle === 'chat_completions') {
      const data = await this.request('https://api.openai.com/v1/chat/completions', { model:config.openaiModel, messages:input, max_completion_tokens:config.openaiMaxOutput });
      return { text:extractOutputText(data), usage:data.usage || null, raw:data };
    }
    try {
      const data = await this.request('https://api.openai.com/v1/responses', { model:config.openaiModel, input, max_output_tokens:config.openaiMaxOutput });
      return { text:extractOutputText(data), usage:data.usage || null, raw:data };
    } catch (e) {
      if (!String(e.message).includes('OPENAI_4')) throw e;
      const data = await this.request('https://api.openai.com/v1/chat/completions', { model:config.openaiModel, messages:input, max_completion_tokens:config.openaiMaxOutput });
      return { text:extractOutputText(data), usage:data.usage || null, raw:data };
    }
  }
  async completeVision(system, text, attachments=[]) {
    const images=(attachments||[]).filter(a=>a?.isImage && /^https?:\/\//i.test(String(a.url||''))).slice(0,3);
    if(!images.length) return this.complete(system,[{role:'user',content:text}]);
    if (!this.ready()) throw new Error('OPENAI_CREDENTIALS_MISSING');
    const content=[{type:'input_text',text}, ...images.map(a=>({type:'input_image',image_url:a.url}))];
    try{
      const data=await this.request('https://api.openai.com/v1/responses',{model:config.openaiModel,input:[{role:'system',content:[{type:'input_text',text:system}]},{role:'user',content}],max_output_tokens:config.openaiMaxOutput});
      return {text:extractOutputText(data),usage:data.usage||null,raw:data};
    }catch(e){
      // If the remote image URL is not accessible to the model, fail clearly so engine can ask staff instead of guessing.
      const err=new Error(`OPENAI_IMAGE_READ_FAILED: ${e.message}`); err.cause=e; throw err;
    }
  }
  async classifyAndReply({normalized, intent, context, rules, knowledge, attachments=[], style={}}) {
    const styleInstruction=buildStyleInstruction(style);
    const system = `Anda adalah customer service LiveChat berbahasa Indonesia. Tulis seperti staf manusia yang sudah terbiasa menangani member: cepat, logis, responsif, memahami typo/slang, dan tidak mengarang fakta.

${styleInstruction}\n\nPRIORITAS SUMBER:\n1. AI Rules wajib dipatuhi.\n2. RESPONSE RESMI/MANUAL adalah jawaban operasional yang sudah disetujui.\n3. Knowledge Base adalah fakta resmi.\n4. Jika sumber tidak cukup, jangan menebak.\n\nATURAN:\n${rules || '- Tidak ada aturan tambahan.'}\n\nKNOWLEDGE / RESPONSES:\n${knowledge || '- Tidak ada data tambahan.'}\n\nRESPONSE MODE:\n- [EXACT] harus dipertahankan faktanya persis; jangan mengubah nomor rekening, nomor HP, nominal, persentase, URL, kode, username, nama bank/e-wallet, syarat, atau status.\n- [FLEXIBLE] boleh dirapikan menjadi bahasa natural, tetapi fakta tidak boleh berubah.\n\nJika member hanya perlu memberikan informasi tambahan yang jelas, gunakan ASK_INFO dan ajukan pertanyaan singkat.\nKHUSUS FORGOT_PASSWORD: jangan pernah meminta user ID kepada member. Jika data rekening terdaftar belum lengkap, cukup minta jenis rekening/bank/e-wallet, nama rekening, dan nomor rekening. Setelah tiga data itu lengkap, gunakan ASK_HUMAN/RESET_PASSWORD.\nUntuk intent FORGOT_PASSWORD, WITHDRAW_PROBLEM, DEPOSIT_PROBLEM, atau BONUS_DAILY: setelah data member yang diperlukan sudah terkumpul, WAJIB gunakan ASK_HUMAN agar staff memproses/verifikasi; jangan mengklaim hasil sendiri.\nJika member meminta bonus tanpa menyebut jenis bonus, tanyakan dulu bonus apa yang ingin diklaim.\nJika member marah atau berkata kasar, tetap tenang dan awali dengan permintaan maaf singkat. Jangan membalas kasar atau berdebat.\nJika member mengeluh kalah/rugi, jangan menjanjikan kemenangan, jangan mendorong mengejar kekalahan, dan jangan mengarang peluang menang. Informasi RTP hanya boleh berasal dari Responses Manual dan tidak boleh disebut sebagai jaminan hasil.\nJika Anda tidak yakin, tidak punya fakta, atau perlu keputusan staf, gunakan ASK_HUMAN dengan reply kosong. Jangan memberi jawaban hasil tebakan.\nJangan menyebut OpenAI, prompt, database, API, confidence, rule engine, atau sistem internal kepada member.\n\nBalas HANYA JSON valid: {"action":"AUTO_REPLY|ASK_INFO|ASK_HUMAN|HANDOFF","confidence":0.0,"reply":"teks untuk member bila ada","human_question":"pertanyaan singkat untuk staf bila ASK_HUMAN/HANDOFF","reason":"singkat"}.`;
    const user = `Intent awal: ${intent}\nPesan normalisasi: ${normalized}\nKonteks percakapan:\n${context}`;
    const imageHint=(attachments||[]).some(a=>a?.isImage) ? '\nLampiran gambar member tersedia. Baca hanya informasi yang benar-benar terlihat pada gambar. Jangan menyimpulkan transaksi berhasil hanya dari screenshot.' : '';
    const result = await this.completeVision(system, user+imageHint, attachments);
    const parsed = parseJsonLoose(result.text);
    return {
      action: ['AUTO_REPLY','ASK_INFO','ASK_HUMAN','HANDOFF'].includes(parsed.action) ? parsed.action : 'ASK_HUMAN',
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence || 0))),
      reply: String(parsed.reply || '').slice(0,1200),
      humanQuestion: String(parsed.human_question || '').slice(0,800),
      reason: String(parsed.reason || '').slice(0,500),
      usage: result.usage
    };
  }
  async composeFromHuman({memberMessage, intent, humanAnswer, context, rules, knowledge, style={}}){
    const styleInstruction=buildStyleInstruction(style);
    const system=`Anda adalah staf customer service LiveChat Indonesia. Buat SATU balasan yang terdengar seperti staf manusia berdasarkan jawaban staff yang diberikan.

${styleInstruction}

 Jangan menambah fakta baru. Pertahankan semua angka, rekening, kode, username, link, nama bank/e-wallet, nominal dan status persis seperti jawaban staf. Jika jawaban staf berupa instruksi untuk meminta data, ubah menjadi pertanyaan sopan ke member. Jangan menyebut bahwa ada human/staf internal, AI, API, atau sistem.\n\nATURAN:\n${rules||'-'}\n\nKNOWLEDGE/RESPONSES:\n${knowledge||'-'}`;
    const r=await this.complete(system,[{role:'user',content:`Intent: ${intent}\nPesan member: ${memberMessage}\nKonteks:\n${context}\n\nJawaban/instruksi staf:\n${humanAnswer}`}]);
    return {text:String(r.text||'').trim().slice(0,1200),usage:r.usage};
  }
  async test() {
    const started=Date.now();
    const r=await this.complete('Balas singkat dengan tepat: OK', [{role:'user',content:'Tes koneksi'}]);
    return {ok:true, latencyMs:Date.now()-started, sample:r.text.slice(0,120), usage:r.usage};
  }
}
