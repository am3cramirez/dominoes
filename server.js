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
const TARGET_SCORE = 100;
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

function createRoom(hostSocket, name) {
  const code = makeRoomCode();
  const room = {
    code,
    hostId: hostSocket.id,
    players: [], // { id, name, connected, hand: [], score }
    game: null,
    lastActivity: Date.now(),
  };
  rooms.set(code, room);
  addPlayer(room, hostSocket, name);
  return room;
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
    passes: 0,
    over: false,
    roundWinner: null,
    matchWinner: null,
    blocked: false,
    lastMove: null, // { playerIndex, tile, side } | { playerIndex, pass: true } | { playerIndex, drew: true }
  };
}

function advanceTurn(room) {
  const g = room.game;
  g.turn = (g.turn + 1) % room.players.length;
}

function endRound(room, winnerIndex, blocked) {
  const g = room.game;
  g.over = true;
  g.blocked = blocked;
  g.roundWinner = winnerIndex;
  if (winnerIndex !== null) {
    const winner = room.players[winnerIndex];
    const gained = room.players.reduce(
      (s, p, i) => (i === winnerIndex ? s : s + pipSum(p.hand)),
      0
    );
    winner.score += gained;
    g.roundPoints = gained;
    if (winner.score >= TARGET_SCORE) g.matchWinner = winnerIndex;
  } else {
    g.roundPoints = 0; // tie on a blocked game
  }
}

function checkBlocked(room) {
  const g = room.game;
  if (g.passes < room.players.length) return;
  // Everyone passed consecutively -> blocked. Lowest pip count wins (tie -> no winner).
  const sums = room.players.map((p) => pipSum(p.hand));
  const min = Math.min(...sums);
  const winners = sums.map((s, i) => (s === min ? i : -1)).filter((i) => i >= 0);
  endRound(room, winners.length === 1 ? winners[0] : null, true);
}

/** Build the state payload one player is allowed to see. */
function stateFor(room, playerId) {
  const g = room.game;
  const meIndex = room.players.findIndex((p) => p.id === playerId);
  return {
    code: room.code,
    hostId: room.hostId,
    youIndex: meIndex,
    players: room.players.map((p, i) => ({
      name: p.name,
      connected: p.connected,
      score: p.score,
      tileCount: p.hand.length,
      isHost: p.id === room.hostId,
      // reveal hands when the round is over
      hand: g && g.over ? p.hand : i === meIndex ? p.hand : undefined,
    })),
    game: g
      ? {
          board: g.board,
          leftEnd: g.leftEnd,
          rightEnd: g.rightEnd,
          boneyardCount: g.boneyard.length,
          turn: g.turn,
          over: g.over,
          blocked: g.blocked,
          roundWinner: g.roundWinner,
          roundPoints: g.roundPoints,
          matchWinner: g.matchWinner,
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
  socket.on('createRoom', ({ name }, cb) => {
    name = String(name || '').trim().slice(0, 20);
    if (!name) return cb({ error: 'Enter a name first.' });
    const room = createRoom(socket, name);
    cb({ ok: true, code: room.code });
    broadcast(room);
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
    broadcast(room);
  });

  socket.on('startGame', (cb) => {
    const { room } = getRoomAndPlayer(socket);
    if (!room) return cb?.({ error: 'Not in a room.' });
    if (socket.id !== room.hostId) return cb?.({ error: 'Only the host can start.' });
    if (room.game && !room.game.over) return cb?.({ error: 'Game already running.' });
    const connected = room.players.filter((p) => p.connected);
    if (connected.length < MIN_PLAYERS) return cb?.({ error: 'Need at least 2 players.' });
    // Drop seats that never came back before dealing a fresh round.
    room.players = room.players.filter((p) => p.connected);
    // New match if previous one finished.
    if (room.game && room.game.matchWinner !== null && room.game.matchWinner !== undefined) {
      for (const p of room.players) p.score = 0;
    }
    startRound(room);
    cb?.({ ok: true });
    broadcast(room);
  });

  socket.on('playTile', ({ tileIndex, side }, cb) => {
    const { room, playerIndex, player } = getRoomAndPlayer(socket);
    const g = room?.game;
    if (!g || g.over) return cb?.({ error: 'No active game.' });
    if (g.turn !== playerIndex) return cb?.({ error: 'Not your turn.' });
    const tile = player.hand[tileIndex];
    if (!tile) return cb?.({ error: 'Invalid tile.' });
    const sides = tilePlayableSides(tile, g);
    if (!sides.includes(side)) {
      if (sides.length === 0) return cb?.({ error: "That tile doesn't match either end." });
      side = sides[0];
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
    } else {
      const oriented = tile[0] === g.rightEnd ? tile : [tile[1], tile[0]];
      g.board.push(oriented);
      g.rightEnd = oriented[1];
    }

    g.passes = 0;
    g.lastMove = { playerIndex, tile, side };

    if (player.hand.length === 0) {
      endRound(room, playerIndex, false);
    } else {
      advanceTurn(room);
    }
    cb?.({ ok: true });
    broadcast(room);
  });

  socket.on('drawTile', (cb) => {
    const { room, playerIndex, player } = getRoomAndPlayer(socket);
    const g = room?.game;
    if (!g || g.over) return cb?.({ error: 'No active game.' });
    if (g.turn !== playerIndex) return cb?.({ error: 'Not your turn.' });
    if (handHasPlayable(player.hand, g)) return cb?.({ error: 'You have a playable tile.' });
    if (g.boneyard.length === 0) return cb?.({ error: 'Boneyard is empty — pass instead.' });
    player.hand.push(g.boneyard.pop());
    g.lastMove = { playerIndex, drew: true };
    cb?.({ ok: true });
    broadcast(room);
  });

  socket.on('pass', (cb) => {
    const { room, playerIndex, player } = getRoomAndPlayer(socket);
    const g = room?.game;
    if (!g || g.over) return cb?.({ error: 'No active game.' });
    if (g.turn !== playerIndex) return cb?.({ error: 'Not your turn.' });
    if (handHasPlayable(player.hand, g)) return cb?.({ error: 'You have a playable tile.' });
    if (g.boneyard.length > 0) return cb?.({ error: 'You must draw from the boneyard first.' });
    g.passes += 1;
    g.lastMove = { playerIndex, pass: true };
    checkBlocked(room);
    if (!g.over) advanceTurn(room);
    cb?.({ ok: true });
    broadcast(room);
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
    }
    io.to(room.code).emit('toast', `${target.name} was removed from the game`);
    cb?.({ ok: true });
    if (room.players.length === 0) {
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
      }
    }
  } else {
    // Unexpected disconnect mid-game: keep the seat so they can rejoin.
    player.connected = false;
    io.to(room.code).emit('toast', `${player.name} disconnected — they can rejoin with the room code`);
  }

  if (room.players.length === 0) {
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
    if (now - room.lastActivity > ROOM_TTL_MS) rooms.delete(code);
  }
}, 1000 * 60 * 10);

server.listen(PORT, () => {
  console.log(`Dominoes server running on http://localhost:${PORT}`);
});
