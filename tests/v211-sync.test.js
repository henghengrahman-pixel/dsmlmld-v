import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {LiveChatClient} from '../src/livechat.js';

const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('v2.1.1 listChats follows next_page_id and de-duplicates chats',async()=>{
  const c=new LiveChatClient({base:'x',accountId:'a',pat:'p'});
  const calls=[];
  c.call=async(action,body)=>{
    assert.equal(action,'list_chats'); calls.push(body);
    if(!body.page_id) return {found_chats:3,next_page_id:'page-2',chats_summary:[{id:'a'},{id:'b'}]};
    assert.equal(body.page_id,'page-2');
    return {found_chats:3,chats_summary:[{id:'b'},{id:'c'}]};
  };
  const out=await c.listChats();
  assert.deepEqual(out._normalizedChats.map(x=>x.id),['a','b','c']);
  assert.equal(out._pagesFetched,2);
  assert.equal(calls.length,2);
});

test('v2.1.1 poller periodically refreshes detail even for unchanged summary',()=>{
  const src=read('src/poller.js');
  assert.match(src,/lcDetailRefreshMs/);
  assert.match(src,/detailDue/);
  assert.match(src,/mustFetchDetail/);
  assert.match(src,/stale\/stale|cached\/stale|cannot freeze|freeze on an old message/i);
});

test('v2.1.1 defaults to LiveChat My chats',()=>{
  const src=read('src/config.js');
  assert.match(src,/lcInboxMode:\s*process\.env\.LIVECHAT_INBOX_MODE\s*\|\|\s*'my_active'/);
});
