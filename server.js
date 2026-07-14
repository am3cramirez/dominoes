const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;
const HAND_SIZE = 7;
const TARGET_SCORE = 200;
const PASS_BONUS = 25; // everyone skips after your tile
const CAPICUA_BONUS = 25; // winning tile fits both ends
const TURN_MS = Number(process.env.TURN_MS) || 15000; // time to play before the CPU plays for you
const AUTO_DELAY = Number(process.env.AUTO_DELAY_MS) || 900; // pause before automatic draws/passes so players can follow
const LOBBY_COUNTDOWN_MS = Number(process.env.LOBBY_COUNTDOWN_MS) || 25000; // join window after host presses Start
const BOT_MOVE_MS = Number(process.env.BOT_MOVE_MS) || 1300; // CPU-filled players "think" this long per turn
const ROUND_TALLY_MS = Number(process.env.ROUND_TALLY_MS) || 3200; // gap before the next round auto-deals
const OPENING_BLOCK_BONUS = 25; // round-opening tile shuts out the next opponent, but not their partner too
const ROOM_TTL_MS = 1000 * 60 * 60; // sweep rooms idle for an hour

/** rooms: code -> room */
const rooms = new Map();

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function makeTileSet() {
  const tiles = [];
  for (let a = 0; a <= 6; a++) {
    for (let b = a; b <= 6; b++) tiles.push([a, b]);
  }
  return tiles;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pipSum(hand) {
  return hand.reduce((s, t) => s + t[0] + t[1], 0);
}

/* With exactly 4 players it's partner dominoes: seats 0&2 vs 1&3. */
function teamsEnabled(room) {
  return room.players.length === 4;
}

function teamOf(room, playerIndex) {
  return teamsEnabled(room) ? playerIndex % 2 : playerIndex;
}

function teammates(room, playerIndex) {
  return room.players
    .map((_, i) => i)
    .filter((i) => teamOf(room, i) === teamOf(room, playerIndex));
}

/* Points always go to the whole team (just the player when no teams). */
function awardPoints(room, playerIndex, pts) {
  for (const i of teammates(room, playerIndex)) room.players[i].score += pts;
}

function tilePlayableSides(tile, game) {
  if (game.board.length === 0) return ['left'];
  const sides = [];
  if (tile[0] === game.leftEnd || tile[1] === game.leftEnd) sides.push('left');
  if (tile[0] === game.rightEnd || tile[1] === game.rightEnd) sides.push('right');
  return sides;
}

function handHasPlayable(hand, game) {
  return hand.some((t) => tilePlayableSides(t, game).length > 0);
}

function createRoom(hostSocket, name, isPublic) {
  const code = makeRoomCode();
  const room = {
    code,
    isPublic: !!isPublic,
    hostId: hostSocket.id,
    players: [], // { id, name, connected, hand: [], score }
    game: null,
    startCountdownEndsAt: null,
    lastActivity: Date.now(),
  };
  rooms.set(code, room);
  addPlayer(room, hostSocket, name);
  return room;
}

/** Deal a new round if the room is in a startable state. Returns true if started. */
function tryStartRound(room) {
  if (room.game && !room.game.over) return false;
  clearStartCountdown(room);
  // Drop seats that never came back before dealing a fresh round.
  room.players = room.players.filter((p) => p.connected);
  if (room.players.length < MIN_PLAYERS) return false;
  // New match if the previous one finished.
  if (room.game && room.game.matchWinner !== null && room.game.matchWinner !== undefined) {
    for (const p of room.players) p.score = 0;
  }
  startRound(room);
  return true;
}

function clearStartCountdown(room) {
  if (room.startCountdownTimer) clearTimeout(room.startCountdownTimer);
  room.startCountdownTimer = null;
  room.startCountdownEndsAt = null;
}

function clearRoundTimer(room) {
  if (room.roundTimer) clearTimeout(room.roundTimer);
  room.roundTimer = null;
}

/** Fill every empty seat (up to MAX_PLAYERS) with a CPU-controlled bot. */
function fillWithBots(room) {
  let n = 1;
  while (room.players.length < MAX_PLAYERS) {
    while (room.players.some((p) => p.name === `CPU ${n}`)) n++;
    room.players.push({
      id: `bot-${room.code}-${n}`,
      name: `CPU ${n}`,
      connected: true,
      isBot: true,
      hand: [],
      score: 0,
    });
    n++;
  }
}

/** Start (or restart) the 25s join window. Any join while it runs resets it. */
function armStartCountdown(room) {
  clearStartCountdown(room);
  room.startCountdownEndsAt = Date.now() + LOBBY_COUNTDOWN_MS;
  room.startCountdownTimer = setTimeout(() => {
    if (rooms.get(room.code) !== room) return;
    room.startCountdownTimer = null;
    room.startCountdownEndsAt = null;
    if (room.players.length < MAX_PLAYERS) fillWithBots(room);
    tryStartRound(room);
    broadcast(room);
  }, LOBBY_COUNTDOWN_MS);
}

/** Called after a join: extend the countdown, or start now if the table just filled up. */
function onPlayerJoinedDuringLobby(room) {
  if (!room.startCountdownTimer) return;
  if (room.players.length >= MAX_PLAYERS) {
    clearStartCountdown(room);
    tryStartRound(room);
  } else {
    armStartCountdown(room);
  }
}

function addPlayer(room, socket, name) {
  const player = { id: socket.id, name, connected: true, hand: [], score: 0 };
  room.players.push(player);
  socket.join(room.code);
  socket.data.roomCode = room.code;
  return player;
}

function startRound(room) {
  const boneyard = shuffle(makeTileSet());
  for (const p of room.players) p.hand = boneyard.splice(0, HAND_SIZE);

  // Highest double starts; if nobody holds a double, highest pip tile starts.
  let starter = 0;
  let bestDouble = -1;
  let bestPips = -1;
  room.players.forEach((p, i) => {
    for (const t of p.hand) {
      if (t[0] === t[1] && t[0] > bestDouble) {
        bestDouble = t[0];
        starter = i;
      }
      if (bestDouble < 0 && t[0] + t[1] > bestPips) {
        bestPips = t[0] + t[1];
        starter = i;
      }
    }
  });

  room.game = {
    board: [], // ordered tiles, oriented: tile[0] touches previous tile
    leftEnd: null,
    rightEnd: null,
    boneyard,
    turn: starter,
    starter, // who opens this round (for the "X starts" announcement)
    roundId: (room.roundCounter = (room.roundCounter || 0) + 1),
    passes: 0,
    over: false,
    roundWinner: null,
    matchWinner: null,
    blocked: false,
    lastMove: null, // { playerIndex, tile, side } | { playerIndex, pass: true } | { playerIndex, drew: true }
    lastTilePlayer: null, // who placed the most recent tile (for the pass-around bonus)
    capicua: false,
    bonuses: [], // e.g. [{ playerIndex, type: 'pass'|'capicua', points }]
    turnDeadline: null,
    leftCount: 0, // tiles added to the left of the first tile (board anchor for layout)
  };
  beginTurn(room);
}

function clearTimers(room) {
  if (room.turnTimer) clearTimeout(room.turnTimer);
  if (room.autoTimer) clearTimeout(room.autoTimer);
  room.turnTimer = room.autoTimer = null;
}

/**
 * Called whenever a new player is on the move. Auto-draws when they have no
 * playable tile, auto-passes when the boneyard is dry, and arms the 15s
 * timer after which the CPU plays for them.
 */
function beginTurn(room) {
  const g = room.game;
  clearTimers(room);
  if (!g || g.over || room.players.length === 0) return;
  if (g.turn >= room.players.length) g.turn = 0;
  const player = room.players[g.turn];

  const autoDelay = AUTO_DELAY;
  if (!handHasPlayable(player.hand, g)) {
    g.turnDeadline = Date.now() + autoDelay;
    g.turnTotal = autoDelay;
    room.autoTimer = setTimeout(() => {
      const cur = room.game;
      if (!cur || cur.over || cur !== g) return;
      if (g.boneyard.length > 0) {
        player.hand.push(g.boneyard.pop());
        g.lastMove = { playerIndex: g.turn, drew: true, auto: true };
        broadcast(room);
        beginTurn(room); // may need to draw again, or can play now
      } else {
        doPass(room, g.turn, true);
      }
    }, autoDelay);
    return;
  }

  // CPU-filled seats "think" briefly instead of waiting out the full human timer.
  const thinkMs = player.isBot ? BOT_MOVE_MS : TURN_MS;
  g.turnDeadline = Date.now() + thinkMs;
  g.turnTotal = thinkMs;
  room.turnTimer = setTimeout(() => {
    const cur = room.game;
    if (!cur || cur.over || cur !== g) return;
    // CPU plays a random playable tile on a random valid side
    const options = [];
    player.hand.forEach((t, i) => {
      for (const side of tilePlayableSides(t, g)) options.push({ i, side });
    });
    if (options.length === 0) return beginTurn(room); // shouldn't happen
    const pick = options[Math.floor(Math.random() * options.length)];
    if (!player.isBot) io.to(room.code).emit('toast', `⏱ Time's up — playing for ${player.name}`);
    doPlay(room, g.turn, pick.i, pick.side, true);
  }, thinkMs);
}

/** Place a tile. Assumes turn/ownership already validated. Returns {error} or {ok}. */
function doPlay(room, playerIndex, tileIndex, side, auto = false) {
  const g = room.game;
  const player = room.players[playerIndex];
  const tile = player.hand[tileIndex];
  if (!tile) return { error: 'Invalid tile.' };
  const sides = tilePlayableSides(tile, g);
  if (!sides.includes(side)) {
    if (sides.length === 0) return { error: "That tile doesn't match either end." };
    side = sides[0];
  }

  // Resolve any pending opening-block bonus: this player COULD play, so no bonus.
  if (g.openingBonusPending && g.openingBonusPending.nextIndex === playerIndex) {
    g.openingBonusPending = null;
  }

  const wasFirstTile = g.board.length === 0;

  // Capicúa: the round-winning tile fits BOTH open ends of the line.
  if (player.hand.length === 1 && g.board.length > 0 && tile[0] !== tile[1]) {
    const fitsLeft = tile[0] === g.leftEnd || tile[1] === g.leftEnd;
    const fitsRight = tile[0] === g.rightEnd || tile[1] === g.rightEnd;
    g.capicua = fitsLeft && fitsRight;
  }

  player.hand.splice(tileIndex, 1);

  if (g.board.length === 0) {
    g.board.push(tile);
    g.leftEnd = tile[0];
    g.rightEnd = tile[1];
  } else if (side === 'left') {
    const oriented = tile[1] === g.leftEnd ? tile : [tile[1], tile[0]];
    g.board.unshift(oriented);
    g.leftEnd = oriented[0];
    g.leftCount += 1;
  } else {
    const oriented = tile[0] === g.rightEnd ? tile : [tile[1], tile[0]];
    g.board.push(oriented);
    g.rightEnd = oriented[1];
  }

  g.passes = 0;
  g.lastMove = { playerIndex, tile, side, auto };
  g.lastTilePlayer = playerIndex;

  if (player.hand.length === 0) {
    endRound(room, playerIndex, false);
  } else {
    advanceTurn(room);
    // Track the round-opening tile so we can reward the opener if the very
    // next player is shut out — but only while their partner can still play.
    if (wasFirstTile && teamsEnabled(room)) {
      g.openingBonusPending = { starterIndex: playerIndex, nextIndex: g.turn };
    }
  }
  broadcast(room);
  if (!g.over) beginTurn(room);
  return { ok: true };
}

/** Pass the turn (only legal with no playable tile and an empty boneyard). */
function doPass(room, playerIndex, auto = false) {
  const g = room.game;
  g.passes += 1;
  g.lastMove = { playerIndex, pass: true, auto };

  // Opening-block bonus: the round-opening tile shut out the very next
  // player, but only pays if the opener's partner can still play — if it
  // skips the partner too, nothing is awarded.
  if (g.openingBonusPending && g.openingBonusPending.nextIndex === playerIndex) {
    const { starterIndex } = g.openingBonusPending;
    const partnerIndex = teammates(room, starterIndex).find((i) => i !== starterIndex);
    if (partnerIndex !== undefined && handHasPlayable(room.players[partnerIndex].hand, g)) {
      awardPoints(room, starterIndex, OPENING_BLOCK_BONUS);
      g.bonuses.push({ playerIndex: starterIndex, type: 'openingBlock', points: OPENING_BLOCK_BONUS });
      io.to(room.code).emit('bonus', {
        playerIndex: starterIndex,
        name: room.players[starterIndex].name,
        type: 'openingBlock',
        points: OPENING_BLOCK_BONUS,
      });
      if (room.players[starterIndex].score >= TARGET_SCORE) {
        g.over = true;
        g.roundWinner = starterIndex;
        g.matchWinner = starterIndex;
        g.roundPoints = 0;
      }
    }
    g.openingBonusPending = null;
  }

  // Pass-around bonus: everyone else skipped after your tile AND you can still
  // play (so the game keeps going). If it comes back to you and you're stuck
  // too, that's a locked game — no bonus is awarded for locking it.
  if (
    !g.over &&
    g.passes === room.players.length - 1 &&
    g.lastTilePlayer !== null &&
    handHasPlayable(room.players[g.lastTilePlayer].hand, g)
  ) {
    awardPoints(room, g.lastTilePlayer, PASS_BONUS);
    g.bonuses.push({ playerIndex: g.lastTilePlayer, type: 'pass', points: PASS_BONUS });
    io.to(room.code).emit('bonus', {
      playerIndex: g.lastTilePlayer,
      name: room.players[g.lastTilePlayer].name,
      type: 'pass',
      points: PASS_BONUS,
    });
    // If the bonus alone reaches the target, the match ends right here.
    if (room.players[g.lastTilePlayer].score >= TARGET_SCORE) {
      g.over = true;
      g.roundWinner = g.lastTilePlayer;
      g.matchWinner = g.lastTilePlayer;
      g.roundPoints = PASS_BONUS;
    }
  }
  if (!g.over) checkBlocked(room);
  if (!g.over) advanceTurn(room);
  broadcast(room);
  if (g.over) clearTimers(room);
  else beginTurn(room);
  return { ok: true };
}

function advanceTurn(room) {
  const g = room.game;
  g.turn = (g.turn + 1) % room.players.length;
}

function endRound(room, winnerIndex, blocked) {
  const g = room.game;
  clearTimers(room);
  clearRoundTimer(room);
  g.over = true;
  g.blocked = blocked;
  g.roundWinner = winnerIndex;
  if (winnerIndex !== null) {
    // Winner's side collects ALL remaining pips on the table (partner's included).
    let gained = room.players.reduce(
      (s, p, i) => (i === winnerIndex ? s : s + pipSum(p.hand)),
      0
    );
    if (g.capicua) {
      gained += CAPICUA_BONUS;
      g.bonuses.push({ playerIndex: winnerIndex, type: 'capicua', points: CAPICUA_BONUS });
      io.to(room.code).emit('bonus', {
        playerIndex: winnerIndex,
        name: room.players[winnerIndex].name,
        type: 'capicua',
        points: CAPICUA_BONUS,
      });
    }
    awardPoints(room, winnerIndex, gained);
    g.roundPoints = gained;
    if (room.players[winnerIndex].score >= TARGET_SCORE) g.matchWinner = winnerIndex;
  } else {
    g.roundPoints = 0; // tie on a blocked game
  }

  // Mid-match rounds deal themselves automatically once the score tally has
  // had time to play out on screen — no "next round" button. A finished
  // match waits for the host to press Start again (fresh lobby countdown).
  if (g.matchWinner === null || g.matchWinner === undefined) {
    room.roundTimer = setTimeout(() => {
      if (rooms.get(room.code) !== room) return;
      room.roundTimer = null;
      if (tryStartRound(room)) broadcast(room);
    }, ROUND_TALLY_MS);
  }
}

function checkBlocked(room) {
  const g = room.game;
  if (g.passes < room.players.length) return;
  // Game is locked (everyone passed in a row). The round goes to whichever of
  // just TWO players holds the lighter hand: the one who locked it (played the
  // last tile) and the player who sits immediately after them. Everyone else's
  // hand is irrelevant. Equal pips between the two -> no winner (tie).
  const n = room.players.length;
  const locker = g.lastTilePlayer;
  let winner = null;
  if (locker !== null && locker !== undefined) {
    const next = (locker + 1) % n;
    const a = pipSum(room.players[locker].hand);
    const b = pipSum(room.players[next].hand);
    if (a < b) winner = locker;
    else if (b < a) winner = next;
    // a === b -> tie, winner stays null
  }
  endRound(room, winner, true);
}

/** Build the state payload one player is allowed to see. */
function stateFor(room, playerId) {
  const g = room.game;
  const meIndex = room.players.findIndex((p) => p.id === playerId);
  return {
    code: room.code,
    isPublic: room.isPublic,
    startCountdownEndsAt: room.startCountdownEndsAt,
    hostId: room.hostId,
    youIndex: meIndex,
    teams: teamsEnabled(room),
    players: room.players.map((p, i) => ({
      name: p.name,
      connected: p.connected,
      score: p.score,
      tileCount: p.hand.length,
      isHost: p.id === room.hostId,
      team: teamOf(room, i),
      // reveal hands when the round is over
      hand: g && g.over ? p.hand : i === meIndex ? p.hand : undefined,
    })),
    game: g
      ? {
          board: g.board,
          anchorIndex: g.leftCount,
          leftEnd: g.leftEnd,
          rightEnd: g.rightEnd,
          boneyardCount: g.boneyard.length,
          turn: g.turn,
          starter: g.starter,
          roundId: g.roundId,
          over: g.over,
          blocked: g.blocked,
          roundWinner: g.roundWinner,
          roundPoints: g.roundPoints,
          matchWinner: g.matchWinner,
          lastTilePlayer: g.lastTilePlayer,
          capicua: g.capicua,
          bonuses: g.bonuses,
          turnDeadline: g.turnDeadline,
          turnTotal: g.turnTotal || TURN_MS,
          lastMove: g.lastMove,
          targetScore: TARGET_SCORE,
        }
      : null,
  };
}

function broadcast(room) {
  room.lastActivity = Date.now();
  for (const p of room.players) {
    io.to(p.id).emit('state', stateFor(room, p.id));
  }
}

function getRoomAndPlayer(socket) {
  const room = rooms.get(socket.data.roomCode);
  if (!room) return {};
  const playerIndex = room.players.findIndex((p) => p.id === socket.id);
  if (playerIndex < 0) return {};
  return { room, playerIndex, player: room.players[playerIndex] };
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name, isPublic }, cb) => {
    name = String(name || '').trim().slice(0, 20);
    if (!name) return cb({ error: 'Enter a name first.' });
    const room = createRoom(socket, name, isPublic);
    cb({ ok: true, code: room.code });
    broadcast(room);
  });

  // Matchmaking: hop into the fullest open public room, or open a new one.
  socket.on('quickPlay', ({ name }, cb) => {
    name = String(name || '').trim().slice(0, 20);
    if (!name) return cb({ error: 'Enter a name first.' });
    let best = null;
    for (const room of rooms.values()) {
      if (!room.isPublic) continue;
      if (room.game && !room.game.over) continue;
      if (room.players.length >= MAX_PLAYERS) continue;
      if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) continue;
      if (!best || room.players.length > best.players.length) best = room;
    }
    if (best) {
      addPlayer(best, socket, name);
      cb({ ok: true, code: best.code });
      io.to(best.code).emit('toast', `${name} joined the room`);
      onPlayerJoinedDuringLobby(best);
      broadcast(best);
    } else {
      const room = createRoom(socket, name, true);
      cb({ ok: true, code: room.code });
      broadcast(room);
    }
  });

  socket.on('joinRoom', ({ name, code }, cb) => {
    name = String(name || '').trim().slice(0, 20);
    code = String(code || '').trim().toUpperCase();
    if (!name) return cb({ error: 'Enter a name first.' });
    const room = rooms.get(code);
    if (!room) return cb({ error: 'Room not found. Check the code.' });

    // Rejoin: reclaim a disconnected seat with the same name.
    const seat = room.players.find((p) => !p.connected && p.name.toLowerCase() === name.toLowerCase());
    if (seat) {
      seat.id = socket.id;
      seat.connected = true;
      socket.join(room.code);
      socket.data.roomCode = room.code;
      if (!room.players.some((p) => p.id === room.hostId)) room.hostId = socket.id;
      cb({ ok: true, code: room.code });
      io.to(room.code).emit('toast', `${name} reconnected`);
      broadcast(room);
      return;
    }

    if (room.game && !room.game.over) return cb({ error: 'Game already in progress.' });
    if (room.players.length >= MAX_PLAYERS) return cb({ error: 'Room is full (4 players max).' });
    if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase()))
      return cb({ error: 'That name is taken in this room.' });

    addPlayer(room, socket, name);
    cb({ ok: true, code: room.code });
    io.to(room.code).emit('toast', `${name} joined the room`);
    onPlayerJoinedDuringLobby(room);
    broadcast(room);
  });

  // Host presses Start: opens (or refreshes) a 25s window for others to join.
  // If the table is already full, the round deals immediately.
  socket.on('startGame', (cb) => {
    const { room } = getRoomAndPlayer(socket);
    if (!room) return cb?.({ error: 'Not in a room.' });
    if (socket.id !== room.hostId) return cb?.({ error: 'Only the host can start.' });
    if (room.game && !room.game.over) return cb?.({ error: 'Game already running.' });
    if (room.players.length >= MAX_PLAYERS) {
      if (!tryStartRound(room)) return cb?.({ error: 'Unable to start.' });
      cb?.({ ok: true });
      return broadcast(room);
    }
    armStartCountdown(room);
    cb?.({ ok: true });
    broadcast(room);
  });

  socket.on('playTile', ({ tileIndex, side }, cb) => {
    const { room, playerIndex } = getRoomAndPlayer(socket);
    const g = room?.game;
    if (!g || g.over) return cb?.({ error: 'No active game.' });
    if (g.turn !== playerIndex) return cb?.({ error: 'Not your turn.' });
    cb?.(doPlay(room, playerIndex, tileIndex, side));
  });

  // Host can remove a disconnected seat so the game keeps moving.
  socket.on('kickDisconnected', ({ playerIndex }, cb) => {
    const { room } = getRoomAndPlayer(socket);
    if (!room) return cb?.({ error: 'Not in a room.' });
    if (socket.id !== room.hostId) return cb?.({ error: 'Only the host can do that.' });
    const target = room.players[playerIndex];
    if (!target || target.connected) return cb?.({ error: 'Player is still connected.' });
    const g = room.game;
    room.players.splice(playerIndex, 1);
    if (g && !g.over) {
      // Their tiles go back to the boneyard.
      g.boneyard.push(...shuffle(target.hand));
      if (g.turn > playerIndex) g.turn -= 1;
      if (g.turn >= room.players.length) g.turn = 0;
      if (room.players.length === 1) endRound(room, 0, false);
      else beginTurn(room);
    }
    io.to(room.code).emit('toast', `${target.name} was removed from the game`);
    cb?.({ ok: true });
    if (room.players.length === 0) {
      clearTimers(room);
      clearStartCountdown(room);
      clearRoundTimer(room);
      rooms.delete(room.code);
      return;
    }
    broadcast(room);
  });

  socket.on('leaveRoom', () => {
    handleLeave(socket, true);
  });

  socket.on('disconnect', () => {
    handleLeave(socket, false);
  });
});

function handleLeave(socket, explicit) {
  const room = rooms.get(socket.data.roomCode);
  if (!room) return;
  const idx = room.players.findIndex((p) => p.id === socket.id);
  if (idx < 0) return;
  const player = room.players[idx];
  const inGame = room.game && !room.game.over;

  if (explicit || !inGame) {
    room.players.splice(idx, 1);
    if (inGame) {
      // Fix turn pointer after removing a seat mid-game.
      const g = room.game;
      if (g.turn > idx) g.turn -= 1;
      if (g.turn >= room.players.length) g.turn = 0;
      g.boneyard.push(...shuffle(player.hand));
      if (room.players.length === 1) {
        endRound(room, 0, false);
        io.to(room.code).emit('toast', `${player.name} left — round goes to ${room.players[0].name}`);
      } else {
        beginTurn(room);
      }
    }
  } else {
    // Unexpected disconnect mid-game: keep the seat so they can rejoin.
    player.connected = false;
    io.to(room.code).emit('toast', `${player.name} disconnected — they can rejoin with the room code`);
  }

  if (room.players.length === 0) {
    clearTimers(room);
    clearStartCountdown(room);
    clearRoundTimer(room);
    rooms.delete(room.code);
    return;
  }
  if (!room.players.some((p) => p.id === room.hostId)) {
    const newHost = room.players.find((p) => p.connected) || room.players[0];
    room.hostId = newHost.id;
  }
  socket.leave(room.code);
  delete socket.data.roomCode;
  if (explicit || !inGame) io.to(room.code).emit('toast', `${player.name} left the room`);
  broadcast(room);
}

// Sweep abandoned rooms.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActivity > ROOM_TTL_MS) {
      clearTimers(room);
      clearStartCountdown(room);
      clearRoundTimer(room);
      rooms.delete(code);
    }
  }
}, 1000 * 60 * 10);

server.listen(PORT, () => {
  console.log(`Dominoes server running on http://localhost:${PORT}`);
});
