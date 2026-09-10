import { LiveChatClient } from './livechat.js';
import { config } from './config.js';

function cleanKey(v='default'){return String(v||'default').trim().toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'')||'default'}
function parseSites(){
  const out=[];
  if(config.lcAccountId&&config.lcPat) out.push({id:'default',name:process.env.DEFAULT_SITE_NAME||'Website Utama',accountId:config.lcAccountId,pat:config.lcPat,base:config.lcApiBase,registerUrl:String(process.env.DEFAULT_SITE_REGISTER_URL||''),loginUrl:String(process.env.DEFAULT_SITE_LOGIN_URL||''),webhookSecret:String(config.lcWebhookSecret||'')});
  const raw=String(config.lcSitesJson||'').trim();
  if(raw){
    let arr; try{arr=JSON.parse(raw)}catch{throw new Error('CONFIG_ERROR: LIVECHAT_SITES_JSON bukan JSON valid')}
    if(!Array.isArray(arr)) throw new Error('CONFIG_ERROR: LIVECHAT_SITES_JSON harus array');
    for(const x of arr){
      const id=cleanKey(x?.id||x?.key||x?.name); if(!x?.accountId||!x?.pat) continue;
      const row={id,name:String(x.name||id),accountId:String(x.accountId),pat:String(x.pat),base:String(x.base||config.lcApiBase),registerUrl:String(x.registerUrl||''),loginUrl:String(x.loginUrl||''),webhookSecret:String(x.webhookSecret||'')};
      const i=out.findIndex(y=>y.id===id); if(i>=0) out[i]=row; else out.push(row);
    }
  }
  return out;
}

export class LiveChatHub{
  constructor(){
    this.sites=parseSites();
    this.clients=new Map(this.sites.map(s=>[s.id,new LiveChatClient({accountId:s.accountId,pat:s.pat,base:s.base})]));
  }
  ready(){return this.clients.size>0&&[...this.clients.values()].some(c=>c.ready())}
  siteList(){return this.sites.map(({pat,webhookSecret,...s})=>({...s,configured:true,webhookConfigured:Boolean(webhookSecret)}))}
  scopedId(siteId,nativeId){return siteId==='default'?String(nativeId):`${siteId}::${nativeId}`}
  resolve(chatId){const s=String(chatId||'');const p=s.indexOf('::');const siteId=p>0?s.slice(0,p):'default';const nativeId=p>0?s.slice(p+2):s;const client=this.clients.get(siteId);if(!client)throw new Error(`LIVECHAT_SITE_NOT_FOUND:${siteId}`);return {siteId,nativeId,client}}
  annotate(summary,site){const native=String(summary?.id||'');return {...summary,id:this.scopedId(site.id,native),_nativeId:native,_siteId:site.id,_siteName:site.name}}
  async listChats(){
    const results=await Promise.allSettled(this.sites.map(async site=>{const client=this.clients.get(site.id);const data=await client.listChats();const items=(data?._normalizedChats||[]).map(x=>this.annotate(x,site));return {site,data,items}}));
    const items=[];const errors=[];for(const r of results){if(r.status==='fulfilled')items.push(...r.value.items);else errors.push(String(r.reason?.message||r.reason))}
    items.sort((a,b)=>String(b?.last_thread_summary?.created_at||b?.updated_at||'').localeCompare(String(a?.last_thread_summary?.created_at||a?.updated_at||'')));
    if(!items.length&&errors.length)throw new Error(errors.join(' | '));
    return {_normalizedChats:items,_listSource:'multi_site',siteCount:this.sites.length,errors};
  }
  filterInbox(items){return (items||[]).filter(x=>{const c=this.clients.get(x?._siteId||'default');return c?c.isMyActiveChat(x):false})}
  chatState(summary){const c=this.clients.get(summary?._siteId||'default')||this.clients.get('default');return c?c.chatState(summary):{followed:null,active:null,routingStatus:''}}
  async getChat(chatId,fallback={}){const {siteId,nativeId,client}=this.resolve(chatId);const fb={...fallback,id:nativeId};const chat=await client.getChat(nativeId,fb);return {...chat,id:this.scopedId(siteId,chat.id||nativeId),_nativeId:String(chat.id||nativeId),_siteId:siteId,_siteName:this.sites.find(s=>s.id===siteId)?.name||siteId}}
  chatDiagnostics(chat){const c=this.clients.get(chat?._siteId||'default')||this.clients.values().next().value;return c?c.chatDiagnostics(chat):{}}
  sendMessage(chatId,text){const {nativeId,client}=this.resolve(chatId);return client.sendMessage(nativeId,text)}
  endChat(chatId){const {nativeId,client}=this.resolve(chatId);return client.endChat(nativeId)}
  prepareImageAttachments(a){const c=this.clients.values().next().value;return c?c.prepareImageAttachments(a):Promise.resolve(a)}
  async test(){const started=Date.now();const checks=await Promise.allSettled(this.sites.map(async s=>({siteId:s.id,name:s.name,...await this.clients.get(s.id).test()})));return {ok:checks.some(x=>x.status==='fulfilled'),connected:checks.some(x=>x.status==='fulfilled'),latencyMs:Date.now()-started,sites:checks.map((x,i)=>x.status==='fulfilled'?x.value:{siteId:this.sites[i]?.id,name:this.sites[i]?.name,ok:false,error:String(x.reason?.message||x.reason)})}}
  getSiteMeta(chatId){const {siteId}=this.resolve(chatId);return this.sites.find(s=>s.id===siteId)||{id:siteId,name:siteId}}
  getWebhookSecret(siteId='default'){return String(this.sites.find(s=>s.id===siteId)?.webhookSecret||config.lcWebhookSecret||'')}
}
