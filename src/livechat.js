import { config } from './config.js';

export class LiveChatClient {
  constructor(overrides={}) {
    this.base = overrides.base || config.lcApiBase;
    this.accountId = overrides.accountId || config.lcAccountId;
    this.pat = overrides.pat || config.lcPat;
    this.timeoutMs = overrides.timeoutMs || 15000;
  }
  ready() { return Boolean(this.accountId && this.pat && this.base); }
  authHeader() {
    return 'Basic ' + Buffer.from(`${this.accountId}:${this.pat}`).toString('base64');
  }
  async call(action, body={}) {
    if (!this.ready()) throw new Error('LIVECHAT_CREDENTIALS_MISSING');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const r = await fetch(`${this.base}/${action}`, {
        method:'POST',
        headers:{ 'Authorization': this.authHeader(), 'Content-Type':'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      const txt = await r.text();
      let data; try { data = txt ? JSON.parse(txt) : {}; } catch { data = { raw:txt }; }
      if (!r.ok) {
        const err = new Error(`LIVECHAT_${r.status}: ${data?.error?.message || data?.message || txt.slice(0,300)}`);
        err.status = r.status; err.data = data; throw err;
      }
      return data;
    } finally { clearTimeout(timer); }
  }

  // LiveChat Agent Chat API list_chats may expose the list as chats_summary.
  // Keep compatibility with alternate/older shapes as well.
  normalizeChatList(data) {
    if (Array.isArray(data?.chats_summary)) return { items:data.chats_summary, source:'chats_summary' };
    if (Array.isArray(data?.chats)) return { items:data.chats, source:'chats' };
    if (Array.isArray(data?.items)) return { items:data.items, source:'items' };
    return { items:[], source:'none' };
  }


  chatState(summary) {
    const th = summary?.last_thread_summary || summary?.last_thread || {};
    const followed = summary?.is_followed;
    const active = typeof th?.active === 'boolean' ? th.active
      : (typeof summary?.active === 'boolean' ? summary.active
      : (String(summary?.status || '').toLowerCase() === 'active' ? true : null));
    const routingStatus = String(summary?.routing_status || th?.routing_status || '').toLowerCase();
    return { followed, active, routingStatus };
  }

  isMyActiveChat(summary) {
    const st = this.chatState(summary);
    // LiveChat's Agent API marks chats followed by the current agent with is_followed.
    // This most closely mirrors the web app's "My chats" list.
    if (st.followed === true) return st.active !== false && st.routingStatus !== 'closed';
    if (st.followed === false) return false;
    // Defensive fallback for response variants without is_followed.
    return st.active === true && !['closed','archived'].includes(st.routingStatus);
  }

  filterInbox(items) {
    if (config.lcInboxMode === 'all') return items;
    return items.filter(x => this.isMyActiveChat(x));
  }

  async listChats() {
    const candidates = [
      { filters: { include_active: true, include_chats_without_threads: true }, sort_order: 'desc', limit: config.lcListLimit },
      { filters: { include_active: true }, sort_order: 'desc', limit: config.lcListLimit },
      { sort_order: 'desc', limit: config.lcListLimit },
      { limit: config.lcListLimit }
    ];
    let last;
    for (const body of candidates) {
      try {
        const data = await this.call('list_chats', body);
        const normalized = this.normalizeChatList(data);
        return { ...data, _normalizedChats: normalized.items, _listSource: normalized.source };
      } catch (e) {
        last=e;
        if (e.status !== 400) throw e;
      }
    }
    throw last;
  }
  getChat(chatId) { return this.call('get_chat', { chat_id: chatId }); }
  sendMessage(chatId, text) {
    return this.call('send_event', {
      chat_id: chatId,
      event: { type:'message', text },
      attach_to_last_thread: true
    });
  }
  async test() {
    const started = Date.now();
    const data = await this.listChats();
    const items = data?._normalizedChats || [];
    return {
      ok:true,
      connected:true,
      latencyMs:Date.now()-started,
      count:this.filterInbox(items).length,
      rawCount:items.length,
      myActiveCount:this.filterInbox(items).length,
      listSource:data?._listSource || 'none',
      foundChats:Number(data?.found_chats ?? items.length),
      hasNextPage:Boolean(data?.next_page_id),
      sampleChatIds:this.filterInbox(items).slice(0,5).map(x=>String(x?.id||'')).filter(Boolean),
      sampleStates:items.slice(0,10).map(x=>({id:String(x?.id||''),...this.chatState(x)}))
    };
  }
}

export function extractChatEvents(chat) {
  const out = [];
  for (const th of (chat?.threads || [])) {
    for (const ev of (th?.events || [])) {
      if (ev?.type !== 'message' || !ev?.text) continue;
      out.push({
        eventId: String(ev.id ?? `${th.id}:${ev.created_at}:${ev.text}`),
        threadId: String(th.id ?? ''),
        createdAt: ev.created_at || th.created_at || new Date().toISOString(),
        text: ev.text,
        authorId: ev.author_id || '',
        authorType: ev.author_type || '',
        recipients: ev.recipients || 'all'
      });
    }
  }
  return out.sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)));
}
