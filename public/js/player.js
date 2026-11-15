import { getBackend, DEMO, shapeSvg, esc, ordinal, gdgLogo } from "./backend.js";

const app = document.getElementById("app");
let B;
const P = {
  pin: null, name: null, joined: false, game: null, key: null,
  answeredRound: sessionStorage.getItem("dfq-answered") || null, myChoice: null,
  seenRoundAt: {}, timer: null, unsubGame: null, unsubMe: null, unsubRes: null, score: 0, myRes: null,
};
const CATS = { "Emoji Puzzle": "🧩", Google: "🔷", AI: "🤖", Tech: "💻", Naija: "🇳🇬", "Just for Fun": "😂" };

function shell(inner, cls = "") {
  app.innerHTML = `
    <header class="p-top">
      <div class="brand small">${gdgLogo}<strong>DevFest Ibadan</strong></div>
      ${P.joined ? `<div class="p-me"><span>${esc(P.name)}</span><b>${P.score.toLocaleString()}</b></div>` : ""}
    </header>
    ${DEMO ? `<div class="demo-banner small">Demo mode (same browser only)</div>` : ""}
    <main class="p-main ${cls}">${inner}</main>`;
}
function toast(msg) {
  const t = document.createElement("div"); t.className = "toast"; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 2600);
}
function buzz(ms) { try { navigator.vibrate && navigator.vibrate(ms); } catch {} }

// ---------------- Join ----------------
function renderPin(prefill = "", err = "") {
  shell(`
    <form class="join card" id="pinForm" autocomplete="off">
      <h1>Join the game</h1>
      <input id="pin" inputmode="numeric" pattern="[0-9 ]*" maxlength="7" placeholder="Game PIN" value="${esc(prefill)}" aria-label="Game PIN" />
      ${err ? `<div class="err">${esc(err)}</div>` : ""}
      <button class="btn btn-dark btn-block" type="submit">Enter</button>
      <p class="muted">The PIN is on the big screen in your hall.</p>
    </form>`, "center");
  const input = document.getElementById("pin");
  if (!prefill) input.focus();
  document.getElementById("pinForm").onsubmit = async (e) => {
    e.preventDefault();
    const pin = input.value.replace(/\D/g, "");
    if (pin.length !== 6) return renderPin(input.value, "PINs have 6 digits.");
    const btn = e.target.querySelector("button"); btn.disabled = true; btn.textContent = "Checking…";
    try {
      const g = await B.getGame(pin);
      if (!g || g.state === "final") return renderPin(pin, "We couldn't find that game. Check the PIN on screen.");
      P.pin = pin;
      const me = await B.getMe(pin);
      if (me) { P.name = me.name; return enterGame(); }
      renderName();
    } catch (err) {
      console.error(err); renderPin(pin, "Connection problem. Try again.");
    }
  };
}

function renderName(err = "") {
  const saved = localStorage.getItem("dfq-name") || "";
  shell(`
    <form class="join card" id="nameForm" autocomplete="off">
      <div class="muted">PIN ${P.pin.slice(0, 3)} ${P.pin.slice(3)}</div>
      <h1>Pick a nickname</h1>
      <input id="nick" maxlength="16" placeholder="e.g. FlutterFlex" value="${esc(saved)}" aria-label="Nickname" />
      ${err ? `<div class="err">${esc(err)}</div>` : ""}
      <button class="btn btn-dark btn-block" type="submit">I'm ready 🚀</button>
      <p class="muted">Keep it friendly, it shows on the big screen.</p>
    </form>`, "center");
  const input = document.getElementById("nick"); input.focus();
  document.getElementById("nameForm").onsubmit = async (e) => {
    e.preventDefault();
    const name = input.value.replace(/\s+/g, " ").trim().slice(0, 16);
    if (!name) return renderName("Type a nickname first.");
    const btn = e.target.querySelector("button"); btn.disabled = true; btn.textContent = "Joining…";
    try {
      await B.joinGame(P.pin, name);
      P.name = name;
      try { localStorage.setItem("dfq-name", name); } catch {}
      enterGame();
    } catch (err) {
      console.error(err); renderName("Couldn't join. Try again.");
    }
  };
}

function enterGame() {
  P.joined = true;
  try { localStorage.setItem("dfq-player", JSON.stringify({ pin: P.pin, name: P.name })); } catch {}
  history.replaceState(null, "", location.pathname + "?pin=" + P.pin);
  P.unsubGame?.(); P.unsubMe?.(); P.unsubRes?.();
  P.unsubGame = B.watchGame(P.pin, onGame, (e) => { console.error(e); toast("Connection lost, retrying…"); });
  P.unsubRes = B.watchMyResult(P.pin, (res) => { P.myRes = res; if (P.game) onGame(P.game); });
  let seen = false;
  P.unsubMe = B.watchMe(P.pin, (me) => {
    if (me) { seen = true; return; }
    if (seen) {
      P.unsubGame?.(); P.joined = false;
      try { localStorage.removeItem("dfq-player"); } catch {}
      shell(`<div class="status card"><div class="big-emoji">🚪</div><h2>You were removed by the host</h2><button class="btn btn-dark" id="again">Join again</button></div>`, "center");
      document.getElementById("again").onclick = () => renderPin(P.pin);
    }
  });
}

// ---------------- Game states ----------------
function onGame(g) {
  P.game = g;
  if (!g) {
    shell(`<div class="status card"><div class="big-emoji">👋</div><h2>This game has ended</h2></div>`, "center");
    return;
  }
  const needsResult = ["reveal", "leaderboard", "final"].includes(g.state);
  const ready = P.myRes && P.myRes.q === g.q;
  const r = ready ? P.myRes.r : null;
  if (r) P.score = r.s;
  const key = `${g.state}|${g.q}|${g.round}|${needsResult && ready ? "r" : ""}`;
  if (key === P.key) return; // ignore duplicate snapshots (e.g. server timestamp confirmations)
  P.key = key;
  clearInterval(P.timer);

  switch (g.state) {
    case "lobby":
      return shell(`<div class="status card"><div class="big-emoji">🎉</div><h2>You're in, ${esc(P.name)}!</h2><p>See your name on the big screen? Sit tight, the game starts soon.</p></div>`, "center");
    case "intro":
      return shell(`<div class="status intro-p"><div class="muted">Question ${g.q + 1} of ${g.total}</div><div class="cat-tag big">${CATS[g.question?.cat] || "❓"} ${esc(g.question?.cat || "")}</div><h2>Get ready…</h2><div class="intro-bar"><i style="animation-duration:3500ms"></i></div></div>`, "center");
    case "question":
      return renderQuestion(g);
    case "reveal":
      if (!ready) return shell(`<div class="status card"><div class="big-emoji">⏳</div><h2>Checking your answer…</h2></div>`, "center");
      return renderResult(g, r);
    case "leaderboard":
      return shell(r
        ? `<div class="status card"><div class="big-emoji">${r.r <= 3 ? "🔥" : "📊"}</div><h2>You're in ${ordinal(r.r)} place</h2>${g.playerCount ? `<p class="muted">out of ${g.playerCount.toLocaleString()}</p>` : ""}<p class="score-line">${r.s.toLocaleString()} points</p><p class="muted">Check the leaderboard on screen.</p></div>`
        : `<div class="status card"><div class="big-emoji">📊</div><h2>Leaderboard on screen</h2><p class="muted">Your first points are coming!</p></div>`, "center");
    case "final": {
      try { localStorage.removeItem("dfq-player"); } catch {}
      const medal = r ? ["🥇", "🥈", "🥉"][r.r - 1] || "🎊" : "🎊";
      return shell(`<div class="status card"><div class="big-emoji">${medal}</div><h2>${r ? `You finished ${ordinal(r.r)}${g.playerCount ? ` of ${g.playerCount.toLocaleString()}` : ""}` : "Game over"}</h2>${r ? `<p class="score-line">${r.s.toLocaleString()} points</p>` : ""}<p>Thanks for playing at DevFest Ibadan 2026! 💙</p></div>`, "center");
    }
  }
}

function renderQuestion(g) {
  const q = g.question;
  if (P.answeredRound === g.round) return renderLocked(q);
  if (!P.seenRoundAt[g.round]) P.seenRoundAt[g.round] = Date.now();
  const total = q.time * 1000;
  shell(`
    <div class="p-q">
      <div class="p-q-head"><span>Q${q.n}/${g.total}</span><div class="p-timer"><i id="ptimer"></i></div></div>
      <div class="p-prompt">${q.emoji ? `<div class="p-emoji">${esc(q.emoji)}</div>` : ""}${esc(q.prompt)}</div>
      <div class="p-tiles">
        ${q.options.map((o, k) => `<button class="p-tile t${k}" data-k="${k}">${shapeSvg(k)}<span>${esc(o)}</span></button>`).join("")}
      </div>
    </div>`, "fill");
  app.querySelectorAll(".p-tile").forEach((b) => (b.onclick = () => answer(+b.dataset.k)));
  const bar = document.getElementById("ptimer");
  P.timer = setInterval(() => {
    const left = Math.max(0, total - (Date.now() - P.seenRoundAt[g.round]));
    if (bar) bar.style.width = (left / total) * 100 + "%";
    if (left <= 0) {
      clearInterval(P.timer);
      app.querySelectorAll(".p-tile").forEach((b) => (b.disabled = true));
    }
  }, 100);
}

async function answer(k) {
  const g = P.game; if (!g || g.state !== "question" || P.answeredRound === g.round) return;
  P.answeredRound = g.round; P.myChoice = k;
  try { sessionStorage.setItem("dfq-answered", g.round); } catch {}
  clearInterval(P.timer);
  buzz(30);
  renderLocked(g.question);
  try { await B.submitAnswer(P.pin, g.round, k); }
  catch (e) { console.warn(e); if (!/already|permission/i.test(String(e.code || e.message))) toast("Answer may not have sent. Check your network."); }
}

function renderLocked(q) {
  const k = P.myChoice;
  shell(`<div class="status card">
      ${k != null ? `<div class="locked-tile t${k}">${shapeSvg(k)}</div>` : `<div class="big-emoji">🔒</div>`}
      <h2>Answer locked in!</h2><p class="muted">${k != null ? esc(q.options[k]) : ""}</p><p>Were you fast enough? 👀</p></div>`, "center");
}

function renderResult(g, r) {
  const correctText = g.question?.options?.[g.reveal?.answer] ?? "";
  let html;
  if (!r) html = `<div class="result neutral"><div class="big-emoji">👀</div><h2>Next one is yours!</h2></div>`;
  else if (r.c) { buzz([40, 60, 40]); html = `<div class="result good"><div class="big-emoji">✅</div><h2>Correct!</h2><div class="gain">+${r.g.toLocaleString()}</div>${r.st > 1 ? `<div class="streak">🔥 Answer streak ${r.st}</div>` : ""}</div>`; }
  else if (r.a) { buzz(200); html = `<div class="result bad"><div class="big-emoji">❌</div><h2>Not quite</h2><p>It was <b>${esc(correctText)}</b></p></div>`; }
  else html = `<div class="result bad"><div class="big-emoji">⏰</div><h2>Time's up!</h2><p>It was <b>${esc(correctText)}</b></p></div>`;
  shell(`${html}${r ? `<div class="place">You're in <b>${ordinal(r.r)}</b> place · ${r.s.toLocaleString()} pts</div>` : ""}`, "center result-wrap " + (r ? (r.c ? "bg-good" : "bg-bad") : ""));
}

// ---------------- Boot ----------------
(async function boot() {
  shell(`<div class="boot">Connecting…</div>`, "center");
  try { B = await getBackend(); }
  catch (e) { console.error(e); shell(`<div class="status card"><h2>Couldn't connect</h2><p class="muted">${esc(e.code || e.message)}</p></div>`, "center"); return; }
  const urlPin = (new URLSearchParams(location.search).get("pin") || "").replace(/\D/g, "");
  try {
    const saved = JSON.parse(localStorage.getItem("dfq-player") || "null");
    if (saved && (!urlPin || urlPin === saved.pin)) {
      const g = await B.getGame(saved.pin);
      const me = g && g.state !== "final" ? await B.getMe(saved.pin) : null;
      if (me) { P.pin = saved.pin; P.name = me.name; return enterGame(); }
    }
  } catch {}
  renderPin(urlPin);
})();
