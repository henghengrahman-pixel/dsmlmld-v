import test from 'node:test';
import assert from 'node:assert/strict';
import { isGreetingTriggerMessage } from '../src/greeting.js';

test('promo LiveChat message triggers greeting even when URLs vary',()=>{
  assert.equal(isGreetingTriggerMessage('Lebih Mudah Menghubungi Kami Via Telegram & Whatsapp Hanya Dengan Klik Link >> https://layanancsomtogel.live | Dapatkan Prediksi Bola Akurat Dengan Klik link >> https://livebolautama.ink'),true);
});

test('normal human agent reply is not an automatic greeting trigger',()=>{
  assert.equal(isGreetingTriggerMessage('Baik bosku, saya bantu cek dulu ya'),false);
});
