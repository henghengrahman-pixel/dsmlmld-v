import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveChatClient } from '../src/livechat.js';

test('single-LC default inbox mirrors LiveChat My chats',()=>{
 const c=new LiveChatClient({base:'x',accountId:'a',pat:'b'});
 const items=[
  {id:'1',is_followed:true,last_thread_summary:{active:true}},
  {id:'2',is_followed:false,last_thread_summary:{active:true}},
  {id:'3',is_followed:true,last_thread_summary:{active:false}},
 ];
 assert.deepEqual(c.filterInbox(items).map(x=>x.id),['1']);
});

test('isMyActiveChat still identifies followed active chats',()=>{
 const c=new LiveChatClient({base:'x',accountId:'a',pat:'b'});
 assert.equal(c.isMyActiveChat({id:'1',is_followed:true,last_thread_summary:{active:true}}),true);
 assert.equal(c.isMyActiveChat({id:'2',is_followed:false,last_thread_summary:{active:true}}),false);
 assert.equal(c.isMyActiveChat({id:'3',last_thread_summary:{active:true}}),true);
 assert.equal(c.isMyActiveChat({id:'4',last_thread_summary:{active:false}}),false);
});
