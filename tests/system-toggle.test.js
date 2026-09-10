import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('poller keeps LiveChat sync active while AI GLOBAL is off',()=>{
  const s=fs.readFileSync(new URL('../src/poller.js',import.meta.url),'utf8');
  assert.match(s,/ingestion must continue even when AI GLOBAL is OFF/);
  assert.match(s,/livechat\.listChats\(\)/);
  assert.doesNotMatch(s,/getSetting\('system_enabled'/);
});

test('engine gates OpenAI behind AI GLOBAL',()=>{
  const s=fs.readFileSync(new URL('../src/engine.js',import.meta.url),'utf8');
  const gate=s.indexOf("getSetting('system_enabled'");
  const call=s.indexOf('ai.classifyAndReply');
  assert.ok(gate>=0 && call>gate);
  assert.match(s,/AI_GLOBAL_OFF/);
});

test('dashboard exposes independent AI GLOBAL and AUTO REPLY switches',()=>{
  const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const js=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  assert.match(html,/AI GLOBAL/); assert.match(html,/id="systemEnabled"/); assert.match(html,/id="autoReply"/);
  assert.match(js,/settings\/system-enabled/); assert.match(js,/settings\/auto-reply/); assert.match(js,/data-human-card/);
});
