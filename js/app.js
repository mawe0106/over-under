'use strict';
/* =====================================================================
   Over/Under — pass-the-phone (or every-phone) chug betting game.

   Two modes:
     'ou'      Over/Under — the chugger calls their own time, everyone
               else just bets OVER or UNDER. Wrong callers are up next
               (one wrong → straight up; several wrong → spinning wheel).
     'psychic' Crystal Ball — everyone except the chugger predicts the
               exact time. Closest scores a point, furthest off chugs
               next (ties → spinning wheel).

   Room mode syncs shared state through Supabase (Postgres + Realtime);
   Solo mode keeps everything in localStorage on one phone.
   ===================================================================== */

/* ---------- tiny utils ---------- */
const $  = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') :
  Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).slice(0, 10);
const clone = o => JSON.parse(JSON.stringify(o));
const clamp2 = x => Math.round(x * 100) / 100;
// phones with EU keyboards type "5,5" — accept both comma and dot
const parseSec = v => {
  const n = parseFloat(String(v ?? '').trim().replace(',', '.'));
  return isFinite(n) ? n : NaN;
};
const pad2 = n => String(n).padStart(2, '0');
const secs = x => `${(+x).toFixed(2)}s`;
const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const makeCode = () => Array.from({ length: 4 }, () => CODE_LETTERS[Math.random() * CODE_LETTERS.length | 0]).join('');
const AVATAR_COLORS = ['#ffd60a', '#2ee6ff', '#ff2e7e', '#3dff8f', '#ff7a1a', '#8b5cf6', '#ff5c5c', '#7cf5d0'];

function fmtClock(ms) {
  ms = Math.max(0, ms);
  const m = Math.floor(ms / 60000);
  const s = Math.floor(ms / 1000) % 60;
  const h = Math.floor(ms / 10) % 100;
  return `${pad2(m)}:${pad2(s)}.${pad2(h)}`;
}

function vibrate(p) { try { navigator.vibrate && navigator.vibrate(p); } catch (e) {} }

let toastTimer = null;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

// styled replacement for window.confirm — msg may contain markup
function askConfirm(msg, okLabel, onOk) {
  const box = $('#confirmbox');
  box.classList.remove('hidden');
  box.innerHTML = `
    <div class="confirmcard">
      <p>${msg}</p>
      <div class="confirmbtns">
        <button class="btn small dim" id="cf-no">Cancel</button>
        <button class="btn small yellow" id="cf-yes">${okLabel}</button>
      </div>
    </div>`;
  $('#cf-no').onclick = () => box.classList.add('hidden');
  $('#cf-yes').onclick = () => { box.classList.add('hidden'); onOk(); };
  box.onclick = e => { if (e.target === box) box.classList.add('hidden'); };
}

function confetti() {
  const cv = $('#confetti');
  const ctx = cv.getContext('2d');
  cv.width = innerWidth; cv.height = innerHeight;
  const colors = ['#ff2e7e', '#ffd60a', '#2ee6ff', '#3dff8f', '#8b5cf6', '#ff7a1a'];
  const parts = Array.from({ length: 150 }, () => ({
    x: Math.random() * cv.width, y: -30 - Math.random() * cv.height * 0.6,
    w: 6 + Math.random() * 6, h: 8 + Math.random() * 9,
    c: colors[Math.random() * colors.length | 0],
    vy: 2.2 + Math.random() * 3.6, vx: -1.6 + Math.random() * 3.2,
    r: Math.random() * Math.PI, vr: -0.12 + Math.random() * 0.24
  }));
  const t0 = performance.now();
  (function frame(t) {
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.vy += 0.02; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
      ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (t - t0 < 3200) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, cv.width, cv.height);
  })(t0);
}

const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} },
};

/* ---------- identity & session ---------- */
let me = store.get('ou_identity') || { id: uid(), name: '' };
store.set('ou_identity', me);
const myName = () => me.name || 'This phone';

let session = store.get('ou_session'); // {mode:'room'|'solo', code?}
let S = null;                          // shared game state (source of truth mirror)
let backend = null;

const MODE_INFO = {
  ou:      { icon: '🎲', name: 'Over/Under',    blurb: 'Bet over or under the chugger’s call — wrong callers risk the wheel.' },
  psychic: { icon: '🔮', name: 'Crystal Ball', blurb: 'Predict the exact time — closest scores, furthest off chugs next.' },
};
const gameMode = () => (S && MODE_INFO[S.gameMode]) ? S.gameMode : 'ou';

/* ---------- game state ---------- */
function blankRound(n, chuggerId, mode) {
  return {
    n, chuggerId, mode,
    prediction: null, bets: {},
    timerOwner: null, timerOwnerName: null, startAt: null,
    actual: null, results: null,
    nextChuggerId: null, nextReason: null, wheelPool: null,
    push: false, maxDiff: null, newRecord: false,
  };
}
function newState(mode) {
  return {
    v: 2, mode, code: null, createdAt: Date.now(),
    gameMode: 'ou',
    hostId: null, firstChugger: null, lobbySpin: null,
    players: [], phase: 'lobby',
    round: blankRound(0, null, 'ou'),
    history: [],
  };
}

/* The room creator is the host: only their phone starts rounds. If the
   host ever drops out of the roster, the first remaining player takes over. */
function effectiveHostId() {
  if (!S || session?.mode !== 'room') return null;
  if (S.hostId && S.players.some(p => p.id === S.hostId)) return S.hostId;
  return S.players[0]?.id || null;
}
const isHost = () => session?.mode !== 'room' || effectiveHostId() === null || effectiveHostId() === me.id;
const hostName = () => nameOf(S, effectiveHostId());
const nameOf = (st, pid) => st.players.find(p => p.id === pid)?.name
  || st.history.flatMap(h => Object.entries(h.bets || {})).find(([id]) => id === pid)?.[1]?.name
  || '???';
const betDone = (bet, mode) => !!bet && (mode === 'psychic'
  ? (typeof bet.guess === 'number' && isFinite(bet.guess))
  : (bet.choice === 'over' || bet.choice === 'under'));

/* ---------- backends ---------- */
// Credentials can come from js/config.js (best: every phone gets them
// automatically) or be pasted once in-app (stored in localStorage and
// piggybacked onto invite links so friends' phones pick them up too).
function supaCreds() {
  const c = window.OU_CONFIG || {};
  const ls = store.get('ou_supa') || {};
  return {
    url: (c.SUPABASE_URL || ls.url || '').trim(),
    key: (c.SUPABASE_ANON_KEY || ls.key || '').trim(),
  };
}
const supaConfigured = () => { const c = supaCreds(); return !!(c.url && c.key); };

const loadScript = src => new Promise((res, rej) => {
  const s = document.createElement('script');
  s.src = src; s.onload = res; s.onerror = () => rej(new Error('failed to load ' + src));
  document.head.appendChild(s);
});

let supaClient = null;
async function getSupaClient() {
  if (supaClient) return supaClient;
  if (!window.supabase) {
    await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js');
  }
  const c = supaCreds();
  supaClient = window.supabase.createClient(c.url, c.key, { auth: { persistSession: false } });
  return supaClient;
}

class SupaBackend {
  constructor(client) {
    this.c = client; this.isLocal = false;
    this.offset = 0; this.channel = null; this.poll = null;
    this.status = 'connecting';
  }
  now() { return Date.now() + this.offset; }
  async rpc(fn, args) {
    const { data, error } = await this.c.rpc(fn, args);
    if (error) throw error;
    return data;
  }
  // Estimate server-clock offset once so every phone can compute
  // elapsed = serverNow() - startAt against the same clock.
  async syncClock() {
    try {
      const t0 = Date.now();
      const serverMs = await this.rpc('server_now_ms');
      const t1 = Date.now();
      if (serverMs) this.offset = Number(serverMs) - Math.round((t0 + t1) / 2);
    } catch (e) { console.warn('clock sync failed', e); }
  }
  async create(state) {
    for (let i = 0; i < 6; i++) {
      const code = makeCode();
      const ok = await this.rpc('create_room', { p_code: code, p_state: { ...state, code } });
      if (ok === true) return code;
    }
    throw new Error('Could not allocate a room code');
  }
  fetch(code)            { return this.rpc('get_room', { p_code: code }); }
  joinRoom(code, player) { return this.rpc('join_room', { p_code: code, p_player: player }); }
  save(state)            { return this.rpc('save_state', { p_code: state.code, p_state: state }); }
  setBet(code, pid, bet) { return this.rpc('set_bet', { p_code: code, p_player_id: pid, p_bet: bet }); }
  setPhase(code, from, to) { return this.rpc('set_phase', { p_code: code, p_from: from, p_to: to }); }
  async claimTimer(code, pid, name) {
    const startAt = await this.rpc('claim_timer', { p_code: code, p_player_id: pid, p_player_name: name });
    return startAt == null ? null : Number(startAt);
  }
  subscribe(code, onState) {
    this.unsubscribe();
    this.channel = this.c.channel('room-' + code)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'rooms', filter: `code=eq.${code}` },
        payload => { if (payload.new && payload.new.state) onState(payload.new.state); })
      .subscribe(status => {
        this.status = status === 'SUBSCRIBED' ? 'live' : 'connecting';
        renderHeader();
      });
    // Safety-net poll: realtime on flaky party wifi can silently drop.
    this.poll = setInterval(async () => {
      if (document.hidden) return;
      try { const st = await this.fetch(code); if (st) onState(st); } catch (e) {}
    }, 10000);
  }
  unsubscribe() {
    if (this.channel) { this.c.removeChannel(this.channel); this.channel = null; }
    if (this.poll) { clearInterval(this.poll); this.poll = null; }
  }
}

const localBackend = { isLocal: true, now: () => Date.now(), unsubscribe() {} };

/* ---------- persistence / commits ---------- */
function cacheState() {
  if (!S || !session) return;
  if (session.mode === 'solo') store.set('ou_solo_state', S);
  else if (S.code) store.set('ou_cache_' + S.code, S);
}

function commit(st) {
  S = st;
  cacheState();
  render();
  if (!backend.isLocal) {
    backend.save(st).catch(err => {
      console.error(err);
      toast('⚠️ Sync hiccup — retrying…');
      setTimeout(() => backend.save(S).catch(() => {}), 1500);
    });
  }
}

/* Bets written from many phones at once go through their own merge RPC
   so simultaneous bets never clobber each other. */
const pendingBets = {};
let flushTimer = null;
function setLocalBet(pid, patch) {
  if (!S || (S.phase !== 'betting' && S.phase !== 'guessing')) return;
  const r = S.round;
  const bet = { ...(r.bets[pid] || {}), ...patch };
  r.bets[pid] = bet;
  pendingBets[pid] = bet;
  cacheState();
  patchScreen();
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushBets, 450);
}
async function flushBets() {
  clearTimeout(flushTimer);
  const entries = Object.entries(pendingBets);
  if (!entries.length) return;
  if (backend.isLocal) {
    for (const [pid] of entries) delete pendingBets[pid];
    return;
  }
  for (const [pid, bet] of entries) {
    try { await backend.setBet(S.code, pid, bet); delete pendingBets[pid]; }
    catch (e) { console.error('bet sync failed', e); }
  }
}

function onRemoteState(st) {
  if (!st || !session || session.mode !== 'room') return;
  const bettingPhase = p => p === 'betting' || p === 'guessing';
  if (S && bettingPhase(st.phase) && st.phase === S.phase && st.round?.n === S.round?.n) {
    st = clone(st);
    Object.assign(st.round.bets, pendingBets); // keep unsent local bets on top
  } else {
    for (const k of Object.keys(pendingBets)) delete pendingBets[k];
  }
  S = st;
  cacheState();
  render();
}

/* ---------- round resolution ---------- */
function finishRound(actual) {
  const st = clone(S);
  const r = st.round;
  const mode = r.mode || st.gameMode || 'ou';
  r.actual = actual;

  const results = {};
  const award = pid => { const p = st.players.find(p => p.id === pid); if (p) p.score++; };

  let pool = [], reason = 'random';
  if (mode === 'psychic') {
    for (const [pid, bet] of Object.entries(r.bets)) {
      if (!betDone(bet, mode)) continue;
      results[pid] = { guess: bet.guess, diff: clamp2(Math.abs(bet.guess - actual)) };
    }
    const diffs = Object.values(results).map(x => x.diff);
    if (diffs.length) {
      const minD = Math.min(...diffs), maxD = Math.max(...diffs);
      for (const [pid, res] of Object.entries(results)) {
        res.closest = res.diff <= minD + 1e-9;
        res.furthest = res.diff >= maxD - 1e-9;
        if (res.closest) award(pid);
      }
      pool = Object.keys(results).filter(pid => results[pid].furthest);
      r.maxDiff = maxD;
      reason = pool.length > 1 ? 'tie-wheel' : 'furthest';
    }
  } else {
    r.push = Math.abs(actual - r.prediction) < 0.005;
    for (const [pid, bet] of Object.entries(r.bets)) {
      if (!betDone(bet, mode)) continue;
      const correct = r.push ? null :
        (bet.choice === 'over' ? actual > r.prediction : actual < r.prediction);
      results[pid] = { choice: bet.choice, correct };
      if (correct) award(pid);
    }
    const wrongs = Object.keys(results).filter(pid => results[pid].correct === false);
    if (wrongs.length) {
      pool = wrongs;
      reason = wrongs.length > 1 ? 'wrong-wheel' : 'wrong-one';
    } else if (Object.keys(results).length) {
      pool = Object.keys(results); // everybody right (or push): fate decides
      reason = pool.length > 1 ? 'all-right-wheel' : 'all-right-one';
    }
  }
  if (!pool.length) {
    pool = st.players.filter(p => p.id !== r.chuggerId).map(p => p.id);
    reason = 'random';
  }
  r.results = results;
  r.nextChuggerId = pool.length ? pool[Math.random() * pool.length | 0] : r.chuggerId;
  r.nextReason = reason;
  r.wheelPool = pool.length > 1 ? pool : null;

  const prevFastest = st.history.reduce((m, h) => Math.min(m, h.actual), Infinity);
  r.newRecord = actual < prevFastest;

  st.history.push({
    n: r.n, ts: Date.now(), mode,
    chuggerId: r.chuggerId, chuggerName: nameOf(st, r.chuggerId),
    prediction: r.prediction, actual,
    bets: Object.fromEntries(Object.entries(results).map(([pid, res]) =>
      [pid, { name: nameOf(st, pid), ...res }])),
    nextChuggerId: r.nextChuggerId,
  });
  st.phase = 'result';
  commit(st);
}

function computeStats(st) {
  const H = st.history;
  if (!H.length) return null;
  const fastest = H.reduce((a, h) => h.actual < a.actual ? h : a);
  const slowest = H.reduce((a, h) => h.actual > a.actual ? h : a);
  const avg = H.reduce((s, h) => s + h.actual, 0) / H.length;

  const per = {}; // pid -> aggregates
  const P = pid => (per[pid] ||= { name: '', chugs: [], ouW: 0, ouL: 0, psySum: 0, psyN: 0, psyWins: 0 });
  for (const h of H) {
    const mode = h.mode || 'ou';
    const c = P(h.chuggerId);
    c.name = h.chuggerName;
    c.chugs.push(h.actual);
    for (const [pid, b] of Object.entries(h.bets || {})) {
      const g = P(pid);
      g.name = b.name;
      if (mode === 'psychic') {
        if (typeof b.diff === 'number') { g.psySum += b.diff; g.psyN++; if (b.closest) g.psyWins++; }
      } else {
        if (b.correct === true) g.ouW++;
        else if (b.correct === false) g.ouL++;
      }
    }
  }
  let bestCaller = null, bestPsychic = null;
  for (const [pid, p] of Object.entries(per)) {
    p.avgChug = p.chugs.length ? p.chugs.reduce((a, b) => a + b, 0) / p.chugs.length : null;
    const n = p.ouW + p.ouL;
    p.ouRate = n ? p.ouW / n : null;
    p.ouN = n;
    p.psyAvg = p.psyN ? p.psySum / p.psyN : null;
    if (p.ouRate != null && (!bestCaller || p.ouRate > bestCaller.ouRate ||
        (p.ouRate === bestCaller.ouRate && n > bestCaller.ouN))) bestCaller = { pid, ...p };
    if (p.psyAvg != null && (!bestPsychic || p.psyAvg < bestPsychic.psyAvg)) bestPsychic = { pid, ...p };
  }
  return { rounds: H.length, fastest, slowest, avg, per, bestCaller, bestPsychic };
}

/* ---------- spinning wheel ---------- */
function renderWheel(box, names, targetIdx, onDone) {
  const n = names.length;
  const seg = 360 / n;
  box.innerHTML = `
    <div class="wheelwrap">
      <div class="wpointer">▼</div>
      <canvas class="wheelcv" width="560" height="560"></canvas>
    </div>
    <button class="btn go" id="b-spin">🎡 SPIN THE WHEEL</button>`;
  const cv = $('.wheelcv', box);
  const ctx = cv.getContext('2d');
  const cx = 280, cy = 280, R = 268;
  for (let i = 0; i < n; i++) {
    const a0 = (i * seg - 90) * Math.PI / 180;
    const a1 = ((i + 1) * seg - 90) * Math.PI / 180;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, a0, a1); ctx.closePath();
    ctx.fillStyle = AVATAR_COLORS[i % AVATAR_COLORS.length];
    ctx.fill();
    ctx.strokeStyle = '#160a2e'; ctx.lineWidth = 6; ctx.stroke();
    const mid = ((i + 0.5) * seg - 90) * Math.PI / 180;
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(mid);
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#1b0836';
    ctx.font = '900 32px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText(names[i].slice(0, 10), R - 22, 0);
    ctx.restore();
  }
  ctx.beginPath(); ctx.arc(cx, cy, 26, 0, Math.PI * 2);
  ctx.fillStyle = '#160a2e'; ctx.fill();

  // land the *center* of the winning segment under the top pointer
  const jitter = (Math.random() - 0.5) * seg * 0.5;
  const final = 5 * 360 + ((360 - (targetIdx + 0.5) * seg) % 360) + jitter;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    $('#b-spin', box)?.remove();
    vibrate(80);
    onDone();
  };
  $('#b-spin', box).onclick = () => {
    const b = $('#b-spin', box);
    if (b.disabled) return;
    b.disabled = true;
    b.textContent = '🥁 …';
    vibrate(20);
    cv.style.transition = 'transform 3.4s cubic-bezier(.12,.75,.15,1)';
    cv.style.transform = `rotate(${final}deg)`;
    cv.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, 4000); // fallback if transitionend is swallowed
  };
}

/* =====================================================================
   Rendering — full rebuild when (screen, round) changes, surgical
   patches otherwise so nobody's half-typed guess gets wiped.
   ===================================================================== */
const ui = { screen: 'home', joinCode: '', pickedChugger: null };
let builtKey = null;
const appEl = () => $('#app');

function screenKey() {
  if (!S || !session) return 'pre:' + ui.screen;
  switch (S.phase) {
    case 'lobby':    return 'lobby';
    case 'predict':  return `predict:${S.round.n}`;
    case 'betting':  return `betting:${S.round.n}:${S.players.length}`;
    case 'guessing': return `guessing:${S.round.n}:${S.players.length}`;
    case 'ready':    return `ready:${S.round.n}`;
    case 'running':  return `running:${S.round.n}`;
    case 'result':   return `result:${S.round.n}`;
  }
  return 'pre:home';
}

function render() {
  const key = screenKey();
  if (key !== builtKey) {
    builtKey = key;
    buildScreen(key);
  }
  patchScreen();
  renderHeader();
}

function renderHeader() {
  const hdr = $('#hdr'), bar = $('#scorebar');
  if (!S || !session) {
    hdr.classList.add('hidden');
    bar.classList.add('hidden');
    return;
  }
  hdr.classList.remove('hidden');
  $('#hcode').textContent = session.mode === 'room' ? (S.code || '····') : 'SOLO';
  const dot = $('#hdot');
  if (session.mode === 'room') {
    dot.classList.remove('hidden');
    dot.classList.toggle('off', backend?.status !== 'live');
  } else dot.classList.add('hidden');

  const anyScore = S.players.some(p => p.score > 0);
  if (S.phase === 'lobby' || !S.players.length) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const sorted = [...S.players].sort((a, b) => b.score - a.score);
  const top = sorted[0]?.score || 0;
  bar.innerHTML = sorted.map(p =>
    `<span class="scorechip ${anyScore && p.score === top ? 'leader' : ''}">
       ${anyScore && p.score === top ? '👑 ' : ''}<b>${esc(p.name)}</b><span class="pts">${p.score}</span>
     </span>`).join('');
}

function buildScreen(key) {
  const [kind] = key.split(':');
  const app = appEl();
  if (kind === 'pre') {
    ({ home: buildHome, newroom: buildNewRoom, join: buildJoin }[key.split(':')[1]] || buildHome)(app);
    return;
  }
  ({ lobby: buildLobby, predict: buildPredict, betting: buildBetting, guessing: buildGuessing,
     ready: buildReady, running: buildRunning, result: buildResult }[kind])(app);
}

function patchScreen() {
  if (!S || !session) return;
  if (S.phase === 'lobby') patchLobby();
  else if (S.phase === 'betting') patchBetting();
  else if (S.phase === 'guessing') patchGuessing();
  else if (S.phase === 'running') patchRunning();
}

function showScreen(name) {
  ui.screen = name;
  render();
}

/* ---------- pre-game screens ---------- */
function buildHome(app) {
  app.innerHTML = `
    <div class="hero">
      <div class="logo">🍺</div>
      <h1>OVER/UNDER</h1>
      <p class="tag">Chug. Predict. Bet. Repeat.</p>
    </div>
    <button class="btn primary big" id="b-new">🎉 New Game</button>
    <button class="btn cyan big" id="b-joinroom">📲 Join with code</button>
    <button class="btn ghost" id="b-solo">📵 Solo phone — no setup, pass it around</button>`;
  $('#b-new').onclick = () => supaConfigured() ? showScreen('newroom') : showSetupNotice();
  $('#b-joinroom').onclick = () => supaConfigured() ? showScreen('join') : showSetupNotice();
  $('#b-solo').onclick = () => startSolo();
}

function buildNewRoom(app) {
  app.innerHTML = `
    <h2>🎉 New game</h2>
    <div class="field">
      <label for="nameIn">Your name</label>
      <input type="text" id="nameIn" maxlength="16" autocomplete="off" placeholder="Jamie" value="${esc(me.name)}">
    </div>
    <button class="btn primary big" id="b-create">Create room</button>
    <button class="linkbtn" id="b-back">← Back</button>`;
  $('#b-back').onclick = () => showScreen('home');
  $('#b-create').onclick = async () => {
    const name = $('#nameIn').value.trim();
    if (!name) { toast('Enter your name first'); return; }
    $('#b-create').disabled = true;
    try { await createRoom(name); }
    catch (e) { console.error(e); toast('⚠️ Could not reach the server'); $('#b-create').disabled = false; }
  };
}

function buildJoin(app) {
  app.innerHTML = `
    <h2>📲 Join a game</h2>
    <div class="field">
      <label for="codeIn">Room code</label>
      <input type="text" id="codeIn" class="codein" maxlength="4" autocomplete="off"
             autocapitalize="characters" placeholder="WOLF" value="${esc(ui.joinCode)}">
    </div>
    <div class="field">
      <label for="nameIn">Your name</label>
      <input type="text" id="nameIn" maxlength="16" autocomplete="off" placeholder="Jamie" value="${esc(me.name)}">
    </div>
    <button class="btn primary big" id="b-join">Join room</button>
    <button class="linkbtn" id="b-back">← Back</button>`;
  $('#b-back').onclick = () => showScreen('home');
  $('#b-join').onclick = async () => {
    const code = $('#codeIn').value.trim().toUpperCase();
    const name = $('#nameIn').value.trim();
    if (code.length !== 4) { toast('Room codes are 4 letters'); return; }
    if (!name) { toast('Enter your name first'); return; }
    $('#b-join').disabled = true;
    try { await joinRoom(code, name); }
    catch (e) { console.error(e); toast('⚠️ Could not reach the server'); }
    $('#b-join') && ($('#b-join').disabled = false);
  };
}

function showSetupNotice() {
  const ov = $('#overlay');
  const creds = supaCreds();
  ov.classList.remove('hidden');
  ov.innerHTML = `
    <div class="ovl-inner">
      <div class="ovl-head"><h2>🔌 One-time backend setup</h2>
        <button class="hbtn" id="ov-close">✕</button></div>
      <div class="card">
        <p style="margin-top:0">Multi-phone rooms sync through a free Supabase project.
        <b>You set this up once, ever</b> — after that, every game is just “New Game” → share the 4-letter code.</p>
        <ol style="line-height:1.7; padding-left:20px; margin:0">
          <li>Create a project at <b>supabase.com</b> (free)</li>
          <li>Run <b>supabase/schema.sql</b> in its SQL editor</li>
          <li>Paste the project URL + anon key below <i>or</i> into <b>js/config.js</b></li>
        </ol>
      </div>
      <div class="field"><label>Supabase project URL</label>
        <input type="text" id="su-url" autocomplete="off" placeholder="https://xxxx.supabase.co" value="${esc(creds.url)}"></div>
      <div class="field"><label>anon public key</label>
        <input type="text" id="su-key" autocomplete="off" placeholder="eyJhbGciOi…" value="${esc(creds.key)}"></div>
      <button class="btn cyan" id="su-save">💾 Save on this phone</button>
      <p class="hint">Saved keys ride along on invite links, so friends who join
        through your link are set up automatically.</p>
      <button class="btn yellow big" id="ov-solo">📵 Play Solo phone instead</button>
    </div>`;
  $('#ov-close').onclick = () => ov.classList.add('hidden');
  $('#ov-solo').onclick = () => { ov.classList.add('hidden'); startSolo(); };
  $('#su-save').onclick = () => {
    const url = $('#su-url').value.trim().replace(/\/+$/, '');
    const key = $('#su-key').value.trim();
    if (!/^https:\/\/.+\.supabase\.co$/.test(url) || key.length < 20) {
      toast('That URL or key doesn’t look right'); return;
    }
    store.set('ou_supa', { url, key });
    supaClient = null; // rebuild with new creds
    ov.classList.add('hidden');
    toast('✅ Backend saved — you never have to do that again');
  };
}

/* ---------- lobby ---------- */
function buildLobby(app) {
  const isRoom = session.mode === 'room';
  app.innerHTML = `
    ${isRoom ? `
      <div class="codecard">
        <div class="sub">ROOM CODE</div>
        <div class="bigcode">${esc(S.code)}</div>
        <button class="btn small yellow" id="b-share" style="margin:10px auto 0">📤 Share invite</button>
      </div>` : `
      <h2>📵 Solo phone</h2>`}
    <h3>Game mode</h3>
    <div class="modepick" id="modePick">
      ${Object.entries(MODE_INFO).map(([m, info]) => `
        <button class="modecard" data-m="${m}">
          <span class="mtitle">${info.icon} ${info.name}</span>
          <span class="mblurb">${info.blurb}</span>
        </button>`).join('')}
    </div>
    <h3>Players <span id="pcount"></span></h3>
    <div class="roster" id="roster"></div>
    <form id="addForm" autocomplete="off">
      <input type="text" id="addName" maxlength="16" placeholder="${isRoom ? 'Add someone without a phone' : 'Add player by name'}">
      <button type="submit" aria-label="Add player">+</button>
    </form>
    <h3>Who chugs first?</h3>
    <div class="pickwrap" id="firstPick"></div>
    <button class="btn primary big" id="b-startgame" disabled>Start round 1 🍺</button>
    <div class="lockmsg thinking hidden" id="hostwait"></div>`;

  if (isRoom) $('#b-share').onclick = shareInvite;
  $('#modePick').onclick = e => {
    const card = e.target.closest('.modecard');
    if (!card || card.dataset.m === S.gameMode) return;
    const st = clone(S);
    st.gameMode = card.dataset.m;
    commit(st);
    vibrate(15);
  };
  $('#addForm').onsubmit = e => {
    e.preventDefault();
    const name = $('#addName').value.trim();
    if (!name) return;
    addPlayer(name);
    $('#addName').value = '';
  };
  $('#roster').onclick = e => {
    const rm = e.target.closest('.rm');
    if (rm) removePlayer(rm.dataset.pid);
  };
  $('#firstPick').onclick = e => {
    const chip = e.target.closest('.pickchip');
    if (!chip || ui.rouletteTimer) return;
    if (chip.id === 'b-randompick') {
      const ps = S.players;
      if (!ps.length) return;
      const winner = ps[Math.random() * ps.length | 0];
      const spin = { winner: winner.id, ts: Date.now() };
      ui.seenSpin = spin.ts;
      ui.animPick = ps[0].id; // suppress the final answer flashing early
      const st = clone(S);
      st.firstChugger = winner.id;
      st.lobbySpin = spin; // other phones play the same roulette when this lands
      commit(st);
      playRoulette(winner.id);
    } else {
      const st = clone(S);
      st.firstChugger = chip.dataset.pid;
      commit(st);
    }
  };
  $('#b-startgame').onclick = startGame;
}

/* roulette flash across the name chips, landing on a predetermined winner */
function playRoulette(winnerId) {
  if (ui.rouletteTimer) return;
  const ps = S.players;
  const idx = Math.max(0, ps.findIndex(p => p.id === winnerId));
  const hops = ps.length * 2 + idx + 1;
  let i = 0;
  ui.rouletteTimer = setInterval(() => {
    if (!S || S.phase !== 'lobby') { clearInterval(ui.rouletteTimer); ui.rouletteTimer = null; ui.animPick = null; return; }
    ui.animPick = ps[i % ps.length].id;
    patchLobby();
    vibrate(10);
    if (++i >= hops) {
      clearInterval(ui.rouletteTimer);
      ui.rouletteTimer = null;
      ui.animPick = null;
      patchLobby();
      toast(`🎲 ${nameOf(S, winnerId)} chugs first!`);
      vibrate(60);
    }
  }, 110);
}

function patchLobby() {
  if (!$('#roster')) return;
  // a fresh lobbySpin from another phone → play the same roulette here
  if (S.lobbySpin && ui.seenSpin !== S.lobbySpin.ts) {
    ui.seenSpin = S.lobbySpin.ts;
    if (!ui.rouletteTimer && S.players.length > 1 && Math.abs(Date.now() - S.lobbySpin.ts) < 15000) {
      playRoulette(S.lobbySpin.winner);
    }
  }
  $$('.modecard').forEach(c => c.classList.toggle('sel', c.dataset.m === gameMode()));
  $('#pcount').textContent = `(${S.players.length})`;
  const hostId = effectiveHostId();
  $('#roster').innerHTML = S.players.map((p, i) => `
    <div class="rosterrow">
      <span class="avatar" style="background:${AVATAR_COLORS[i % AVATAR_COLORS.length]}">${esc(p.name[0]?.toUpperCase() || '?')}</span>
      ${esc(p.name)}${p.id === hostId ? ' <span class="you" style="color:var(--yellow);font-size:13px">HOST</span>' : ''}${p.id === me.id && session.mode === 'room' ? ' <span class="you" style="color:var(--cyan);font-size:13px">YOU</span>' : ''}
      <button class="rm" data-pid="${p.id}" aria-label="Remove">✕</button>
    </div>`).join('') || '<p class="hint">Nobody yet — add at least 2 players.</p>';
  const selId = ui.animPick
    || (S.firstChugger && S.players.some(p => p.id === S.firstChugger) ? S.firstChugger : null);
  $('#firstPick').innerHTML = S.players.map(p =>
    `<button class="pickchip ${selId === p.id ? 'sel' : ''}" data-pid="${p.id}">${esc(p.name)}</button>`
  ).join('') + `<button class="pickchip" id="b-randompick">🎲 Random</button>`;
  const btn = $('#b-startgame'), wait = $('#hostwait');
  if (isHost()) {
    btn.classList.remove('hidden');
    wait.classList.add('hidden');
    btn.disabled = S.players.length < 2;
    btn.textContent = S.players.length < 2 ? 'Need at least 2 players' : 'Start round 1 🍺';
  } else {
    btn.classList.add('hidden');
    wait.classList.remove('hidden');
    wait.textContent = `⏳ ${hostName()} (host) starts the game…`;
  }
}

async function shareInvite() {
  const url = new URL(location.href);
  url.search = '?join=' + S.code;
  url.hash = '';
  // if creds only live in this phone's localStorage, hand them to joiners
  const cfg = window.OU_CONFIG || {};
  if (!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY) && supaConfigured()) {
    const c = supaCreds();
    url.hash = '#su=' + btoa(c.url + '|' + c.key);
  }
  const text = `Over/Under 🍻 — join my game with code ${S.code}: ${url}`;
  try {
    if (navigator.share) { await navigator.share({ text }); return; }
    await navigator.clipboard.writeText(text);
    toast('Invite copied 📋');
  } catch (e) { /* user cancelled */ }
}

function addPlayer(name) {
  const player = { id: uid(), name, score: 0 };
  const st = clone(S);
  st.players.push(player);
  if (backend.isLocal) { commit(st); return; }
  // atomic append server-side; realtime echoes the result to everyone
  S = st; cacheState(); render();
  backend.joinRoom(S.code, player).catch(e => { console.error(e); toast('⚠️ Sync hiccup'); });
}

function removePlayer(pid) {
  const st = clone(S);
  st.players = st.players.filter(p => p.id !== pid);
  commit(st);
}

function startGame() {
  if (S.players.length < 2 || !isHost()) return;
  const chugger = (S.firstChugger && S.players.some(p => p.id === S.firstChugger))
    ? S.firstChugger
    : S.players[Math.random() * S.players.length | 0].id;
  const st = clone(S);
  const mode = gameMode();
  st.round = blankRound((st.history.at(-1)?.n || 0) + 1, chugger, mode);
  st.phase = mode === 'psychic' ? 'guessing' : 'predict';
  commit(st);
  vibrate(30);
}

/* ---------- predict (Over/Under: the chugger calls their own time) ----------
   Room mode: only the chugger's phone can type the prediction. Everyone
   else sees a waiting screen, with a takeover link for chuggers who were
   added to the roster without a phone of their own. */
function buildPredict(app) {
  const r = S.round;
  const name = nameOf(S, r.chuggerId);
  const isRoom = session.mode === 'room';
  const isMe = isRoom && r.chuggerId === me.id;
  const canType = !isRoom || isMe || ui.takeover === r.n;
  if (!canType) {
    app.innerHTML = `
      <div class="roundtag">Round ${r.n} · ${MODE_INFO.ou.icon} ${MODE_INFO.ou.name}</div>
      <h2 style="text-align:center">🍺 ${esc(name)} chugs!</h2>
      <div class="lockmsg thinking">🤔 ${esc(name)} is thinking…</div>
      <button class="linkbtn" id="b-takeover">${esc(name)} doesn’t have a phone? Enter it from here</button>`;
    $('#b-takeover').onclick = () => { ui.takeover = r.n; builtKey = null; render(); };
    return;
  }
  app.innerHTML = `
    <div class="roundtag">Round ${r.n} · ${MODE_INFO.ou.icon} ${MODE_INFO.ou.name}</div>
    <h2 style="text-align:center">🍺 ${isMe ? 'You chug' : esc(name) + ' chugs'}!</h2>
    ${session.mode === 'solo' ? `<p class="hint">Pass the phone to <b>${esc(name)}</b> — call your time.</p>` : ''}
    <div class="predictwrap">
      <input type="text" id="predIn" inputmode="decimal" autocomplete="off" placeholder="12">
      <span class="unit">sec</span>
    </div>
    <button class="btn primary big" id="b-lock">Lock it in 🔒</button>`;
  const lock = () => {
    const v = parseSec($('#predIn').value);
    if (!isFinite(v) || v <= 0 || v > 3600) { toast('Enter the prediction in seconds'); return; }
    if (S.phase !== 'predict') return;
    const st = clone(S);
    st.round.prediction = clamp2(v);
    st.phase = 'betting';
    commit(st);
    vibrate(20);
  };
  $('#b-lock').onclick = lock;
  $('#predIn').onkeydown = e => { if (e.key === 'Enter') lock(); };
  $('#predIn').focus();
}

/* ---------- betting (Over/Under: big OVER / UNDER buttons only) ----------
   Room mode: each phone only places its own bet — everyone else shows as an
   anonymous "in / waiting" chip, and all calls are revealed on the ready
   screen. Solo mode keeps all rows (pass-the-phone). A link reveals the
   full rows for players who were added without a phone. */
function bettableRows(others) {
  const isRoom = session.mode === 'room';
  if (!isRoom || ui.helpBets === S.round.n) return others;
  return others.filter(p => p.id === me.id);
}

function buildBetting(app) {
  const r = S.round;
  const chugger = nameOf(S, r.chuggerId);
  const others = S.players.filter(p => p.id !== r.chuggerId);
  const isRoom = session.mode === 'room';
  const iChug = isRoom && r.chuggerId === me.id;
  const rows = bettableRows(others);
  app.innerHTML = `
    <div class="roundtag">Round ${r.n} · ${MODE_INFO.ou.icon} ${MODE_INFO.ou.name}</div>
    <div class="callout"><b>${iChug ? 'You' : esc(chugger)}</b> ${iChug ? 'said' : 'says'} <span class="bigpred">${r.prediction}s</span></div>
    <div id="betrows" style="display:flex;flex-direction:column;gap:10px">
      ${rows.map(p => `
        <div class="betrow ${isRoom && p.id === me.id ? 'mine' : ''}" data-pid="${p.id}">
          <div class="betname">${esc(p.name)}
            ${isRoom && p.id === me.id ? '<span class="you">you</span>' : ''}
            <span class="in hidden">✓ in</span>
          </div>
          <div class="betctl two">
            <button class="seg under" data-c="under">UNDER</button>
            <button class="seg over" data-c="over">OVER</button>
          </div>
        </div>`).join('')}
    </div>
    ${isRoom ? '<div class="statusrow" id="betstatus"></div>' : ''}
    <button class="btn go" id="b-ready" disabled>To the stopwatch ▶</button>
    ${isRoom && ui.helpBets !== r.n ? '<button class="linkbtn" id="b-helpbets">Someone without a phone? Bet for them</button>' : ''}`;

  $('#betrows').addEventListener('click', e => {
    const seg = e.target.closest('.seg');
    if (!seg) return;
    const pid = seg.closest('.betrow').dataset.pid;
    setLocalBet(pid, { choice: seg.dataset.c });
    vibrate(15);
  });
  if ($('#b-helpbets')) $('#b-helpbets').onclick = () => { ui.helpBets = r.n; builtKey = null; render(); };
  $('#b-ready').onclick = goReady;
  patchBetting();
}

function patchBetting() {
  if (!$('#betrows') || S.phase !== 'betting') return;
  const r = S.round;
  const others = S.players.filter(p => p.id !== r.chuggerId);
  let done = 0;
  for (const p of others) {
    const bet = r.bets[p.id] || {};
    const complete = betDone(bet, 'ou');
    if (complete) done++;
    const row = $(`.betrow[data-pid="${p.id}"]`);
    if (!row) continue;
    $$('.seg', row).forEach(b => b.classList.toggle('sel', bet.choice === b.dataset.c));
    row.classList.toggle('done', complete);
    $('.in', row).classList.toggle('hidden', !complete);
  }
  const status = $('#betstatus');
  if (status) status.innerHTML = others.map(p =>
    `<span class="pill ${betDone(r.bets[p.id], 'ou') ? 'in' : ''}">${esc(p.name)} ${betDone(r.bets[p.id], 'ou') ? '✓' : '…'}</span>`).join('');
  const total = others.length;
  const btn = $('#b-ready');
  btn.disabled = done === 0;
  btn.textContent = done < total ? `To the stopwatch (${done}/${total}) ▶` : 'To the stopwatch ▶';
}

/* ---------- guessing (Crystal Ball: everyone predicts the time) ---------- */
function buildGuessing(app) {
  const r = S.round;
  const chugger = nameOf(S, r.chuggerId);
  const others = S.players.filter(p => p.id !== r.chuggerId);
  const isRoom = session.mode === 'room';
  const iChug = isRoom && r.chuggerId === me.id;
  const rows = bettableRows(others);
  app.innerHTML = `
    <div class="roundtag">Round ${r.n} · ${MODE_INFO.psychic.icon} ${MODE_INFO.psychic.name}</div>
    <div class="callout"><b>${iChug ? 'You are' : esc(chugger) + ' is'}</b> about to chug 🍺<br>
      <span style="font-size:14px;color:var(--muted)">Call the exact time</span>
    </div>
    <div id="betrows" style="display:flex;flex-direction:column;gap:10px">
      ${rows.map(p => `
        <div class="betrow ${isRoom && p.id === me.id ? 'mine' : ''}" data-pid="${p.id}">
          <div class="betname">${esc(p.name)}
            ${isRoom && p.id === me.id ? '<span class="you">you</span>' : ''}
            <span class="in hidden">✓ in</span>
          </div>
          <div class="betctl solo">
            <input class="guess" type="text" inputmode="decimal" autocomplete="off" placeholder="seconds">
          </div>
        </div>`).join('')}
    </div>
    ${isRoom ? '<div class="statusrow" id="betstatus"></div>' : ''}
    <button class="btn go" id="b-ready" disabled>To the stopwatch ▶</button>
    ${isRoom && ui.helpBets !== r.n ? '<button class="linkbtn" id="b-helpbets">Someone without a phone? Predict for them</button>' : ''}`;

  $('#betrows').addEventListener('input', e => {
    const g = e.target.closest('.guess');
    if (!g) return;
    const pid = g.closest('.betrow').dataset.pid;
    const v = parseSec(g.value);
    setLocalBet(pid, { guess: isFinite(v) && v >= 0 ? clamp2(v) : null });
  });
  if ($('#b-helpbets')) $('#b-helpbets').onclick = () => { ui.helpBets = r.n; builtKey = null; render(); };
  $('#b-ready').onclick = goReady;
  patchGuessing();
}

function patchGuessing() {
  if (!$('#betrows') || S.phase !== 'guessing') return;
  const r = S.round;
  const others = S.players.filter(p => p.id !== r.chuggerId);
  let done = 0;
  for (const p of others) {
    const bet = r.bets[p.id] || {};
    const complete = betDone(bet, 'psychic');
    if (complete) done++;
    const row = $(`.betrow[data-pid="${p.id}"]`);
    if (!row) continue;
    const g = $('.guess', row);
    if (document.activeElement !== g) {
      const val = bet.guess == null ? '' : String(bet.guess);
      if (g.value !== val) g.value = val;
    }
    row.classList.toggle('done', complete);
    $('.in', row).classList.toggle('hidden', !complete);
  }
  const status = $('#betstatus');
  if (status) status.innerHTML = others.map(p =>
    `<span class="pill ${betDone(r.bets[p.id], 'psychic') ? 'in' : ''}">${esc(p.name)} ${betDone(r.bets[p.id], 'psychic') ? '✓' : '…'}</span>`).join('');
  const total = others.length;
  const btn = $('#b-ready');
  btn.disabled = done === 0;
  btn.textContent = done < total ? `To the stopwatch (${done}/${total}) ▶` : 'To the stopwatch ▶';
}

async function goReady() {
  if (!S || (S.phase !== 'betting' && S.phase !== 'guessing')) return;
  await flushBets();
  if (S.phase !== 'betting' && S.phase !== 'guessing') return;
  const from = S.phase;
  const st = clone(S);
  st.phase = 'ready';
  S = st;
  cacheState();
  render();
  vibrate(20);
  if (!backend.isLocal) {
    // phase-only write so a bet landing this instant can't get clobbered
    backend.setPhase(S.code, from, 'ready').catch(e => { console.error(e); toast('⚠️ Sync hiccup'); });
  }
}

/* ---------- ready: armed stopwatch, manual start ---------- */
function buildReady(app) {
  const r = S.round;
  const mode = r.mode || gameMode();
  const chugger = nameOf(S, r.chuggerId);
  const isRoom = session.mode === 'room';
  // room mode: the stopwatch belongs to the chugger's phone (with a
  // takeover link for chuggers who don't have their own device)
  const canStart = !isRoom || r.chuggerId === me.id || ui.takeover === r.n;
  // the reveal: everyone's (until now secret) calls, side by side
  const reveal = S.players
    .filter(p => p.id !== r.chuggerId && betDone(r.bets[p.id], mode))
    .map(p => {
      const b = r.bets[p.id];
      return `<span class="revealchip"><b>${esc(p.name)}</b> ${mode === 'psychic'
        ? esc(String(b.guess)) + 's'
        : `<span class="chip ${b.choice}">${b.choice.toUpperCase()}</span>`}</span>`;
    }).join('');
  app.innerHTML = `
    <div class="roundtag">Round ${r.n} · get ready</div>
    <div class="callout">
      ${mode === 'psychic'
        ? `<b>${esc(chugger)}</b>, drink when the clock starts!`
        : `<b>${esc(chugger)}</b> says <span class="bigpred">${r.prediction}s</span>`}
    </div>
    ${reveal ? `<div class="revealwrap">${reveal}</div>` : ''}
    <div class="clockwrap"><div class="clock" id="clock">00:00.00</div></div>
    ${canStart ? `
      <button class="btn go" id="b-startclock" style="min-height:96px;font-size:28px">▶ START</button>
      ${(isRoom && r.chuggerId === me.id) ? '' : `<p class="hint">Hit START the moment ${esc(chugger)} starts drinking.</p>`}` : `
      <div class="lockmsg thinking">⏱ Waiting for ${esc(chugger)} to hit START…</div>
      <button class="linkbtn" id="b-takeover">${esc(chugger)} doesn’t have a phone? Start from here</button>`}`;
  if (canStart) $('#b-startclock').onclick = startClock;
  else $('#b-takeover').onclick = () => { ui.takeover = r.n; builtKey = null; render(); };
}

/* ---------- stopwatch ---------- */
async function startClock() {
  if (!S || S.phase !== 'ready') return;
  let startAt;
  if (backend.isLocal) {
    if (S.round.timerOwner) return;
    startAt = Date.now();
  } else {
    let claimed;
    try { claimed = await backend.claimTimer(S.code, me.id, myName()); }
    catch (e) { console.error(e); toast('⚠️ Network hiccup — tap again'); return; }
    if (claimed == null) {
      toast(`${S.round.timerOwnerName || 'Someone else'} already started the clock`);
      return;
    }
    startAt = claimed;
  }
  const st = clone(S);
  st.phase = 'running';
  st.round.timerOwner = me.id;
  st.round.timerOwnerName = myName();
  st.round.startAt = startAt;
  S = st;
  cacheState();
  render();
  vibrate(40);
  try { navigator.wakeLock?.request('screen'); } catch (e) {}
}

function buildRunning(app) {
  const r = S.round;
  const mode = r.mode || gameMode();
  const chugger = nameOf(S, r.chuggerId);
  const iOwn = r.timerOwner === me.id;
  const guesses = Object.values(r.bets).filter(b => typeof b.guess === 'number').map(b => b.guess);
  app.innerHTML = `
    <div class="roundtag">Round ${r.n} · ${esc(chugger)} is chugging</div>
    <div class="clockwrap"><div class="clock" id="clock">00:00.00</div></div>
    <div class="predsmall">${mode === 'psychic'
      ? (guesses.length ? `Predictions: <b>${Math.min(...guesses)}s – ${Math.max(...guesses)}s</b>` : '')
      : `Prediction: <b>${r.prediction}s</b>`}</div>
    ${iOwn
      ? `<button class="btn stop" id="b-stop">■ STOP</button>`
      : `<div class="lockmsg" id="lockmsg">⏱ ${esc(r.timerOwnerName || 'Someone')} is running the clock</div>`}`;
  if (iOwn) $('#b-stop').onclick = stopClock;
  requestAnimationFrame(tickLoop);
}

function patchRunning() {
  const msg = $('#lockmsg');
  if (msg && S.round.timerOwnerName) {
    msg.textContent = `⏱ ${S.round.timerOwnerName} is running the clock`;
  }
}

function tickLoop() {
  if (!S || S.phase !== 'running' || !S.round.startAt) return;
  const el = document.getElementById('clock');
  if (!el) return;
  el.textContent = fmtClock(backend.now() - S.round.startAt);
  requestAnimationFrame(tickLoop);
}

function stopClock() {
  if (!S || S.phase !== 'running' || S.round.timerOwner !== me.id) return;
  const actual = clamp2(Math.max(0.01, (backend.now() - S.round.startAt) / 1000));
  vibrate([40, 60, 40]);
  finishRound(actual);
}

/* ---------- result ---------- */
function buildResult(app) {
  const r = S.round;
  const mode = r.mode || gameMode();
  const chugger = nameOf(S, r.chuggerId);
  const nextName = nameOf(S, r.nextChuggerId);
  const entries = Object.entries(r.results || {});

  let vsLine = '', rows = '', sipLine = '';
  if (mode === 'psychic') {
    const sorted = entries.sort((a, b) => a[1].diff - b[1].diff);
    rows = sorted.map(([pid, res]) => `
      <div class="resrow ${res.closest ? 'win flashwin' : ''}">
        <span>${esc(nameOf(S, pid))}</span>
        <span class="g">said ${secs(res.guess)} · off by ${secs(res.diff)}</span>
        <span class="mark ${res.closest ? 'ok' : res.furthest ? 'no' : ''}">${res.closest ? '🎯 +1' : res.furthest ? '🍺' : ''}</span>
      </div>`).join('');
  } else {
    const dir = r.push ? 'push' : (r.actual > r.prediction ? 'over' : 'under');
    const diff = clamp2(Math.abs(r.actual - r.prediction));
    vsLine = `<div class="vs"><b>${esc(chugger)}</b> predicted <b>${secs(r.prediction)}</b> —
      ${r.push ? '<span class="push">DEAD ON 🎯 nobody scores</span>'
               : `actual was <span class="${dir}">${dir.toUpperCase()}</span> by ${secs(diff)}`}</div>`;
    rows = entries.map(([pid, res]) => `
      <div class="resrow ${res.correct ? 'win flashwin' : ''}">
        <span>${esc(nameOf(S, pid))}</span>
        <span class="chip ${res.choice}">${res.choice.toUpperCase()}</span>
        <span class="mark ${res.correct ? 'ok' : 'no'}">${res.correct === null ? '–' : res.correct ? '✓ +1' : '✗'}</span>
      </div>`).join('');
    const wrongNames = entries.filter(([, res]) => res.correct === false).map(([pid]) => nameOf(S, pid));
    if (wrongNames.length) sipLine = `<p class="hint">🍻 ${esc(wrongNames.join(', '))} — drink!</p>`;
  }

  const reasonText = {
    'wrong-one':      'called it wrong — up next, no wheel needed',
    'wrong-wheel':    'the wheel has spoken',
    'all-right-one':  'everyone was right, but someone has to chug',
    'all-right-wheel':'everyone was right — the wheel decided',
    'furthest':       r.maxDiff != null ? `furthest off at ${secs(r.maxDiff)} away` : 'furthest off',
    'tie-wheel':      `tied for furthest off${r.maxDiff != null ? ` at ${secs(r.maxDiff)}` : ''} — the wheel decided`,
    'random':         'picked at random — nobody bet',
  }[r.nextReason] || '';

  app.innerHTML = `
    <div class="roundtag">Round ${r.n} result</div>
    ${r.newRecord ? `<div class="recordbanner">🏆 NEW FASTEST CHUG EVER!</div>` : ''}
    <div class="actual">${fmtClock(r.actual * 1000)}</div>
    ${vsLine}
    <div style="display:flex;flex-direction:column;gap:8px">${rows || '<p class="hint">No bets this round.</p>'}</div>
    ${sipLine}
    ${r.wheelPool ? '<div id="wheelbox"></div>' : ''}
    <div class="nextup ${r.wheelPool ? 'hidden' : ''}" id="nextupbanner">🍺 <b>${esc(nextName)}</b> is up next
      ${reasonText ? `<span class="why">${reasonText}</span>` : ''}</div>
    ${isHost() ? '<button class="btn primary big" id="b-next">Next round ▶</button>'
               : `<div class="lockmsg thinking">⏳ ${esc(hostName())} (host) starts the next round…</div>`}`;
  if ($('#b-next')) $('#b-next').onclick = nextRoundAction;
  if (r.newRecord) { confetti(); vibrate([60, 40, 120]); }

  if (r.wheelPool) {
    // Winner was already decided (and synced) when the clock stopped;
    // every phone just plays the same reveal.
    const names = r.wheelPool.map(pid => nameOf(S, pid));
    renderWheel($('#wheelbox'), names, r.wheelPool.indexOf(r.nextChuggerId), () => {
      const banner = $('#nextupbanner');
      if (banner) banner.classList.remove('hidden');
    });
  }
}

function nextRoundAction() {
  if (!S || S.phase !== 'result' || !isHost()) return;
  const st = clone(S);
  const mode = gameMode();
  st.round = blankRound(st.round.n + 1, st.round.nextChuggerId, mode);
  st.phase = mode === 'psychic' ? 'guessing' : 'predict';
  commit(st);
}

/* ---------- stats overlay (pure stats — actions live in the menu) ---------- */
function openStats() {
  const ov = $('#overlay');
  ov.classList.remove('hidden');
  const stats = computeStats(S);
  const per = stats ? Object.entries(stats.per) : [];
  ov.innerHTML = `
    <div class="ovl-inner">
      <div class="ovl-head"><h2>📊 Stats</h2><button class="hbtn" id="ov-close">✕</button></div>
      ${!stats ? '<p class="hint">No rounds played yet — stats show up after the first chug.</p>' : `
      <div class="statgrid">
        <div class="statcard"><div class="lbl">⚡ Fastest</div>
          <div class="val">${secs(stats.fastest.actual)}</div>
          <div class="who">${esc(stats.fastest.chuggerName)}</div></div>
        <div class="statcard"><div class="lbl">🐌 Slowest</div>
          <div class="val">${secs(stats.slowest.actual)}</div>
          <div class="who">${esc(stats.slowest.chuggerName)}</div></div>
        <div class="statcard"><div class="lbl">Average</div>
          <div class="val">${secs(stats.avg)}</div>
          <div class="who">&nbsp;</div></div>
        <div class="statcard"><div class="lbl">Rounds</div>
          <div class="val">${stats.rounds}</div>
          <div class="who">&nbsp;</div></div>
      </div>
      ${stats.bestCaller || stats.bestPsychic ? `
      <div class="card">
        <h3 style="margin-top:0">Hall of fame</h3>
        ${stats.bestCaller ? `<div class="famerow">🎲 <b>${esc(stats.bestCaller.name)}</b> calls it best
          <span class="t">${Math.round(stats.bestCaller.ouRate * 100)}% (${stats.bestCaller.ouW}/${stats.bestCaller.ouN})</span></div>` : ''}
        ${stats.bestPsychic ? `<div class="famerow">🔮 <b>${esc(stats.bestPsychic.name)}</b> sees the future
          <span class="t">±${secs(stats.bestPsychic.psyAvg)}</span></div>` : ''}
      </div>` : ''}
      <div class="card">
        <h3 style="margin-top:0">Per player</h3>
        <table class="ptable">
          <tr><th>Player</th><th>Avg chug</th><th>O/U</th><th>🔮</th></tr>
          ${per.map(([pid, p]) => `
            <tr><td>${esc(p.name)}</td>
              <td>${p.avgChug != null ? secs(p.avgChug) : '—'}</td>
              <td>${p.ouN ? `${p.ouW}/${p.ouN}` : '—'}</td>
              <td>${p.psyAvg != null ? '±' + secs(p.psyAvg) : '—'}</td></tr>`).join('')}
        </table>
      </div>
      <div class="card">
        <h3 style="margin-top:0">Last rounds</h3>
        ${[...S.history].reverse().slice(0, 6).map(h => `
          <div class="histrow"><span>#${h.n} ${MODE_INFO[h.mode || 'ou'].icon}</span>
            <b>${esc(h.chuggerName)}</b>
            ${h.prediction != null ? `<span>said ${secs(h.prediction)}</span>` : ''}
            <span class="t">${secs(h.actual)}</span></div>`).join('')}
      </div>`}
    </div>`;
  $('#ov-close').onclick = () => ov.classList.add('hidden');
}

/* ---------- menu overlay ---------- */
function openMenu() {
  const ov = $('#overlay');
  ov.classList.remove('hidden');
  const isRoom = session.mode === 'room';
  ov.innerHTML = `
    <div class="ovl-inner">
      <div class="ovl-head"><h2>Menu</h2><button class="hbtn" id="ov-close">✕</button></div>
      ${isRoom ? `
      <div class="codecard">
        <div class="sub">ROOM CODE</div>
        <div class="bigcode">${esc(S.code)}</div>
        <button class="btn small yellow" id="mn-share" style="margin:8px auto 0">📤 Share invite</button>
      </div>` : ''}
      ${isHost() ? `
      <div class="card">
        <h3 style="margin-top:0">Game mode</h3>
        <div class="pickwrap">
          ${Object.entries(MODE_INFO).map(([m, info]) => `
            <button class="pickchip ${gameMode() === m ? 'sel' : ''}" data-mode="${m}">${info.icon} ${info.name}</button>`).join('')}
        </div>
        <p class="hint" style="text-align:left;margin-top:8px">Applies from the next round.</p>
      </div>` : ''}
      <div class="menulist">
        ${isHost() ? `
        <button class="menubtn" id="mn-lobby">🏁 Back to lobby<span>pick the mode & who chugs first — scores stay</span></button>
        <button class="menubtn" id="mn-reset">🔄 Reset scores<span>history and records stay</span></button>` : `
        <p class="hint" style="text-align:left">${esc(hostName())} is the host — they control the game mode, rounds and resets.</p>`}
        <button class="menubtn danger" id="mn-leave">${isRoom ? '🚪 Leave room' : '🚪 Exit to home'}<span>${isRoom ? 'the game keeps going for the others' : 'your solo game stays saved'}</span></button>
      </div>
    </div>`;
  const close = () => ov.classList.add('hidden');
  $('#ov-close').onclick = close;
  if (isRoom) $('#mn-share').onclick = shareInvite;
  if (!isHost()) {
    $('#mn-leave').onclick = () => {
      close();
      askConfirm('Leave this room?<br><span class="sub">The game keeps going for everyone else.</span>', '🚪 Leave', leaveGame);
    };
    return;
  }
  $$('#overlay [data-mode]').forEach(chip => chip.onclick = () => {
    if (chip.dataset.mode === S.gameMode) return;
    const st = clone(S);
    st.gameMode = chip.dataset.mode;
    commit(st);
    close();
    toast(`${MODE_INFO[chip.dataset.mode].icon} ${MODE_INFO[chip.dataset.mode].name} from the next round`);
  });
  $('#mn-lobby').onclick = () => {
    close();
    askConfirm('Back to the lobby?<br><span class="sub">The current round is scrapped — scores and history stay.</span>', '🏁 To the lobby', () => {
      const st = clone(S);
      st.phase = 'lobby';
      st.round = blankRound(st.history.at(-1)?.n || 0, null, st.gameMode);
      commit(st);
    });
  };
  $('#mn-reset').onclick = () => {
    close();
    askConfirm('Reset everyone’s score to 0?<br><span class="sub">All-time stats and records stay.</span>', '🔄 Reset', () => {
      const st = clone(S);
      st.players.forEach(p => p.score = 0);
      commit(st);
      toast('Scores reset');
    });
  };
  $('#mn-leave').onclick = () => {
    close();
    askConfirm(isRoom
      ? 'Leave this room?<br><span class="sub">The game keeps going for everyone else.</span>'
      : 'Exit to the home screen?<br><span class="sub">Your solo game is saved.</span>',
      '🚪 Leave', leaveGame);
  };
}

/* ---------- session flows ---------- */
async function createRoom(name) {
  me.name = name; store.set('ou_identity', me);
  const client = await getSupaClient();
  backend = new SupaBackend(client);
  await backend.syncClock();
  const st = newState('room');
  st.hostId = me.id;
  st.players = [{ id: me.id, name, score: 0 }];
  const code = await backend.create(st);
  st.code = code;
  session = { mode: 'room', code };
  store.set('ou_session', session);
  backend.subscribe(code, onRemoteState);
  S = st; cacheState();
  builtKey = null; render();
  toast(`Room ${code} created 🎉`);
}

async function joinRoom(code, name) {
  me.name = name; store.set('ou_identity', me);
  const client = await getSupaClient();
  backend = new SupaBackend(client);
  await backend.syncClock();
  const st = await backend.joinRoom(code, { id: me.id, name, score: 0 });
  if (!st) { toast(`No room “${code}” — check the code`); return; }
  session = { mode: 'room', code };
  store.set('ou_session', session);
  backend.subscribe(code, onRemoteState);
  S = st; cacheState();
  builtKey = null; render();
}

function startSolo() {
  backend = localBackend;
  session = { mode: 'solo' };
  store.set('ou_session', session);
  S = store.get('ou_solo_state') || newState('solo');
  if (!S.gameMode) S.gameMode = 'ou';
  if (S.round && !S.round.mode) S.round.mode = S.gameMode;
  builtKey = null; render();
}

function leaveGame() {
  backend?.unsubscribe?.();
  if (session?.mode === 'room' && S?.code) store.del('ou_cache_' + S.code);
  store.del('ou_session');
  session = null; S = null; backend = null;
  builtKey = null;
  showScreen('home');
}

async function resume() {
  // invite links can carry backend creds: #su=base64(url|key)
  const hashMatch = location.hash.match(/^#su=(.+)$/);
  if (hashMatch) {
    try {
      const [url, key] = atob(hashMatch[1]).split('|');
      if (url && key && !((window.OU_CONFIG || {}).SUPABASE_URL)) store.set('ou_supa', { url, key });
    } catch (e) {}
    history.replaceState(null, '', location.pathname + location.search);
  }
  const url = new URL(location.href);
  const joinParam = url.searchParams.get('join');
  if (joinParam && (!session || session.code !== joinParam.toUpperCase())) {
    ui.joinCode = joinParam.toUpperCase().slice(0, 4);
    history.replaceState(null, '', location.pathname);
    if (supaConfigured()) { showScreen('join'); return; }
  }
  if (session?.mode === 'solo') { startSolo(); return; }
  if (session?.mode === 'room') {
    // show cached state instantly, then reconcile with the server
    S = store.get('ou_cache_' + session.code);
    backend = localBackend; // placeholder until connected
    if (S) { builtKey = null; render(); }
    if (!supaConfigured()) { leaveGame(); return; }
    try {
      const client = await getSupaClient();
      backend = new SupaBackend(client);
      await backend.syncClock();
      const st = await backend.fetch(session.code);
      if (!st) { toast('That room expired'); leaveGame(); return; }
      backend.subscribe(session.code, onRemoteState);
      onRemoteState(st);
    } catch (e) {
      console.error(e);
      toast('📴 Offline — showing the last synced state');
    }
    return;
  }
  showScreen('home');
}

/* ---------- global wiring ---------- */
$('#h-menu').onclick = () => S && openMenu();
$('#h-stats').onclick = () => S && openStats();

document.addEventListener('visibilitychange', async () => {
  if (document.hidden || !session || session.mode !== 'room' || !backend || backend.isLocal) return;
  // phones lock constantly mid-party — refetch the moment we're back
  try {
    await backend.syncClock();
    const st = await backend.fetch(session.code);
    if (st) onRemoteState(st);
  } catch (e) {}
});

resume();
