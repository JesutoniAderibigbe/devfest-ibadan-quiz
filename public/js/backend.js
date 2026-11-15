// Backend abstraction: Firebase (Firestore + anonymous auth) or a local demo mode.
//
// Firestore layout
//   games/{pin}                          game state, written by the host only
//   games/{pin}/players/{uid}            { name, joinedAt }   created by each player
//   games/{pin}/rounds/{round}/answers/{uid}  { choice, at } created once per player per round
//   games/{pin}/results/s{0..15}         { q, r: {uid: {s,g,c,a,st,r}} } per-player results, sharded
//                                        so each phone only downloads a small slice (scales to thousands)

const cfg = window.FIREBASE_CONFIG || {};
export const DEMO = !cfg.apiKey || cfg.apiKey === "PASTE_ME";
export const SHARDS = 16;
export function shardOf(uid) {
  let h = 0;
  for (let i = 0; i < uid.length; i++) h = (h * 31 + uid.charCodeAt(i)) >>> 0;
  return h % SHARDS;
}

function toMillis(obj) {
  if (!obj) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = v && typeof v.toMillis === "function" ? v.toMillis() : v;
  return out;
}

async function firebaseBackend() {
  const fb = await import("../vendor/firebase.js");
  const app = fb.initializeApp(cfg);
  const auth = fb.getAuth(app);
  // Some networks block identitytoolkit/securetoken.googleapis.com. On Vercel we relay those calls
  // through same-origin rewrites (see vercel.json), so phones only talk to this site and Firestore.
  // Relies on the bundled SDK's auth.config hosts, so keep the vendor bundle pinned.
  if (!/^(localhost|127\.|\[::1\])/.test(location.hostname)
      && !/\.(web\.app|firebaseapp\.com)$/.test(location.hostname)) {
    auth.config.apiHost = location.host + "/gapi/auth";
    auth.config.tokenApiHost = location.host + "/gapi/token";
  }
  // Long-polling auto-detect helps on venue Wi-Fi and proxies that break WebChannel streams.
  const db = fb.initializeFirestore(app, { experimentalAutoDetectLongPolling: true });

  const uid = await new Promise((resolve, reject) => {
    const off = fb.onAuthStateChanged(auth, (u) => {
      if (u) { off(); resolve(u.uid); }
    });
    fb.signInAnonymously(auth).catch(reject);
  });

  const gameRef = (pin) => fb.doc(db, "games", pin);
  const snapOpts = { serverTimestamps: "estimate" };

  return {
    demo: false,
    uid,
    serverTime: () => fb.serverTimestamp(),
    async getGame(pin) {
      const s = await fb.getDoc(gameRef(pin));
      return s.exists() ? toMillis(s.data(snapOpts)) : null;
    },
    createGame: (pin, data) => fb.setDoc(gameRef(pin), data),
    updateGame: (pin, patch) => fb.updateDoc(gameRef(pin), patch),
    watchGame(pin, cb, onErr) {
      return fb.onSnapshot(gameRef(pin), (s) => cb(s.exists() ? toMillis(s.data(snapOpts)) : null), onErr);
    },
    joinGame: (pin, name) =>
      fb.setDoc(fb.doc(db, "games", pin, "players", uid), { name, joinedAt: fb.serverTimestamp() }),
    async getMe(pin) {
      const s = await fb.getDoc(fb.doc(db, "games", pin, "players", uid));
      return s.exists() ? s.data() : null;
    },
    watchMe(pin, cb) {
      return fb.onSnapshot(fb.doc(db, "games", pin, "players", uid), (s) => cb(s.exists() ? s.data() : null));
    },
    watchPlayers(pin, cb) {
      const m = new Map();
      return fb.onSnapshot(fb.collection(db, "games", pin, "players"), (qs) => {
        for (const ch of qs.docChanges()) {
          if (ch.type === "removed") m.delete(ch.doc.id);
          else m.set(ch.doc.id, { uid: ch.doc.id, ...toMillis(ch.doc.data(snapOpts)) });
        }
        cb([...m.values()]);
      });
    },
    removePlayer: (pin, puid) => fb.deleteDoc(fb.doc(db, "games", pin, "players", puid)),
    submitAnswer: (pin, round, choice) =>
      fb.setDoc(fb.doc(db, "games", pin, "rounds", round, "answers", uid), { choice, at: fb.serverTimestamp() }),
    watchAnswers(pin, round, cb) {
      const m = new Map();
      return fb.onSnapshot(fb.collection(db, "games", pin, "rounds", round, "answers"), (qs) => {
        for (const ch of qs.docChanges()) {
          if (ch.type === "removed") m.delete(ch.doc.id);
          else m.set(ch.doc.id, { uid: ch.doc.id, ...toMillis(ch.doc.data(snapOpts)) });
        }
        cb([...m.values()]);
      });
    },
    // shards: array of SHARDS maps {uid: result}. One small write per shard, in parallel.
    writeResults: (pin, q, shards) =>
      Promise.all(shards.map((r, i) => fb.setDoc(fb.doc(db, "games", pin, "results", "s" + i), { q, r }))),
    watchMyResult(pin, cb) {
      return fb.onSnapshot(fb.doc(db, "games", pin, "results", "s" + shardOf(uid)), (s) => {
        const d = s.exists() ? s.data() : null;
        cb(d ? { q: d.q, r: (d.r || {})[uid] || null } : null);
      });
    },
    async getAllResults(pin) {
      const qs = await fb.getDocs(fb.collection(db, "games", pin, "results"));
      const out = {};
      qs.forEach((d) => Object.assign(out, d.data().r || {}));
      return out;
    },
  };
}

// ---------- Demo backend: localStorage + storage events, works across tabs of one browser ----------
function demoBackend() {
  const P = "dfq:";
  let uid = sessionStorage.getItem("dfq-uid");
  if (!uid) { uid = "u" + Math.random().toString(36).slice(2, 10); sessionStorage.setItem("dfq-uid", uid); }
  const subs = new Set(); // { match(path), fire() }
  const read = (path) => { try { return JSON.parse(localStorage.getItem(P + path)); } catch { return null; } };
  const notify = (path) => subs.forEach((s) => s.match(path) && s.fire());
  const resolveTimes = (o) => {
    const out = {};
    for (const [k, v] of Object.entries(o)) out[k] = v && v.__st ? Date.now() : v;
    return out;
  };
  const write = (path, val) => { localStorage.setItem(P + path, JSON.stringify(val)); notify(path); };
  const del = (path) => { localStorage.removeItem(P + path); notify(path); };
  const list = (prefix) => {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith(P + prefix) && !k.slice((P + prefix).length).includes("/"))
        out.push({ uid: k.slice((P + prefix).length), ...JSON.parse(localStorage.getItem(k)) });
    }
    return out;
  };
  window.addEventListener("storage", (e) => { if (e.key && e.key.startsWith(P)) notify(e.key.slice(P.length)); });
  const sub = (match, fire) => { const s = { match, fire }; subs.add(s); setTimeout(fire, 0); return () => subs.delete(s); };
  const later = (v) => new Promise((r) => setTimeout(() => r(v), 30));

  return {
    demo: true,
    uid,
    serverTime: () => ({ __st: 1 }),
    getGame: (pin) => later(read(`games/${pin}`)),
    createGame: (pin, data) => later(write(`games/${pin}`, resolveTimes(data))),
    updateGame: (pin, patch) => later(write(`games/${pin}`, { ...read(`games/${pin}`), ...resolveTimes(patch) })),
    watchGame: (pin, cb) => sub((p) => p === `games/${pin}`, () => cb(read(`games/${pin}`))),
    joinGame: (pin, name) => later(write(`games/${pin}/players/${uid}`, resolveTimes({ name, joinedAt: { __st: 1 } }))),
    getMe: (pin) => later(read(`games/${pin}/players/${uid}`)),
    watchMe: (pin, cb) => sub((p) => p === `games/${pin}/players/${uid}`, () => cb(read(`games/${pin}/players/${uid}`))),
    watchPlayers: (pin, cb) => sub((p) => p.startsWith(`games/${pin}/players/`), () => cb(list(`games/${pin}/players/`))),
    removePlayer: (pin, puid) => later(del(`games/${pin}/players/${puid}`)),
    async submitAnswer(pin, round, choice) {
      const path = `games/${pin}/rounds/${round}/answers/${uid}`;
      if (read(path)) throw new Error("already answered");
      write(path, { choice, at: Date.now() });
    },
    watchAnswers: (pin, round, cb) =>
      sub((p) => p.startsWith(`games/${pin}/rounds/${round}/answers/`), () => cb(list(`games/${pin}/rounds/${round}/answers/`))),
    writeResults: async (pin, q, shards) => shards.forEach((r, i) => write(`games/${pin}/results/s${i}`, { q, r })),
    watchMyResult: (pin, cb) => {
      const path = `games/${pin}/results/s${shardOf(uid)}`;
      return sub((p) => p === path, () => { const d = read(path); cb(d ? { q: d.q, r: (d.r || {})[uid] || null } : null); });
    },
    getAllResults: async (pin) => {
      const out = {};
      for (let i = 0; i < SHARDS; i++) Object.assign(out, (read(`games/${pin}/results/s${i}`) || {}).r || {});
      return out;
    },
  };
}

export async function getBackend() {
  return DEMO ? demoBackend() : firebaseBackend();
}

// ---------- Shared helpers ----------
export const SHAPES = ["triangle", "diamond", "circle", "square"];
export function shapeSvg(i) {
  const paths = [
    '<polygon points="50,10 92,88 8,88"/>',
    '<polygon points="50,6 94,50 50,94 6,50"/>',
    '<circle cx="50" cy="50" r="42"/>',
    '<rect x="12" y="12" width="76" height="76" rx="6"/>',
  ];
  return `<svg viewBox="0 0 100 100" class="shape" aria-hidden="true" fill="currentColor">${paths[i]}</svg>`;
}
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
export function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
export const gdgLogo = `<svg viewBox="0 0 120 70" class="gdg-logo" aria-hidden="true">
  <g stroke="#1b1b1b" stroke-width="4">
    <rect x="6" y="20" width="52" height="22" rx="11" transform="rotate(-35 32 31)" fill="#EA4335"/>
    <rect x="6" y="32" width="52" height="22" rx="11" transform="rotate(35 32 43)" fill="#4285F4"/>
    <rect x="62" y="20" width="52" height="22" rx="11" transform="rotate(35 88 31)" fill="#34A853"/>
    <rect x="62" y="32" width="52" height="22" rx="11" transform="rotate(-35 88 43)" fill="#FBBC04"/>
  </g></svg>`;
