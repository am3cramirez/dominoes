/* global io */
const socket = io();

const $ = (id) => document.getElementById(id);
const screens = { home: $('screen-home'), lobby: $('screen-lobby'), game: $('screen-game') };

let state = null; // last server state
let selectedTileIndex = null;

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

function half(value) {
  const h = document.createElement('div');
  h.className = 'half';
  const pips = document.createElement('div');
  pips.className = 'pips';
  for (let i = 0; i < 9; i++) {
    const cell = document.createElement('div');
    if (PIP_CELLS[value].includes(i)) cell.className = 'pip';
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

/* ---------- Home ---------- */
$('btn-create').onclick = () => {
  socket.emit('createRoom', { name: $('name-input').value }, (res) => {
    if (res.error) return ($('home-error').textContent = res.error);
    $('home-error').textContent = '';
  });
};

$('btn-join').onclick = joinRoom;
$('code-input').onkeydown = (e) => e.key === 'Enter' && joinRoom();
$('name-input').onkeydown = (e) => e.key === 'Enter' && $('code-input').focus();

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
  socket.emit('playTile', { tileIndex, side }, (res) => res?.error && toast(res.error));
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
  // After a socket reconnect our old seat is orphaned; user can rejoin via home screen.
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
  $('lobby-hint').textContent = meHost
    ? state.players.length < 2 ? 'Waiting for at least one more player…' : 'Ready when you are!'
    : 'Waiting for the host to start the game…';
}

function renderGame() {
  show('game');
  const g = state.game;
  const me = state.players[state.youIndex];
  const myTurn = g.turn === state.youIndex && !g.over;

  $('game-code').textContent = state.code;
  $('boneyard-count').textContent = g.boneyardCount;

  // opponents
  const opps = $('opponents');
  opps.innerHTML = '';
  state.players.forEach((p, i) => {
    if (i === state.youIndex) return;
    const el = document.createElement('div');
    el.className = 'opp' + (g.turn === i && !g.over ? ' turn' : '') + (p.connected ? '' : ' disconnected');
    el.innerHTML = `<div class="opp-name"></div><div class="opp-meta"></div>`;
    el.querySelector('.opp-name').textContent = p.name + (p.connected ? '' : ' (offline)');
    el.querySelector('.opp-meta').textContent = `${p.tileCount} tiles · ${p.score} pts`;
    if (!p.connected && state.players[state.youIndex]?.isHost) {
      const kick = document.createElement('button');
      kick.className = 'btn small kick';
      kick.textContent = 'Remove';
      kick.onclick = () => socket.emit('kickDisconnected', { playerIndex: i }, (r) => r?.error && toast(r.error));
      el.appendChild(kick);
    }
    opps.appendChild(el);
  });

  // board
  const board = $('board');
  board.innerHTML = '';
  $('board-empty').style.display = g.board.length ? 'none' : '';
  g.board.forEach((tile, idx) => {
    const isDouble = tile[0] === tile[1];
    const el = dominoEl(tile, isDouble ? 'v' : 'h');
    if (g.lastMove && g.lastMove.tile) {
      const lm = g.lastMove;
      const isNewest =
        (lm.side === 'left' && idx === 0) ||
        ((lm.side === 'right' || g.board.length === 1) && idx === g.board.length - 1);
      if (isNewest) el.classList.add('just-played');
    }
    board.appendChild(el);
  });

  // turn banner
  const banner = $('turn-banner');
  if (g.over) {
    banner.textContent = '';
    banner.className = '';
  } else if (myTurn) {
    banner.textContent = '▶ Your turn!';
    banner.className = 'mine';
  } else {
    banner.textContent = `${state.players[g.turn]?.name}'s turn…`;
    banner.className = '';
  }

  // my info + hand
  $('my-info').innerHTML = '';
  const info = document.createElement('span');
  info.append(`${me.name} — `);
  const b = document.createElement('b');
  b.textContent = `${me.score} pts`;
  info.appendChild(b);
  info.append(` (first to ${g.targetScore})`);
  $('my-info').appendChild(info);

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
        if (sides.length === 1 || g.board.length === 0) {
          playTile(i, sides[0]);
        } else {
          selectedTileIndex = i;
          el.classList.add('selected');
          const rect = el.getBoundingClientRect();
          sideChooser.classList.remove('hidden');
          const cw = sideChooser.offsetWidth;
          sideChooser.style.left = Math.max(8, Math.min(window.innerWidth - cw - 8, rect.left + rect.width / 2 - cw / 2)) + 'px';
          sideChooser.style.top = rect.top - 60 + 'px';
        }
      };
    }
    hand.appendChild(el);
  });

  $('btn-draw').disabled = !myTurn || anyPlayable || g.boneyardCount === 0;
  $('btn-pass').disabled = !myTurn || anyPlayable || g.boneyardCount > 0;

  // round-over overlay
  const overlay = $('overlay');
  if (g.over) {
    overlay.classList.remove('hidden');
    const isMatchOver = g.matchWinner !== null && g.matchWinner !== undefined;
    const winnerName = g.roundWinner !== null ? state.players[g.roundWinner]?.name : null;
    $('overlay-title').textContent = isMatchOver
      ? `🏆 ${state.players[g.matchWinner]?.name} wins the match!`
      : g.roundWinner === null
        ? 'Blocked — tie round!'
        : g.roundWinner === state.youIndex
          ? '🎉 You won the round!'
          : `${winnerName} won the round`;
    $('overlay-sub').textContent = g.blocked
      ? 'The game was blocked — lowest pip count takes it.'
      : winnerName ? `${winnerName} played all their tiles${g.roundPoints ? ` (+${g.roundPoints} pts)` : ''}.` : '';

    const scores = $('overlay-scores');
    scores.innerHTML = '';
    [...state.players]
      .map((p, i) => ({ p, i }))
      .sort((a, b) => b.p.score - a.p.score)
      .forEach(({ p, i }) => {
        const row = document.createElement('div');
        row.className = 'row' + (i === (isMatchOver ? g.matchWinner : g.roundWinner) ? ' winner' : '');
        const left = document.createElement('span');
        left.textContent = p.name + (i === state.youIndex ? ' (you)' : '');
        const right = document.createElement('span');
        right.textContent = `${p.score} pts`;
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
