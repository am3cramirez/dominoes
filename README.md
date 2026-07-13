# 🁣 Multiplayer Dominoes

An online multiplayer dominoes game (draw variant) inspired by dominoes.playdrift.com. Create a room, share the 5-letter code, and friends join instantly — no accounts needed.

## Features

- **Room codes** — host creates a room, gets a shareable 5-letter code, 2–4 players join with it
- **Real-time gameplay** via Socket.IO, with server-authoritative rules (no cheating from the client)
- **Draw dominoes rules** — double-six set, 7 tiles each, draw from the boneyard when you can't play, pass when it's empty
- **Scoring across rounds** — round winner collects opponents' pips; first to 100 wins the match
- **Blocked-game handling** — lowest pip count wins when nobody can move
- **Reconnect support** — drop mid-game and rejoin with the same name and room code; host can remove players who don't come back
- Mobile-friendly UI with tile animations, turn indicators, and live opponent tile counts

## Run it

```bash
npm install
npm start
```

Open http://localhost:3000 (set `PORT` to change the port). To play with friends over the internet, deploy anywhere Node.js runs (Railway, Render, Fly.io, a VPS) — it's a single process with no database.

## How to play

1. Enter your name and click **Create Room**
2. Share the room code with friends; they enter it under **Join**
3. Host clicks **Start Game** once 2–4 players are in
4. The player with the highest double leads. On your turn, click a highlighted tile to play it; if it fits both ends you'll be asked which side
5. Can't play? **Draw** from the boneyard until you can, or **Pass** once it's empty
6. First player to empty their hand wins the round and scores the opponents' remaining pips. First to 100 points wins the match
