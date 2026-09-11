
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('new LiveChat promo banner is treated as a hard session boundary',()=>{
  const engine=fs.readFileSync(new URL('../src/engine.js',import.meta.url),'utf8');
  assert.match(engine,/welcome:\$\{String\(eventId/);
  assert.match(engine,/beginNewConversationSession/);
  assert.match(engine,/getCurrentSessionContext\(chatId,10000\)/);
});

test('old workflow cannot contaminate current-session operational history',()=>{
  const db=fs.readFileSync(new URL('../src/db.js',import.meta.url),'utf8');
  assert.match(db,/export async function getCurrentSessionContext/);
  assert.match(db,/intent='GREETING_TRIGGER'/);
  assert.match(db,/workflow_type=NULL/);
  assert.match(db,/case_brain='\{\}'::jsonb/);
});

test('greeting text remains daypart aware and first-response friendly',()=>{
  const greeting=fs.readFileSync(new URL('../src/greeting.js',import.meta.url),'utf8');
  assert.match(greeting,/Selamat \$\{part\}, bosku/);
  assert.match(greeting,/Ada yang bisa kami bantu/);
});
