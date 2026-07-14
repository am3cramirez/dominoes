/* global io */
const socket = io();

const $ = (id) => document.getElementById(id);
const screens = { home: $('screen-home'), lobby: $('screen-lobby'), game: $('screen-game') };

let state = null; // last server state
let selectedTileIndex = null;
let prevBoardLen = 0; // for detecting a newly placed tile to animate
let pendingHandRect = null; // where my played tile started, so the animation begins there
let wasOver = false; // detects the round-end transition for the smack finale
let overlayHoldUntil = 0; // keep the scoreboard hidden while the finale plays

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

/* ---------- Drag & drop ---------- */
function makeDropZones(sides) {
  const zones = [];
  const board = $('board');
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
  if (board.children.length === 0) {
    place('left', wrap.left + wrap.width / 2, wrap.top + wrap.height / 2);
  } else {
    if (sides.includes('left')) {
      const r = board.children[0].getBoundingClientRect();
      place('left', r.left - 60, r.top + r.height / 2);
    }
    if (sides.includes('right')) {
      const r = board.children[board.children.length - 1].getBoundingClientRect();
      place('right', r.right + 60, r.top + r.height / 2);
    }
  }
  return zones;
}

function inRect(ev, rect, pad = 22) {
  return (
    ev.clientX >= rect.left - pad && ev.clientX <= rect.right + pad &&
    ev.clientY >= rect.top - pad && ev.clientY <= rect.bottom + pad
  );
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

    const onMove = (ev) => {
      if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 8) {
        dragging = true;
        ghost = dominoEl(tile, 'v');
        ghost.classList.add('drag-ghost');
        ghost.style.width = el.offsetWidth + 'px';
        ghost.style.height = el.offsetHeight + 'px';
        document.body.appendChild(ghost);
        el.classList.add('drag-source');
        zones = makeDropZones(sides);
      }
      if (dragging) {
        ghost.style.left = ev.clientX + 'px';
        ghost.style.top = ev.clientY + 'px';
        zones.forEach((z) => z.el.classList.toggle('hot', inRect(ev, z.rect)));
      }
    };

    const onUp = (ev) => {
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
  const secs = state?.autoStartAt
    ? Math.max(0, Math.ceil((state.autoStartAt - Date.now()) / 1000))
    : null;
  $('lobby-countdown').textContent = secs !== null && !state.game ? `Starting in ${secs}s…` : '';
  $('overlay-auto').textContent = secs !== null && state?.game?.over ? `Next round in ${secs}s…` : '';
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
      b.type === 'capicua' ? `Capicúa! ${who}` : `${who} shut everyone out!`;
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
  $('btn-start').disabled = state.players.length < 2;
  let hint = meHost
    ? state.players.length < 2 ? 'Waiting for at least one more player…' : 'Ready when you are!'
    : state.isPublic
      ? 'The game starts automatically…'
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

  // --- board ---
  const board = $('board');
  board.innerHTML = '';
  g.board.forEach((tile) => {
    board.appendChild(dominoEl(tile, tile[0] === tile[1] ? 'v' : 'h'));
  });

  // round just ended with a played tile -> smack finale; otherwise fly-in
  const justEnded = g.over && !wasOver;
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

  // --- round-over overlay (delayed while the finale plays) ---
  if (g.over) {
    const wait = overlayHoldUntil - Date.now();
    if (wait > 0) {
      $('overlay').classList.add('hidden');
      setTimeout(() => state?.game?.over && renderOverlay(state.game), wait);
    } else {
      renderOverlay(g);
    }
  } else {
    $('overlay').classList.add('hidden');
  }
}

function newestTileEl(board, g) {
  return g.lastMove.side === 'left' && g.board.length > 1
    ? board.children[0]
    : board.children[board.children.length - 1];
}

function renderOverlay(g) {
  const overlay = $('overlay');
  overlay.classList.remove('hidden');
  const isMatchOver = g.matchWinner !== null && g.matchWinner !== undefined;
  const sideName = (i) => {
    if (i === null || i === undefined) return null;
    if (!state.teams) return state.players[i]?.name;
    return state.players.filter((p) => p.team === state.players[i].team).map((p) => p.name).join(' & ');
  };
  const winnerIdx = isMatchOver ? g.matchWinner : g.roundWinner;
  const iWon = winnerIdx !== null && (state.teams
    ? state.players[winnerIdx]?.team === state.players[state.youIndex]?.team
    : winnerIdx === state.youIndex);
  $('overlay-title').textContent = isMatchOver
    ? `🏆 ${sideName(g.matchWinner)} win${state.teams ? '' : 's'} the match!`
    : g.roundWinner === null
      ? 'Blocked — tie round!'
      : iWon
        ? '🎉 You won the round!'
        : `${sideName(g.roundWinner)} won the round`;

  const subParts = [];
  if (g.blocked) subParts.push('The game was blocked — fewest remaining pips takes it.');
  else if (g.roundWinner !== null) subParts.push(`All remaining pips collected: +${g.roundPoints} pts.`);
  for (const b of g.bonuses || []) {
    subParts.push(
      b.type === 'capicua'
        ? `Capicúa! The winning tile fit both ends: +${b.points}.`
        : `${state.players[b.playerIndex]?.name} made everyone pass: +${b.points}.`
    );
  }
  $('overlay-sub').textContent = subParts.join(' ');

  const scores = $('overlay-scores');
  scores.innerHTML = '';
  let rows;
  if (state.teams) {
    rows = [0, 1].map((t) => {
      const members = state.players.map((p, i) => ({ p, i })).filter(({ p }) => p.team === t);
      return {
        label: members.map(({ p }) => p.name).join(' & ') + (members.some(({ i }) => i === state.youIndex) ? ' (you)' : ''),
        score: members[0].p.score,
        winner: winnerIdx !== null && state.players[winnerIdx]?.team === t,
      };
    });
  } else {
    rows = state.players.map((p, i) => ({
      label: p.name + (i === state.youIndex ? ' (you)' : ''),
      score: p.score,
      winner: i === winnerIdx,
    }));
  }
  rows
    .sort((a, b) => b.score - a.score)
    .forEach((r) => {
      const row = document.createElement('div');
      row.className = 'row' + (r.winner ? ' winner' : '');
      const left = document.createElement('span');
      left.textContent = r.label;
      const right = document.createElement('span');
      right.textContent = `${r.score} pts`;
      row.append(left, right);
      scores.appendChild(row);
    });

  const meHost = state.players[state.youIndex]?.isHost;
  $('btn-next-round').style.display = meHost ? '' : 'none';
  $('btn-next-round').textContent = isMatchOver ? 'New Match' : 'Next Round';
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
    others.forEach((el) => {
      const r = el.getBoundingClientRect();
      const ex = r.left + r.width / 2 - cx;
      const ey = r.top + r.height / 2 - cy;
      const dist = Math.max(40, Math.hypot(ex, ey));
      const push = 260 + Math.random() * 420;
      const dx = (ex / dist) * push + (Math.random() - 0.5) * 160;
      const dy = (ey / dist) * push + (Math.random() - 0.5) * 160;
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
  const dx = fromRect.left + fromRect.width / 2 - (target.left + target.width / 2);
  const dy = fromRect.top + fromRect.height / 2 - (target.top + target.height / 2);
  el.style.transform = `translate(${dx}px, ${dy}px) scale(1.15) rotate(8deg)`;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.classList.add('flying');
      el.style.transform = '';
      el.addEventListener('transitionend', () => el.classList.remove('flying'), { once: true });
    });
  });
}
