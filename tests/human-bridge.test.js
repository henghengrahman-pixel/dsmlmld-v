import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeCategory, CATEGORIES } from '../src/bridge-category.js';

test('Human Bridge maps operational intents deterministically',()=>{
  assert.equal(bridgeCategory('FORGOT_PASSWORD'),'RESET_PASSWORD');
  assert.equal(bridgeCategory('WITHDRAW_PROBLEM'),'WD_PROBLEM');
  assert.equal(bridgeCategory('DEPOSIT_PROBLEM'),'DEPOSIT_PROBLEM');
  assert.equal(bridgeCategory('BONUS_DAILY'),'BONUS');
  assert.equal(bridgeCategory('GENERAL'),'CUSTOM');
  assert.deepEqual(CATEGORIES,['RESET_PASSWORD','WD_PROBLEM','DEPOSIT_PROBLEM','BONUS','CUSTOM']);
});
