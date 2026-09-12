import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('README and package declare v1.28.7 final audited',()=>{
  const pkg=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  const readme=fs.readFileSync(new URL('../README.md',import.meta.url),'utf8');
  assert.equal(pkg.version,'1.28.7');
  assert.match(readme,/Current release: v1\.28\.7 FINAL AUDITED/);
});

test('Docker install applies npmrc and excludes package-lock generation',()=>{
  const docker=fs.readFileSync(new URL('../Dockerfile',import.meta.url),'utf8');
  assert.match(docker,/COPY package\.json \.npmrc \.\//);
  assert.match(docker,/npm install --omit=dev --no-audit --no-fund --package-lock=false/);
});

test('release audit is part of npm verify',()=>{
  const pkg=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  assert.equal(pkg.scripts.verify,'npm run check && npm test -- --runInBand && npm run audit');
});
