import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {LiveChatClient} from '../src/livechat.js';

const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('v2.1 is single-LiveChat per deployment',()=>{
  const hub=read('src/livechat-hub.js');
  const config=read('src/config.js');
  const ui=read('public/index.html');
  assert.doesNotMatch(config,/lcSitesJson|LIVECHAT_SITES_JSON/);
  assert.match(hub,/satu deployment = satu akun LiveChat/i);
  assert.doesNotMatch(ui,/siteSelect|Website aktif|data-tab="sites"/);
});

test('v2.1 retries send_event after auto follow when requester is not chat user',async()=>{
  const c=new LiveChatClient({base:'https://example.invalid',accountId:'a',pat:'p'});
  const calls=[];
  c.call=async(action,body)=>{
    calls.push([action,body]);
    if(action==='send_event' && calls.filter(x=>x[0]==='send_event').length===1){
      const e=new Error('LIVECHAT_403: Requester is not user of the chat'); e.status=403; throw e;
    }
    if(action==='follow_chat') return {ok:true};
    return {event_id:'evt-ok'};
  };
  const out=await c.sendMessage('chat-1','halo');
  assert.equal(out.event_id,'evt-ok');
  assert.deepEqual(calls.map(x=>x[0]),['send_event','follow_chat','send_event']);
  assert.equal(calls[1][1].chat_id,'chat-1');
});

test('v2.1 does not hide repeated membership failure',async()=>{
  const c=new LiveChatClient({base:'https://example.invalid',accountId:'a',pat:'p'});
  c.call=async(action)=>{
    if(action==='follow_chat') return {ok:true};
    const e=new Error('LIVECHAT_403: Requester is not user of the chat'); e.status=403; throw e;
  };
  await assert.rejects(()=>c.sendMessage('chat-1','halo'),/LIVECHAT_CHAT_MEMBERSHIP_REQUIRED/);
});

test('v2.1 all inbox still excludes closed chats',()=>{
  const c=new LiveChatClient({base:'x',accountId:'a',pat:'p'});
  const old=process.env.LIVECHAT_INBOX_MODE;
  // config is loaded already with project default=all.
  const items=[
    {id:'1',active:true,routing_status:'active',is_followed:false},
    {id:'2',active:false,routing_status:'closed',is_followed:false}
  ];
  const out=c.filterInbox(items);
  assert.equal(out.some(x=>x.id==='1'),true);
  assert.equal(out.some(x=>x.id==='2'),false);
  if(old===undefined) delete process.env.LIVECHAT_INBOX_MODE; else process.env.LIVECHAT_INBOX_MODE=old;
});

test('v2.1 smart reply keeps human-context rules',()=>{
  const ai=read('src/ai.js');
  const engine=read('src/engine.js');
  const poller=read('src/poller.js');
  assert.match(ai,/Jangan menjawab hanya dari pesan terakhir/);
  assert.match(ai,/Jangan mengulang pertanyaan/);
  assert.match(engine,/workflowRelevant/);
  assert.match(poller,/Coalesce message bursts/);
  assert.match(poller,/NEW_LIVECHAT_SESSION/);
});
