import { LiveChatClient } from './livechat.js';
import { config } from './config.js';

// v2.1: satu deployment = satu akun LiveChat. Wrapper ini dipertahankan agar modul lain
// tetap kompatibel tanpa membawa kompleksitas multi-tenant ke panel/operator.
export class LiveChatHub {
  constructor(){
    this.client=new LiveChatClient();
    this.site={id:'default',name:process.env.DEFAULT_SITE_NAME||'Website',accountId:config.lcAccountId,registerUrl:String(process.env.DEFAULT_SITE_REGISTER_URL||''),loginUrl:String(process.env.DEFAULT_SITE_LOGIN_URL||''),webhookSecret:String(config.lcWebhookSecret||'')};
  }
  ready(){ return this.client.ready(); }
  siteList(){ return [{id:'default',name:this.site.name,configured:this.ready(),webhookConfigured:Boolean(this.site.webhookSecret),registerUrl:this.site.registerUrl,loginUrl:this.site.loginUrl}]; }
  scopedId(_siteId,nativeId){ return String(nativeId||''); }
  resolve(chatId){ return {siteId:'default',nativeId:String(chatId||''),client:this.client}; }
  annotate(summary){ return {...summary,id:String(summary?.id||''),_nativeId:String(summary?.id||''),_siteId:'default',_siteName:this.site.name}; }
  async listChats(){ const data=await this.client.listChats(); return {...data,_normalizedChats:(data?._normalizedChats||[]).map(x=>this.annotate(x)),_listSource:data?._listSource||'single'}; }
  filterInbox(items){ return this.client.filterInbox(items||[]); }
  chatState(summary){ return this.client.chatState(summary); }
  async getChat(chatId,fallback={}){ const chat=await this.client.getChat(String(chatId),fallback); return {...chat,id:String(chat.id||chatId),_nativeId:String(chat.id||chatId),_siteId:'default',_siteName:this.site.name}; }
  chatDiagnostics(chat){ return this.client.chatDiagnostics(chat); }
  sendMessage(chatId,text){ return this.client.sendMessage(String(chatId),text); }
  endChat(chatId){ return this.client.endChat(String(chatId)); }
  prepareImageAttachments(a){ return this.client.prepareImageAttachments(a); }
  test(){ return this.client.test(); }
  getSiteMeta(){ return this.site; }
  getWebhookSecret(){ return String(this.site.webhookSecret||''); }
}
