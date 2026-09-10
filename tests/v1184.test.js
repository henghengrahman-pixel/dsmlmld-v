import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractClaimUserIdFromText } from '../src/user-id.js';

test('v1.18.4 understands unlabeled account ID in a bonus claim',()=>{
  assert.equal(extractClaimUserIdFromText('klaim bonus bunglon8008'),'bunglon8008');
  assert.equal(extractClaimUserIdFromText('claim bonus harian yanid89'),'yanid89');
  assert.equal(extractClaimUserIdFromText('claim bonus harian'),'');
  assert.equal(extractClaimUserIdFromText('bonus harian bagus'),'');
});

test('v1.18.4 tracks LiveChat thread id and resets stale operational state on a new session',()=>{
  const db=fs.readFileSync(new URL('../src/db.js',import.meta.url),'utf8');
  const poller=fs.readFileSync(new URL('../src/poller.js',import.meta.url),'utf8');
  assert.match(db,/lc_thread_id TEXT/);
  assert.match(db,/resetConversationForNewSession/);
  assert.match(db,/workflow_type=NULL,workflow_state=NULL/);
  assert.match(db,/handling_mode='AI'/);
  assert.match(db,/human_requests SET status='CANCELLED'/);
  assert.match(poller,/NEW_LIVECHAT_SESSION/);
  assert.match(poller,/currentThreadId\(summary\)/);
});

test('v1.18.4 bonus operational flow uses claim-aware ID parser',()=>{
  const eng=fs.readFileSync(new URL('../src/engine.js',import.meta.url),'utf8');
  assert.match(eng,/extractClaimUserIdFromText\(text\)/);
});
