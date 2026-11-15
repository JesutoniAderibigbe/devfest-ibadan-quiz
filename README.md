# DevFest Ibadan 2026 Quiz Arena

Kahoot-style live quiz for the four halls. Each hall's host screen creates its own 6-digit game PIN and QR code; attendees join on their phones, answer on big coloured tiles, and get points for speed and streaks. Live sync runs on Firebase (Firestore + Anonymous Auth, project `devfest-ibadan-quiz-2026`). The site is hosted on Vercel at https://devfest-ibadan-quiz.vercel.app.

- `public/host.html`: projector screen. Pick a hall, show the PIN, run the 10 questions.
- `public/index.html`: phone screen. Enter PIN (or scan the QR), pick a nickname, play.
- `public/questions.js`: the 4 question sets. Edit freely, no rebuild needed.
- `public/config.js`: your Firebase web config.
- `firestore.rules`: security rules (players can only write their own name and one answer per round; only the host can change the game, read answers or write results).
- `firestore.indexes.json`: turns off indexes on timestamp fields so thousands of answers can land in the same second without hitting Firestore's hotspot limit.

**Live:** host screen at https://devfest-ibadan-quiz.vercel.app/host · players at https://devfest-ibadan-quiz.vercel.app

## 1. Setup

The live setup uses **Firebase** for data and sign-in and **Vercel** for hosting.

### Firebase (data + sign-in)

1. In the Firebase console, create a project. The live one is `devfest-ibadan-quiz-2026`.
2. **Build > Authentication > Sign-in method**: enable **Anonymous**.
3. **Build > Firestore Database**: create a database in production mode, region `africa-south1` (or `europe-west1`).
4. **Project settings > Your apps > Add app > Web**. Copy the `firebaseConfig` object into `public/config.js`.
5. Deploy the security rules and indexes:
   ```bash
   npm install -g firebase-tools
   firebase login
   firebase use --add            # select your project (writes .firebaserc)
   firebase deploy --only firestore
   ```

### Vercel (hosting)

Pushing to `main` on GitHub deploys to production automatically. To deploy by hand: `vercel deploy --prod`.

**Why Vercel and not Firebase Hosting:** some networks block Google's sign-in servers (`identitytoolkit` / `securetoken.googleapis.com`), which makes players see `auth/network-request-failed`. `vercel.json` relays those calls through `/gapi/auth` and `/gapi/token` on our own domain, and `public/js/backend.js` points the Auth SDK there. Phones then only talk to the Vercel site and Firestore.

- The relay uses the bundled SDK's internal `auth.config.apiHost`. Don't rebuild `public/vendor/firebase.js` with a newer SDK without re-testing sign-in on a restricted network.
- The old Firebase Hosting copy (`devfest-ibadan-quiz-2026.web.app`) skips the relay, so share the Vercel URL.
- A custom domain (e.g. `quiz.devfestibadan.com`) can be added in the Vercel project under Settings > Domains.

## 2. Capacity: built for thousands per hall

- Each hall's game is independent, and each can take thousands of players.
- Phones only listen to two small documents: the game state and one of 16 result "shards" (about 20 KB at 5,000 players). Scoring 5,000 players takes a few milliseconds on the host laptop.
- Answers are written as separate documents with server timestamps, and their indexes are disabled, so a burst of thousands of taps in one second is fine.
- The lobby shows the newest 60 names plus a "+N more" counter so the projector stays readable.

**Use the Blaze (pay as you go) plan.** The free Spark plan caps Firestore at 50,000 reads and 20,000 writes a day (resetting at 9:00 am Nigeria time). Each player uses about 55 reads per game, so the free plan runs out at roughly 900 players per day across all halls. Rough cost on Blaze: a 10-question game with 3,000 players is about 170,000 reads and 35,000 writes, well under US$1. Set a budget alert (e.g. $10) in Google Cloud Billing.

## 3. Running it on the day

- One laptop per hall on the projector, signed in to nothing special. Open `/host`, click the hall, press **F** for fullscreen.
- Keyboard: **Space / Enter / →** triggers the main button (Start, Leaderboard, Next).
- **End question** skips the timer. The question also ends automatically when everyone has answered.
- Tap a nickname in the lobby to remove it (for rude names). The player sees "removed by the host" and can rejoin.
- If the host laptop refreshes or crashes, reopen `/host` on the same browser and press **Resume**. Scores are kept; an interrupted question restarts.
- Sound effects are generated in the browser; plug the laptop into the hall speakers. 🔊 toggles mute.
- Players need internet (mobile data is safer than crowded venue Wi-Fi).

## 4. Scoring

Each question has a 10-second timer (the `time` field in `questions.js`). Correct answers earn 500 to 1,000 points depending on speed (server-timestamped, so a slow phone clock doesn't matter), plus a streak bonus of +100 per consecutive correct answer (max +500). Wrong or missing answers earn 0 and reset the streak.

## 5. Rehearse without Firebase

Leave `apiKey: "PASTE_ME"` in `config.js` and serve the `public` folder locally:

```bash
cd public && python3 -m http.server 8080
```

Open `http://localhost:8080/host` in one tab and `http://localhost:8080/?pin=XXXXXX` in other tabs of the **same browser**. Demo mode syncs tabs through localStorage, so you can click through the whole game.

## 6. Editing questions

Each question in `public/questions.js`:

```js
{ cat: "Emoji Puzzle", prompt: "Guess the app!", emoji: "👻📸",
  options: ["Instagram", "BeReal", "Pinterest", "Snapchat"], answer: 3, time: 10,
  fact: "Snapchat's ghost logo is called Ghostface Chillah." }
```

`answer` is the 0-based index of the correct option. Keep exactly 4 options. Note that `questions.js` is a public file, so a determined attendee could open it; it's a fun game, so that's an accepted trade-off.

## Rebuilding the bundled libraries (optional)

The Firebase SDK and QR generator are pre-bundled in `public/vendor/` so the site doesn't depend on CDNs at the venue. To update them:

```bash
npm install
npm run build:vendor
```
