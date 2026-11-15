import { getBackend, DEMO, SHARDS, shardOf, shapeSvg, esc, gdgLogo } from "./backend.js";
import { scoreRound, GRACE_MS } from "./scoring.js";
import qrcode from "../vendor/qrcode.js";

const app = document.getElementById("app");
const HALL_COLORS = { 1: "blue", 2: "red", 3: "yellow", 4: "green" };
const INTRO_MS = 3500;

let B; // backend
const S = {
  pin: null, hall: null, qs: [], q: -1, round: null,
  players: new Map(), scores: {}, answers: [], game: null,
  top: [], counts: [0, 0, 0, 0], screen: "setup",
  unsubPlayers: null, unsubAnswers: null, unsubGame: null,
  timer: null, timerEnd: 0, ending: false, muted: false,
};

// ---------------- Sound (WebAudio, no files) ----------------
let ac;
function audio() {
  if (!ac) try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch { ac = null; }
  if (ac && ac.state === "suspended") ac.resume().catch(() => {});
  return ac;
}
function tone(freq, dur = 0.12, type = "sine", vol = 0.15, delay = 0) {
  if (S.muted) return;
  const a = audio(); if (!a) return;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.value = freq;
  const t = a.currentTime + delay;
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination); o.start(t); o.stop(t + dur + 0.02);
}
const sfx = {
  tick: () => tone(880, 0.06, "square", 0.06),
  join: () => { tone(660, 0.08); tone(990, 0.1, "sine", 0.12, 0.07); },
  go: () => [523, 659, 784].forEach((f, i) => tone(f, 0.15, "triangle", 0.15, i * 0.09)),
  timeup: () => { tone(220, 0.35, "sawtooth", 0.1); tone(165, 0.45, "sawtooth", 0.1, 0.15); },
  reveal: () => [784, 988, 1175].forEach((f, i) => tone(f, 0.18, "triangle", 0.14, i * 0.08)),
  fanfare: () => [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, 0.25, "triangle", 0.16, i * 0.14)),
};

// ---------------- Helpers ----------------
const $ = (sel) => app.querySelector(sel);
function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 2600);
}
const joinBase = () => location.origin + location.pathname.replace(/host(\.html)?$/, "");
const prettyPin = (p) => `${p.slice(0, 3)} ${p.slice(3)}`;
function publicQuestion(q, i) {
  return { n: i + 1, cat: q.cat, prompt: q.prompt, emoji: q.emoji || "", options: q.options, time: q.time };
}
function playerList() { return [...S.players.entries()].map(([uid, p]) => ({ uid, name: p.name })); }
async function safeUpdate(patch) {
  try { await B.updateGame(S.pin, patch); }
  catch (e) { console.error(e); toast("Couldn't sync with Firebase: " + (e.code || e.message)); }
}

function frame(inner, { wide = false } = {}) {
  const inGame = !!S.pin;
  app.innerHTML = `
  <header class="topbar">
    <div class="brand">${gdgLogo}<div><strong>DevFest Ibadan 2026</strong><span>Quiz Arena</span></div></div>
    <div class="top-right">
      ${S.hall ? `<span class="chip chip-${HALL_COLORS[S.hall]}">${esc(window.HALLS[S.hall].name)}</span>` : ""}
      ${inGame ? `<span class="chip chip-pin">PIN <b>${prettyPin(S.pin)}</b></span>
                  <span class="chip">👥 <b id="pcount">${S.players.size.toLocaleString()}</b></span>` : ""}
      <button class="icon-btn" id="muteBtn" title="Sound">${S.muted ? "🔇" : "🔊"}</button>
      <button class="icon-btn" id="fsBtn" title="Fullscreen (F)">⛶</button>
    </div>
  </header>
  ${DEMO ? `<div class="demo-banner">DEMO MODE: Firebase not configured, so players can only join from other tabs of this browser. Add your config in <code>config.js</code>.</div>` : ""}
  <main class="stage ${wide ? "wide" : ""}">${inner}</main>
  ${footerShapes}`;
  $("#muteBtn").onclick = () => { S.muted = !S.muted; $("#muteBtn").textContent = S.muted ? "🔇" : "🔊"; };
  $("#fsBtn").onclick = toggleFs;
}
function toggleFs() {
  try {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  } catch {}
}
const footerShapes = `<footer class="shapes-strip" aria-hidden="true">
  <i class="tri red"></i><i class="tri red"></i><i class="blk yellow"></i><i class="blk yellow"></i>
  <i class="par blue"></i><i class="par blue"></i><i class="blk green"></i><i class="blk green"></i>
  <i class="tri pink"></i><i class="tri pink"></i></footer>`;

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea")) return;
  if (e.key === "f" || e.key === "F") toggleFs();
  if ([" ", "Enter", "ArrowRight"].includes(e.key)) {
    const btn = app.querySelector("[data-primary]:not([disabled])");
    if (btn) { e.preventDefault(); btn.click(); }
  }
});

// ---------------- Setup: pick a hall ----------------
async function renderSetup(resumable) {
  S.screen = "setup"; S.pin = null; S.hall = null;
  frame(`
    <section class="setup">
      <h1 class="hero">Hello <span class="hl">Techies</span><span class="caret"></span></h1>
      <p class="lede">Pick the hall you're hosting. Each hall gets its own game PIN and its own 10 questions.</p>
      ${resumable ? `<div class="resume card">
          <div>Unfinished game in <b>${esc(resumable.hallName)}</b>, PIN <b>${prettyPin(resumable.pin)}</b> (question ${resumable.q + 1}).</div>
          <div class="row"><button class="btn btn-dark" id="resumeBtn">Resume</button><button class="btn btn-ghost" id="discardBtn">Discard</button></div>
        </div>` : ""}
      <div class="hall-grid">
        ${[1, 2, 3, 4].map((h) => `
          <button class="hall-card hall-${HALL_COLORS[h]}" data-hall="${h}">
            <span class="hall-num">${h}</span>
            <span class="hall-name">${esc(window.HALLS[h].name)}</span>
            <span class="hall-sub">${window.HALLS[h].questions.length} questions · Host this hall →</span>
          </button>`).join("")}
      </div>
    </section>`);
  app.querySelectorAll("[data-hall]").forEach((b) => (b.onclick = () => { audio(); createGame(+b.dataset.hall); }));
  if (resumable) {
    $("#resumeBtn").onclick = () => { audio(); resumeGame(resumable); };
    $("#discardBtn").onclick = async () => {
      await B.updateGame(resumable.pin, { state: "final" }).catch(() => {});
      localStorage.removeItem("dfq-host"); renderSetup(null);
    };
  }
}

async function createGame(hall) {
  const btns = app.querySelectorAll("[data-hall]"); btns.forEach((b) => (b.disabled = true));
  let pin = null;
  for (let i = 0; i < 8 && !pin; i++) {
    const cand = String(Math.floor(100000 + Math.random() * 900000));
    const existing = await B.getGame(cand).catch(() => null);
    if (existing) continue;
    try {
      await B.createGame(cand, {
        hostId: B.uid, hall, hallName: window.HALLS[hall].name, state: "lobby",
        q: -1, total: window.HALLS[hall].questions.length, round: null,
        question: null, reveal: null, top: [], playerCount: 0,
        createdAt: B.serverTime(), qStartedAt: null,
      });
      pin = cand;
    } catch (e) { console.warn("PIN create failed", cand, e); }
  }
  if (!pin) { toast("Couldn't create a game. Check Firebase config and rules."); btns.forEach((b) => (b.disabled = false)); return; }
  startSession(pin, hall);
  renderLobby();
}

function startSession(pin, hall) {
  S.pin = pin; S.hall = hall; S.qs = window.HALLS[hall].questions;
  try { localStorage.setItem("dfq-host", pin); } catch {}
  S.unsubGame?.(); S.unsubPlayers?.();
  S.unsubGame = B.watchGame(pin, (g) => { S.game = g; });
  S.unsubPlayers = B.watchPlayers(pin, (list) => {
    const before = S.players.size;
    S.players = new Map(list.map((p) => [p.uid, { name: p.name, t: p.joinedAt || 0 }]));
    if (S.screen === "lobby" && S.players.size > before) throttledJoinSound();
    scheduleUi();
  });
}

// Batch UI updates: with thousands of players, snapshots arrive in bursts.
let uiQueued = false, lastJoinSound = 0;
function throttledJoinSound() { const n = Date.now(); if (n - lastJoinSound > 400) { lastJoinSound = n; sfx.join(); } }
function scheduleUi() {
  if (uiQueued) return; uiQueued = true;
  setTimeout(() => {
    uiQueued = false;
    const pc = $("#pcount"); if (pc) pc.textContent = S.players.size.toLocaleString();
    if (S.screen === "lobby") renderLobbyPlayers();
    if (S.screen === "question") updateAnswerCount();
  }, 250);
}

async function resumeGame(g) {
  startSession(g.pin, g.hall);
  S.q = g.q;
  S.scores = {};
  const all = await B.getAllResults(g.pin).catch(() => ({}));
  for (const [uid, r] of Object.entries(all)) S.scores[uid] = { s: r.s, st: r.st };
  S.top = g.top || [];
  if (g.state === "lobby" || g.q < 0) return renderLobby();
  if (g.state === "reveal" && g.reveal) { S.counts = g.reveal.counts; return renderReveal(); }
  if (g.state === "leaderboard") return renderLeaderboard();
  return runIntro(g.q); // intro or question: restart this question with a fresh round
}

// ---------------- Lobby ----------------
function renderLobby() {
  S.screen = "lobby";
  const url = joinBase();
  const qr = qrcode(0, "M"); qr.addData(`${url}?pin=${S.pin}`); qr.make();
  frame(`
    <section class="lobby">
      <div class="join-panel card">
        <div class="join-text">
          <div class="join-step">Join at <b>${esc(url.replace(/^https?:\/\//, "").replace(/\/$/, ""))}</b></div>
          <div class="pin-label">Game PIN</div>
          <div class="pin-big">${prettyPin(S.pin)}</div>
        </div>
        <div class="qr">${qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true })}</div>
      </div>
      <div class="lobby-bar">
        <div class="count-badge"><b id="lobbyCount">${S.players.size.toLocaleString()}</b> players</div>
        <div class="hint">Tap a name to remove it</div>
        <button class="btn btn-dark btn-lg" id="startBtn" data-primary ${S.players.size ? "" : "disabled"}>Start ▶</button>
      </div>
      <div class="player-cloud" id="cloud"></div>
    </section>`, { wide: true });
  $("#startBtn").onclick = () => { sfx.go(); runIntro(0); };
  renderLobbyPlayers();
}
function renderLobbyPlayers() {
  const cloud = $("#cloud"); if (!cloud) return;
  const list = [...S.players.entries()].map(([uid, p]) => ({ uid, name: p.name, t: p.t })).sort((a, b) => b.t - a.t);
  const SHOW = 60;
  const shown = list.slice(0, SHOW);
  cloud.innerHTML = list.length
    ? shown.map((p, i) => `<button class="pill pill-${i % 4}" data-kick="${esc(p.uid)}">${esc(p.name)}</button>`).join("")
      + (list.length > SHOW ? `<span class="pill more">+${(list.length - SHOW).toLocaleString()} more</span>` : "")
    : `<div class="waiting">Waiting for players<span class="dots"></span></div>`;
  $("#lobbyCount").textContent = list.length.toLocaleString();
  const sb = $("#startBtn"); if (sb) sb.disabled = list.length === 0;
  cloud.querySelectorAll("[data-kick]").forEach((b) => (b.onclick = async () => {
    const name = b.textContent;
    await B.removePlayer(S.pin, b.dataset.kick).catch((e) => toast("Couldn't remove: " + (e.code || e.message)));
    toast(`Removed ${name}`);
  }));
}

// ---------------- Question flow ----------------
async function runIntro(i) {
  S.q = i; S.screen = "intro"; S.ending = false;
  const q = S.qs[i];
  await safeUpdate({ state: "intro", q: i, question: publicQuestion(q, i), reveal: null, playerCount: S.players.size });
  frame(`
    <section class="intro">
      <div class="intro-count">Question ${i + 1} <span>of ${S.qs.length}</span></div>
      <div class="cat-tag big">${esc(q.cat)}</div>
      <div class="intro-prompt">${esc(q.prompt)}</div>
      <div class="intro-bar"><i style="animation-duration:${INTRO_MS}ms"></i></div>
    </section>`);
  setTimeout(() => { if (S.screen === "intro" && S.q === i) runQuestion(i); }, INTRO_MS);
}

async function runQuestion(i) {
  const q = S.qs[i];
  S.screen = "question"; S.answers = []; S.ending = false;
  S.round = `q${i}-${Date.now().toString(36)}`;
  S.localStart = Date.now();
  await safeUpdate({ state: "question", round: S.round, qStartedAt: B.serverTime() });
  S.unsubAnswers?.();
  S.unsubAnswers = B.watchAnswers(S.pin, S.round, (list) => { S.answers = list; scheduleUi(); });

  frame(`
    <section class="question">
      <div class="q-head">
        <div class="q-num">${i + 1}/${S.qs.length}</div>
        <div class="cat-tag">${esc(q.cat)}</div>
        <button class="btn btn-ghost" id="skipBtn">End question ⏭</button>
      </div>
      <div class="q-prompt card">${esc(q.prompt)}</div>
      <div class="q-middle">
        <div class="timer"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" class="track"/><circle cx="50" cy="50" r="44" class="bar" id="tbar"/></svg><b id="tnum">${q.time}</b></div>
        <div class="q-emoji">${q.emoji ? esc(q.emoji) : "🤔"}</div>
        <div class="ans-count"><b id="acount">0</b><span>answers</span></div>
      </div>
      <div class="tiles">
        ${q.options.map((o, k) => `<div class="tile t${k}">${shapeSvg(k)}<span>${esc(o)}</span></div>`).join("")}
      </div>
    </section>`, { wide: true });
  $("#skipBtn").onclick = () => endQuestion();

  const total = q.time * 1000;
  S.timerEnd = performance.now() + total;
  let lastSec = q.time;
  clearInterval(S.timer);
  S.timer = setInterval(() => {
    const left = Math.max(0, S.timerEnd - performance.now());
    const sec = Math.ceil(left / 1000);
    const tnum = $("#tnum"), tbar = $("#tbar");
    if (tnum) tnum.textContent = sec;
    if (tbar) tbar.style.strokeDashoffset = String(276.5 * (1 - left / total));
    if (sec !== lastSec) { lastSec = sec; if (sec <= 5 && sec > 0) sfx.tick(); }
    if (left <= 0) endQuestion();
  }, 100);
}

function updateAnswerCount() {
  const el = $("#acount"); if (!el) return;
  const valid = S.answers.filter((a) => S.players.has(a.uid)).length;
  el.textContent = valid.toLocaleString();
  if (S.screen === "question" && !S.ending && S.players.size > 0 && valid >= S.players.size) {
    setTimeout(() => endQuestion(), 600);
  }
}

async function endQuestion() {
  if (S.ending || S.screen !== "question") return;
  S.ending = true;
  clearInterval(S.timer);
  sfx.timeup();
  const sk = $("#skipBtn"); if (sk) sk.disabled = true;
  const st = $(".q-middle");
  if (st) st.insertAdjacentHTML("beforeend", `<div class="timeup">Time's up!</div>`);
  // Let in-flight answers land before scoring.
  await new Promise((r) => setTimeout(r, Math.min(GRACE_MS, 1200)));
  S.unsubAnswers?.(); S.unsubAnswers = null;

  const q = S.qs[S.q];
  const g = S.game;
  const startMs = g && g.round === S.round && g.qStartedAt ? g.qStartedAt : S.localStart;
  const { scores, results, counts, top } = scoreRound(playerList(), S.answers, S.scores, q, startMs);
  S.scores = scores; S.counts = counts; S.top = top;
  // Per-player results go to small shard docs (each phone reads only its own shard), then the game flips to reveal.
  const shards = Array.from({ length: SHARDS }, () => ({}));
  for (const [uid, r] of Object.entries(results)) shards[shardOf(uid)][uid] = r;
  try { await B.writeResults(S.pin, S.q, shards); }
  catch (e) { console.error(e); toast("Couldn't save results: " + (e.code || e.message)); }
  await safeUpdate({ state: "reveal", reveal: { answer: q.answer, counts, fact: q.fact || "" }, top, playerCount: S.players.size });
  renderReveal();
}

function renderReveal() {
  S.screen = "reveal";
  const q = S.qs[S.q];
  const max = Math.max(1, ...S.counts);
  sfx.reveal();
  frame(`
    <section class="reveal">
      <div class="q-head">
        <div class="q-num">${S.q + 1}/${S.qs.length}</div>
        <div class="cat-tag">${esc(q.cat)}</div>
        <button class="btn btn-dark btn-lg" id="nextBtn" data-primary>Leaderboard ▶</button>
      </div>
      <div class="q-prompt card small">${q.emoji ? `<span class="mini-emoji">${esc(q.emoji)}</span>` : ""}${esc(q.prompt)}</div>
      <div class="bars">
        ${q.options.map((o, k) => `
          <div class="bar-col ${k === q.answer ? "correct" : "dim"}">
            <div class="bar-num">${S.counts[k]}</div>
            <div class="bar-fill t${k}" style="--h:${Math.round((S.counts[k] / max) * 100)}%"></div>
            <div class="bar-label t${k}">${shapeSvg(k)}${k === q.answer ? "✔" : ""}</div>
          </div>`).join("")}
      </div>
      <div class="tiles">
        ${q.options.map((o, k) => `<div class="tile t${k} ${k === q.answer ? "is-correct" : "is-wrong"}">${shapeSvg(k)}<span>${esc(o)}</span>${k === q.answer ? '<em>✔</em>' : ""}</div>`).join("")}
      </div>
      ${q.fact ? `<div class="fact card">💡 ${esc(q.fact)}</div>` : ""}
    </section>`, { wide: true });
  $("#nextBtn").onclick = () => renderLeaderboard(true);
}

async function renderLeaderboard(sync) {
  S.screen = "leaderboard";
  if (sync) await safeUpdate({ state: "leaderboard" });
  const last = S.q >= S.qs.length - 1;
  const top = S.top.length ? S.top : [];
  const max = Math.max(1, ...top.map((t) => t.s));
  frame(`
    <section class="leader">
      <div class="q-head">
        <h2>Leaderboard</h2>
        <button class="btn btn-dark btn-lg" id="nextBtn" data-primary>${last ? "Show winners 🏆" : "Next question ▶"}</button>
      </div>
      <ol class="lb">
        ${top.map((t, i) => `
          <li style="--d:${i * 120}ms">
            <span class="lb-rank">${i + 1}</span>
            <span class="lb-bar" style="--w:${Math.max(18, Math.round((t.s / max) * 100))}%"><span class="lb-name">${esc(t.name)}</span></span>
            <span class="lb-score">${t.s.toLocaleString()}</span>
          </li>`).join("") || `<li class="empty">No points yet. Speed up, Ibadan! 😄</li>`}
      </ol>
    </section>`, { wide: true });
  $("#nextBtn").onclick = () => (last ? renderFinal(true) : runIntro(S.q + 1));
}

async function renderFinal(sync) {
  S.screen = "final";
  if (sync) await safeUpdate({ state: "final" });
  try { localStorage.removeItem("dfq-host"); } catch {}
  sfx.fanfare();
  const t = S.top;
  const slot = (i, cls) => t[i]
    ? `<div class="podium-col ${cls}"><div class="podium-name">${esc(t[i].name)}</div><div class="podium-score">${t[i].s.toLocaleString()}</div><div class="podium-block"><span>${i + 1}</span></div></div>`
    : `<div class="podium-col ${cls} empty"><div class="podium-block"><span>${i + 1}</span></div></div>`;
  frame(`
    <section class="final">
      <div class="q-head"><button class="btn btn-ghost" id="newBtn">Back to halls</button></div>
      <h2 class="final-title">🏆 ${esc(window.HALLS[S.hall].name)} Champions</h2>
      <div class="podium">${slot(1, "second")}${slot(0, "first")}${slot(2, "third")}</div>
      ${t.length > 3 ? `<div class="runners">${t.slice(3).map((r, i) => `<span>${i + 4}. ${esc(r.name)} · ${r.s.toLocaleString()}</span>`).join("")}</div>` : ""}
    </section>
    <canvas id="confetti"></canvas>`, { wide: true });
  $("#newBtn").onclick = () => {
    S.unsubPlayers?.(); S.unsubGame?.(); S.players = new Map(); S.scores = {}; S.top = []; S.q = -1;
    renderSetup(null);
  };
  confetti($("#confetti"));
}

function confetti(canvas) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = (canvas.width = innerWidth), H = (canvas.height = innerHeight);
  const colors = ["#4285F4", "#EA4335", "#FBBC04", "#34A853", "#F07FA8"];
  const parts = Array.from({ length: 180 }, () => ({
    x: Math.random() * W, y: -20 - Math.random() * H, w: 6 + Math.random() * 8, h: 8 + Math.random() * 10,
    vy: 2 + Math.random() * 4, vx: -1.5 + Math.random() * 3, r: Math.random() * 6, vr: -0.2 + Math.random() * 0.4,
    c: colors[(Math.random() * colors.length) | 0],
  }));
  let frames = 0;
  (function step() {
    if (!canvas.isConnected) return;
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.r += p.vr;
      if (p.y > H + 20 && frames < 420) { p.y = -20; p.x = Math.random() * W; }
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
    }
    frames++;
    if (frames < 700) requestAnimationFrame(step); else ctx.clearRect(0, 0, W, H);
  })();
}

// ---------------- Boot ----------------
(async function boot() {
  app.innerHTML = `<div class="boot">Connecting…</div>`;
  try { B = await getBackend(); }
  catch (e) {
    console.error(e);
    app.innerHTML = `<div class="boot error card">Couldn't connect to Firebase.<br><small>${esc(e.code || e.message)}</small><br><br>Check <code>config.js</code> and that Anonymous sign-in is enabled.</div>`;
    return;
  }
  let resumable = null;
  try {
    const pin = localStorage.getItem("dfq-host");
    if (pin) {
      const g = await B.getGame(pin);
      if (g && g.hostId === B.uid && g.state !== "final") resumable = { ...g, pin };
    }
  } catch {}
  renderSetup(resumable);
})();
