/* Element Island — tiny multiplayer server: static files + WebSocket rooms.
 * No database: a room lives in memory while players are connected.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const EI = require('./game.js');

const PORT = Number(process.env.PORT || 8765);
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

/* ------------------------------------------------------------------ static */
const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch (e) {
    res.writeHead(400);
    return res.end('bad request');
  }
  if (urlPath === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(ROOT, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('not found');
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache'
    });
    res.end(data);
  });
});

/* ------------------------------------------------------------------- rooms */
const rooms = new Map();
const COLORS = ['#0F6E6E', '#D97706', '#7C3AED', '#B91C1C'];
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += ALPHA[Math.floor(Math.random() * ALPHA.length)];
  } while (rooms.has(code));
  return code;
}

function roomView(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    started: room.started,
    mode: room.mode,
    players: room.players.map((p) => ({ id: p.id, name: p.name, connected: p.connected, seat: p.seat }))
  };
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj) {
  room.players.forEach((p) => send(p.ws, obj));
}

function broadcastRoom(room) {
  room.players.forEach((p) => send(p.ws, { t: 'room', room: roomView(room), you: p.id }));
}

// clients only need the deck SIZE, not the order (otherwise they could read the future)
function stateView(state) {
  const v = Object.assign({}, state);
  v.goalDeckCount = Array.isArray(state.goalDeck) ? state.goalDeck.length : 0;
  delete v.goalDeck;
  return v;
}

function broadcastState(room) {
  const view = stateView(room.state);
  room.players.forEach((p) => {
    send(p.ws, { t: 'state', state: view, you: p.seat });
  });
}

function cleanupRoom(room) {
  if (room.players.every((p) => !p.connected)) {
    room.emptyAt = Date.now();
  }
}
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, code) => {
    if (room.emptyAt && now - room.emptyAt > 10 * 60 * 1000) rooms.delete(code);
  });
}, 60 * 1000);

/* ----------------------------------------------------------------- actions */
const ACTIONS = {
  roll: (s) => EI.roll(s),
  setupLab: (s, p, a) => EI.placeSetupLab(s, p, a.vertex),
  setupPipe: (s, p, a) => EI.placeSetupPipe(s, p, a.edge),
  placePollution: (s, p, a) => EI.placePollution(s, a.hex),
  steal: (s, p, a) => EI.steal(s, a.victim),
  skipSteal: (s) => EI.skipSteal(s),
  synth: (s, p, a) => EI.synthesize(s, p, a.rid),
  buildPipe: (s, p, a) => EI.buildPipe(s, p, a.edge, a.any),
  buildLab: (s, p, a) => EI.buildLab(s, p, a.vertex),
  buildFactory: (s, p, a) => EI.buildFactory(s, p, a.vertex, a.rid),
  goal: (s, p, a) => EI.completeGoal(s, p, a.index),
  refreshGoal: (s, p, a) => EI.refreshMarketWith(s, p, a.index, a.elem),
  treat: (s, p) => EI.treatPollution(s, p),
  tradeBank: (s, p, a) => EI.tradeBank(s, p, a.give, a.get),
  tradePort: (s, p, a) => EI.tradePort(s, p, a.port, a.give, a.get),
  endTurn: (s) => EI.endTurn(s)
};

function applyAction(room, seat, name, args) {
  const fn = ACTIONS[name];
  if (!fn) return { ok: false, error: '未知操作：' + name };
  if (!room.state) return { ok: false, error: '游戏还没开始' };
  const before = JSON.stringify(room.state);
  let result;
  try {
    result = fn(room.state, seat, args || {});
  } catch (e) {
    return { ok: false, error: '操作异常：' + e.message };
  }
  if (!result || result.ok === false) {
    return { ok: false, error: (result && result.error) || '操作不合法' };
  }
  // guard against accidental no-ops that would desync clients
  if (JSON.stringify(room.state) === before && name !== 'roll') {
    // still fine: some actions are no-ops by design; keep going
  }
  return { ok: true };
}

/* -------------------------------------------------------------------- wss */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });

wss.on('connection', (ws) => {
  ws.id = crypto.randomUUID();
  ws.roomCode = null;
  send(ws, { t: 'welcome', id: ws.id });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return send(ws, { t: 'error', message: '消息格式错误' });
    }
    if (!msg || typeof msg.t !== 'string') return;

    if (msg.t === 'create') {
      const name = String(msg.name || '玩家').slice(0, 10) || '玩家';
      const mode = msg.mode === 'short' ? 'short' : 'standard';
      const code = makeCode();
      const room = {
        code,
        hostId: ws.id,
        started: false,
        mode,
        state: null,
        players: [],
        createdAt: Date.now()
      };
      rooms.set(code, room);
      joinRoom(room, ws, name);
      return;
    }

    if (msg.t === 'join') {
      const code = String(msg.code || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(ws, { t: 'error', message: '房间不存在：' + code });
      if (room.started) return send(ws, { t: 'error', message: '这局已经开始，等下一局吧' });
      if (room.players.length >= 4) return send(ws, { t: 'error', message: '房间已满（4 人）' });
      const name = String(msg.name || '玩家').slice(0, 10) || '玩家';
      joinRoom(room, ws, name);
      return;
    }

    if (msg.t === 'rejoin') {
      const code = String(msg.code || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(ws, { t: 'left', reason: '房间已关闭' });
      const seat = room.players.find((p) => p.id === msg.id);
      if (!seat) return send(ws, { t: 'left', reason: '找不到你的座位' });
      seat.ws = ws;
      seat.connected = true;
      ws.id = seat.id;
      ws.roomCode = room.code;
      broadcastRoom(room);
      if (room.state) {
        send(ws, { t: 'state', state: stateView(room.state), you: seat.seat });
      }
      return;
    }

    const room = rooms.get(ws.roomCode);
    if (!room) return send(ws, { t: 'error', message: '你不在房间里' });
    const me = room.players.find((p) => p.id === ws.id);

    if (msg.t === 'start') {
      if (ws.id !== room.hostId) return send(ws, { t: 'error', message: '只有房主能开始' });
      if (room.started) return send(ws, { t: 'error', message: '已经开始了' });
      if (room.players.length < 2) return send(ws, { t: 'error', message: '至少 2 人才能开始' });
      room.state = EI.newGame({
        players: room.players.map((p) => p.name),
        colors: room.players.map((p) => COLORS[p.seat]),
        mode: room.mode
      });
      room.started = true;
      broadcastRoom(room);
      broadcastState(room);
      return;
    }

    if (msg.t === 'action') {
      if (!me) return;
      if (!room.started) return send(ws, { t: 'error', message: '游戏还没开始' });
      const res = applyAction(room, me.seat, msg.name, msg.args);
      if (!res.ok) return send(ws, { t: 'error', message: res.error });
      broadcastState(room);
      return;
    }

    if (msg.t === 'leave') {
      leaveRoom(ws, room);
      return;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const me = room.players.find((p) => p.id === ws.id);
    if (!me) return;
    me.connected = false;
    me.ws = null;
    broadcastRoom(room);
    cleanupRoom(room);
  });
});

function joinRoom(room, ws, name) {
  const used = room.players.map((p) => p.seat);
  let seat = 0;
  while (used.includes(seat)) seat++;
  const player = { id: ws.id, name, seat, connected: true, ws };
  room.players.push(player);
  ws.roomCode = room.code;
  broadcastRoom(room);
  if (room.state) send(ws, { t: 'state', state: stateView(room.state), you: seat });
  console.log(`[room ${room.code}] + ${name} (seat ${seat})`);
}

function leaveRoom(ws, room) {
  const idx = room.players.findIndex((p) => p.id === ws.id);
  if (idx < 0) return;
  ws.roomCode = null;
  if (room.started) {
    // keep the seat so the engine's player order never shifts; just mark it offline
    room.players[idx].connected = false;
    room.players[idx].ws = null;
    broadcastRoom(room);
    return;
  }
  room.players.splice(idx, 1);
  if (room.players.length === 0) {
    rooms.delete(room.code);
    return;
  }
  if (room.hostId === ws.id) room.hostId = room.players[0].id;
  room.players.forEach((p, i) => (p.seat = i));
  broadcastRoom(room);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('元素岛服务器已启动: http://127.0.0.1:' + PORT);
  console.log('WebSocket: /ws ｜ 房间最多 4 人 ｜ Ctrl+C 停止');
});
