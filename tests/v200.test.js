import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';

const read=(p)=>fs.readFileSync(p,'utf8');

test('v2 multi-site hub isolates chat ids and never exposes PAT/webhook secret',()=>{
  const script=`
    process.env.LIVECHAT_ACCOUNT_ID='';process.env.LIVECHAT_PAT='';
    process.env.LIVECHAT_SITES_JSON=JSON.stringify([
      {id:'site-a',name:'Site A',accountId:'a1',pat:'secret-a',webhookSecret:'hook-a'},
      {id:'site-b',name:'Site B',accountId:'b1',pat:'secret-b',webhookSecret:'hook-b'}
    ]);
    const {LiveChatHub}=await import('./src/livechat-hub.js');
    const h=new LiveChatHub();
    console.log(JSON.stringify({sites:h.siteList(),a:h.scopedId('site-a','chat-1'),b:h.scopedId('site-b','chat-1'),sa:h.getWebhookSecret('site-a')}));
  `;
  const r=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:process.cwd(),encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
  const out=JSON.parse(r.stdout.trim());
  assert.equal(out.a,'site-a::chat-1');
  assert.equal(out.b,'site-b::chat-1');
  assert.equal(out.sites.length,2);
  assert.equal('pat' in out.sites[0],false);
  assert.equal('webhookSecret' in out.sites[0],false);
  assert.equal(out.sa,'hook-a');
});

test('v2 database has session case and unified event ledger',()=>{
  const s=read('src/db.js');
  assert.match(s,/CREATE TABLE IF NOT EXISTS conversation_sessions/);
  assert.match(s,/CREATE TABLE IF NOT EXISTS conversation_cases/);
  assert.match(s,/CREATE TABLE IF NOT EXISTS event_inbox/);
  assert.match(s,/idx_event_inbox_site_event/);
  assert.match(s,/idx_human_requests_one_open_case/);
});

test('v2 site knowledge and learning are isolated by site_id',()=>{
  const s=read('src/db.js');
  assert.match(s,/getKnowledge\(intent,siteId='default'\)/);
  assert.match(s,/getRelevantCanned\(query, limit=8, siteId='default'\)/);
  assert.match(s,/getHumanStyleExamples\(limit=30,siteId='default'\)/);
  assert.match(s,/listLearningExamples\(status='ALL',limit=300,siteId=null\)/);
});

test('v2 webhook verifies the original raw body and supports site-specific secrets',()=>{
  const s=read('src/server.js');
  assert.match(s,/req\.rawBody/);
  assert.match(s,/lc\.getWebhookSecret\(requestedSite\)/);
  assert.match(s,/req\.query\?\.site/);
  assert.doesNotMatch(s,/createHmac\('sha256',config\.lcWebhookSecret\)\.update\(body\)/);
});

test('v2 Telegram routing can be different for every website',()=>{
  const bridge=read('src/human-bridge.js');
  const server=read('src/server.js');
  assert.match(bridge,/root\.__sites/);
  assert.match(bridge,/request\.site_id/);
  assert.match(server,/fullRoutes\.__sites\[req\.siteId\]/);
});

test('v2 explicit new topic is not swallowed by stale operational workflow',()=>{
  const s=read('src/engine.js');
  assert.match(s,/function workflowRelevant/);
  assert.match(s,/if\(t\.startsWith\('DEPOSIT'\)\) return i\.includes\('DEPOSIT'\)/);
  assert.match(s,/if\(t\.startsWith\('BONUS'\)\) return i\.includes\('BONUS'\)/);
  assert.match(s,/const wf=workflowRelevant\(storedWf,effective\)\?storedWf:null/);
});

test('v2 reset registration reply no longer hardcodes OMTOGEL URL in engine',()=>{
  const s=read('src/engine.js');
  assert.doesNotMatch(s,/omtogelpos\.com/i);
  assert.match(s,/profile\.registerUrl/);
});

test('v2 partial multi-site outage does not clear other website inbox',()=>{
  const s=read('src/poller.js');
  assert.match(s,/PARTIAL_SITE_SYNC/);
  assert.match(s,/reconciliation skipped for this cycle/);
});

test('v2 dashboard switches all operational data with active website',()=>{
  const s=read('public/app.js');
  assert.match(s,/X-Site-ID/);
  assert.match(s,/loadBridge\(\)/);
  assert.match(s,/loadHuman\(\)/);
  assert.match(s,/loadCases\(id\)/);
});
