const typoMap = new Map(Object.entries({
  'blm':'belum','blom':'belum','belom':'belum','bloom':'belum',
  'msk':'masuk','msuk':'masuk','masok':'masuk',
  'wd':'withdraw','wede':'withdraw','withdrw':'withdraw','widraw':'withdraw',
  'dp':'deposit','depo':'deposit','depsoit':'deposit','depost':'deposit','depoist':'deposit',
  'psw':'password','pw':'password','pass':'password','paswod':'password','pasword':'password','sandi':'password','sandiku':'password','sandy':'password',
  'brp':'berapa','brpa':'berapa','brrp':'berapa',
  'min':'minimal','mins':'minimal',
  'gk':'tidak','ga':'tidak','gak':'tidak','nggak':'tidak','ngga':'tidak',
  'bsa':'bisa','bs':'bisa','bisaa':'bisa',
  'udh':'sudah','uda':'sudah','sdh':'sudah',
  'hrn':'harian','bnus':'bonus','bonuss':'bonus',
  'knp':'kenapa','kpn':'kapan','skrg':'sekarang','tdk':'tidak',
  'akun':'akun','user':'username','usr':'username','rungkad':'rungkad','bon':'bonus','klaim':'claim','claim':'claim'
}));

export function normalizeText(text='') {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@._\-\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map(w => typoMap.get(w) || w)
    .join(' ');
}

export function detectIntent(text='') {
  const t = normalizeText(text);
  const has = (...parts) => parts.every(p => t.includes(p));
  const forgotPassword = has('password','lupa') || has('lupa','password') || (t.includes('reset') && t.includes('password')) || (t.includes('ganti') && t.includes('password')) || (t.includes('password') && (t.includes('cek') || t.includes('lihat') || t.includes('ingat') || t.includes('tahu')));
  if (forgotPassword) return 'FORGOT_PASSWORD';
  if ((t.includes('withdraw') || t.includes('penarikan')) && (t.includes('belum') || t.includes('pending') || t.includes('tidak masuk') || t.includes('gangguan') || t.includes('masalah'))) return 'WITHDRAW_PROBLEM';
  if (t.includes('deposit') && (t.includes('belum') || t.includes('pending') || t.includes('tidak masuk'))) return 'DEPOSIT_PROBLEM';
  if ((t.includes('minimal') || t.includes('minimum')) && t.includes('withdraw')) return 'MINIMUM_WITHDRAW';
  if ((t.includes('minimal') || t.includes('minimum')) && t.includes('deposit')) return 'MINIMUM_DEPOSIT';
  if (t.includes('bonus') && t.includes('harian')) return 'BONUS_DAILY';
  if (t.includes('bonus')) return 'BONUS_REQUEST';
  if ((t.includes('ganti') || t.includes('ubah') || t.includes('alihkan')) && (t.includes('rekening') || t.includes('rek'))) return 'ACCOUNT_CHANGE_REQUEST';
  if ((t.includes('login') || t.includes('masuk')) && (t.includes('tidak') || t.includes('gagal') || t.includes('ga bisa') || t.includes('tidak bisa'))) return 'LOGIN_PROBLEM';
  if ((t.includes('link') || t.includes('web') || t.includes('website') || t.includes('situs')) && (t.includes('tidak bisa') || t.includes('gagal') || t.includes('akses') || t.includes('error') || t.includes('eror'))) return 'LINK_PROBLEM';
  if ((t.includes('permainan') || t.includes('game')) && (t.includes('error') || t.includes('eror') || t.includes('keluar sendiri') || t.includes('force close') || t.includes('tidak bisa'))) return 'GAME_PROBLEM';
  if (t.includes('gangguan') || t.includes('kendala sistem') || t.includes('server error') || t.includes('server eror')) return 'GENERAL_DISTURBANCE';
  if (/(kontol|goblok|bodoh|bangsat|anjing|babi|tolol|kampret|sialan)/i.test(t)) return 'ABUSIVE';
  if (t.includes('kalah') || t.includes('rungkad') || t.includes('rugi') || t.includes('boncos')) return 'LOSS_COMPLAINT';
  if (t.includes('kecewa') || t.includes('parah') || t.includes('rusak') || t.includes('marah') || t.includes('komplain')) return 'COMPLAINT';
  if (/^(halo|hallo|hi|hai|p|test|tes)\b/.test(t)) return 'GREETING';
  return 'GENERAL';
}
