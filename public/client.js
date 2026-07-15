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
let lastRoundId = null; // detects a fresh round so we announce its starter once
let prevMyTurn = false; // detects the moment it becomes your turn (for the chime)

function show(name) {
  Object.values(screens).forEach((s) => s.classList.remove('active'));
  screens[name].classList.add('active');
}

/* ---------- Sound (synthesized via Web Audio — no asset files) ---------- */
const Sound = (() => {
  let ctx = null;
  let muted = localStorage.getItem('dom-muted') === '1';
  const ensure = () => {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  };
  const tone = (freq, dur, { type = 'sine', gain = 0.18, slideTo = null, delay = 0 } = {}) => {
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime + delay;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(c.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.03);
  };
  const noise = (dur, { freq = 1600, q = 1, gain = 0.3 } = {}) => {
    const c = ensure();
    if (!c) return;
    const buf = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3);
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const g = c.createGain();
    g.gain.value = gain;
    src.connect(f).connect(g).connect(c.destination);
    src.start();
  };
  const api = {
    get muted() { return muted; },
    toggle() {
      muted = !muted;
      localStorage.setItem('dom-muted', muted ? '1' : '0');
      if (!muted) api.tick();
      return muted;
    },
    resume() { if (!muted) ensure(); },
    place() { if (muted) return; noise(0.09, { freq: 1900, gain: 0.28 }); tone(170, 0.1, { type: 'triangle', gain: 0.22, slideTo: 90 }); },
    turn() { if (muted) return; tone(660, 0.13, { type: 'sine', gain: 0.16 }); tone(990, 0.16, { type: 'sine', gain: 0.12, delay: 0.08 }); },
    tick() { if (muted) return; tone(520, 0.05, { type: 'square', gain: 0.08 }); },
    bonus() { if (muted) return; [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.16, { type: 'triangle', gain: 0.16, delay: i * 0.075 })); },
    win() { if (muted) return; [392, 523, 659].forEach((f, i) => tone(f, 0.22, { type: 'sine', gain: 0.18, delay: i * 0.09 })); },
    flip() { if (muted) return; noise(0.16, { freq: 900, q: 0.7, gain: 0.18 }); },
    lose() { if (muted) return; tone(330, 0.3, { type: 'sine', gain: 0.14, slideTo: 180 }); },
  };
  return api;
})();
// The browser only lets audio start after a gesture; wake it on the first one.
['pointerdown', 'keydown'].forEach((ev) =>
  window.addEventListener(ev, () => Sound.resume(), { once: false, passive: true })
);

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
// one vivid, well-separated color per pip value (1-6); 0 has no pips
const PIP_COLORS = ['#8a93a3', '#2563eb', '#16a34a', '#dc2626', '#7c3aed', '#f97316', '#0891b2'];

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

const muteBtn = $('btn-mute');
function syncMuteBtn() {
  muteBtn.textContent = Sound.muted ? '🔇' : '🔊';
  muteBtn.classList.toggle('muted', Sound.muted);
}
muteBtn.onclick = () => { Sound.toggle(); syncMuteBtn(); };
syncMuteBtn();

function leaveRoom() {
  socket.emit('leaveRoom');
  state = null;
  prevBoardLen = 0;
  wasOver = false;
  lastLiveScores = null;
  tallyTriggeredForRound = false;
  lastRoundId = null;
  prevMyTurn = false;
  $('tally').classList.add('hidden');
  $('overlay').classList.add('hidden');
  $('lock-banner').classList.add('hidden');
  show('home');
}

$('btn-next-round').onclick = () => socket.emit('startGame', (res) => res?.error && toast(res.error));
$('btn-back-home').onclick = leaveRoom;

// Clicking away from a hand tile or its placement ghosts cancels the preview.
document.addEventListener('pointerdown', (e) => {
  if (selectedTileIndex === null) return;
  if (e.target.closest('.hand-tile') || e.target.closest('.domino.preview')) return;
  clearPreview();
}, true);

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

/* ---------- Board layout: centre-anchored perimeter spiral ----------
   The opening tile stays in the middle; the chain grows from both ends and
   snakes around a bounded rectangle (fill the width, then turn and run
   vertically up to a height bound, then turn sideways again) — exactly like
   PlayDrift. The whole board is then zoomed to fit, so it "spreads out" and
   zooms away as it grows. Doubles sit perpendicular to the run (upright in a
   horizontal row, flat across a vertical column). */
const U = 40;      // short side of a tile in board units (bigger = larger pips)
const LONG = U * 2;
const GAP = 3;
// Half-bounds of the rectangle the chain snakes around, set responsively each
// render. Minimums keep the geometry in its verified overlap-free range.
let HALF_W = 520;
let HALF_H = 380;

let boardMeta = { scale: 1, ends: {}, origin: null }; // refreshed each render

function layoutBoard(g) {
  const placements = [];
  if (!g.board.length) return { placements, ends: {} };
  const anchorIdx = Math.min(g.anchorIndex ?? 0, g.board.length - 1);

  const alongOf = (tile) => (tile[0] === tile[1] ? U : LONG); // doubles are short along travel
  const make = (tile, near, far, cx, cy, d) => {
    const horiz = d.x !== 0;
    if (tile[0] === tile[1]) {
      return horiz
        ? { x: cx, y: cy, w: U, h: LONG, orient: 'v', halves: [tile[0], tile[1]] }
        : { x: cx, y: cy, w: LONG, h: U, orient: 'h', halves: [tile[0], tile[1]] };
    }
    const halves = horiz ? (d.x > 0 ? [near, far] : [far, near]) : (d.y > 0 ? [near, far] : [far, near]);
    return { x: cx, y: cy, w: horiz ? LONG : U, h: horiz ? U : LONG, orient: horiz ? 'h' : 'v', halves };
  };

  // Walk one arm outward from the anchor, bending 90° whenever the next tile
  // would leave the rectangle. `rot` sets the spiral direction for this arm.
  const arm = (indices, nearOf, farOf, startX, dir, rot) => {
    let px = startX, py = 0, d = { ...dir };
    const out = [];
    for (const i of indices) {
      const tile = g.board[i];
      let along = alongOf(tile);
      const overX = d.x !== 0 && Math.abs(px + d.x * (along + GAP)) > HALF_W;
      const overY = d.y !== 0 && Math.abs(py + d.y * (along + GAP)) > HALF_H;
      if (overX || overY) {
        const cross = tile[0] === tile[1] ? LONG : U; // width across the turn
        px += d.x * (cross / 2 + GAP);
        py += d.y * (cross / 2 + GAP);
        d = rot(d);
        along = alongOf(tile);
      }
      out.push({ index: i, dir: d, ...make(tile, nearOf(tile), farOf(tile), px + d.x * (along / 2), py + d.y * (along / 2), d) });
      px += d.x * (along + GAP);
      py += d.y * (along + GAP);
    }
    return { out, end: { x: px, y: py, dir: d } };
  };

  const at = g.board[anchorIdx];
  const anchorD = at[0] === at[1];
  placements.push({
    index: anchorIdx, dir: { x: 1, y: 0 }, x: 0, y: 0,
    w: anchorD ? U : LONG, h: anchorD ? LONG : U, orient: anchorD ? 'v' : 'h',
    halves: [at[0], at[1]],
  });
  const aHalf = (anchorD ? U : LONG) / 2 + GAP;

  const rightIdx = [], leftIdx = [];
  for (let i = anchorIdx + 1; i < g.board.length; i++) rightIdx.push(i);
  for (let i = anchorIdx - 1; i >= 0; i--) leftIdx.push(i);

  // Both ends turn the same way (rot 90° CW in screen space): the right end
  // runs right then curls UP; the left end runs left then curls DOWN — a
  // balanced rectangle around the centre, like the reference.
  const rot = (d) => ({ x: d.y, y: -d.x });
  const right = arm(rightIdx, (t) => t[0], (t) => t[1], aHalf, { x: 1, y: 0 }, rot);
  const left = arm(leftIdx, (t) => t[1], (t) => t[0], -aHalf, { x: -1, y: 0 }, rot);
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
        // A tile that fits only one end plays immediately on a click. A tile
        // that fits both ends shows placement previews to pick a side.
        if (sides.length === 1 || state.game.board.length === 0) {
          pendingHandRect = el.getBoundingClientRect();
          clearPreview();
          playTile(tileIndex, sides[0]);
        } else if (selectedTileIndex === tileIndex) {
          clearPreview();
        } else {
          showPreview(tileIndex, tile, sides, el);
        }
      }
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  };
}

/* Work out exactly where `tile` would land on a given side, by running the
   real layout over a hypothetical board with the tile appended. Returns the
   placement (board coords) of the new tile, matching the eventual position. */
function predictPlacement(side, tile) {
  const g = state.game;
  let board, anchorIndex, newIndex;
  if (g.board.length === 0) {
    board = [tile.slice()];
    anchorIndex = 0;
    newIndex = 0;
  } else if (side === 'left') {
    const oriented = tile[1] === g.leftEnd ? tile.slice() : [tile[1], tile[0]];
    board = [oriented, ...g.board];
    anchorIndex = (g.anchorIndex ?? 0) + 1;
    newIndex = 0;
  } else {
    const oriented = tile[0] === g.rightEnd ? tile.slice() : [tile[1], tile[0]];
    board = [...g.board, oriented];
    anchorIndex = g.anchorIndex ?? 0;
    newIndex = board.length - 1;
  }
  const { placements } = layoutBoard({ board, anchorIndex });
  return placements.find((p) => p.index === newIndex);
}

/* Show a translucent ghost of the tile at each valid end. Clicking a ghost
   commits the play; clicking the tile again (or anywhere else) cancels. */
function showPreview(tileIndex, tile, sides, handEl) {
  clearPreview();
  selectedTileIndex = tileIndex;
  if (handEl) handEl.classList.add('selected');
  const board = $('board');
  for (const side of sides) {
    const pl = predictPlacement(side, tile);
    if (!pl) continue;
    const ghost = dominoEl(pl.halves, pl.orient);
    ghost.classList.add('preview');
    ghost.style.position = 'absolute';
    ghost.style.left = pl.x - pl.w / 2 + 'px';
    ghost.style.top = pl.y - pl.h / 2 + 'px';
    ghost.style.width = pl.w + 'px';
    ghost.style.height = pl.h + 'px';
    ghost.onpointerdown = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      pendingHandRect = handEl ? handEl.getBoundingClientRect() : null;
      const idx = selectedTileIndex;
      clearPreview();
      playTile(idx, side);
    };
    board.appendChild(ghost);
  }
}

function clearPreview() {
  document.querySelectorAll('#board .domino.preview').forEach((el) => el.remove());
  document.querySelectorAll('.hand-tile.selected').forEach((el) => el.classList.remove('selected'));
  selectedTileIndex = null;
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
    Sound.bonus();
    const banner = $('bonus-banner');
    const counted = b.counted !== false;
    const pointsEl = banner.querySelector('.bonus-points');
    pointsEl.textContent = `+${b.points}`;
    pointsEl.classList.toggle('void', !counted);
    let who = b.name;
    if (state?.teams && state.players[b.playerIndex]) {
      who = state.players
        .filter((p) => p.team === state.players[b.playerIndex].team)
        .map((p) => p.name)
        .join(' & ');
    }
    const headline =
      b.type === 'capicua' ? `Capicúa! ${who}`
      : b.type === 'openingBlock' ? `${who} opened strong — shut out!`
      : `${who} shut everyone out!`;
    banner.querySelector('.bonus-text').textContent =
      counted ? headline : `${headline}  ·  doesn't count (would pass ${state?.game?.targetScore ?? 200})`;
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

/* A player has nothing to play — flash an alert above their seat before the
   server draws or passes for them. */
socket.on('noplay', (n) => {
  const blocked = n.action === 'pass';
  showSeatAlert(
    n.playerIndex,
    blocked ? 'Blocked' : 'Drawing…',
    blocked ? 'blocked' : 'draw',
    Math.max(900, (n.ms || 1500) - 150)
  );
  if (blocked) Sound.lose();
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

  const revealed = g.over && Array.isArray(player.hand);
  const stack = document.createElement('div');
  stack.className = revealed ? 'reveal-hand' : 'stack';
  if (revealed) {
    // Flip their tiles face-up so everyone can see what was left.
    player.hand.forEach((tile, k) => {
      const d = dominoEl(tile, 'h');
      d.classList.add('reveal-tile');
      d.style.animationDelay = k * 70 + 'ms';
      stack.appendChild(d);
    });
    if (player.hand.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'reveal-empty';
      empty.textContent = 'empty';
      stack.appendChild(empty);
    }
  } else {
    for (let i = 0; i < Math.min(player.tileCount, 7); i++) {
      const t = document.createElement('div');
      t.className = 'back-tile';
      stack.appendChild(t);
    }
  }
  seatEl.appendChild(stack);

  const pts = document.createElement('div');
  pts.className = 'seat-points';
  if (revealed) {
    // During the reveal, show the remaining pip total prominently.
    pts.innerHTML = '<b></b><span>pips left</span>';
    pts.querySelector('b').textContent = player.hand.reduce((s, t) => s + t[0] + t[1], 0);
    pts.classList.add('reveal-total');
  } else {
    pts.innerHTML = '<b></b><span>points</span>';
    pts.querySelector('b').textContent = player.score;
  }
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
  // A fresh state rebuilds the board, so any open placement preview is stale.
  selectedTileIndex = null;

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

  // Announce who opens each new round with a little toast above their seat.
  if (g.roundId !== lastRoundId) {
    lastRoundId = g.roundId;
    if (!g.over && g.starter !== undefined && g.starter !== null) {
      const anchor = g.starter === state.youIndex ? $('my-seat') : seatOfPlayer[g.starter];
      // seat rects aren't final until layout settles this frame
      requestAnimationFrame(() => showStarterToast(g.starter, anchor));
    }
  }

  // --- board: snake layout, then zoom so everything fits ---
  const board = $('board');
  board.innerHTML = '';
  // Let each row use (almost) the full play-area width before wrapping, so the
  // chain spans the board instead of huddling in the middle.
  const wrapRect = $('board-wrap').getBoundingClientRect();
  // Size the spiral's rectangle to the play area (mins keep it in the verified
  // overlap-free range); the chain fills the width, then curls within it.
  HALF_W = Math.max(460, wrapRect.width / 2 - 60);
  HALF_H = Math.max(360, wrapRect.height / 2 - 60);
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
    const wrap = wrapRect;
    const pad = 60; // breathing room for drop zones
    const bw = maxX - minX + pad * 2;
    const bh = maxY - minY + pad * 2;
    // Allow up to 1.4x so small/medium boards render noticeably larger; big
    // boards still shrink to fit.
    scale = Math.min(1.4, wrap.width / bw, wrap.height / bh);
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
    // Hold the scoreboard until the slow slam + scatter has played out.
    overlayHoldUntil = Date.now() + 3600;
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
    Sound.place();
  }
  prevBoardLen = g.board.length;
  pendingHandRect = null;
  wasOver = g.over;

  // A soft chime the moment it becomes your turn.
  if (myTurn && !prevMyTurn) Sound.turn();
  prevMyTurn = myTurn;

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
  if (g.over && Array.isArray(me.hand)) {
    pts.innerHTML = '<b></b><span>pips left</span>';
    pts.querySelector('b').textContent = me.hand.reduce((s, t) => s + t[0] + t[1], 0);
    pts.classList.add('reveal-total');
  } else {
    pts.classList.remove('reveal-total');
    pts.innerHTML = '<b></b><span>points</span>';
    pts.querySelector('b').textContent = me.score;
  }

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
        ? 'Your turn — tap a tile to preview, or drag it onto the board'
        : g.boneyardCount > 0 ? 'No play — drawing for you…' : 'No play — passing…';
    } else {
      const cur = state.players[g.turn];
      label = g.lastMove?.drew && g.lastMove.playerIndex === g.turn
        ? `${cur?.name} is drawing…`
        : `Waiting for ${cur?.name}…`;
    }
  }
  $('turn-label').textContent = label;

  // --- round result ---
  if (g.over && g.blocked) {
    // Locked game: keep the table visible with every hand flipped up and pip
    // totals under each seat. A small banner names the outcome; no full-screen
    // tally covers the reveal, and the server holds here longer.
    const lb = $('lock-banner');
    lb.textContent = g.roundWinner === null
      ? 'Locked — tied, no score'
      : `Locked — +${g.roundPoints}`;
    lb.classList.remove('hidden');
    $('tally').classList.add('hidden');
    if (!tallyTriggeredForRound) {
      tallyTriggeredForRound = true;
      Sound.flip();
      // If this locked round also wins the match, show the match card after
      // the reveal has had time to sink in.
      if (g.matchWinner !== null && g.matchWinner !== undefined) {
        setTimeout(() => {
          if (state?.game?.over) { $('lock-banner').classList.add('hidden'); renderOverlay(state.game); }
        }, 4200);
      }
    }
  } else if (g.over) {
    $('lock-banner').classList.add('hidden');
    if (!tallyTriggeredForRound) {
      tallyTriggeredForRound = true;
      const wait = Math.max(0, overlayHoldUntil - Date.now());
      setTimeout(() => state?.game?.over && runTally(state.game), wait);
    }
  } else {
    $('lock-banner').classList.add('hidden');
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
      .map((b) => {
        const label = b.type === 'capicua' ? 'Capicúa' : b.type === 'openingBlock' ? 'Shutout' : 'Pass';
        return b.counted === false ? `${label} +${b.points} (void)` : `${label} +${b.points}`;
      });

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
  (g.roundPoints || 0) > 0 ? Sound.win() : Sound.tick();

  // No "so-and-so won the round" — just how many points were scored.
  const pts = g.roundPoints || 0;
  $('tally-title').textContent = pts > 0 ? `+${pts}` : g.blocked ? 'Locked' : '—';
  $('tally-sub').textContent = pts > 0 ? 'points' : g.blocked ? 'no score this round' : '';

  const rowsEl = $('tally-rows');
  rowsEl.innerHTML = '';
  const D_ANIM = 900;
  const STAGGER = 120;
  const HOLD = 2000; // linger ~2s after the count-up before the next round
  rows.forEach((r, i) => {
    const from = lastLiveScores?.[r.repIdx] ?? r.to;
    const el = document.createElement('div');
    el.className = 'tally-row' + (r.to > from ? ' gained' : '');
    el.style.animation = `tally-row-in .4s ${i * STAGGER}ms both cubic-bezier(.2,.9,.3,1.1)`;
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

    if (r.to !== from) {
      const start = performance.now() + i * STAGGER + 250; // start after the row slides in
      const step = (now) => {
        const t = Math.max(0, Math.min(1, (now - start) / D_ANIM));
        const eased = 1 - Math.pow(1 - t, 3);
        scoreEl.textContent = Math.round(from + (r.to - from) * eased);
        if (t >= 1) scoreEl.classList.remove('counting');
        else requestAnimationFrame(step);
      };
      scoreEl.classList.add('counting');
      requestAnimationFrame(step);
    }
  });

  $('tally').classList.remove('hidden');
  const totalMs = (rows.length - 1) * STAGGER + 250 + D_ANIM + HOLD;
  setTimeout(() => {
    $('tally').classList.add('hidden');
    if (isMatchOver && state?.game?.over) renderOverlay(state.game);
  }, totalMs);
}

/* Find the seat DOM element for a player (my seat, or an opponent seat). */
function seatAnchorFor(playerIndex) {
  if (!state) return null;
  if (playerIndex === state.youIndex) return $('my-seat');
  return document.querySelector(`.seat[data-player-index="${playerIndex}"]`);
}

/* A short-lived pill floating above a player's seat (e.g. "Blocked"). */
function showSeatAlert(playerIndex, text, kind, ms = 1400) {
  const anchor = seatAnchorFor(playerIndex);
  if (!anchor) return;
  const r = anchor.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = 'seat-alert' + (kind ? ' ' + kind : '');
  el.textContent = text;
  document.body.appendChild(el);
  const tw = el.offsetWidth;
  el.style.left = Math.max(8, Math.min(window.innerWidth - tw - 8, r.left + r.width / 2 - tw / 2)) + 'px';
  const isTop = anchor.id === 'seat-top';
  el.style.top = (isTop ? r.bottom + 10 : r.top - 46) + 'px';
  setTimeout(() => el.classList.add('leaving'), Math.max(300, ms - 350));
  setTimeout(() => el.remove(), ms);
}

function showStarterToast(starterIndex, anchor) {
  const name = state.players[starterIndex]?.name;
  if (!name || !anchor) return;
  const r = anchor.getBoundingClientRect();
  const t = document.createElement('div');
  t.className = 'starter-toast';
  t.textContent = `${name} starts`;
  document.body.appendChild(t);
  const tw = t.offsetWidth;
  const left = Math.max(8, Math.min(window.innerWidth - tw - 8, r.left + r.width / 2 - tw / 2));
  t.style.left = left + 'px';
  // above the seat, except the top seat where we drop it just below
  const isTop = anchor.id === 'seat-top';
  t.style.top = (isTop ? r.bottom + 10 : r.top - 42) + 'px';
  setTimeout(() => t.classList.add('leaving'), 1900);
  setTimeout(() => t.remove(), 2300);
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
  // The CSS "smack" hovers big for suspense, then slams at ~0.9s. Sync the
  // impact (sound + table shake + scatter) to that moment.
  const SLAM = 900;
  setTimeout(() => {
    Sound.place();
    table.classList.add('shake');
    setTimeout(() => table.classList.remove('shake'), 600);
    const k = boardMeta.scale || 1;
    [...board.children]
      .filter((el) => el !== newest)
      .forEach((el) => {
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
  }, SLAM);
}

/* FLIP animation: the tile starts where it was played from and flies to its board slot. */
function flyIn(el, fromRect) {
  const target = el.getBoundingClientRect();
  const k = boardMeta.scale || 1; // tile transforms live in board (scaled) space
  const dx = (fromRect.left + fromRect.width / 2 - (target.left + target.width / 2)) / k;
  const dy = (fromRect.top + fromRect.height / 2 - (target.top + target.height / 2)) / k;
  el.style.transform = `translate(${dx}px, ${dy}px) scale(1.06)`;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.classList.add('flying');
      el.style.transform = '';
      el.addEventListener('transitionend', () => el.classList.remove('flying'), { once: true });
    });
  });
}
