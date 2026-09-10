import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const dbSource=fs.readFileSync(new URL('../src/db.js', import.meta.url),'utf8');

test('conversation sync casts thread-id bind parameter explicitly for PostgreSQL',()=>{
  assert.match(dbSource,/\$10::text,CASE WHEN \$10::text IS NOT NULL THEN now\(\) ELSE NULL END/);
});

test('conversation sync casts visible flag used in CASE to boolean',()=>{
  assert.match(dbSource,/CASE WHEN \$4::boolean THEN now\(\) ELSE NULL END/);
});
