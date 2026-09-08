import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeCategory, CATEGORIES, isTelegramBridgeCategory } from '../src/bridge-category.js';

test('Human Bridge hanya untuk reset password, WD, dan bonus',()=>{
  assert.equal(bridgeCategory('FORGOT_PASSWORD'),'RESET_PASSWORD');
  assert.equal(bridgeCategory('WITHDRAW_PROBLEM'),'WD_PROBLEM');
  assert.equal(bridgeCategory('BONUS_DAILY'),'BONUS');
  assert.equal(bridgeCategory('DEPOSIT_PROBLEM'),'PANEL_ONLY');
  assert.equal(bridgeCategory('GENERAL'),'PANEL_ONLY');
  assert.equal(isTelegramBridgeCategory('FORGOT_PASSWORD'),true);
  assert.equal(isTelegramBridgeCategory('WITHDRAW_PROBLEM'),true);
  assert.equal(isTelegramBridgeCategory('BONUS_REQUEST'),true);
  assert.equal(isTelegramBridgeCategory('DEPOSIT_PROBLEM'),false);
  assert.deepEqual(CATEGORIES,['RESET_PASSWORD','WD_PROBLEM','BONUS']);
});
