/* global io */
const socket = io();

const $ = (id) => document.getElementById(id);
const screens = { home: $('screen-home'), lobby: $('screen-lobby'), game: $('screen-game') };

let state = null; // last server state
let selectedTileIndex = null;
let prevBoardLen = 0; // for detecting a newly placed tile to animate
let pendingHandRect = null; // where my played tile started, so the animation begins there
let wasOver = false; // detects the round-end transition for the smack finale
let overlayHoldUntil = 0; // keep the tally hidden while the smack finale plays
let lastLiveScores = null; // scores from the moment before the round ended (tally "from" values)
let tallyTriggeredForRound = false; // guards runTally() to once per round-over transition

function show(name) {
  Object.values(screens).forEach((s) => s.classList.remove('active'));
  screens[name].classList.add('active');
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

/* ---------- Domino rendering ---------- */
const PIP_CELLS = {
  0: [], 1: [4], 2: [0, 8], 3: [0, 4, 8],
  4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8],
};
// one color per pip value, playdrift-style
const PIP_COLORS = ['#8a93a3', '#3b7fc4', '#8a6d4a', '#d94f4f', '#4caf7d', '#2ab5b0', '#e8923a'];

function half(value) {
  const h = document.createElement('div');
  h.className = 'half';
  const pips = document.createElement('div');
  pips.className = 'pips';
  for (let i = 0; i < 9; i++) {
    const cell = document.createElement('div');
    if (PIP_CELLS[value].includes(i)) {
      cell.className = 'pip';
      cell.style.background = PIP_COLORS[value];
    }
    cell.style.gridArea = `${Math.floor(i / 3) + 1} / ${(i % 3) + 1}`;
    pips.appendChild(cell);
  }
  h.appendChild(pips);
  return h;
}

function dominoEl(tile, orientation) {
  const d = document.createElement('div');
  d.className = `domino ${orientation}`;
  d.appendChild(half(tile[0]));
  d.appendChild(half(tile[1]));
  return d;
}

/* ---------- Avatars ---------- */
const SEAT_COLORS = ['#e05a7e', '#3bbcd9', '#f0c24b', '#c0703f'];
const INVADER = [
  '00100000100',
  '00010001000',
  '00111111100',
  '01101110110',
  '11111111111',
  '10111111101',
  '10100000101',
  '00011011000',
];

function seatColor(playerIndex) {
  // in team play (4 players) partners share a color
  const p = state.players[playerIndex];
  const idx = state.teams && p ? p.team : playerIndex;
  return SEAT_COLORS[idx % SEAT_COLORS.length];
}

function avatarEl(playerIndex) {
  const div = document.createElement('div');
  div.className = 'avatar';
  div.style.background = seatColor(playerIndex);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 11 8');
  for (let y = 0; y < INVADER.length; y++) {
    for (let x = 0; x < INVADER[y].length; x++) {
      if (INVADER[y][x] === '1') {
        const r = document.createElementNS(ns, 'rect');
        r.setAttribute('x', x);
        r.setAttribute('y', y);
        r.setAttribute('width', 1);
        r.setAttribute('height', 1);
        svg.appendChild(r);
      }
    }
  }
  div.appendChild(svg);
  return div;
}

/* ---------- Home ---------- */
$('btn-quick').onclick = () => {
  socket.emit('quickPlay', { name: $('name-input').value }, (res) => {
    if (res.error) return ($('home-error').textContent = res.error);
    $('home-error').textContent = '';
  });
};

$('btn-create').onclick = () => {
  socket.emit('createRoom', { name: $('name-input').value, isPublic: false }, (res) => {
    if (res.error) return ($('home-error').textContent = res.error);
    $('home-error').textContent = '';
  });
};

$('btn-join').onclick = joinRoom;
$('code-input').onkeydown = (e) => {
  if (e.key === 'Enter') joinRoom();
};
$('name-input').onkeydown = (e) => {
  if (e.key === 'Enter') $('code-input').focus();
};

function joinRoom() {
  socket.emit('joinRoom', { name: $('name-input').value, code: $('code-input').value }, (res) => {
    if (res.error) return ($('home-error').textContent = res.error);
    $('home-error').textContent = '';
  });
}

/* ---------- Lobby ---------- */
$('btn-copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText(state.code);
    toast('Code copied!');
  } catch {
    toast(`Code: ${state.code}`);
  }
};

$('btn-start').onclick = () => {
  socket.emit('startGame', (res) => res?.error && toast(res.error));
};

$('btn-leave-lobby').onclick = leaveRoom;
$('btn-leave-game').onclick = () => {
  if (confirm('Leave the game? Your tiles return to the boneyard.')) leaveRoom();
};

function leaveRoom() {
  socket.emit('leaveRoom');
  state = null;
  prevBoardLen = 0;
  wasOver = false;
  lastLiveScores = null;
  tallyTriggeredForRound = false;
  $('tally').classList.add('hidden');
  $('overlay').classList.add('hidden');
  show('home');
}

$('btn-next-round').onclick = () => socket.emit('startGame', (res) => res?.error && toast(res.error));
$('btn-back-home').onclick = leaveRoom;

const sideChooser = $('side-chooser');
sideChooser.querySelectorAll('button').forEach((b) => {
  b.onclick = () => {
    if (selectedTileIndex !== null) playTile(selectedTileIndex, b.dataset.side);
    hideSideChooser();
  };
});
document.addEventListener('click', (e) => {
  if (!sideChooser.classList.contains('hidden') && !sideChooser.contains(e.target)) hideSideChooser();
}, true);

function hideSideChooser() {
  sideChooser.classList.add('hidden');
  selectedTileIndex = null;
  render();
}

function playTile(tileIndex, side) {
  socket.emit('playTile', { tileIndex, side }, (res) => {
    if (res?.error) {
      pendingHandRect = null;
      toast(res.error);
    }
  });
}

function playableSides(tile) {
  const g = state.game;
  if (g.board.length === 0) return ['left'];
  const sides = [];
  if (tile[0] === g.leftEnd || tile[1] === g.leftEnd) sides.push('left');
  if (tile[0] === g.rightEnd || tile[1] === g.rightEnd) sides.push('right');
  return sides;
}

/* ---------- Board layout: anchored snake that zooms to fit ----------
   The first tile stays at the origin; the right side of the chain grows
   rightward and bends counterclockwise along the table edges (up the right
   side), the left side grows leftward and bends down — like PlayDrift.
   The whole board container is then scaled so everything always fits. */
const U = 32;      // short side of a tile in board units
const LONG = U * 2;
const GAP = 3;
const SNAKE_X = 340; // where the line bends
const SNAKE_Y = 230;

let boardMeta = { scale: 1, ends: {}, origin: null }; // refreshed each render

function layoutBoard(g) {
  const placements = [];
  if (!g.board.length) return { placements, ends: {} };
  const anchorIdx = Math.min(g.anchorIndex ?? 0, g.board.length - 1);
  const rot = (d) => ({ x: d.y, y: -d.x }); // right end turns up, left end turns down

  const mk = (tile, near, far, cx, cy, d) => {
    const isD = tile[0] === tile[1];
    const horiz = d.x !== 0;
    const w = isD ? (horiz ? U : LONG) : horiz ? LONG : U;
    const h = isD ? (horiz ? LONG : U) : horiz ? U : LONG;
    let orient, halves;
    if (isD) { orient = horiz ? 'v' : 'h'; halves = [tile[0], tile[1]]; }
    else if (horiz) { orient = 'h'; halves = d.x > 0 ? [near, far] : [far, near]; }
    else { orient = 'v'; halves = d.y > 0 ? [near, far] : [far, near]; }
    return { x: cx, y: cy, w, h, orient, halves };
  };

  const walk = (indices, nearOf, farOf, start, dir) => {
    let px = start, py = 0, d = dir;
    let turns = 0;
    const out = [];
    for (const i of indices) {
      const tile = g.board[i];
      const len = (tile[0] === tile[1] ? U : LONG) + GAP;
      // shrink the box a little on every bend so laps spiral inward;
      // only the axis of travel is checked, so a fresh turn can't re-trigger
      const bx = SNAKE_X - turns * (U + 10);
      const by = SNAKE_Y - turns * (U + 10);
      let ex = px + d.x * len;
      let ey = py + d.y * len;
      if ((d.x !== 0 && Math.abs(ex) > bx) || (d.y !== 0 && Math.abs(ey) > by)) {
        // L-corner: step past the previous tile's end so the turning tile
        // sits flush beside it instead of overlapping it
        const across = (tile[0] === tile[1] ? LONG : U) / 2 + GAP;
        px += d.x * across;
        py += d.y * across;
        d = rot(d);
        turns++;
        ex = px + d.x * len;
        ey = py + d.y * len;
      }
      out.push({ index: i, dir: d, ...mk(tile, nearOf(tile), farOf(tile), (px + ex) / 2, (py + ey) / 2, d) });
      px = ex; py = ey;
    }
    return { out, end: { x: px, y: py, dir: d } };
  };

  const at = g.board[anchorIdx];
  const aD = at[0] === at[1];
  placements.push({
    index: anchorIdx, dir: { x: 1, y: 0 },
    x: 0, y: 0,
    w: aD ? U : LONG, h: aD ? LONG : U,
    orient: aD ? 'v' : 'h',
    halves: [at[0], at[1]],
  });
  const aHalf = (aD ? U : LONG) / 2 + GAP;

  const rightIdx = [];
  for (let i = anchorIdx + 1; i < g.board.length; i++) rightIdx.push(i);
  const leftIdx = [];
  for (let i = anchorIdx - 1; i >= 0; i--) leftIdx.push(i);

  const right = walk(rightIdx, (t) => t[0], (t) => t[1], aHalf, { x: 1, y: 0 });
  const left = walk(leftIdx, (t) => t[1], (t) => t[0], -aHalf, { x: -1, y: 0 });
  placements.push(...right.out, ...left.out);
  placements.sort((a, b) => a.index - b.index);
  return { placements, ends: { left: left.end, right: right.end } };
}

function boardToScreen(bx, by) {
  const o = $('board').getBoundingClientRect();
  return { x: o.left + bx * boardMeta.scale, y: o.top + by * boardMeta.scale };
}

/* ---------- Drag & drop ---------- */
function makeDropZones(sides) {
  const zones = [];
  const wrap = $('board-wrap').getBoundingClientRect();
  const place = (side, x, y) => {
    const z = document.createElement('div');
    z.className = 'drop-zone';
    z.textContent = '+';
    document.body.appendChild(z);
    const half = 48;
    z.style.left = Math.max(8, Math.min(window.innerWidth - 104, x - half)) + 'px';
    z.style.top = Math.max(8, Math.min(window.innerHeight - 104, y - half)) + 'px';
    zones.push({ side, el: z, rect: z.getBoundingClientRect() });
  };
  if (!state.game.board.length) {
    place('left', wrap.left + wrap.width / 2, wrap.top + wrap.height / 2);
  } else {
    for (const side of ['left', 'right']) {
      if (!sides.includes(side)) continue;
      const end = boardMeta.ends[side];
      if (!end) continue;
      const p = boardToScreen(end.x + end.dir.x * 70, end.y + end.dir.y * 70);
      place(side, p.x, p.y);
    }
  }
  return zones;
}

function inRect(ev, rect, pad = 26) {
  const x = ev.clientX ?? ev.x;
  const y = ev.clientY ?? ev.y;
  return x >= rect.left - pad && x <= rect.right + pad && y >= rect.top - pad && y <= rect.bottom + pad;
}

function attachTileInteraction(el, tileIndex, tile, sides) {
  el.onpointerdown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    let ghost = null;
    let zones = [];

    const cleanup = () => {
      zones.forEach((z) => z.el.remove());
      zones = [];
      if (ghost) ghost.remove();
      ghost = null;
      el.classList.remove('drag-source');
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
    };

    let raf = null;
    let pointer = { x: startX, y: startY };
    let ghostPos = null;

    const follow = () => {
      if (!ghost) return;
      // ease toward the pointer for a fluid feel
      ghostPos.x += (pointer.x - ghostPos.x) * 0.45;
      ghostPos.y += (pointer.y - ghostPos.y) * 0.45;
      ghost.style.transform = `translate3d(${ghostPos.x}px, ${ghostPos.y}px, 0) translate(-50%, -50%) scale(1.08) rotate(3deg)`;
      zones.forEach((z) => z.el.classList.toggle('hot', inRect(pointer, z.rect)));
      raf = requestAnimationFrame(follow);
    };

    const onMove = (ev) => {
      pointer = { x: ev.clientX, y: ev.clientY, clientX: ev.clientX, clientY: ev.clientY };
      if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 6) {
        dragging = true;
        ghost = dominoEl(tile, 'v');
        ghost.classList.add('drag-ghost');
        ghost.style.width = el.offsetWidth + 'px';
        ghost.style.height = el.offsetHeight + 'px';
        ghost.style.left = '0';
        ghost.style.top = '0';
        document.body.appendChild(ghost);
        ghostPos = { x: ev.clientX, y: ev.clientY };
        el.classList.add('drag-source');
        zones = makeDropZones(sides);
        raf = requestAnimationFrame(follow);
      }
    };

    const onUp = (ev) => {
      if (raf) cancelAnimationFrame(raf);
      if (dragging) {
        const hit = zones.find((z) => inRect(ev, z.rect));
        const ghostRect = ghost.getBoundingClientRect();
        cleanup();
        if (hit) {
          pendingHandRect = ghostRect;
          playTile(tileIndex, hit.side);
        } else {
          render(); // snap back
        }
      } else {
        cleanup();
        tapPlay(el, tileIndex, sides);
      }
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  };
}

function tapPlay(el, tileIndex, sides) {
  const rect = el.getBoundingClientRect();
  if (sides.length === 1 || state.game.board.length === 0) {
    pendingHandRect = rect;
    playTile(tileIndex, sides[0]);
  } else {
    selectedTileIndex = tileIndex;
    pendingHandRect = rect;
    el.classList.add('selected');
    sideChooser.classList.remove('hidden');
    const cw = sideChooser.offsetWidth;
    sideChooser.style.left = Math.max(8, Math.min(window.innerWidth - cw - 8, rect.left + rect.width / 2 - cw / 2)) + 'px';
    sideChooser.style.top = rect.top - 60 + 'px';
  }
}

/* ---------- Countdown bars & auto-start timers ---------- */
(function tickTimer() {
  const g = state?.game;
  if (g && !g.over && g.turnDeadline) {
    const frac = Math.max(0, Math.min(1, (g.turnDeadline - Date.now()) / (g.turnTotal || 15000)));
    const myTurn = g.turn === state.youIndex;
    $('turn-bar').style.transform = `scaleX(${myTurn ? frac : 0})`;
    document.querySelectorAll('.seat.turn .seat-timer').forEach((bar) => {
      bar.style.transform = `scaleX(${frac})`;
    });
  }
  const secs = state?.startCountdownEndsAt
    ? Math.max(0, Math.ceil((state.startCountdownEndsAt - Date.now()) / 1000))
    : null;
  if (secs !== null && !state.game) {
    const empty = Math.max(0, 4 - state.players.length);
    $('lobby-countdown').textContent =
      `Starting in ${secs}s…` + (empty > 0 ? ` (${empty} empty seat${empty > 1 ? 's' : ''} → CPU)` : '');
  } else {
    $('lobby-countdown').textContent = '';
  }
  requestAnimationFrame(tickTimer);
})();

/* ---------- Bonus banner ---------- */
socket.on('bonus', (b) => {
  const delay = b.type === 'capicua' ? 900 : 0; // let the smack land first
  setTimeout(() => {
    const banner = $('bonus-banner');
    banner.querySelector('.bonus-points').textContent = `+${b.points}`;
    let who = b.name;
    if (state?.teams && state.players[b.playerIndex]) {
      who = state.players
        .filter((p) => p.team === state.players[b.playerIndex].team)
        .map((p) => p.name)
        .join(' & ');
    }
    banner.querySelector('.bonus-text').textContent =
      b.type === 'capicua' ? `Capicúa! ${who}`
      : b.type === 'openingBlock' ? `${who} opened strong — shut out!`
      : `${who} shut everyone out!`;
    banner.classList.remove('hidden');
    // restart CSS animations
    banner.querySelectorAll('div').forEach((d) => {
      d.style.animation = 'none';
      void d.offsetWidth;
      d.style.animation = '';
    });
    $('table')?.classList.add('shake');
    setTimeout(() => $('table')?.classList.remove('shake'), 600);
    setTimeout(() => banner.classList.add('hidden'), 2400);
  }, delay);
});

/* ---------- State + rendering ---------- */
socket.on('toast', toast);

socket.on('state', (s) => {
  state = s;
  render();
});

socket.on('disconnect', () => toast('Connection lost — reconnecting…'));
socket.on('connect', () => {
  // After a socket reconnect our old seat is orphaned; try to reclaim it.
  if (state && state.code) {
    const name = $('name-input').value;
    const code = state.code;
    socket.emit('joinRoom', { name, code }, (res) => {
      if (res.error) {
        toast('Could not rejoin: ' + res.error);
        state = null;
        show('home');
      }
    });
  }
});

function render() {
  if (!state) return show('home');
  if (!state.game) return renderLobby();
  renderGame();
}

function renderLobby() {
  show('lobby');
  wasOver = false;
  tallyTriggeredForRound = false;
  $('tally').classList.add('hidden');
  $('overlay').classList.add('hidden');
  $('lobby-code').textContent = state.code;
  const list = $('lobby-players');
  list.innerHTML = '';
  state.players.forEach((p, i) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = p.name + (i === state.youIndex ? ' (you)' : '');
    if (i === state.youIndex) name.className = 'you';
    li.appendChild(name);
    if (p.isHost) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'HOST';
      li.appendChild(badge);
    }
    list.appendChild(li);
  });

  $('lobby-visibility').textContent = state.isPublic
    ? 'Public table — anyone can join, or invite friends with the code above.'
    : 'Private room — share this code so friends can join. 2–4 players.';

  const meHost = state.players[state.youIndex]?.isHost;
  $('btn-start').style.display = meHost ? '' : 'none';
  $('btn-start').disabled = false;
  const counting = !!state.startCountdownEndsAt;
  let hint = meHost
    ? counting
      ? 'Waiting for more players — empty seats fill with CPU players when time runs out.'
      : 'Press Start when ready — you\'ll get 25s for others to join first.'
    : counting
      ? 'Starting soon…'
      : 'Waiting for the host to start the game…';
  if (state.players.length === 4) {
    const t0 = state.players.filter((p) => p.team === 0).map((p) => p.name).join(' & ');
    const t1 = state.players.filter((p) => p.team === 1).map((p) => p.name).join(' & ');
    hint += ` Teams: ${t0} vs ${t1}.`;
  }
  $('lobby-hint').textContent = hint;
}

/* Opponents fill seats clockwise around the table, relative to me. */
function seatLayout(opponentCount) {
  if (opponentCount === 1) return ['seat-top'];
  if (opponentCount === 2) return ['seat-left', 'seat-right'];
  return ['seat-left', 'seat-top', 'seat-right'];
}

function buildSeat(seatEl, player, playerIndex, g) {
  seatEl.innerHTML = '';
  seatEl.classList.add('occupied');
  seatEl.classList.toggle('turn', g.turn === playerIndex && !g.over);
  seatEl.classList.toggle('disconnected', !player.connected);
  seatEl.dataset.playerIndex = playerIndex;

  const who = document.createElement('div');
  who.style.display = 'flex';
  who.style.flexDirection = 'column';
  who.style.alignItems = 'center';
  who.style.gap = '4px';
  who.appendChild(avatarEl(playerIndex));
  const nm = document.createElement('div');
  nm.className = 'seat-name';
  nm.textContent = player.name + (player.connected ? '' : ' ⚠');
  who.appendChild(nm);
  seatEl.appendChild(who);

  const stack = document.createElement('div');
  stack.className = 'stack';
  for (let i = 0; i < Math.min(player.tileCount, 7); i++) {
    const t = document.createElement('div');
    t.className = 'back-tile';
    stack.appendChild(t);
  }
  seatEl.appendChild(stack);

  const pts = document.createElement('div');
  pts.className = 'seat-points';
  pts.innerHTML = '<b></b><span>points</span>';
  pts.querySelector('b').textContent = player.score;
  seatEl.appendChild(pts);

  const timer = document.createElement('div');
  timer.className = 'seat-timer';
  seatEl.appendChild(timer);

  if (!player.connected && state.players[state.youIndex]?.isHost) {
    const kick = document.createElement('button');
    kick.className = 'kick';
    kick.textContent = 'Remove';
    kick.onclick = () => socket.emit('kickDisconnected', { playerIndex }, (r) => r?.error && toast(r.error));
    seatEl.appendChild(kick);
  }
}

function renderGame() {
  show('game');
  const g = state.game;
  const me = state.players[state.youIndex];
  const myTurn = g.turn === state.youIndex && !g.over;

  $('game-code').textContent = state.code;
  $('boneyard-count').textContent = g.boneyardCount;

  // --- seats around the table ---
  const seatEls = { 'seat-top': $('seat-top'), 'seat-left': $('seat-left'), 'seat-right': $('seat-right') };
  Object.values(seatEls).forEach((el) => {
    el.classList.remove('occupied', 'turn', 'disconnected');
    el.innerHTML = '';
  });
  const opponents = [];
  for (let i = 1; i < state.players.length; i++) {
    opponents.push((state.youIndex + i) % state.players.length);
  }
  const layout = seatLayout(opponents.length);
  const seatOfPlayer = {}; // playerIndex -> seat element (for animations)
  opponents.forEach((pIdx, k) => {
    const el = seatEls[layout[k]];
    if (!el) return;
    buildSeat(el, state.players[pIdx], pIdx, g);
    seatOfPlayer[pIdx] = el;
  });

  // --- board: snake layout, then zoom so everything fits ---
  const board = $('board');
  board.innerHTML = '';
  const { placements, ends } = layoutBoard(g);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const pl of placements) {
    const el = dominoEl(pl.halves, pl.orient);
    el.style.position = 'absolute';
    el.style.left = pl.x - pl.w / 2 + 'px';
    el.style.top = pl.y - pl.h / 2 + 'px';
    el.style.width = pl.w + 'px';
    el.style.height = pl.h + 'px';
    board.appendChild(el);
    minX = Math.min(minX, pl.x - pl.w / 2); maxX = Math.max(maxX, pl.x + pl.w / 2);
    minY = Math.min(minY, pl.y - pl.h / 2); maxY = Math.max(maxY, pl.y + pl.h / 2);
  }
  let scale = 1;
  if (placements.length) {
    const wrap = $('board-wrap').getBoundingClientRect();
    const pad = 70; // breathing room for drop zones
    const bw = maxX - minX + pad * 2;
    const bh = maxY - minY + pad * 2;
    scale = Math.min(1, wrap.width / bw, wrap.height / bh);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    board.style.transform = `scale(${scale}) translate(${-cx}px, ${-cy}px)`;
  } else {
    board.style.transform = 'scale(1)';
  }
  boardMeta = { scale, ends };

  if (!g.over) lastLiveScores = state.players.map((p) => p.score);

  // round just ended with a played tile -> smack finale; otherwise fly-in
  const justEnded = g.over && !wasOver;
  if (justEnded) tallyTriggeredForRound = false;
  const smackFinale =
    justEnded && !g.blocked && g.lastMove?.tile && g.roundWinner === g.lastMove.playerIndex;

  if (smackFinale) {
    overlayHoldUntil = Date.now() + 2300;
    runSmackFinale(board, g, seatOfPlayer);
  } else if (g.board.length > prevBoardLen && g.lastMove?.tile && board.children.length > 0) {
    const newest = newestTileEl(board, g);
    let fromRect = null;
    if (g.lastMove.playerIndex === state.youIndex && pendingHandRect) {
      fromRect = pendingHandRect;
    } else {
      const seatEl = seatOfPlayer[g.lastMove.playerIndex];
      if (seatEl) fromRect = seatEl.getBoundingClientRect();
    }
    if (fromRect) flyIn(newest, fromRect);
  }
  prevBoardLen = g.board.length;
  pendingHandRect = null;
  wasOver = g.over;

  // --- my seat ---
  const mySeat = $('my-seat');
  mySeat.classList.toggle('turn', myTurn);
  const myAvatar = $('my-avatar');
  myAvatar.innerHTML = '';
  const who = document.createElement('div');
  who.style.display = 'flex';
  who.style.flexDirection = 'column';
  who.style.alignItems = 'center';
  who.style.gap = '4px';
  who.appendChild(avatarEl(state.youIndex));
  const nm = document.createElement('div');
  nm.className = 'seat-name';
  nm.textContent = me.name;
  who.appendChild(nm);
  myAvatar.appendChild(who);

  const pts = $('my-points');
  pts.innerHTML = '<b></b><span>points</span>';
  pts.querySelector('b').textContent = me.score;

  // --- hand ---
  const hand = $('hand');
  hand.innerHTML = '';
  let anyPlayable = false;
  (me.hand || []).forEach((tile, i) => {
    const el = dominoEl(tile, 'v');
    el.classList.add('hand-tile');
    const sides = playableSides(tile);
    const canPlay = myTurn && sides.length > 0;
    if (canPlay) anyPlayable = true;
    el.classList.add(canPlay ? 'playable' : 'dead');
    if (i === selectedTileIndex) el.classList.add('selected');
    if (canPlay) attachTileInteraction(el, i, tile, sides);
    hand.appendChild(el);
  });

  // --- turn label ---
  let label = '';
  if (!g.over) {
    if (g.turn === state.youIndex) {
      label = anyPlayable
        ? 'Your turn — drag a tile onto the board'
        : g.boneyardCount > 0 ? 'No play — drawing for you…' : 'No play — passing…';
    } else {
      const cur = state.players[g.turn];
      label = g.lastMove?.drew && g.lastMove.playerIndex === g.turn
        ? `${cur?.name} is drawing…`
        : `Waiting for ${cur?.name}…`;
    }
  }
  $('turn-label').textContent = label;

  // --- round result: a high-score-style tally, no click required ---
  if (g.over) {
    if (!tallyTriggeredForRound) {
      tallyTriggeredForRound = true;
      const wait = Math.max(0, overlayHoldUntil - Date.now());
      setTimeout(() => state?.game?.over && runTally(state.game), wait);
    }
  } else {
    $('tally').classList.add('hidden');
    $('overlay').classList.add('hidden');
  }
}

/* Shared row-building for the tally and the match-over card. */
function buildScoreRows(g, winnerIdx) {
  const tagsFor = (idx) =>
    (g.bonuses || [])
      .filter((b) =>
        state.teams
          ? state.players[b.playerIndex]?.team === state.players[idx]?.team
          : b.playerIndex === idx
      )
      .map((b) =>
        b.type === 'capicua' ? `Capicúa +${b.points}`
        : b.type === 'openingBlock' ? `Shutout +${b.points}`
        : `Pass +${b.points}`
      );

  if (state.teams) {
    return [0, 1].map((t) => {
      const members = state.players.map((p, i) => ({ p, i })).filter(({ p }) => p.team === t);
      const repIdx = members[0].i;
      return {
        label: members.map(({ p, i }) => p.name + (i === state.youIndex ? ' (you)' : '')).join(' & '),
        to: members[0].p.score,
        repIdx,
        winner: winnerIdx !== null && state.players[winnerIdx]?.team === t,
        tags: tagsFor(repIdx),
      };
    });
  }
  return state.players.map((p, i) => ({
    label: p.name + (i === state.youIndex ? ' (you)' : ''),
    to: p.score,
    repIdx: i,
    winner: i === winnerIdx,
    tags: tagsFor(i),
  }));
}

/* High-score-style tally: numbers count up rapidly, then either the match
   card appears (match won) or this just fades — the server deals the next
   round on its own, no button required. */
function runTally(g) {
  const isMatchOver = g.matchWinner !== null && g.matchWinner !== undefined;
  const winnerIdx = isMatchOver ? g.matchWinner : g.roundWinner;
  const rows = buildScoreRows(g, winnerIdx).sort((a, b) => b.to - a.to);

  const winnerRow = rows.find((r) => r.winner);
  $('tally-title').textContent = isMatchOver
    ? `🏆 ${winnerRow?.label ?? ''} wins the match!`
    : g.blocked
      ? winnerRow ? `Blocked — ${winnerRow.label} takes it` : 'Blocked — tie round'
      : winnerRow ? `${winnerRow.label} wins the round!` : 'Round over';
  $('tally-sub').textContent = g.blocked
    ? 'Fewest remaining pips wins the round.'
    : g.roundWinner !== null ? 'All remaining pips collected:' : '';

  const rowsEl = $('tally-rows');
  rowsEl.innerHTML = '';
  const D_ANIM = 1100;
  const STAGGER = 150;
  const HOLD = 1000;
  rows.forEach((r, i) => {
    const from = lastLiveScores?.[r.repIdx] ?? r.to;
    const el = document.createElement('div');
    el.className = 'tally-row' + (r.winner ? ' winner' : '');
    const nameEl = document.createElement('span');
    nameEl.className = 'tr-name';
    nameEl.textContent = r.label;
    const scoreEl = document.createElement('span');
    scoreEl.className = 'tr-score';
    scoreEl.textContent = from;
    el.append(nameEl, scoreEl);
    if (r.tags.length) {
      const tagEl = document.createElement('div');
      tagEl.className = 'tr-tags';
      tagEl.textContent = r.tags.join(' · ');
      el.appendChild(tagEl);
    }
    rowsEl.appendChild(el);

    const start = performance.now() + i * STAGGER;
    const step = (now) => {
      const t = Math.max(0, Math.min(1, (now - start) / D_ANIM));
      const eased = 1 - Math.pow(1 - t, 3);
      scoreEl.textContent = Math.round(from + (r.to - from) * eased);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });

  $('tally').classList.remove('hidden');
  const totalMs = (rows.length - 1) * STAGGER + D_ANIM + HOLD;
  setTimeout(() => {
    $('tally').classList.add('hidden');
    if (isMatchOver && state?.game?.over) renderOverlay(state.game);
  }, totalMs);
}

function newestTileEl(board, g) {
  return g.lastMove.side === 'left' && g.board.length > 1
    ? board.children[0]
    : board.children[board.children.length - 1];
}

/* Persistent match-over card — shown once, after the tally finishes. Round
   endings never reach here; the server deals the next round on its own. */
function renderOverlay(g) {
  const overlay = $('overlay');
  overlay.classList.remove('hidden');
  const winnerIdx = g.matchWinner;
  const rows = buildScoreRows(g, winnerIdx).sort((a, b) => b.to - a.to);
  const winnerRow = rows.find((r) => r.winner);

  $('overlay-title').textContent = `🏆 ${winnerRow?.label ?? ''} win${state.teams ? '' : 's'} the match!`;
  $('overlay-sub').textContent = `First to ${g.targetScore} points.`;

  const scores = $('overlay-scores');
  scores.innerHTML = '';
  rows.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'row' + (r.winner ? ' winner' : '');
    const left = document.createElement('span');
    left.textContent = r.label;
    const right = document.createElement('span');
    right.textContent = `${r.to} pts`;
    row.append(left, right);
    scores.appendChild(row);
  });

  const meHost = state.players[state.youIndex]?.isHost;
  $('btn-next-round').style.display = meHost ? '' : 'none';
}

/* The winning tile slams onto the table and knocks everything flying. */
function runSmackFinale(board, g) {
  const newest = newestTileEl(board, g);
  const newestRect = newest.getBoundingClientRect();
  const cx = newestRect.left + newestRect.width / 2;
  const cy = newestRect.top + newestRect.height / 2;

  newest.classList.add('smack');
  const table = $('table');
  setTimeout(() => {
    table.classList.add('shake');
    setTimeout(() => table.classList.remove('shake'), 600);
  }, 320);

  // everything else scatters away from the impact point
  const others = [...board.children].filter((el) => el !== newest);
  setTimeout(() => {
    const k = boardMeta.scale || 1;
    others.forEach((el) => {
      const r = el.getBoundingClientRect();
      const ex = r.left + r.width / 2 - cx;
      const ey = r.top + r.height / 2 - cy;
      const dist = Math.max(40, Math.hypot(ex, ey));
      const push = (260 + Math.random() * 420) / k;
      const dx = (ex / dist) * push + ((Math.random() - 0.5) * 160) / k;
      const dy = (ey / dist) * push + ((Math.random() - 0.5) * 160) / k;
      const rot = (Math.random() - 0.5) * 1080;
      el.classList.add('scatter');
      el.style.transform = `translate(${dx}px, ${dy}px) rotate(${rot}deg)`;
      el.style.opacity = '0.25';
    });
  }, 360);
}

/* FLIP animation: the tile starts where it was played from and flies to its board slot. */
function flyIn(el, fromRect) {
  const target = el.getBoundingClientRect();
  const k = boardMeta.scale || 1; // tile transforms live in board (scaled) space
  const dx = (fromRect.left + fromRect.width / 2 - (target.left + target.width / 2)) / k;
  const dy = (fromRect.top + fromRect.height / 2 - (target.top + target.height / 2)) / k;
  el.style.transform = `translate(${dx}px, ${dy}px) scale(1.15) rotate(8deg)`;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.classList.add('flying');
      el.style.transform = '';
      el.addEventListener('transitionend', () => el.classList.remove('flying'), { once: true });
    });
  });
}
