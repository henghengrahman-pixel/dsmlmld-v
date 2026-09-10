import { config } from './config.js';
import { LiveChatCannedClient } from './canned.js';
import { LiveChatHub } from './livechat-hub.js';
import * as db from './db.js';

const hub=new LiveChatHub();
const entries=(hub.sites||[]).map(site=>({site,client:new LiveChatCannedClient({accountId:site.accountId,pat:site.pat,base:config.lcCannedApiBase})}));
const client=(entries.find(x=>x.site.id==='default')||entries[0])?.client || new LiveChatCannedClient();
let timer=null,running=false,lastResult=null,lastError=null,lastRun=null;
export function cannedSyncStatus(){return {enabled:config.lcCannedSyncEnabled,running,lastResult,lastError,lastRun,intervalMinutes:config.lcCannedSyncMinutes,configured:entries.filter(x=>x.client.ready()).length>0,siteCount:entries.length};}
export async function syncCannedNow({manual=false,siteId=null}={}){
  if(!manual){const enabled=Boolean(await db.getSetting('system_enabled',true));if(!enabled)return {ok:true,paused:true,skipped:'system_off'};}
  if(running)return {ok:true,skipped:'already_running'};
  running=true;lastError=null;
  try{
    const targets=siteId?entries.filter(x=>x.site.id===String(siteId)):entries;
    if(!targets.length) throw new Error(`LIVECHAT_SITE_NOT_FOUND:${siteId}`);
    const sites=[]; const errors=[];
    for(const {site,client:c} of targets){
      if(!c.ready()){errors.push({siteId:site.id,error:'CANNED_CREDENTIALS_MISSING'});continue;}
      try{const data=await c.listAll();const saved=await db.syncCannedResponses(data.items,site.id);sites.push({siteId:site.id,name:site.name,source:data.source,action:data.action,received:data.items.length,...saved});}
      catch(e){errors.push({siteId:site.id,error:e.message});await db.logError('canned','SITE_SYNC_FAILED',e.message,{siteId:site.id});}
    }
    if(!sites.length&&errors.length) throw new Error(errors.map(x=>`${x.siteId}:${x.error}`).join(' | '));
    lastRun=new Date().toISOString();lastResult={ok:true,sites,errors,received:sites.reduce((n,x)=>n+x.received,0),upserted:sites.reduce((n,x)=>n+x.upserted,0)};return lastResult;
  }catch(e){lastError=e.message;await db.logError('canned','SYNC_FAILED',e.message);throw e;}finally{running=false;}
}
export async function testCannedSites(siteId=null){
  const targets=siteId?entries.filter(x=>x.site.id===String(siteId)):entries;const sites=[];
  for(const {site,client:c} of targets){try{sites.push({siteId:site.id,name:site.name,...await c.test()});}catch(e){sites.push({siteId:site.id,name:site.name,ok:false,error:e.message});}}
  return {ok:sites.some(x=>x.ok),sites};
}
export function startCannedSync(){
  if(!config.lcCannedSyncEnabled)return;
  const run=async()=>{try{await syncCannedNow();}catch{}finally{timer=setTimeout(run,config.lcCannedSyncMinutes*60_000);}};
  timer=setTimeout(run,5000);
}
export { client as cannedClient };
