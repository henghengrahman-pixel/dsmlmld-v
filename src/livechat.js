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
    if (config.lcInboxMode === 'all') return items.filter(x=>{ const st=this.chatState(x); return st.active!==false && !['closed','archived'].includes(st.routingStatus); });
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
    for (const baseBody of candidates) {
      try {
        const all=[]; const seen=new Set(); let firstData=null; let pageId=null; let pages=0; let source='none';
        do {
          const body={...baseBody};
          if(pageId) body.page_id=pageId;
          const data=await this.call('list_chats',body);
          if(!firstData) firstData=data;
          const normalized=this.normalizeChatList(data);
          source=normalized.source!=='none'?normalized.source:source;
          for(const item of normalized.items){
            const id=String(item?.id||'');
            if(!id || seen.has(id)) continue;
            seen.add(id); all.push(item);
          }
          pageId=data?.next_page_id ? String(data.next_page_id) : null;
          pages++;
          // Safety cap: an account should never need this many pages for an active inbox.
          if(pages>=20) pageId=null;
        } while(pageId);
        return { ...(firstData||{}), _normalizedChats:all, _listSource:source, _pagesFetched:pages, found_chats:Number(firstData?.found_chats ?? all.length), next_page_id:null };
      } catch (e) {
        last=e;
        if (e.status !== 400) throw e;
      }
    }
    throw last;
  }
  normalizeChatDetail(data, fallback={}) {
    let chat = null;
    let source = 'none';
    if (data && typeof data === 'object' && data.chat && typeof data.chat === 'object') {
      chat = data.chat; source = 'chat';
    } else if (data && typeof data === 'object' && (data.id || Array.isArray(data.threads))) {
      chat = data; source = 'direct';
    } else if (Array.isArray(data?.chats) && data.chats[0]) {
      chat = data.chats[0]; source = 'chats[0]';
    } else if (Array.isArray(data?.items) && data.items[0]) {
      chat = data.items[0]; source = 'items[0]';
    }
    if (!chat) chat = { ...fallback };
    else chat = { ...fallback, ...chat };
    if (!chat.id && fallback?.id) chat.id = fallback.id;
    Object.defineProperty(chat, '_detailSource', { value: source, enumerable: false, configurable: true });
    return chat;
  }

  async getChat(chatId, fallback={}) {
    const threadId = fallback?.last_thread_summary?.id ?? fallback?.last_thread?.id ?? fallback?.thread_id ?? null;
    const candidates = [];
    // Prefer requests that ask LiveChat for a wider history window when supported.
    // IMPORTANT: never return the first non-empty result. Some accounts return only the selected
    // thread for a thread_id request, while the plain chat request contains more of the conversation.
    // We evaluate every supported candidate and keep the response with the most readable events.
    if (threadId !== null && threadId !== undefined && String(threadId) !== '') {
      candidates.push({ chat_id: chatId, thread_id: threadId, thread_limit: 100 });
    }
    candidates.push({ chat_id: chatId, thread_limit: 100 });
    if (threadId !== null && threadId !== undefined && String(threadId) !== '') {
      candidates.push({ chat_id: chatId, thread_id: threadId });
    }
    candidates.push({ chat_id: chatId });

    const seenBodies=new Set();
    let lastErr = null;
    let best = null;
    let bestCount = -1;
    for (const body of candidates) {
      const key=JSON.stringify(body); if(seenBodies.has(key)) continue; seenBodies.add(key);
      try {
        const data = await this.call('get_chat', body);
        const chat = this.normalizeChatDetail(data, fallback);
        Object.defineProperty(chat, '_getChatRequest', { value: body, enumerable: false, configurable: true });
        const count = extractChatEvents(chat).length;
        if (count > bestCount) { best = chat; bestCount = count; }
      } catch (e) {
        lastErr = e;
        // thread_limit / thread_id shapes vary between LiveChat accounts. Unsupported variants are
        // expected and simply fall through to the next candidate.
        if (![400,404,422].includes(Number(e?.status))) throw e;
      }
    }
    if (best) return best;
    if (lastErr) throw lastErr;
    return this.normalizeChatDetail({}, fallback);
  }

  chatDiagnostics(chat) {
    const threads = Array.isArray(chat?.threads) ? chat.threads : [];
    const topEvents = Array.isArray(chat?.events) ? chat.events.length : 0;
    const threadEvents = threads.reduce((n,t)=>n + (Array.isArray(t?.events)?t.events.length:0), 0);
    const messages = extractChatEvents(chat).length;
    return {
      detailSource: chat?._detailSource || 'unknown',
      threadCount: threads.length,
      eventCount: topEvents + threadEvents,
      messageCount: messages,
      requestedThreadId: chat?._getChatRequest?.thread_id ?? null,
      requestUsed: chat?._getChatRequest || null,
      keys: chat && typeof chat==='object' ? Object.keys(chat).slice(0,30) : []
    };
  }
  isRequesterNotUserError(err) {
    const msg=String(err?.message||'').toLowerCase();
    return Number(err?.status)===403 && (msg.includes('requester is not user of the chat') || msg.includes('requester is not a user of the chat'));
  }
  async ensureChatMembership(chatId) {
    // LiveChat may keep a chat visible in local history after the PAT agent is no longer
    // following/participating in it. Sending then returns 403 "Requester is not user of the chat".
    // follow_chat is idempotent for an already-followed chat and is the safest recovery action.
    try {
      await this.call('follow_chat',{chat_id:chatId});
      return {ok:true,action:'follow_chat'};
    } catch(e) {
      // Some accounts return a benign conflict when already followed.
      if ([409].includes(Number(e?.status))) return {ok:true,action:'already_followed'};
      throw e;
    }
  }
  async sendMessage(chatId, text) {
    const payload={chat_id:chatId,event:{type:'message',text},attach_to_last_thread:true};
    try {
      return await this.call('send_event',payload);
    } catch(e) {
      if (!this.isRequesterNotUserError(e)) throw e;
      await this.ensureChatMembership(chatId);
      try {
        return await this.call('send_event',payload);
      } catch(retryErr) {
        if (this.isRequesterNotUserError(retryErr)) {
          const err=new Error('LIVECHAT_CHAT_MEMBERSHIP_REQUIRED: akun PAT belum menjadi peserta chat. Chat sudah dicoba follow otomatis tetapi LiveChat tetap menolak. Pastikan PAT dibuat dari agent yang memiliki akses ke chat/group tersebut.');
          err.status=403; err.cause=retryErr; err.data=retryErr?.data; throw err;
        }
        throw retryErr;
      }
    }
  }
  chatActiveFlag(chat={}) {
    const th=chat?.last_thread || chat?.last_thread_summary || (Array.isArray(chat?.threads)?chat.threads.at(-1):null) || {};
    if(typeof th?.active==='boolean') return th.active;
    if(typeof chat?.active==='boolean') return chat.active;
    const status=String(chat?.status||chat?.routing_status||th?.routing_status||'').toLowerCase();
    if(['closed','archived','inactive'].includes(status)) return false;
    if(status==='active') return true;
    return null;
  }
  async endChat(chatId) {
    let lastResponse=null;
    for(let attempt=1;attempt<=2;attempt++){
      try{
        lastResponse=await this.call('deactivate_chat',{chat_id:chatId});
        if(lastResponse?.ok===true) return {ok:true,verified:true,attempts:attempt,response:lastResponse};
      }catch(e){
        if(![400,404,422].includes(Number(e?.status))) throw e;
        try{ const state=await this.getChat(chatId,{}); if(this.chatActiveFlag(state)===false) return {ok:true,alreadyClosed:true,verified:true,attempts:attempt,response:lastResponse}; }
        catch(v){ if(Number(v?.status)===404) return {ok:true,alreadyClosed:true,verified:true,attempts:attempt,response:lastResponse}; }
        throw e;
      }
      await new Promise(r=>setTimeout(r,180));
      try{
        const state=await this.getChat(chatId,{}); const active=this.chatActiveFlag(state);
        if(active===false) return {ok:true,verified:true,attempts:attempt,response:lastResponse};
        if(active===null) return {ok:true,verified:null,attempts:attempt,response:lastResponse};
      }catch(e){ if(Number(e?.status)===404) return {ok:true,verified:true,attempts:attempt,response:lastResponse}; }
    }
    const err=new Error('LIVECHAT_END_NOT_CONFIRMED'); err.status=502; throw err;
  }
  async prepareImageAttachments(attachments=[]) {
    const out=[];
    for(const a of (attachments||[]).filter(x=>x?.isImage).slice(0,3)) {
      const item={...a};
      const url=String(item.url||'');
      if(!/^https:\/\//i.test(url)) { out.push(item); continue; }
      try {
        const ctrl=new AbortController(); const timer=setTimeout(()=>ctrl.abort(),8000);
        const r=await fetch(url,{signal:ctrl.signal,redirect:'follow'}); clearTimeout(timer);
        if(!r.ok) throw new Error(`HTTP_${r.status}`);
        const ct=String(r.headers.get('content-type')||item.mime||'image/jpeg').split(';')[0];
        if(!ct.startsWith('image/')) throw new Error('NOT_IMAGE');
        const ab=await r.arrayBuffer();
        if(ab.byteLength>5*1024*1024) throw new Error('IMAGE_TOO_LARGE');
        item.url=`data:${ct};base64,${Buffer.from(ab).toString('base64')}`; item.mime=ct; item.prepared=true;
      } catch { item.prepared=false; }
      out.push(item);
    }
    return out;
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
      pagesFetched:Number(data?._pagesFetched||1),
      hasNextPage:Boolean(data?.next_page_id),
      sampleChatIds:this.filterInbox(items).slice(0,5).map(x=>String(x?.id||'')).filter(Boolean),
      sampleStates:items.slice(0,10).map(x=>({id:String(x?.id||''),...this.chatState(x)}))
    };
  }
}

export function extractChatEvents(chat) {
  const out = [];
  const seen = new Set();
  const eventGroups = [];
  const visited = new Set();

  function walk(node, owner=null, depth=0) {
    if (!node || typeof node !== 'object' || depth > 8) return;
    if (visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node.events)) eventGroups.push({ owner: node, events: node.events });
    if (Array.isArray(node)) { for (const x of node) walk(x, owner, depth+1); return; }
    for (const [k,v] of Object.entries(node)) { if (k !== 'events' && v && typeof v === 'object') walk(v, node, depth+1); }
  }
  walk(chat);

  function collectAttachments(ev) {
    const arr=[]; const seenUrl=new Set();
    const candidates=[];
    if(Array.isArray(ev?.attachments)) candidates.push(...ev.attachments);
    if(Array.isArray(ev?.files)) candidates.push(...ev.files);
    if(ev?.file && typeof ev.file==='object') candidates.push(ev.file);
    if(ev?.image && typeof ev.image==='object') candidates.push(ev.image);
    if(ev?.content && typeof ev.content==='object') {
      if(Array.isArray(ev.content.attachments)) candidates.push(...ev.content.attachments);
      if(ev.content.file) candidates.push(ev.content.file);
      if(ev.content.image) candidates.push(ev.content.image);
    }
    const type=String(ev?.type||ev?.event_type||'').toLowerCase();
    if(['file','image'].includes(type)) candidates.push(ev);
    for(const a of candidates){
      if(!a || typeof a!=='object') continue;
      const url=a.url||a.image_url||a.file_url||a.download_url||a.secure_url||a.src||a?.content?.url||null;
      if(!url || seenUrl.has(url)) continue; seenUrl.add(url);
      const mime=String(a.content_type||a.mime_type||a.mime||a.type||'').toLowerCase();
      const name=String(a.name||a.file_name||a.filename||'');
      const isImage=mime.startsWith('image/') || /\.(png|jpe?g|webp|gif)(?:\?|$)/i.test(String(url)) || /\.(png|jpe?g|webp|gif)$/i.test(name) || type==='image';
      arr.push({url:String(url),mime,name,isImage});
    }
    return arr.slice(0,8);
  }

  for (const {owner,events} of eventGroups) {
    for (const ev of events) {
      const type = String(ev?.type || ev?.event_type || ev?.event?.type || '').toLowerCase();
      let text = ev?.text;
      if (!text && typeof ev?.content?.text === 'string') text = ev.content.text;
      if (!text && typeof ev?.message?.text === 'string') text = ev.message.text;
      if (!text && typeof ev?.event?.text === 'string') text = ev.event.text;
      if (!text && Array.isArray(ev?.elements)) text = ev.elements.map(x=>x?.title||x?.text||x?.subtitle||'').filter(Boolean).join(' ');
      const attachments=collectAttachments(ev);
      text = String(text || '').trim();
      if (!text && attachments.length) text = attachments.some(a=>a.isImage) ? '[Member mengirim gambar]' : '[Member mengirim file]';
      if (!text) continue;
      if (type && !['message','rich_message','file','image'].includes(type) && !attachments.length) continue;
      const createdAt = ev?.created_at || owner?.created_at || new Date().toISOString();
      const ownerId = owner?.id ?? owner?.thread_id ?? '';
      const eventId = String(ev?.id ?? `${ownerId}:${createdAt}:${text}:${attachments.map(a=>a.url).join('|')}`);
      if (seen.has(eventId)) continue; seen.add(eventId);
      out.push({
        eventId, threadId:String(ownerId), createdAt, text, attachments,
        authorId: ev?.author_id || ev?.author?.id || ev?.user_id || '',
        authorType: ev?.author_type || ev?.author?.type || '', recipients: ev?.recipients || 'all'
      });
    }
  }
  return out.sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)));
}

