import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('authoritative System banner greeting key is event based, not reusable thread based',()=>{
  const src=fs.readFileSync(new URL('../src/engine.js',import.meta.url),'utf8');
  assert.match(src,/const threadKey=exactWelcomeBanner/);
  assert.match(src,/`welcome:\$\{bannerEventKey\}`/);
  assert.match(src,/rawThreadKey \|\| `welcome:\$\{bannerEventKey\}`/);
});

test('poller retries a fresh welcome banner even when message was already inserted',()=>{
  const src=fs.readFileSync(new URL('../src/poller.js',import.meta.url),'utf8');
  assert.match(src,/async function ensureFreshWelcomeGreeting/);
  assert.match(src,/processGreetingTrigger\(\{/);
  assert.match(src,/await ensureFreshWelcomeGreeting\(chatId,events,livechat\)/);
});

test('welcome retry remains idempotent through processGreetingTrigger claim',()=>{
  const engine=fs.readFileSync(new URL('../src/engine.js',import.meta.url),'utf8');
  assert.match(engine,/claimGreetingForThread\(chatId,threadKey\)/);
  assert.match(engine,/greeting_already_sent_for_session/);
});
