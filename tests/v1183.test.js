import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const engine=fs.readFileSync(new URL('../src/engine.js',import.meta.url),'utf8');

test('v1.18.3 WD WAITING_ID accepts a standalone account ID',()=>{
  assert.match(engine,/workflow_type==='WD_CHECK' && wf\?\.workflow_state==='WAITING_ID'/);
  assert.match(engine,/extractUserIdFromText\(text\) \|\| extractUserId\(ctx\) \|\| extractStandaloneRequestedUserId\(ctx\)/);
});

test('v1.18.3 WD flow does not require the member to repeat an ID label',()=>{
  assert.match(engine,/bare token such as HOKII123456/);
  assert.match(engine,/cek kepastian wd/);
});
