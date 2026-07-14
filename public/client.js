/* global io */
const socket = io();

const $ = (id) => document.getElementById(id);
const screens = { home: $('screen-home'), lobby: $('screen-lobby'), game: $('screen-game') };

let state = null; // last server state
let selectedTileIndex = null;
let prevBoardLen = 0; // for detecting a newly placed tile to animate
let pendingHandRect = null; // where my clicked tile was, so the animation starts there

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
$('btn-create').onclick = () => {
  socket.emit('createRoom', { name: $('name-input').value }, (res) => {
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
  show('home');
}

/* ---------- Game actions ---------- */
$('btn-draw').onclick = () => socket.emit('drawTile', (res) => res?.error && toast(res.error));
$('btn-pass').onclick = () => socket.emit('pass', (res) => res?.error && toast(res.error));

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

  const meHost = state.players[state.youIndex]?.isHost;
  $('btn-start').style.display = meHost ? '' : 'none';
  $('btn-start').disabled = state.players.length < 2;
  let hint = meHost
    ? state.players.length < 2 ? 'Waiting for at least one more player…' : 'Ready when you are!'
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

  // animate the newest tile flying in from whoever played it
  if (g.board.length > prevBoardLen && g.lastMove?.tile && board.children.length > 0) {
    const newest =
      g.lastMove.side === 'left' && g.board.length > 1
        ? board.children[0]
        : board.children[board.children.length - 1];
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
    if (canPlay) {
      el.onclick = (ev) => {
        ev.stopPropagation();
        const rect = el.getBoundingClientRect();
        if (sides.length === 1 || g.board.length === 0) {
          pendingHandRect = rect;
          playTile(i, sides[0]);
        } else {
          selectedTileIndex = i;
          pendingHandRect = rect;
          el.classList.add('selected');
          sideChooser.classList.remove('hidden');
          const cw = sideChooser.offsetWidth;
          sideChooser.style.left = Math.max(8, Math.min(window.innerWidth - cw - 8, rect.left + rect.width / 2 - cw / 2)) + 'px';
          sideChooser.style.top = rect.top - 60 + 'px';
        }
      };
    }
    hand.appendChild(el);
  });

  // --- draw / pass prompts + turn label ---
  $('btn-draw').classList.toggle('show', myTurn && !anyPlayable && g.boneyardCount > 0);
  $('btn-pass').classList.toggle('show', myTurn && !anyPlayable && g.boneyardCount === 0);
  $('turn-label').textContent = g.over
    ? ''
    : myTurn
      ? anyPlayable ? 'Your turn — tap a tile to play it' : 'No playable tiles…'
      : `Waiting for ${state.players[g.turn]?.name}…`;

  // --- round-over overlay ---
  const overlay = $('overlay');
  if (g.over) {
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
  } else {
    overlay.classList.add('hidden');
  }
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
