/* ══════════════════════════════════════
   小学识字2500 · 学习伙伴 — 应用逻辑 v2
   含：SRS间隔复习 / 专注模式 / 笔顺练习 /
   家长面板 / 设置 / 自动备份与同步
   ══════════════════════════════════════ */

(function() {
'use strict';

// ─── 工具 ──────────────────────
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return Array.from(document.querySelectorAll(sel)); }
// 全部用本地时区日期，避免 toISOString 的 UTC 偏移
function localDateStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
    '-' + String(d.getDate()).padStart(2, '0');
}
function todayDateStr() { return localDateStr(new Date()); }
function parseDate(s) {
  const p = s.split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2]);
}
function addDays(dateStr, n) {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + n);
  return localDateStr(d);
}
function daysBetween(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / 86400000);
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function highlightChar(sentence) {
  return sentence.replace(/\(([^)]+)\)/g, '<span class="highlight">$1</span>');
}

// ─── 状态 v2 + 迁移 ──────────────
const STORAGE_KEY = 'chinese2500_state';
const DEFAULT_SETTINGS = {
  perDay: 10, profile: 'beginner', showPinyin: true,
  ttsRate: 0.8, ttsVoice: '', theme: 'light', font: 'default',
  fontSize: 'normal', reducedMotion: false
};

function freshState() {
  return {
    version: 2,
    srs: {},              // char -> {lv,due,last,ok,ng}
    streak: 0,
    lastStudyDate: null,
    lastExportDate: null,
    quizScores: [],
    activity: {},         // date -> {newC,rev,ok,ng,min}
    settings: { ...DEFAULT_SETTINGS },
    onboarded: false
  };
}

function migrateV1(old) {
  const s = freshState();
  s.streak = old.streak || 0;
  s.lastStudyDate = old.lastStudyDate || null;
  s.quizScores = old.quizScores || [];
  const today = todayDateStr();
  (old.learnedChars || []).forEach(ch => {
    s.srs[ch] = { lv: 2, due: addDays(today, 3), last: today, ok: 1, ng: 0 };
  });
  return s;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (!s.version || s.version < 2) return migrateV1(s);
      s.settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
      return s;
    }
  } catch (e) {}
  return freshState();
}
let state = loadState();

// ─── IndexedDB 自动备份镜像 ──────────
let _idb = null;
function idbOpen() {
  return new Promise(res => {
    if (_idb) return res(_idb);
    if (!window.indexedDB) return res(null);
    let req;
    try { req = indexedDB.open('chinese2500_backup', 1); }
    catch (e) { return res(null); }
    req.onupgradeneeded = e => e.target.result.createObjectStore('kv');
    req.onsuccess = e => { _idb = e.target.result; res(_idb); };
    req.onerror = () => res(null);
  });
}
async function idbSet(key, val) {
  const db = await idbOpen();
  if (!db) return;
  try {
    db.transaction('kv', 'readwrite').objectStore('kv').put(val, key);
  } catch (e) {}
}
async function idbGet(key) {
  const db = await idbOpen();
  if (!db) return null;
  return new Promise(res => {
    try {
      const req = db.transaction('kv', 'readonly').objectStore('kv').get(key);
      req.onsuccess = () => res(req.result || null);
      req.onerror = () => res(null);
    } catch (e) { res(null); }
  });
}

let _saveTimer = null;
function saveState() {
  const json = JSON.stringify(state);
  try { localStorage.setItem(STORAGE_KEY, json); } catch (e) {}
  // 防抖写入 IndexedDB 镜像（自动备份）
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    idbSet('state', json);
    idbSet('snapshot_' + todayDateStr(), json); // 每日快照
  }, 800);
}

// 启动时：若 localStorage 丢失但 IDB 有镜像 → 自动恢复
async function tryRestoreFromIDB() {
  if (Object.keys(state.srs).length > 0 || state.lastStudyDate) return;
  const backup = await idbGet('state');
  if (backup) {
    try {
      const s = JSON.parse(backup);
      if (s && s.srs && Object.keys(s.srs).length > 0) {
        state = s;
        state.settings = { ...DEFAULT_SETTINGS, ...(state.settings || {}) };
        localStorage.setItem(STORAGE_KEY, backup);
        applySettings();
        renderHome();
        if (state.onboarded) $('#onboardingOverlay').classList.add('hidden');
        console.log('✅ 已从自动备份恢复进度');
      }
    } catch (e) {}
  }
}

// ─── 字符数据 & 动态计划 ──────────
const CHARS = window.CHARS;
const PARTS = window.PARTS;
const _localPyMap = {};
CHARS.forEach(c => { if (!_localPyMap[c.char]) _localPyMap[c.char] = c.pinyin; });
const charByChar = {};
CHARS.forEach(c => { if (!charByChar[c.char]) charByChar[c.char] = c; });
// 去重字表：每个汉字只保留一条（CHARS 里有些字在多个分类重复出现）
const UNIQUE_CHARS = CHARS.filter(c => charByChar[c.char] === c);

let PER_DAY = 10, TOTAL_DAYS = 257, charsByDay = {};
function computePlan() {
  PER_DAY = state.settings.perDay || 10;
  TOTAL_DAYS = Math.ceil(CHARS.length / PER_DAY);
  charsByDay = {};
  CHARS.forEach((c, i) => {
    const d = Math.floor(i / PER_DAY);
    (charsByDay[d] = charsByDay[d] || []).push(c);
  });
}
// 当前进度天 = 第一个还没学过的字所在的天
function getCurrentDay() {
  for (let i = 0; i < CHARS.length; i++) {
    if (!state.srs[CHARS[i].char]) return Math.min(TOTAL_DAYS - 1, Math.floor(i / PER_DAY));
  }
  return TOTAL_DAYS - 1;
}

const charsByCategory = {};
CHARS.forEach(c => {
  const key = c.part + '||' + c.category;
  (charsByCategory[key] = charsByCategory[key] || []).push(c);
});

// ─── SRS 引擎 ──────────────────
// 等级: 0=新字 1=学习中 2=熟悉 3=掌握
const SRS_INTERVALS = [0, 1, 3, 7, 21]; // 升到 lv 后间隔天数（lv3 后续 21 天循环）
const SRS_NAMES = ['新字', '学习中', '熟悉', '掌握'];
const SRS_ICONS = ['🌱', '🌿', '🌳', '⭐'];

function srsGet(ch) { return state.srs[ch] || null; }
function srsAnswer(ch, good) {
  const today = todayDateStr();
  let r = state.srs[ch];
  if (!r) r = state.srs[ch] = { lv: 0, due: today, last: null, ok: 0, ng: 0 };
  if (good) {
    r.ok++;
    r.lv = Math.min(3, r.lv + 1);
    r.due = addDays(today, SRS_INTERVALS[Math.min(r.lv + 1, 4)] || 21);
  } else {
    r.ng++;
    r.lv = Math.max(0, r.lv - 1);
    r.due = addDays(today, r.lv === 0 ? 0 : 1);
  }
  r.last = today;
  logActivity(good ? 'ok' : 'ng');
  updateStreak();
  saveState();
}
function srsDueChars() {
  const today = todayDateStr();
  return UNIQUE_CHARS.filter(c => {
    const r = state.srs[c.char];
    return r && r.due <= today;
  });
}
function srsWeakChars() {
  return UNIQUE_CHARS.filter(c => {
    const r = state.srs[c.char];
    return r && r.ng >= 2 && r.ng >= r.ok;
  });
}
function srsCountByLv() {
  const counts = [0, 0, 0, 0];
  Object.values(state.srs).forEach(r => counts[r.lv]++);
  return counts;
}

// ─── 活动日志（家长面板数据） ──────────
function logActivity(kind, val) {
  const today = todayDateStr();
  const a = state.activity[today] = state.activity[today] ||
    { newC: 0, rev: 0, ok: 0, ng: 0, min: 0 };
  if (kind === 'ok') a.ok++;
  else if (kind === 'ng') a.ng++;
  else if (kind === 'new') a.newC++;
  else if (kind === 'rev') a.rev++;
  else if (kind === 'min') a.min += val;
}
function updateStreak() {
  const today = todayDateStr();
  if (state.lastStudyDate === today) return;
  const yesterday = addDays(today, -1);
  state.streak = state.lastStudyDate === yesterday ? state.streak + 1 : 1;
  state.lastStudyDate = today;
}

// 学习时长统计：可见 + 1分钟内有交互 + 在学习类视图
let _lastInteraction = Date.now();
['pointerdown', 'keydown', 'touchstart'].forEach(ev =>
  document.addEventListener(ev, () => { _lastInteraction = Date.now(); }, { passive: true }));
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  if (Date.now() - _lastInteraction > 90000) return;
  const active = currentView === 'today' || currentView === 'quiz' || focusActive;
  if (active) { logActivity('min', 0.5); saveState(); }
}, 30000);

// ─── 语音合成（iOS 兼容） ──────────
const isiOS = /iP(hone|od|ad)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let _voices = [], _zhVoice = null, _speechUnlocked = false;
function loadVoices() {
  if (!('speechSynthesis' in window)) return;
  _voices = speechSynthesis.getVoices() || [];
  const wanted = state.settings.ttsVoice;
  _zhVoice =
    (wanted && _voices.find(v => v.name === wanted)) ||
    _voices.find(v => /zh[-_]CN/i.test(v.lang)) ||
    _voices.find(v => /^zh/i.test(v.lang)) ||
    _voices.find(v => /chinese|中文|普通话/i.test(v.name)) || null;
  populateVoiceSelect();
}
if ('speechSynthesis' in window) {
  loadVoices();
  speechSynthesis.onvoiceschanged = loadVoices;
}
function unlockSpeech() {
  if (_speechUnlocked || !('speechSynthesis' in window)) return;
  try {
    const u = new SpeechSynthesisUtterance('');
    u.volume = 0;
    speechSynthesis.speak(u);
    _speechUnlocked = true;
    loadVoices();
  } catch (e) {}
}
document.addEventListener('touchend', unlockSpeech, { once: true, passive: true });
document.addEventListener('click', unlockSpeech, { once: true });

function speak(text) {
  if (!('speechSynthesis' in window) || !text) return;
  try {
    if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.rate = state.settings.ttsRate || 0.8;
    if (_zhVoice) u.voice = _zhVoice;
    if (speechSynthesis.paused) speechSynthesis.resume();
    speechSynthesis.speak(u);
  } catch (e) {}
}

// ─── 轻柔提示音（WebAudio） ──────────
let _audioCtx = null;
function chime(kind) {
  try {
    _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = _audioCtx;
    if (ctx.state === 'suspended') ctx.resume();
    const freqsMap = {
      start: [523.25, 659.25],
      end: [659.25, 523.25, 392],
      win: [523.25, 659.25, 783.99],
      soft: [659.25]
    };
    const freqs = freqsMap[kind] || freqsMap.soft;
    freqs.forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, ctx.currentTime + i * 0.18);
      g.gain.linearRampToValueAtTime(0.12, ctx.currentTime + i * 0.18 + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.18 + 0.5);
      o.connect(g); g.connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.18);
      o.stop(ctx.currentTime + i * 0.18 + 0.55);
    });
  } catch (e) {}
}

// ─── 组词拼音 ──────────────────
const _pinyinCache = {};
function compoundPinyin(word) {
  if (!word) return '';
  if (_pinyinCache[word] != null) return _pinyinCache[word];
  let py = '';
  if (typeof pinyinPro !== 'undefined' && pinyinPro.pinyin) {
    try { py = pinyinPro.pinyin(word, { toneType: 'symbol', separator: ' ' }); } catch (e) {}
  }
  if (!py) py = Array.from(word).map(ch => _localPyMap[ch] || '?').join(' ');
  _pinyinCache[word] = py;
  return py;
}

// ─── 设置应用 ──────────────────
function applySettings() {
  const s = state.settings;
  const root = document.documentElement;
  root.dataset.theme = s.theme || 'light';
  root.dataset.font = s.font || 'default';
  root.dataset.fontsize = s.fontSize || 'normal';
  document.body.classList.toggle('reduced-motion', !!s.reducedMotion);
  computePlan();
}

// ─── 庆祝动画 ──────────────────
function celebrate(big) {
  if (state.settings.reducedMotion) { chime('win'); return; }
  chime('win');
  const layer = $('#celebrateLayer');
  const emojis = ['🎉', '⭐', '🌟', '✨', '🎈', '🌸'];
  const n = big ? 24 : 12;
  for (let i = 0; i < n; i++) {
    const el = document.createElement('div');
    el.className = 'confetti-bit';
    el.textContent = emojis[Math.floor(Math.random() * emojis.length)];
    el.style.left = (10 + Math.random() * 80) + '%';
    el.style.animationDelay = (Math.random() * 0.4) + 's';
    el.style.fontSize = (16 + Math.random() * 18) + 'px';
    layer.appendChild(el);
    setTimeout(() => el.remove(), 2200);
  }
}

// ─── 泡泡鼓励语 ──────────────────
const MASCOT_LINES = {
  greet: ['你好呀！今天也一起学汉字吧！', '欢迎回来！泡泡想你啦～', '今天学几个新朋友（字）呢？'],
  praise: ['太棒了！', '哇，你记住了！', '真厉害！继续！', '泡泡为你鼓掌！👏'],
  cheer: ['没关系，再想想～', '多看一眼就记住啦！', '慢慢来，不着急。'],
  done: ['今天完成啦！明天见！', '你真是识字小达人！', '休息一下，奖励自己！']
};
function mascotSay(kind) {
  const lines = MASCOT_LINES[kind] || MASCOT_LINES.greet;
  const line = lines[Math.floor(Math.random() * lines.length)];
  const bubble = $('#mascotBubble');
  if (bubble) bubble.textContent = line;
  return line;
}

// ─── 视图切换 ──────────────────
let currentView = 'home';
function showView(name) {
  currentView = name;
  $$('.view').forEach(v => v.classList.remove('active'));
  $$('.nav-btn, .mobile-nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  const v = $('#view-' + name);
  if (v) v.classList.add('active');
  $('#mobileNav').classList.remove('open');
  if (name === 'home') renderHome();
  if (name === 'today') renderToday();
  if (name === 'plan') renderPlan();
  if (name === 'browse') renderBrowse();
  if (name === 'quiz') resetQuiz();
  if (name === 'dashboard') renderDashboard();
  if (name === 'settings') renderSettings();
}

// ─── HOME ─────────────────────
const TREE_STAGES = [
  [0, '🌱', '小种子发芽啦'], [50, '🌿', '长出嫩叶子'], [150, '🪴', '小树苗茁壮'],
  [400, '🌳', '枝繁叶茂'], [800, '🌳🌸', '开花的大树'], [1500, '🌳🍎', '结果子啦'],
  [2400, '🌳👑', '识字之王！']
];
function renderHome() {
  const counts = srsCountByLv();
  const learned = Object.keys(state.srs).length;
  const due = srsDueChars().length;
  $('#stat-mastered').textContent = counts[3];
  $('#stat-learning').textContent = counts[1] + counts[2];
  $('#stat-due').textContent = due;
  $('#stat-streak').textContent = state.streak + '天';
  const pct = Math.round(learned / CHARS.length * 100);
  $('#progress-bar').style.width = pct + '%';
  $('#treeStats').textContent = learned + ' / ' + CHARS.length + ' 字 · ' + pct + '%';
  let stage = TREE_STAGES[0];
  TREE_STAGES.forEach(s => { if (counts[3] >= s[0]) stage = s; });
  $('#treeVisual').textContent = stage[1];
  $('#treeLabel').textContent = stage[2];
  mascotSay(due > 10 ? 'cheer' : 'greet');
  if (due > 10) $('#mascotBubble').textContent = '有 ' + due + ' 个字等着复习哦，先复习再学新的吧！';

  const grid = $('#categoryGrid');
  grid.innerHTML = '';
  PARTS.forEach(p => {
    p.cats.forEach(cat => {
      const chars = charsByCategory[p.name + '||' + cat] || [];
      if (!chars.length) return;
      const done = chars.filter(c => state.srs[c.char]).length;
      const pctC = Math.round(done / chars.length * 100);
      const card = document.createElement('div');
      card.className = 'cat-card';
      card.innerHTML =
        '<div class="cat-card-header"><span class="cat-card-name">' + cat +
        '</span><span class="cat-card-count">' + done + '/' + chars.length + '</span></div>' +
        '<div class="progress-bar-wrap"><div class="progress-bar-fill" style="width:' + pctC + '%"></div></div>';
      card.addEventListener('click', () => {
        currentBrowseFilter = { part: p.name, cat };
        showView('browse');
      });
      grid.appendChild(card);
    });
  });

  // 备份提醒：>30字进度 且 距上次导出>14天
  const last = state.lastExportDate;
  const needBackup = learned > 30 && (!last || daysBetween(last, todayDateStr()) > 14);
  $('#backupTip').classList.toggle('hidden', !needBackup ||
    localStorage.getItem('backupTipSnooze') === todayDateStr());
}

// ─── TODAY（SRS 队列） ──────────────
let todayChars = [], todayIdx = 0, todayCorrect = new Set(), todayAnswered = new Set();
let studyMode = 'today'; // today | review | new | all | custom
let customChars = null, customLabel = '', customDay = -1;
let queueNewSet = new Set(); // 本队列中哪些是新字

function getStudyChars() {
  const day = getCurrentDay();
  queueNewSet = new Set();
  if (studyMode === 'custom') return customChars ? customChars.slice() : [];
  if (studyMode === 'review') {
    // 优先到期的字；若没有到期的，退而练已学字里"最快要到期"的（最多20），保证总有字可练
    let due = srsDueChars();
    if (!due.length) {
      due = UNIQUE_CHARS.filter(c => state.srs[c.char])
        .sort((a, b) => (state.srs[a.char].due || '').localeCompare(state.srs[b.char].due || ''))
        .slice(0, 20);
    }
    return shuffle(due);
  }
  if (studyMode === 'all') return shuffle(UNIQUE_CHARS.filter(c => state.srs[c.char]));
  if (studyMode === 'new') {
    const fresh = (charsByDay[day] || []).filter(c => !state.srs[c.char]);
    fresh.forEach(c => queueNewSet.add(c.char));
    return fresh;
  }
  // today（默认）：固定就是当天那一组字（每天 perDay 个），不混入复习
  const batch = (charsByDay[day] || []).slice();
  batch.forEach(c => { if (!state.srs[c.char]) queueNewSet.add(c.char); });
  return batch;
}

function renderToday() {
  const day = getCurrentDay();
  todayChars = getStudyChars();
  todayIdx = 0;
  todayCorrect = new Set();
  todayAnswered = new Set();
  if (!todayChars.length) {
    $('#flashcardArea').classList.add('hidden');
    $('#todayComplete').classList.remove('hidden');
    const msgs = {
      today: '🎉 今天的任务全部完成啦！',
      review: '✨ 没有需要复习的字，太棒了！',
      new: '🎓 新字都学完了！',
      all: '📭 还没有学过的字，从今日任务开始吧！',
      custom: '📭 这一天没有字。'
    };
    $('#completeIcon').textContent = '🌟';
    $('#completeTitle').textContent = '没有要练的字';
    $('#completeSub').textContent = msgs[studyMode] || msgs.today;
    $('#nextDayBtn').classList.add('hidden');
    $('#todayCharsRow').innerHTML = '';
    return;
  }
  $('#flashcardArea').classList.remove('hidden');
  $('#todayComplete').classList.add('hidden');

  const w = Math.floor(day / 5) + 1, d = day % 5;
  const dueN = srsDueChars().length;
  const dueHint = dueN ? ' · 另有' + dueN + '字待复习' : '';
  const labels = {
    today: '第' + w + '周 第' + (d + 1) + '天 · ' + todayChars.length + '字' + dueHint,
    review: '复习 ' + todayChars.length + ' 个字',
    new: '只学新字 · ' + todayChars.length + ' 字',
    all: '全部已学 · ' + todayChars.length + ' 字',
    custom: customLabel
  };
  $('#today-week-label').textContent = labels[studyMode];
  renderFlashcard();
  renderTodayCharsRow();
}

function renderFlashcard() {
  if (todayIdx >= todayChars.length) return;
  const c = todayChars[todayIdx];
  $('#flashcard').classList.remove('flipped');
  const showPy = state.settings.showPinyin;
  $('#fc-pinyin').textContent = showPy ? c.pinyin : '';
  $('#fc-pinyin').style.display = showPy ? '' : 'none';
  $('#fc-char').textContent = c.char;
  $('#fc-part').textContent = c.part + ' · ' + c.category;
  const r = srsGet(c.char);
  const badge = $('#fcSrsBadge');
  if (r) {
    badge.textContent = SRS_ICONS[r.lv] + ' ' + SRS_NAMES[r.lv];
    badge.className = 'fc-srs-badge lv' + r.lv;
  } else {
    badge.textContent = '✨ 新字';
    badge.className = 'fc-srs-badge new';
  }
  $('#fc-char-small').textContent = c.char;
  const box = $('#fc-compounds');
  box.innerHTML = '';
  c.compounds.forEach(cw => {
    const tag = document.createElement('span');
    tag.className = 'compound-tag';
    tag.innerHTML = '<span class="cw-py">' + (showPy ? compoundPinyin(cw) : '') + '</span>' +
                    '<span class="cw-text">' + cw + '</span>';
    tag.addEventListener('click', e => { e.stopPropagation(); speak(cw); });
    box.appendChild(tag);
  });
  $('#fc-sentence').innerHTML = highlightChar(c.sentence);
  $('#cardIndex').textContent = (todayIdx + 1) + '/' + todayChars.length;
  $('#today-count').textContent = todayCorrect.size + ' / ' + todayChars.length + ' 字';
  $('#today-progress-bar').style.width = (todayCorrect.size / todayChars.length * 100) + '%';
}

function renderTodayCharsRow() {
  const row = $('#todayCharsRow');
  row.innerHTML = '';
  todayChars.forEach((c, i) => {
    const r = srsGet(c.char);
    const chip = document.createElement('div');
    chip.className = 'char-chip' + (r && r.lv >= 2 ? ' learned' : '') + (i === todayIdx ? ' current' : '');
    chip.innerHTML = '<div class="char-chip-char">' + c.char + '</div>' +
      '<div class="char-chip-pinyin">' + (state.settings.showPinyin ? c.pinyin : SRS_ICONS[r ? r.lv : 0]) + '</div>';
    chip.addEventListener('click', () => { todayIdx = i; renderFlashcard(); renderTodayCharsRow(); });
    row.appendChild(chip);
  });
}

function markCurrentChar(known) {
  const c = todayChars[todayIdx];
  if (!c) return;
  // 每个字每轮只记一次 SRS，反复复习不会重复加分
  if (!todayAnswered.has(c.char)) {
    const wasNew = !state.srs[c.char];
    srsAnswer(c.char, known);
    if (wasNew) logActivity('new'); else logActivity('rev');
    saveState();
    todayAnswered.add(c.char);
  }
  if (known) {
    const before = todayCorrect.size;
    todayCorrect.add(c.char);
    if (todayCorrect.size !== before && todayCorrect.size % 5 === 0) mascotSay('praise');
  } else {
    todayCorrect.delete(c.char);
  }
  // 字不会消失：按顺序往下翻，到最后一个再回到第一个
  todayIdx++;
  if (todayIdx >= todayChars.length) {
    todayIdx = 0;
    if (todayCorrect.size === todayChars.length) { finishTodaySession(); return; }
  }
  renderFlashcard();
  renderTodayCharsRow();
}

function finishTodaySession() {
  $('#flashcardArea').classList.add('hidden');
  $('#todayComplete').classList.remove('hidden');
  celebrate(true);
  const day = getCurrentDay();
  const w = Math.floor(day / 5) + 1;
  $('#completeIcon').textContent = '🎉';
  $('#completeTitle').textContent = studyMode === 'custom' ? '复习完成！' : '完成啦！';
  $('#completeSub').textContent = '这一轮学了 ' + todayCorrect.size + ' 个字 · 现在到第' + w + '周啦 · ' + mascotSay('done');
  $('#nextDayBtn').textContent = studyMode === 'custom' ? '下一天 →' : '继续下一组 →';
  $('#nextDayBtn').classList.remove('hidden');
}

// ─── PLAN：旅程地图 + 表格 ──────────
function dayStatus(dayIdx) {
  const chars = charsByDay[dayIdx] || [];
  if (!chars.length) return 'empty';
  const started = chars.filter(c => state.srs[c.char]).length;
  if (started === 0) return 'pending';
  if (started === chars.length) {
    const allMastered = chars.every(c => (state.srs[c.char] || {}).lv >= 3);
    return allMastered ? 'mastered' : 'done';
  }
  return 'partial';
}

function renderPlan() {
  renderJourneyMap();
  renderPlanTable();
}

function renderJourneyMap() {
  const map = $('#journeyMap');
  map.innerHTML = '';
  const curDay = getCurrentDay();
  const curWeek = Math.floor(curDay / 5);
  const totalWeeks = Math.ceil(TOTAL_DAYS / 5);
  for (let w = 0; w < totalWeeks; w++) {
    const node = document.createElement('div');
    node.className = 'journey-node';
    // 周内 5 天完成数
    let doneDays = 0, anyStart = false;
    for (let d = 0; d < 5; d++) {
      const st = dayStatus(w * 5 + d);
      if (st === 'done' || st === 'mastered') doneDays++;
      if (st !== 'pending' && st !== 'empty') anyStart = true;
    }
    let cls = 'future', icon = '🔒';
    if (doneDays === 5) { cls = 'done'; icon = '🌟'; }
    else if (w === curWeek) { cls = 'current'; icon = '🐼'; }
    else if (anyStart || w < curWeek) { cls = 'partial'; icon = '⛳'; }
    node.classList.add(cls);
    node.style.marginLeft = (w % 4 === 1 || w % 4 === 2 ? '40%' : '5%');
    node.innerHTML =
      '<div class="journey-icon">' + icon + '</div>' +
      '<div class="journey-week">第' + (w + 1) + '周</div>' +
      '<div class="journey-stars">' + '★'.repeat(doneDays) + '☆'.repeat(5 - doneDays) + '</div>';
    node.addEventListener('click', () => openWeekDays(w));
    map.appendChild(node);
  }
  // 滚动到当前周
  setTimeout(() => {
    const cur = map.querySelector('.journey-node.current');
    if (cur) cur.scrollIntoView({ block: 'center', behavior: state.settings.reducedMotion ? 'auto' : 'smooth' });
  }, 100);
}

function openWeekDays(week) {
  // 直接弹出该周第一天，标题带切换按钮 → 简化：弹窗显示5天选择
  const modal = $('#planModal');
  $('#planModalTitle').textContent = '第' + (week + 1) + '周 · 选择一天';
  const box = $('#planModalChars');
  box.innerHTML = '';
  box.className = 'plan-modal-chars week-days';
  for (let d = 0; d < 5; d++) {
    const dayIdx = week * 5 + d;
    const chars = charsByDay[dayIdx] || [];
    if (!chars.length) continue;
    const st = dayStatus(dayIdx);
    const stIcon = { mastered: '⭐', done: '✅', partial: '🌗', pending: '⬜' }[st] || '⬜';
    const btn = document.createElement('div');
    btn.className = 'week-day-btn ' + st;
    btn.innerHTML = '<span class="wd-icon">' + stIcon + '</span><span class="wd-label">第' + (d + 1) + '天</span>' +
      '<span class="wd-chars">' + chars.slice(0, 5).map(c => c.char).join('') + '…</span>';
    btn.addEventListener('click', () => showPlanDayChars(dayIdx));
    box.appendChild(btn);
  }
  $('#planPracticeBtn').classList.add('hidden');
  modal.classList.remove('hidden');
}

let planModalDay = -1;
function showPlanDayChars(dayIdx) {
  planModalDay = dayIdx;
  const chars = charsByDay[dayIdx] || [];
  const w = Math.floor(dayIdx / 5) + 1, d = dayIdx % 5;
  $('#planModalTitle').textContent = '第' + w + '周 第' + (d + 1) + '天 （共' + chars.length + '字）';
  const box = $('#planModalChars');
  box.className = 'plan-modal-chars';
  box.innerHTML = '';
  chars.forEach(c => {
    const r = srsGet(c.char);
    const item = document.createElement('div');
    item.className = 'plan-char-item' + (r && r.lv >= 2 ? ' learned' : '');
    item.innerHTML = '<span class="big-char">' + c.char + '</span>' +
      '<span class="small-pinyin">' + c.pinyin + '</span>' +
      '<span class="small-cw">' + (r ? SRS_ICONS[r.lv] + SRS_NAMES[r.lv] : c.compounds[0]) + '</span>';
    item.addEventListener('click', () => showCharModal(c));
    box.appendChild(item);
  });
  $('#planPracticeBtn').classList.remove('hidden');
}

function renderPlanTable() {
  const tbody = $('#planTableBody');
  tbody.innerHTML = '';
  const curDay = getCurrentDay();
  const totalWeeks = Math.ceil(TOTAL_DAYS / 5);
  for (let w = 0; w < totalWeeks; w++) {
    const tr = document.createElement('tr');
    const wcell = document.createElement('td');
    wcell.className = 'plan-week-num';
    wcell.textContent = '第' + (w + 1) + '周';
    tr.appendChild(wcell);
    for (let d = 0; d < 5; d++) {
      const dayIdx = w * 5 + d;
      const td = document.createElement('td');
      td.className = 'plan-cell';
      const chars = charsByDay[dayIdx] || [];
      if (!chars.length) {
        td.classList.add('pending');
        td.innerHTML = '<span class="plan-cell-day">—</span>';
      } else {
        const st = dayStatus(dayIdx);
        if (dayIdx === curDay) td.classList.add('current');
        else if (st === 'done' || st === 'mastered') td.classList.add('done');
        else if (st === 'pending') td.classList.add('pending');
        td.innerHTML = '<span class="plan-cell-day">第' + (d + 1) + '天</span>' +
          '<span class="plan-cell-info">' + chars.length + '字</span>';
        td.addEventListener('click', () => { showPlanDayChars(dayIdx); $('#planModal').classList.remove('hidden'); });
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

$('#planViewToggle').addEventListener('click', () => {
  const tableWrap = $('#planTableWrap');
  const mapEl = $('#journeyMap');
  const showTable = tableWrap.classList.contains('hidden');
  tableWrap.classList.toggle('hidden', !showTable);
  mapEl.classList.toggle('hidden', showTable);
  $('#planViewToggle').textContent = showTable ? '🗺️ 地图视图' : '📋 表格视图';
});

$('#planModalClose').addEventListener('click', () => $('#planModal').classList.add('hidden'));
$('#planModal').addEventListener('click', e => { if (e.target.id === 'planModal') $('#planModal').classList.add('hidden'); });

$('#planPracticeBtn').addEventListener('click', () => {
  if (planModalDay < 0) return;
  startCustomDay(planModalDay);
});
function startCustomDay(dayIdx) {
  const chars = (charsByDay[dayIdx] || []).slice();
  if (!chars.length) return;
  const w = Math.floor(dayIdx / 5) + 1, d = dayIdx % 5;
  customDay = dayIdx;
  customChars = chars;
  customLabel = '复习第' + w + '周 第' + (d + 1) + '天 · ' + chars.length + ' 字';
  studyMode = 'custom';
  $('#planModal').classList.add('hidden');
  showView('today');
  $$('.study-mode-btn').forEach(b => b.classList.remove('active'));
}

// ─── BROWSE ───────────────────
let currentBrowseFilter = null, currentSearch = '';
function renderBrowse() {
  const sb = $('#sidebarList');
  sb.innerHTML = '';
  PARTS.forEach(p => {
    const section = document.createElement('div');
    section.className = 'sidebar-section';
    const head = document.createElement('div');
    head.className = 'sidebar-part';
    head.innerHTML = p.name + '<span>›</span>';
    section.appendChild(head);
    p.cats.forEach(cat => {
      const chars = charsByCategory[p.name + '||' + cat];
      if (!chars || !chars.length) return;
      const item = document.createElement('div');
      item.className = 'sidebar-cat';
      if (currentBrowseFilter && currentBrowseFilter.part === p.name && currentBrowseFilter.cat === cat)
        item.classList.add('active');
      item.textContent = cat + ' (' + chars.length + ')';
      item.addEventListener('click', () => {
        currentBrowseFilter = { part: p.name, cat };
        currentSearch = '';
        $('#searchInput').value = '';
        renderBrowse();
        $('#browseSidebar').classList.remove('visible');
      });
      section.appendChild(item);
    });
    sb.appendChild(section);
  });

  const grid = $('#browseGrid');
  grid.innerHTML = '';
  let chars = CHARS;
  if (currentSearch) {
    const q = currentSearch.toLowerCase();
    chars = CHARS.filter(c => c.char.includes(q) || c.pinyin.toLowerCase().includes(q));
  } else if (currentBrowseFilter) {
    chars = charsByCategory[currentBrowseFilter.part + '||' + currentBrowseFilter.cat] || [];
  }
  if (!chars.length) {
    grid.innerHTML = '<div class="browse-empty">无匹配字符</div>';
    return;
  }
  chars.slice(0, 500).forEach(c => {
    const r = srsGet(c.char);
    const card = document.createElement('div');
    card.className = 'browse-char-card' + (r && r.lv >= 2 ? ' learned' : '');
    card.innerHTML = '<span class="bc-char">' + c.char + '</span>' +
      '<span class="bc-pinyin">' + c.pinyin + '</span>' +
      '<span class="bc-cw">' + (c.compounds[0] || '') + '</span>';
    card.addEventListener('click', () => showCharModal(c));
    grid.appendChild(card);
  });
  if (chars.length > 500) {
    const more = document.createElement('div');
    more.className = 'browse-empty';
    more.textContent = '显示前 500 字，共 ' + chars.length + ' 字（请用搜索缩小范围）';
    grid.appendChild(more);
  }
}
$('#searchInput').addEventListener('input', e => {
  currentSearch = e.target.value.trim();
  if (currentSearch) currentBrowseFilter = null;
  renderBrowse();
});
$('#filterToggle').addEventListener('click', () => $('#browseSidebar').classList.toggle('visible'));

// ─── 字符详情弹窗 + 笔顺 ──────────────
let currentModalChar = null, modalWriter = null;
function makeWriter(el, char, opts) {
  el.innerHTML = '';
  if (typeof HanziWriter === 'undefined') {
    el.innerHTML = '<div class="writer-fallback">' + char + '</div>';
    return null;
  }
  try {
    return HanziWriter.create(el, char, Object.assign({
      width: 160, height: 160, padding: 8,
      showOutline: true, strokeColor: '#c0392b',
      outlineColor: '#f0d5cf', drawingColor: '#e67e22',
      strokeAnimationSpeed: 1, delayBetweenStrokes: 250
    }, opts || {}));
  } catch (e) {
    el.innerHTML = '<div class="writer-fallback">' + char + '</div>';
    return null;
  }
}

function showCharModal(c) {
  currentModalChar = c;
  modalWriter = makeWriter($('#charModalWriter'), c.char);
  $('#charModalPinyin').textContent = c.pinyin;
  $('#charModalPart').textContent = c.part;
  $('#charModalCat').textContent = c.category;
  const r = srsGet(c.char);
  $('#charModalSrs').textContent = r ? SRS_ICONS[r.lv] + ' ' + SRS_NAMES[r.lv] : '✨ 还没学';
  const box = $('#charModalCompounds');
  box.innerHTML = '';
  c.compounds.forEach(cw => {
    const tag = document.createElement('span');
    tag.className = 'compound-tag';
    tag.innerHTML = '<span class="cw-py">' + compoundPinyin(cw) + '</span><span class="cw-text">' + cw + '</span>';
    tag.addEventListener('click', () => speak(cw));
    box.appendChild(tag);
  });
  $('#charModalSentence').innerHTML = highlightChar(c.sentence);
  $('#charModalKnow').textContent = r && r.lv >= 2 ? '✓ 已掌握' : '✓ 标记已学';
  $('#charModal').classList.remove('hidden');
}
$('#charModalClose').addEventListener('click', () => $('#charModal').classList.add('hidden'));
$('#charModal').addEventListener('click', e => { if (e.target.id === 'charModal') $('#charModal').classList.add('hidden'); });
$('#charModalKnow').addEventListener('click', () => {
  if (!currentModalChar) return;
  srsAnswer(currentModalChar.char, true);
  $('#charModalKnow').textContent = '✓ 已记录';
  if (currentView === 'browse') renderBrowse();
  if (currentView === 'plan') renderPlan();
});
$('#charModalSpeak').addEventListener('click', () => { if (currentModalChar) speak(currentModalChar.char); });
$('#charModalAnimate').addEventListener('click', () => { if (modalWriter) modalWriter.animateCharacter(); });
$('#charModalTrace').addEventListener('click', () => {
  if (!modalWriter) return;
  modalWriter.quiz({
    onComplete: () => {
      celebrate(false);
      if (currentModalChar) srsAnswer(currentModalChar.char, true);
    }
  });
});

// ─── QUIZ（SRS 出题） ──────────────
let quizMode = 'recognize', quizQ = 0, quizScore = 0, quizCurrent = null, quizWriter = null;
const QUIZ_DESC = {
  recognize: '看拼音，选出正确的汉字',
  compose: '看汉字，选出含该字的常用词',
  listen: '点击播放，听音选字',
  write: '看拼音和词语，写出这个字'
};

// 出题池：到期复习 + 薄弱字优先
function quizPool() {
  const due = srsDueChars();
  const weak = srsWeakChars();
  const seen = new Set();
  const pool = [];
  due.concat(weak).forEach(c => {
    if (!seen.has(c.char)) { seen.add(c.char); pool.push(c); }
  });
  if (pool.length < 8) {
    CHARS.forEach(c => {
      if (pool.length >= 20) return;
      const r = state.srs[c.char];
      if (r && !seen.has(c.char)) { seen.add(c.char); pool.push(c); }
    });
  }
  if (pool.length < 4) return { pool: UNIQUE_CHARS.slice(), label: '全部汉字' };
  return { pool, label: due.length ? '优先复习到期/薄弱字' : '从已学字中出题' };
}

function resetQuiz() {
  quizQ = 0; quizScore = 0;
  $('#quizResult').classList.add('hidden');
  $('#quizArea').classList.remove('hidden');
  $('#quizFooter').classList.remove('hidden');
  $('#quizDesc').textContent = QUIZ_DESC[quizMode];
  $('#quizScore').textContent = '0';
  nextQuestion();
}

function nextQuestion() {
  if (quizQ >= 10) { showQuizResult(); return; }
  quizQ++;
  $('#quizQ').textContent = quizQ;
  $('#quizProgressBar').style.width = (quizQ * 10) + '%';
  $('#quizFeedback').classList.add('hidden');
  $('#quizWriteArea').classList.add('hidden');
  $('#quizOptions').classList.remove('hidden');

  const { pool, label } = quizPool();
  $('#quizPoolInfo').textContent = label;
  quizCurrent = pool[Math.floor(Math.random() * pool.length)];

  if (quizMode === 'recognize') {
    $('#quizPrompt').textContent = quizCurrent.pinyin;
    $('#quizPrompt').style.cursor = '';
    $('#quizPrompt').onclick = null;
    buildCharOptions();
  } else if (quizMode === 'listen') {
    $('#quizPrompt').textContent = '🔊 点击播放';
    $('#quizPrompt').style.cursor = 'pointer';
    $('#quizPrompt').onclick = () => speak(quizCurrent.char);
    if (!isiOS) setTimeout(() => speak(quizCurrent.char), 300);
    buildCharOptions();
  } else if (quizMode === 'write') {
    $('#quizPrompt').innerHTML = quizCurrent.pinyin +
      '<div class="quiz-write-hint">' + (quizCurrent.compounds[0] || '') + '</div>';
    $('#quizPrompt').style.cursor = '';
    $('#quizPrompt').onclick = null;
    $('#quizOptions').classList.add('hidden');
    $('#quizWriteArea').classList.remove('hidden');
    startWriteQuiz();
  } else { // compose
    $('#quizPrompt').textContent = quizCurrent.char;
    $('#quizPrompt').style.cursor = '';
    $('#quizPrompt').onclick = null;
    const correct = quizCurrent.compounds[0];
    const wrongs = [];
    let tries = 0;
    while (wrongs.length < 3 && tries++ < 200) {
      const r = CHARS[Math.floor(Math.random() * CHARS.length)];
      if (r.char === quizCurrent.char) continue;
      const cw = r.compounds[0];
      if (!cw || wrongs.includes(cw) || cw === correct) continue;
      wrongs.push(cw);
    }
    renderOptionsRaw(shuffle([correct, ...wrongs]), o => o === correct);
  }
}

function startWriteQuiz() {
  let mistakes = 0;
  quizWriter = makeWriter($('#quizWriterTarget'), quizCurrent.char, {
    width: 220, height: 220, showCharacter: false, showOutline: false, showHintAfterMisses: 2
  });
  if (!quizWriter) { onAnswer(null, true); return; }
  quizWriter.quiz({
    onMistake: () => { mistakes++; },
    onComplete: () => {
      const good = mistakes <= 3;
      handleQuizResult(good, quizCurrent.char + ' (' + quizCurrent.pinyin + ')' + (good ? '' : ' — 多练几次会更好'));
    }
  });
}
$('#quizWriteHintBtn').addEventListener('click', () => {
  if (quizWriter) quizWriter.showOutline();
});
$('#quizWriteSkipBtn').addEventListener('click', () => {
  handleQuizResult(false, '正确答案：' + quizCurrent.char + ' (' + quizCurrent.pinyin + ')');
});

function buildCharOptions() {
  const correct = quizCurrent;
  const wrongs = [];
  let tries = 0;
  while (wrongs.length < 3 && tries++ < 200) {
    const r = CHARS[Math.floor(Math.random() * CHARS.length)];
    if (r.char === correct.char || wrongs.some(w => w.char === r.char)) continue;
    wrongs.push(r);
  }
  const opts = shuffle([correct, ...wrongs]);
  const wrap = $('#quizOptions');
  wrap.innerHTML = '';
  opts.forEach(o => {
    const btn = document.createElement('button');
    btn.className = 'quiz-opt';
    btn.textContent = o.char;
    btn.addEventListener('click', () => onAnswer(btn, o.char === correct.char));
    wrap.appendChild(btn);
  });
}
function renderOptionsRaw(options, isCorrect) {
  const wrap = $('#quizOptions');
  wrap.innerHTML = '';
  options.forEach(o => {
    const btn = document.createElement('button');
    btn.className = 'quiz-opt';
    btn.textContent = o;
    btn.addEventListener('click', () => onAnswer(btn, isCorrect(o)));
    wrap.appendChild(btn);
  });
}
function onAnswer(btn, correct) {
  $$('.quiz-opt').forEach(b => b.disabled = true);
  if (btn) btn.classList.add(correct ? 'correct' : 'wrong');
  if (!correct) {
    const rightAns = quizMode === 'compose' ? quizCurrent.compounds[0] : quizCurrent.char;
    $$('.quiz-opt').forEach(b => { if (b.textContent === rightAns) b.classList.add('correct'); });
  }
  handleQuizResult(correct,
    correct ? '' : '正确答案：' + (quizMode === 'compose' ? quizCurrent.compounds[0] : quizCurrent.char) +
    ' (' + quizCurrent.pinyin + ')');
}
function handleQuizResult(correct, msg) {
  // 测验也驱动 SRS
  if (state.srs[quizCurrent.char]) srsAnswer(quizCurrent.char, correct);
  if (correct) {
    quizScore++;
    $('#quizScore').textContent = quizScore;
    $('#quizFeedback').textContent = '✓ 答对了！' + (msg || '');
    $('#quizFeedback').className = 'quiz-feedback correct';
    chime('soft');
  } else {
    $('#quizFeedback').textContent = '✗ ' + (msg || '再接再厉');
    $('#quizFeedback').className = 'quiz-feedback wrong';
  }
  $('#quizFeedback').classList.remove('hidden');
  setTimeout(nextQuestion, quizMode === 'write' ? 1800 : 1400);
}
function showQuizResult() {
  $('#quizArea').classList.add('hidden');
  $('#quizResult').classList.remove('hidden');
  const pct = quizScore / 10;
  let icon = '🌟', title = '完成！';
  if (pct === 1) { icon = '🏆'; title = '满分！太棒了！'; celebrate(true); }
  else if (pct >= 0.8) { icon = '🎉'; title = '优秀！'; celebrate(false); }
  else if (pct >= 0.6) { icon = '👍'; title = '不错，继续努力！'; }
  else { icon = '📚'; title = '多多练习吧！'; }
  $('#resultIcon').textContent = icon;
  $('#resultTitle').textContent = title;
  $('#resultScore').textContent = '得分：' + quizScore + '/10';
  state.quizScores.push({ mode: quizMode, score: quizScore, date: todayDateStr() });
  saveState();
}

// ─── 专注模式 ──────────────────
let focusActive = false, focusQueue = [], focusIdx = 0, focusFlipped = false;
let focusEndTime = 0, focusTimerInterval = null, focusMinutes = 10;
let focusDone = 0, focusBreakShown = false;

$('#focusBtn').addEventListener('click', () => {
  $('#focusOverlay').classList.remove('hidden');
  $('#focusSetup').classList.remove('hidden');
  $('#focusSession').classList.add('hidden');
  $('#focusBreak').classList.add('hidden');
  $('#focusDone').classList.add('hidden');
});
$$('.focus-dur-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.focus-dur-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    focusMinutes = parseInt(btn.dataset.min, 10);
  });
});
$('#focusCancelBtn').addEventListener('click', () => $('#focusOverlay').classList.add('hidden'));
$('#focusStartBtn').addEventListener('click', startFocusSession);

function startFocusSession() {
  const due = shuffle(srsDueChars());
  const day = getCurrentDay();
  const fresh = (charsByDay[day] || []).filter(c => !state.srs[c.char]);
  focusQueue = due.concat(fresh);
  if (!focusQueue.length) focusQueue = shuffle(UNIQUE_CHARS.filter(c => state.srs[c.char])).slice(0, 30);
  if (!focusQueue.length) focusQueue = UNIQUE_CHARS.slice(0, 20);
  focusIdx = 0; focusDone = 0; focusFlipped = false; focusBreakShown = false;
  focusActive = true;
  focusEndTime = Date.now() + focusMinutes * 60000;
  $('#focusSetup').classList.add('hidden');
  $('#focusSession').classList.remove('hidden');
  chime('start');
  renderFocusCard();
  focusTimerInterval = setInterval(tickFocus, 500);
}
function tickFocus() {
  const remain = focusEndTime - Date.now();
  if (remain <= 0) { endFocusSession(); return; }
  const m = Math.floor(remain / 60000), s = Math.floor((remain % 60000) / 1000);
  $('#focusTimer').textContent = m + ':' + String(s).padStart(2, '0');
  // 中场休息提醒（只一次，>=10分钟的场次）
  if (!focusBreakShown && focusMinutes >= 10 && remain <= focusMinutes * 30000) {
    focusBreakShown = true;
    $('#focusSession').classList.add('hidden');
    $('#focusBreak').classList.remove('hidden');
    chime('soft');
  }
}
$('#focusResumeBtn').addEventListener('click', () => {
  $('#focusBreak').classList.add('hidden');
  $('#focusSession').classList.remove('hidden');
});
function renderFocusCard() {
  if (focusIdx >= focusQueue.length) focusIdx = 0;
  const c = focusQueue[focusIdx];
  if (!c) { endFocusSession(); return; }
  focusFlipped = false;
  $('#focusPinyin').textContent = state.settings.showPinyin ? c.pinyin : '';
  $('#focusChar').textContent = c.char;
  $('#focusDetail').classList.add('hidden');
  const comp = $('#focusCompounds');
  comp.innerHTML = c.compounds.map(cw => '<span class="compound-tag"><span class="cw-text">' + cw + '</span></span>').join('');
  $('#focusSentence').innerHTML = highlightChar(c.sentence);
}
$('#focusCard').addEventListener('click', () => {
  focusFlipped = !focusFlipped;
  $('#focusDetail').classList.toggle('hidden', !focusFlipped);
});
$('#focusSpeakBtn').addEventListener('click', () => {
  const c = focusQueue[focusIdx];
  if (c) speak(c.char);
});
$('#focusKnowBtn').addEventListener('click', () => focusAnswer(true));
$('#focusAgainBtn').addEventListener('click', () => focusAnswer(false));
function focusAnswer(good) {
  const c = focusQueue[focusIdx];
  if (!c) return;
  srsAnswer(c.char, good);
  if (good) {
    focusDone++;
    focusQueue.splice(focusIdx, 1);
  } else {
    focusQueue.push(focusQueue.splice(focusIdx, 1)[0]);
  }
  if (!focusQueue.length) { endFocusSession(); return; }
  if (focusIdx >= focusQueue.length) focusIdx = 0;
  renderFocusCard();
}
$('#focusExitBtn').addEventListener('click', endFocusSession);
function endFocusSession() {
  clearInterval(focusTimerInterval);
  focusActive = false;
  chime('end');
  $('#focusSession').classList.add('hidden');
  $('#focusBreak').classList.add('hidden');
  $('#focusDone').classList.remove('hidden');
  $('#focusDoneIcon').textContent = focusDone >= 10 ? '🏆' : '🎉';
  $('#focusDoneSummary').textContent = '这次专注学会了 ' + focusDone + ' 个字，真棒！';
  celebrate(focusDone >= 10);
  saveState();
}
$('#focusDoneBtn').addEventListener('click', () => {
  $('#focusOverlay').classList.add('hidden');
  renderHome();
});

// ─── 家长面板 ──────────────────
function renderDashboard() {
  const counts = srsCountByLv();
  const learned = Object.keys(state.srs).length;
  const weak = srsWeakChars();
  const today = todayDateStr();

  // 活跃天数统计
  const allDates = Object.keys(state.activity).sort();
  const last7 = []; const last30 = [];
  for (let i = 0; i < 30; i++) {
    const d = addDays(today, -i);
    if (state.activity[d] && (state.activity[d].ok + state.activity[d].ng) > 0) {
      last30.push(d);
      if (i < 7) last7.push(d);
    }
  }
  const totalMin = allDates.reduce((sum, d) => sum + (state.activity[d].min || 0), 0);

  $('#dashSummary').innerHTML = [
    ['📚 已接触', learned + ' 字'],
    ['⭐ 已掌握', counts[3] + ' 字'],
    ['🌿 学习中', (counts[0] + counts[1] + counts[2]) + ' 字'],
    ['⚠️ 薄弱字', weak.length + ' 字'],
    ['🔥 连续', state.streak + ' 天'],
    ['📅 本周活跃', last7.length + '/7 天'],
    ['🗓️ 本月活跃', last30.length + '/30 天'],
    ['⏱️ 累计时长', Math.round(totalMin) + ' 分钟']
  ].map(([k, v]) => '<div class="dash-stat"><div class="dash-stat-v">' + v + '</div><div class="dash-stat-k">' + k + '</div></div>').join('');

  // 14天正确率图
  let accHtml = '<div class="chart-bars">';
  for (let i = 13; i >= 0; i--) {
    const d = addDays(today, -i);
    const a = state.activity[d];
    const total = a ? a.ok + a.ng : 0;
    const acc = total ? Math.round(a.ok / total * 100) : 0;
    const h = total ? Math.max(8, acc) : 2;
    accHtml += '<div class="chart-col"><div class="chart-bar acc" style="height:' + h + '%" title="' +
      d + ' 正确率' + acc + '% (' + total + '题)"></div><div class="chart-x">' + d.slice(8) + '</div></div>';
  }
  accHtml += '</div><div class="chart-note">柱高 = 当天正确率（鼠标悬停看详情）</div>';
  $('#dashAccuracyChart').innerHTML = accHtml;

  // 14天时长图
  let maxMin = 1;
  for (let i = 0; i < 14; i++) {
    const a = state.activity[addDays(today, -i)];
    if (a) maxMin = Math.max(maxMin, a.min);
  }
  let timeHtml = '<div class="chart-bars">';
  for (let i = 13; i >= 0; i--) {
    const d = addDays(today, -i);
    const a = state.activity[d];
    const min = a ? a.min : 0;
    const h = Math.max(min / maxMin * 100, min > 0 ? 8 : 2);
    timeHtml += '<div class="chart-col"><div class="chart-bar time" style="height:' + h + '%" title="' +
      d + ' ' + Math.round(min) + '分钟"></div><div class="chart-x">' + d.slice(8) + '</div></div>';
  }
  timeHtml += '</div>';
  $('#dashTimeChart').innerHTML = timeHtml;

  // 薄弱字
  $('#weakCount').textContent = weak.length ? '（' + weak.length + '）' : '';
  $('#weakList').innerHTML = weak.length
    ? weak.slice(0, 40).map(c => {
        const r = state.srs[c.char];
        return '<span class="dash-char weak" data-char="' + c.char + '">' + c.char +
          '<small>' + r.ng + '错</small></span>';
      }).join('')
    : '<p class="dash-empty">没有特别薄弱的字，很棒！</p>';

  // 最近掌握
  const mastered = UNIQUE_CHARS.filter(c => (state.srs[c.char] || {}).lv >= 3)
    .sort((a, b) => (state.srs[b.char].last || '').localeCompare(state.srs[a.char].last || ''));
  $('#masteredCount').textContent = '（' + mastered.length + '）';
  $('#masteredList').innerHTML = mastered.length
    ? mastered.slice(0, 40).map(c => '<span class="dash-char good" data-char="' + c.char + '">' + c.char + '</span>').join('')
    : '<p class="dash-empty">继续加油，很快就有掌握的字啦！</p>';

  // 分类强弱
  let catHtml = '';
  PARTS.forEach(p => {
    p.cats.forEach(cat => {
      const chars = charsByCategory[p.name + '||' + cat] || [];
      if (!chars.length) return;
      const touched = chars.filter(c => state.srs[c.char]);
      if (!touched.length) return;
      let ok = 0, ng = 0;
      touched.forEach(c => { ok += state.srs[c.char].ok; ng += state.srs[c.char].ng; });
      const acc = ok + ng ? Math.round(ok / (ok + ng) * 100) : 0;
      const cls = acc >= 85 ? 'good' : acc >= 65 ? 'mid' : 'low';
      catHtml += '<div class="dash-cat-row"><span class="dash-cat-name">' + cat + '</span>' +
        '<div class="progress-bar-wrap thin"><div class="progress-bar-fill ' + cls + '" style="width:' + acc + '%"></div></div>' +
        '<span class="dash-cat-acc">' + acc + '%</span></div>';
    });
  });
  $('#dashCats').innerHTML = catHtml || '<p class="dash-empty">还没有数据</p>';

  // 点字查看详情
  $$('.dash-char').forEach(el => {
    el.addEventListener('click', () => {
      const c = charByChar[el.dataset.char];
      if (c) showCharModal(c);
    });
  });
}

// ─── 设置 ──────────────────────
function populateVoiceSelect() {
  const sel = $('#setTtsVoice');
  if (!sel) return;
  const zh = _voices.filter(v => /^zh/i.test(v.lang) || /chinese|中文/i.test(v.name));
  const cur = state.settings.ttsVoice;
  sel.innerHTML = '<option value="">自动选择</option>' +
    zh.map(v => '<option value="' + v.name + '"' + (v.name === cur ? ' selected' : '') + '>' +
      v.name + '</option>').join('');
}
function renderSettings() {
  const s = state.settings;
  $('#setPerDay').value = String(s.perDay);
  $('#setProfile').value = s.profile;
  $('#setShowPinyin').checked = s.showPinyin;
  $('#setTtsRate').value = s.ttsRate;
  $('#rateValue').textContent = s.ttsRate;
  $('#setTheme').value = s.theme;
  $('#setFont').value = s.font;
  $('#setFontSize').value = s.fontSize;
  $('#setReducedMotion').checked = s.reducedMotion;
  populateVoiceSelect();
}
function bindSetting(id, key, transform, after) {
  $(id).addEventListener('change', e => {
    const val = transform ? transform(e.target) : e.target.value;
    state.settings[key] = val;
    saveState();
    applySettings();
    if (after) after(val);
  });
}
bindSetting('#setPerDay', 'perDay', el => parseInt(el.value, 10));
bindSetting('#setProfile', 'profile', el => el.value, val => {
  // 高级模式自动关拼音
  state.settings.showPinyin = val !== 'advanced';
  $('#setShowPinyin').checked = state.settings.showPinyin;
  saveState();
});
bindSetting('#setShowPinyin', 'showPinyin', el => el.checked);
bindSetting('#setTtsVoice', 'ttsVoice', el => el.value, () => loadVoices());
bindSetting('#setTheme', 'theme');
bindSetting('#setFont', 'font');
bindSetting('#setFontSize', 'fontSize');
bindSetting('#setReducedMotion', 'reducedMotion', el => el.checked);
$('#setTtsRate').addEventListener('input', e => {
  state.settings.ttsRate = parseFloat(e.target.value);
  $('#rateValue').textContent = e.target.value;
  saveState();
});
$('#setTtsRate').addEventListener('change', () => speak('你好，我是这样读的'));

// ─── 导出 / 导入 / 同步码 ──────────────
function exportPayload() {
  return { app: 'chinese-2500', version: 2, exportedAt: new Date().toISOString(), state };
}
function doExport() {
  const blob = new Blob([JSON.stringify(exportPayload(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'chinese-2500-progress-' + todayDateStr() + '.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  state.lastExportDate = todayDateStr();
  saveState();
  $('#backupTip').classList.add('hidden');
}
$('#exportBtn').addEventListener('click', doExport);
$('#backupTipExport').addEventListener('click', doExport);
$('#backupTipClose').addEventListener('click', () => {
  $('#backupTip').classList.add('hidden');
  localStorage.setItem('backupTipSnooze', todayDateStr());
});

function applyImportedState(s) {
  if (!s) throw new Error('文件格式不对');
  if (!s.version || s.version < 2) s = migrateV1(s);
  s.settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
  state = s;
  saveState();
  applySettings();
}
$('#importBtn').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', e => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const data = JSON.parse(ev.target.result);
      const s = data.state || data;
      const n = s.srs ? Object.keys(s.srs).length : (s.learnedChars || []).length;
      if (!confirm('确认导入？将覆盖当前进度。\n\n记录字数：' + n)) return;
      applyImportedState(s);
      alert('✅ 导入成功！页面即将刷新。');
      location.reload();
    } catch (err) { alert('❌ 导入失败：' + err.message); }
  };
  reader.readAsText(file);
  e.target.value = '';
});

// 同步码：gzip 压缩 + base64（现代浏览器原生支持）
async function compressText(text) {
  if (!('CompressionStream' in window)) return 'RAW.' + btoa(unescape(encodeURIComponent(text)));
  const cs = new CompressionStream('gzip');
  const blob = new Blob([text]);
  const stream = blob.stream().pipeThrough(cs);
  const buf = await new Response(stream).arrayBuffer();
  let bin = '';
  new Uint8Array(buf).forEach(b => bin += String.fromCharCode(b));
  return 'GZ.' + btoa(bin);
}
async function decompressText(code) {
  if (code.startsWith('RAW.')) return decodeURIComponent(escape(atob(code.slice(4))));
  if (!code.startsWith('GZ.')) throw new Error('同步码格式不对');
  const bin = atob(code.slice(3));
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([arr]).stream().pipeThrough(ds);
  return await new Response(stream).text();
}
$('#syncCopyBtn').addEventListener('click', async () => {
  try {
    const code = await compressText(JSON.stringify(exportPayload()));
    await navigator.clipboard.writeText(code);
    state.lastExportDate = todayDateStr();
    saveState();
    alert('✅ 同步码已复制！\n发送到另一台设备（微信/邮件均可），在那台设备上点"粘贴同步码"。');
  } catch (e) { alert('复制失败：' + e.message + '\n请改用"导出文件"。'); }
});
$('#syncPasteBtn').addEventListener('click', async () => {
  try {
    let code = '';
    try { code = await navigator.clipboard.readText(); } catch (e) {}
    if (!code || (!code.startsWith('GZ.') && !code.startsWith('RAW.'))) {
      code = prompt('请粘贴同步码：') || '';
    }
    if (!code) return;
    const text = await decompressText(code.trim());
    const data = JSON.parse(text);
    const s = data.state || data;
    const n = s.srs ? Object.keys(s.srs).length : 0;
    if (!confirm('确认导入同步码？将覆盖当前进度。\n记录字数：' + n)) return;
    applyImportedState(s);
    alert('✅ 同步成功！页面即将刷新。');
    location.reload();
  } catch (e) { alert('❌ 同步失败：' + e.message); }
});

$('#resetBtn').addEventListener('click', () => {
  if (!confirm('确认清空全部学习记录？此操作不可恢复！\n建议先导出备份。')) return;
  localStorage.removeItem(STORAGE_KEY);
  idbSet('state', null);
  alert('记录已清空，页面即将刷新。');
  location.reload();
});

// ─── 新手引导 ──────────────────
let obStep = 0;
const OB_STEPS = 4;
function showOnboarding() {
  obStep = 0;
  $('#onboardingOverlay').classList.remove('hidden');
  renderObStep();
}
function renderObStep() {
  $$('.onboarding-step').forEach(el =>
    el.classList.toggle('hidden', parseInt(el.dataset.step, 10) !== obStep));
  $('#onboardingDots').innerHTML = Array.from({ length: OB_STEPS }, (_, i) =>
    '<span class="ob-dot' + (i === obStep ? ' active' : '') + '"></span>').join('');
  $('#onboardingNextBtn').textContent = obStep === OB_STEPS - 1 ? '开始吧！🎉' : '下一步 →';
}
$('#onboardingNextBtn').addEventListener('click', () => {
  obStep++;
  if (obStep >= OB_STEPS) {
    $('#onboardingOverlay').classList.add('hidden');
    state.onboarded = true;
    saveState();
    celebrate(false);
    return;
  }
  renderObStep();
});
$('#replayOnboardingBtn').addEventListener('click', () => { showView('home'); showOnboarding(); });

// ─── 事件绑定 ──────────────────
$$('.nav-btn, .mobile-nav-btn, .icon-btn').forEach(btn => {
  if (btn.dataset.view) btn.addEventListener('click', () => showView(btn.dataset.view));
});
$('#menuToggle').addEventListener('click', () => $('#mobileNav').classList.toggle('open'));
$('#startTodayBtn').addEventListener('click', () => { studyMode = 'today'; showView('today'); });
$('#knowBtn').addEventListener('click', () => markCurrentChar(true));
$('#retryBtn').addEventListener('click', () => { mascotSay('cheer'); markCurrentChar(false); });

$('#flashcard').addEventListener('click', e => {
  if (e.target.closest('.fc-speak-btn') || e.target.closest('.fc-write-btn') || e.target.closest('.compound-tag')) return;
  $('#flashcard').classList.toggle('flipped');
});
$('#fcSpeakFrontBtn').addEventListener('click', e => {
  e.stopPropagation();
  const c = todayChars[todayIdx];
  if (c) speak(c.char);
});
$('#fcSpeakBackBtn').addEventListener('click', e => {
  e.stopPropagation();
  const c = todayChars[todayIdx];
  if (c) speak(c.sentence.replace(/[()（）]/g, ''));
});
$('#fcWriteBtn').addEventListener('click', e => {
  e.stopPropagation();
  const c = todayChars[todayIdx];
  if (c) showCharModal(c);
});

$('#nextDayBtn').addEventListener('click', () => {
  if (studyMode === 'custom') {
    const next = customDay + 1;
    if (next >= TOTAL_DAYS || !charsByDay[next] || !charsByDay[next].length) {
      alert('已是最后一天，没有下一天可练。');
      return;
    }
    startCustomDay(next);
    return;
  }
  renderToday();
});
$('#practiceAgainBtn').addEventListener('click', () => {
  todayChars = getStudyChars();
  shuffle(todayChars);
  todayIdx = 0;
  todayCorrect = new Set();
  todayAnswered = new Set();
  if (!todayChars.length) { renderToday(); return; }
  $('#todayComplete').classList.add('hidden');
  $('#flashcardArea').classList.remove('hidden');
  renderFlashcard();
  renderTodayCharsRow();
});
$('#practiceUnknownBtn').addEventListener('click', () => {
  const all = getStudyChars();
  const unknown = all.filter(c => {
    const r = state.srs[c.char];
    return !r || r.lv < 2;
  });
  if (!unknown.length) { alert('这些字都很熟啦！🎉'); return; }
  todayChars = shuffle(unknown);
  todayIdx = 0;
  todayCorrect = new Set();
  todayAnswered = new Set();
  $('#todayComplete').classList.add('hidden');
  $('#flashcardArea').classList.remove('hidden');
  renderFlashcard();
  renderTodayCharsRow();
});

$$('.study-mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.study-mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    studyMode = btn.dataset.smode;
    customChars = null; customLabel = '';
    renderToday();
  });
});
$$('.quiz-mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.quiz-mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    quizMode = btn.dataset.mode;
    resetQuiz();
  });
});
$('#quizAgainBtn').addEventListener('click', resetQuiz);

// ─── iOS 提示横幅 ──────────────────
if (isiOS && localStorage.getItem('iosTipDismissed') !== '1') {
  $('#iosTip').classList.remove('hidden');
}
$('#iosTipClose').addEventListener('click', () => {
  $('#iosTip').classList.add('hidden');
  localStorage.setItem('iosTipDismissed', '1');
});

// ─── 初始化 ──────────────────
applySettings();
renderHome();
tryRestoreFromIDB();
if (!state.onboarded) showOnboarding();
console.log('✅ 小学识字2500 v2 已加载', CHARS.length, '字 ·', TOTAL_DAYS, '天计划');

})();
