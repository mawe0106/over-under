# Over/Under 🍻

A party game for one phone or every phone. Someone chugs; everyone else bets on
how long it takes. Two game modes, a synced stopwatch, a spinning wheel of fate.

## Game modes

**🎲 Over/Under** — the chugger calls their own time ("12 seconds"). Everyone
else just picks OVER or UNDER. Correct calls score a point. Whoever called it
*wrong* is up next: one wrong person goes straight up; several wrong people get
the **spinning wheel**, which picks the next chugger. (Everyone right? The wheel
spins over all of you — someone has to drink.)

**🔮 Chugstradamus** — everyone *except* the chugger predicts the exact time in
seconds. Closest prediction scores a point; furthest off chugs next (ties spin
the wheel). The chugger doesn't predict anything — they just drink.

Pick the mode in the lobby; you can also switch it mid-session from the 📊 menu
(applies from the next round).

## Play right now (zero setup)

Open `index.html` in any browser (or serve the folder statically) and tap
**Solo phone**. Everything lives in that phone's `localStorage` — no internet,
no accounts, pass it around the table.

```sh
# any static server works, e.g.:
python3 -m http.server 4173
# → http://localhost:4173
```

## Multi-phone rooms — one-time setup, then never again

Rooms sync live through a free [Supabase](https://supabase.com) project. **This
is not per-game**: you create the backend once, and from then on every game is
just "New Game" → share the 4-letter code. Rooms are throwaway (auto-cleaned
after 24h idle); the backend is permanent.

1. Create a Supabase project (free tier is plenty).
2. In the dashboard, open **SQL Editor**, paste the contents of
   [`supabase/schema.sql`](supabase/schema.sql), and run it.
3. Give the app the credentials, either way:
   - **Hosting for the group (recommended):** put the *Project URL* and *anon
     public* key (Project Settings → API) into [`js/config.js`](js/config.js)
     and host the folder anywhere static (GitHub Pages, Netlify, Vercel…).
     Every phone that opens the URL is ready to play.
   - **No file editing:** tap New Game → the setup screen lets you paste the
     URL + key right in the app (stored on that phone). Invite links then carry
     the credentials along, so friends who join via your link are set up
     automatically too.

## How a round works

1. **Predict** — Over/Under: the chugger calls their time (any phone can type
   it). Chugstradamus: everyone else enters their exact prediction.
2. **Bet** — Over/Under only: big OVER/UNDER buttons per player.
3. **Ready** — the stopwatch screen shows `00:00.00` armed with a manual
   **START** button. Nothing starts until someone taps it. In room mode the
   first phone to tap START owns the clock for the round (everyone else sees
   "Jamie is running the clock").
4. **Chug & stop** — iOS-stopwatch-style display, `MM:SS.HH`, live to the
   hundredth on every phone.
5. **Result** — points awarded, scoreboard updates, and the next chugger is
   revealed — directly, or by the spinning wheel when several people are in the
   firing line. New fastest-chug records get confetti.

📊 in the header opens all-time stats: fastest/slowest chug, average per player,
best over/under caller, best psychic (smallest average miss), and full round
history.

## Design notes

- **Stopwatch sync**: phones never sync a running timer. Tapping START
  atomically claims the clock server-side (`claim_timer`) and records one
  *server* timestamp; every phone renders `serverNow − startAt` using a clock
  offset measured on connect. Network lag can't make displays disagree.
- **Wheel fairness across phones**: the winner is decided (randomly) once, by
  the phone that stops the clock, and synced in the round state — every phone
  plays the same wheel animation landing on the same person.
- **Concurrent writes**: joins, bets, and phase flips go through atomic RPCs
  (`join_room`, `set_bet`, `set_phase`) so two phones acting at the same
  instant can't clobber each other.
- **Offline resilience**: room state is mirrored to `localStorage`, so a
  refresh or dead spot shows the last synced state instantly; a background
  poll and a refetch-on-unlock cover dropped realtime connections.

## Files

```
index.html            app shell
css/style.css         party styles
js/config.js          Supabase URL + anon key (optional — can also be set in-app)
js/app.js             game logic, sync backends, UI
supabase/schema.sql   run once in the Supabase SQL editor
```
