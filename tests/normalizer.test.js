import test from 'node:test';import assert from 'node:assert/strict';import {normalizeText,detectIntent} from '../src/normalizer.js';
test('normalizes slang/typo',()=>{assert.equal(normalizeText('bos wd blm msk knp ya'),'bos withdraw belum masuk kenapa ya')});
test('detect withdraw problem',()=>{assert.equal(detectIntent('wd blm msk'),'WITHDRAW_PROBLEM')});
test('detect deposit problem typo',()=>{assert.equal(detectIntent('depsoit blm msk'),'DEPOSIT_PROBLEM')});
test('detect forgot password',()=>{assert.equal(detectIntent('paswod lupa'),'FORGOT_PASSWORD')});
test('detect min wd',()=>{assert.equal(detectIntent('min wd brp'),'MINIMUM_WITHDRAW')});
test('detect reset password slang',()=>{
  assert.equal(detectIntent('bos reset psw akun aku'),'FORGOT_PASSWORD');
});
