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
  'hrn':'harian','bnus':'bonus','bns':'bonus','bonuz':'bonus','bonuss':'bonus','bonuus':'bonus','bonusss':'bonus',
  'knp':'kenapa','kpn':'kapan','skrg':'sekarang','tdk':'tidak','gngguan':'gangguan','gangguanx':'gangguan','eror':'error','errorr':'error','loginn':'login','ligin':'login','lgin':'login','lupa':'lupa','alihin':'alihkan','alihkn':'alihkan','rek':'rekening',
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
  const any = (...parts) => parts.some(p => t.includes(p));

  // Password reset must win over generic login/"ga bisa masuk" so cases such as
  // "ga bisa masuk lupa psw" are routed to RESET_PASSWORD, not LOGIN_PROBLEM.
  const forgotPassword =
    has('password','lupa') || has('lupa','password') ||
    (t.includes('reset') && t.includes('password')) ||
    (t.includes('ganti') && t.includes('password')) ||
    (t.includes('password') && any('cek','lihat','ingat','tahu','lupa','hilang'));
  if (forgotPassword) return 'FORGOT_PASSWORD';

  // Account/WD redirection must be recognized before generic WD.
  if ((any('ganti','ubah','alihkan','pindah') && any('rekening','withdraw','penarikan')) ||
      (t.includes('withdraw') && any('alihkan','rekening lain','ganti rekening'))) return 'ACCOUNT_CHANGE_REQUEST';

  // Strong operational problems.
  if (any('link','web','website','situs') && any('tidak bisa','gagal','akses','error','blank','down','mati')) return 'LINK_PROBLEM';
  if (any('permainan','game') && any('error','keluar sendiri','force close','tidak bisa','macet','hang','blank')) return 'GAME_PROBLEM';
  if (any('gangguan','kendala sistem','server error','server down','maintenance','sistem error')) return 'GENERAL_DISTURBANCE';
  if (any('login','masuk') && any('tidak','gagal','tidak bisa','error','mentok','blank')) return 'LOGIN_PROBLEM';

  // WD/DP are high-risk operational categories. Route status/complaint and terse "wd/depo"
  // messages to staff instead of letting the model invent transaction state.
  if ((t.includes('withdraw') || t.includes('penarikan')) &&
      any('belum','pending','tidak masuk','gangguan','masalah','proses','lama','gagal','status','cek','alihkan')) return 'WITHDRAW_PROBLEM';
  if ((t.includes('deposit')) &&
      any('belum','pending','tidak masuk','gangguan','masalah','proses','lama','gagal','status','cek','bukti','transfer')) return 'DEPOSIT_PROBLEM';

  if ((t.includes('minimal') || t.includes('minimum')) && t.includes('withdraw')) return 'MINIMUM_WITHDRAW';
  if ((t.includes('minimal') || t.includes('minimum')) && t.includes('deposit')) return 'MINIMUM_DEPOSIT';

  if (t.includes('bonus') && t.includes('harian')) return 'BONUS_DAILY';
  if (t.includes('bonus')) return 'BONUS_REQUEST';

  // Standalone/high-risk transaction words: still confirm through staff, not free-form AI.
  if (/^(?:withdraw|penarikan)(?:\s|$)/.test(t) || t==='withdraw') return 'WITHDRAW_PROBLEM';
  if (/^(?:deposit)(?:\s|$)/.test(t) || t==='deposit') return 'DEPOSIT_PROBLEM';

  // Generic operational error after the specific checks above.
  if (any('error','gangguan','tidak bisa','gagal') && !t.includes('bonus')) return 'GENERAL_DISTURBANCE';

  if (/(kontol|goblok|bodoh|bangsat|anjing|babi|tolol|kampret|sialan)/i.test(t)) return 'ABUSIVE';
  if (t.includes('kalah') || t.includes('rungkad') || t.includes('rugi') || t.includes('boncos')) return 'LOSS_COMPLAINT';
  if (t.includes('kecewa') || t.includes('parah') || t.includes('rusak') || t.includes('marah') || t.includes('komplain')) return 'COMPLAINT';
  if (/^(halo|hallo|hi|hai|p|test|tes)\b/.test(t)) return 'GREETING';
  return 'GENERAL';
}
