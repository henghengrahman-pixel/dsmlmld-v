import { config } from './config.js';

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
  async classifyAndReply({normalized, intent, context, rules, knowledge}) {
    const system = `Anda adalah AI customer service berbahasa Indonesia. Pahami typo/slang member. Jangan mengarang fakta transaksi, saldo, promo, rekening, bonus, atau status proses. Jika data tidak tersedia, action harus HANDOFF atau ASK_INFO. Jawaban harus singkat, sopan, natural, tanpa menyebut sistem internal.\n\nATURAN:\n${rules || '- Tidak ada aturan tambahan.'}\n\nKNOWLEDGE BASE:\n${knowledge || '- Tidak ada data tambahan.'}\n\nBalas HANYA JSON valid dengan bentuk: {"action":"AUTO_REPLY|ASK_INFO|HANDOFF","confidence":0.0,"reply":"teks","reason":"singkat"}.`;
    const user = `Intent awal: ${intent}\nPesan normalisasi: ${normalized}\nKonteks percakapan:\n${context}`;
    const result = await this.complete(system, [{role:'user',content:user}]);
    const parsed = parseJsonLoose(result.text);
    return {
      action: ['AUTO_REPLY','ASK_INFO','HANDOFF'].includes(parsed.action) ? parsed.action : 'HANDOFF',
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence || 0))),
      reply: String(parsed.reply || '').slice(0,1200),
      reason: String(parsed.reason || '').slice(0,500),
      usage: result.usage
    };
  }
  async test() {
    const started=Date.now();
    const r=await this.complete('Balas singkat dengan tepat: OK', [{role:'user',content:'Tes koneksi'}]);
    return {ok:true, latencyMs:Date.now()-started, sample:r.text.slice(0,120), usage:r.usage};
  }
}
