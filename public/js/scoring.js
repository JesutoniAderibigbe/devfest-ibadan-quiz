// Kahoot-style scoring. Pure functions so they can be tested on their own.
// Correct answer: 500 to 1000 points depending on speed, plus a streak bonus (100 per streak step, max 500).

export const GRACE_MS = 1500; // allowance for answers still in flight when the timer hits zero

export function pointsFor(elapsedMs, limitMs) {
  const t = Math.min(1, Math.max(0, elapsedMs / limitMs));
  return Math.round(1000 * (1 - t / 2));
}

/**
 * @param players  [{uid, name}]
 * @param answers  [{uid, choice, at}]  (at = server ms)
 * @param prev     {uid: {s, st}}  running totals and streaks
 * @param q        {answer, time}
 * @param startMs  server ms when the question opened
 * @returns { scores, results, counts, top }
 */
export function scoreRound(players, answers, prev, q, startMs) {
  const limitMs = q.time * 1000;
  const byUid = new Map(answers.map((a) => [a.uid, a]));
  const counts = [0, 0, 0, 0];
  const scores = {};
  const results = {};

  for (const p of players) {
    const before = prev[p.uid] || { s: 0, st: 0 };
    const a = byUid.get(p.uid);
    let gained = 0, correct = false, answered = false, st = 0;
    if (a && Number.isInteger(a.choice) && a.choice >= 0 && a.choice <= 3) {
      const elapsed = (a.at ?? startMs + limitMs) - startMs;
      if (elapsed <= limitMs + GRACE_MS) {
        answered = true;
        counts[a.choice]++;
        if (a.choice === q.answer) {
          correct = true;
          st = before.st + 1;
          gained = pointsFor(elapsed, limitMs) + Math.min(st - 1, 5) * 100;
        }
      }
    }
    scores[p.uid] = { s: before.s + gained, st };
    results[p.uid] = { s: before.s + gained, g: gained, c: correct, a: answered, st };
  }

  const ranked = players
    .map((p) => ({ uid: p.uid, name: p.name, s: scores[p.uid].s }))
    .sort((x, y) => y.s - x.s);
  ranked.forEach((r, i) => {
    // equal scores share a rank
    const rank = i > 0 && ranked[i - 1].s === r.s ? results[ranked[i - 1].uid].r : i + 1;
    results[r.uid].r = rank;
  });

  return { scores, results, counts, top: ranked.slice(0, 5) };
}
