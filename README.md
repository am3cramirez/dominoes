# 🁣 Multiplayer Dominoes

An online multiplayer dominoes game (draw variant) inspired by dominoes.playdrift.com. Create a room, share the 5-letter code, and friends join instantly — no accounts needed.

## Features

- **Room codes** — host creates a room, gets a shareable 5-letter code, 2–4 players join with it; **Play Now** matches you into any open public table with no code needed
- **Real-time gameplay** via Socket.IO, with server-authoritative rules (no cheating from the client)
- **Draw dominoes rules** — double-six set, 7 tiles each, draw from the boneyard when you can't play, pass when it's empty
- **Lobby countdown** — press Start with as few as 1 player to open a 25s join window; every join resets it, and empty seats fill with CPU-controlled players when it expires
- **Scoring across rounds** — round winner collects ALL remaining pips on the table; first to 200 wins the match
- **Team play** — with exactly 4 players it's partner dominoes (seats 1&3 vs 2&4, all 28 tiles dealt, no boneyard); points go to the team
- **Bonuses** — +25 when everyone passes after your tile and you can still play (pass-around), +25 when your winning tile fits both open ends (capicúa), +25 when your round-opening tile shuts out the very next opponent while your partner can still play (opening block). No bonus is ever awarded on the move that locks the game, and the pass-around / opening-block +25 can't carry you across the target to win — if it would, it's announced but doesn't count
- **Locked-game handling** — when nobody can move, the round goes to whichever of just two players holds the lighter hand: the one who locked it (played the last tile) and the player immediately after them. Equal pips → tie, no score. On a lock the table holds while every hand flips face-up with a pip total under each player, so you can see the count
- **Sound** — synthesized effects (no asset files) for tile placement, your turn, bonuses, and round results, with a mute toggle in the top-right
- **Click-to-place or drag** — a tile that fits only one end plays on a single tap; a tile that fits both ends shows a highlighted ghost at each end so you can tap the side you want; or drag it straight onto the board
- **Anchored snake board** — the chain bends cleanly at the table edges like a real layout, doubles stand vertically across the line, and the whole board zooms smoothly to keep everything in view as it grows
- **15-second turn timer** — visible countdown; when it runs out the CPU plays a valid tile for you. CPU-filled seats move in ~1.3s
- **Automatic draw/pass** — no playable tile? The server draws (or passes) for you, no buttons to click
- **Round flow** — a toast announces who opens each round above their seat; when a round ends, a high-score-style tally shows the points scored (counting up) and the next round deals itself automatically — no "Next Round" click
- **Reconnect support** — drop mid-game and rejoin with the same name and room code; host can remove players who don't come back
- Mobile-friendly UI with tile animations, turn indicators, and live opponent tile counts

## Run it

```bash
npm install
npm start
```

Open http://localhost:3000 (set `PORT` to change the port). To play with friends over the internet, deploy anywhere Node.js runs (Railway, Render, Fly.io, a VPS) — it's a single process with no database.

Tunable timings via environment variables (all optional, sane defaults baked in): `TURN_MS`, `AUTO_DELAY_MS`, `LOBBY_COUNTDOWN_MS`, `BOT_MOVE_MS`, `ROUND_TALLY_MS`.

## How to play

1. Enter your name and click **Play Now** to join any open table, or **Create Private Room** for a code-only game with friends
2. Once at least one player is seated, press **Start Game** — this opens a 25 second window for others to join (every join resets it); if it runs out, empty seats are filled with CPU players
3. With exactly 4 players it's 2v2 partner dominoes; otherwise it's every player for themselves
4. The player with the highest double leads. Drag a tile onto a highlighted drop zone to play it; if it fits both ends you'll be asked which side
5. Can't play? The server automatically draws or passes for you — just wait for your turn
6. First to empty their hand wins the round and collects all remaining pips on the table, plus any bonuses. Watch the score tally, then the next round deals itself automatically. First to 200 points wins the match
