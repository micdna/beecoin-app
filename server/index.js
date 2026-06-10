// ═══════════════════════════════════════════════════════════
//  AQUATRADE PRO — Multiplayer WebSocket Server
//  Node.js + ws + Express
//  Deploy su Railway / Render / Fly.io gratuitamente
// ═══════════════════════════════════════════════════════════

const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const path    = require('path');
const crypto  = require('crypto');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// ── Serve la PWA statica ─────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.json());

// ── Stato globale del server ──────────────────────────────
const state = {
  players: new Map(),   // playerId → { ws, name, avatar, wallet, pnl, room, ... }
  rooms:   new Map(),   // roomCode → { players:Set, host, mode, started, prices }
  public:  new Set(),   // playerIds nella lobby pubblica
  prices:  {},          // prezzi correnti simulati
  news:    [],          // ultime 10 news
  chat:    [],          // ultime 50 chat globali
};

// ── Stocks ────────────────────────────────────────────────
const STOCKS = {
  AWK:  { name:"American Water Works", base:134.20, price:134.20 },
  XYL:  { name:"Xylem Inc.",           base:112.50, price:112.50 },
  VIE:  { name:"Veolia Environ.",      base:28.74,  price:28.74  },
  WTRG: { name:"Essential Utilities",  base:24.18,  price:24.18  },
  FIW:  { name:"First Trust ETF",      base:38.92,  price:38.92  },
  SGS:  { name:"Suez SA",             base:11.30,  price:11.30  },
  PRMW: { name:"Primo Water Corp.",    base:17.85,  price:17.85  },
  PHO:  { name:"Invesco Water ETF",    base:54.60,  price:54.60  },
};
Object.keys(STOCKS).forEach(k => state.prices[k] = STOCKS[k].base);

const NEWS_POOL = [
  { h:"AWK quarterly revenue +4.2% beats estimates", imp:"bull", tk:"AWK", mag:1.012 },
  { h:"XYL wins $800M Asia-Pacific deal",            imp:"bull", tk:"XYL", mag:1.018 },
  { h:"SGS faces antitrust regulatory inquiry",      imp:"bear", tk:"SGS", mag:0.985 },
  { h:"Global water stress index at decade high",    imp:"bull", tk:"FIW", mag:1.009 },
  { h:"VIE announces 8% dividend increase",          imp:"bull", tk:"VIE", mag:1.015 },
  { h:"WTRG spending forecast cut by analysts",      imp:"bear", tk:"WTRG",mag:0.988 },
  { h:"PHO ETF sees record $2.1B inflows Q3",        imp:"bull", tk:"PHO", mag:1.011 },
  { h:"UN Water Summit: $500B needed by 2030",       imp:"bull", tk:null,  mag:1.004 },
  { h:"Rising rates pressure utility plays",         imp:"bear", tk:null,  mag:0.993 },
  { h:"Drought emergency: 8 US states",              imp:"bull", tk:"AWK", mag:1.022 },
];

// ── Helpers ───────────────────────────────────────────────
const genId   = () => crypto.randomBytes(8).toString('hex');
const genCode = () => Math.random().toString(36).slice(2,7).toUpperCase();
const rnd     = (a,b) => a + Math.random()*(b-a);

function broadcast(set, msg, exclude=null) {
  const data = JSON.stringify(msg);
  set.forEach(id => {
    const p = state.players.get(id);
    if (p && p.ws.readyState === WebSocket.OPEN && id !== exclude) {
      p.ws.send(data);
    }
  });
}

function broadcastAll(msg, exclude=null) {
  broadcast(state.public, msg, exclude);
  state.rooms.forEach(room => broadcast(room.players, msg, exclude));
}

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function getLeaderboard() {
  const list = [];
  state.players.forEach((p, id) => {
    list.push({ id, name:p.name, avatar:p.avatar, wallet:p.wallet, pnl:p.pnl, level:p.level });
  });
  return list.sort((a,b) => (b.wallet+b.pnl)-(a.wallet+a.pnl)).slice(0,20);
}

function getRoomState(code) {
  const room = state.rooms.get(code);
  if (!room) return null;
  const players = [];
  room.players.forEach(id => {
    const p = state.players.get(id);
    if (p) players.push({ id, name:p.name, avatar:p.avatar, wallet:p.wallet, pnl:p.pnl, level:p.level, isHost: id===room.host });
  });
  return { code, players, mode:room.mode, started:room.started, maxPlayers:room.maxPlayers };
}

// ── Tick mercato ──────────────────────────────────────────
setInterval(() => {
  Object.keys(STOCKS).forEach(k => {
    const mv = (Math.random()-.49) * STOCKS[k].base * 0.004;
    const np = Math.max(STOCKS[k].base*.55, Math.min(STOCKS[k].base*1.45, state.prices[k]+mv));
    state.prices[k] = parseFloat(np.toFixed(3));
  });

  // Update P&L per tutti i giocatori con posizioni aperte
  state.players.forEach((p, id) => {
    let upnl = 0;
    Object.entries(p.portfolio||{}).forEach(([tk,pos]) => {
      upnl += (state.prices[tk] - pos.avg) * pos.qty;
    });
    p.pnl = Math.round(upnl);
  });

  const priceMsg = { type:'prices', prices:state.prices, ts: Date.now() };
  broadcastAll(priceMsg);

  // Leaderboard ogni 5 secondi
}, 2000);

setInterval(() => {
  broadcastAll({ type:'leaderboard', data: getLeaderboard() });
}, 5000);

// News ogni 30-60 secondi
setInterval(() => {
  const n = NEWS_POOL[Math.floor(Math.random()*NEWS_POOL.length)];
  const news = { ...n, time: new Date().toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit'}) };
  if (n.tk) state.prices[n.tk] = parseFloat((state.prices[n.tk]*n.mag).toFixed(3));
  state.news.unshift(news);
  if (state.news.length > 10) state.news.pop();
  broadcastAll({ type:'news', news });
}, 30000+Math.random()*30000);

// ── WebSocket handler ─────────────────────────────────────
wss.on('connection', (ws) => {
  const playerId = genId();
  const player = {
    ws, id: playerId,
    name: 'Trader_' + playerId.slice(0,4).toUpperCase(),
    avatar: '🐝',
    wallet: 50000,
    pnl: 0,
    portfolio: {},
    history: [],
    level: 1,
    xp: 0,
    room: null,
    inPublic: false,
  };
  state.players.set(playerId, player);

  console.log(`[+] Player connected: ${playerId} (total: ${state.players.size})`);

  // Messaggio di benvenuto
  send(ws, {
    type: 'welcome',
    playerId,
    prices: state.prices,
    news: state.news,
    chat: state.chat.slice(-20),
    leaderboard: getLeaderboard(),
    onlineCount: state.players.size,
  });

  // ── Gestione messaggi ──────────────────────────────────
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const p = state.players.get(playerId);
    if (!p) return;

    switch (msg.type) {

      // ── Setup profilo ──────────────────────────────────
      case 'set_profile': {
        if (msg.name) p.name = msg.name.slice(0,20).replace(/[<>]/g,'');
        if (msg.avatar) p.avatar = msg.avatar;
        send(ws, { type:'profile_ok', name:p.name, avatar:p.avatar });
        break;
      }

      // ── Unisciti alla lobby pubblica ────────────────────
      case 'join_public': {
        if (p.room) leaveRoom(playerId);
        p.inPublic = true;
        state.public.add(playerId);
        // Notifica gli altri
        broadcast(state.public, {
          type: 'player_joined_public',
          player: { id:playerId, name:p.name, avatar:p.avatar }
        }, playerId);
        send(ws, {
          type: 'public_state',
          players: [...state.public].map(id => {
            const pp = state.players.get(id);
            return pp ? { id, name:pp.name, avatar:pp.avatar, wallet:pp.wallet, pnl:pp.pnl } : null;
          }).filter(Boolean),
          onlineCount: state.players.size,
        });
        break;
      }

      // ── Crea stanza privata ─────────────────────────────
      case 'create_room': {
        if (p.room) leaveRoom(playerId);
        const code = genCode();
        const room = {
          code,
          host: playerId,
          players: new Set([playerId]),
          mode: msg.mode || 'tournament', // 'tournament' | 'race' | 'free'
          maxPlayers: msg.maxPlayers || 8,
          started: false,
          startTime: null,
          duration: msg.duration || 300000, // 5 min default
        };
        state.rooms.set(code, room);
        p.room = code;
        p.inPublic = false;
        state.public.delete(playerId);
        send(ws, { type:'room_created', room: getRoomState(code) });
        console.log(`[ROOM] Created ${code} by ${p.name}`);
        break;
      }

      // ── Unisciti a stanza con codice ────────────────────
      case 'join_room': {
        const code = msg.code?.toUpperCase();
        const room = state.rooms.get(code);
        if (!room) { send(ws, { type:'error', msg:'Room not found' }); break; }
        if (room.players.size >= room.maxPlayers) { send(ws, { type:'error', msg:'Room is full' }); break; }
        if (room.started) { send(ws, { type:'error', msg:'Match already started' }); break; }
        if (p.room) leaveRoom(playerId);
        room.players.add(playerId);
        p.room = code;
        p.inPublic = false;
        state.public.delete(playerId);
        // Notifica tutti nella room
        broadcast(room.players, { type:'player_joined_room', player:{ id:playerId, name:p.name, avatar:p.avatar }, room: getRoomState(code) });
        send(ws, { type:'room_joined', room: getRoomState(code) });
        break;
      }

      // ── Avvia partita (solo host) ───────────────────────
      case 'start_match': {
        const room = state.rooms.get(p.room);
        if (!room || room.host !== playerId) break;
        if (room.players.size < 2) { send(ws, { type:'error', msg:'Need at least 2 players' }); break; }
        room.started = true;
        room.startTime = Date.now();
        // Reset wallet di tutti
        room.players.forEach(id => {
          const pp = state.players.get(id);
          if (pp) { pp.wallet = 50000; pp.pnl = 0; pp.portfolio = {}; pp.history = []; }
        });
        broadcast(room.players, {
          type: 'match_started',
          duration: room.duration,
          mode: room.mode,
          startTime: room.startTime,
        });
        // Timer fine partita
        setTimeout(() => endMatch(p.room), room.duration);
        console.log(`[MATCH] Started in room ${p.room}`);
        break;
      }

      // ── Trade ────────────────────────────────────────────
      case 'trade': {
        const { side, ticker, qty } = msg;
        if (!ticker || !qty || qty < 10) { send(ws, { type:'trade_error', msg:'Invalid trade' }); break; }
        if (!state.prices[ticker]) { send(ws, { type:'trade_error', msg:'Unknown ticker' }); break; }

        const price = state.prices[ticker];
        const cost  = Math.round(price * qty);
        const fee   = Math.round(cost * 0.001);

        if (side === 'buy') {
          if (p.wallet < cost + fee) { send(ws, { type:'trade_error', msg:'Insufficient funds' }); break; }
          p.wallet -= (cost + fee);
          if (!p.portfolio[ticker]) p.portfolio[ticker] = { qty:0, avg:0 };
          const pos = p.portfolio[ticker];
          pos.avg = (pos.avg * pos.qty + price * qty) / (pos.qty + qty);
          pos.qty += qty;
          p.history.push({ side:'buy', ticker, qty, price, time: Date.now() });
          p.xp += 15;
          send(ws, { type:'trade_ok', side:'buy', ticker, qty, price, wallet:p.wallet, portfolio:p.portfolio });
        } else if (side === 'sell') {
          const pos = p.portfolio[ticker];
          if (!pos || pos.qty < qty) { send(ws, { type:'trade_error', msg:'Insufficient position' }); break; }
          const revenue = Math.round(price * qty) - fee;
          const pnl = Math.round((price - pos.avg) * qty);
          p.wallet += revenue;
          pos.qty -= qty;
          if (pos.qty <= 0) delete p.portfolio[ticker];
          p.history.push({ side:'sell', ticker, qty, price, pnl, time: Date.now() });
          p.xp += Math.max(5, Math.abs(pnl/20)|0);
          send(ws, { type:'trade_ok', side:'sell', ticker, qty, price, pnl, wallet:p.wallet, portfolio:p.portfolio });
        }

        // Notifica trade agli altri nella stessa room o pubblica
        const notifySet = p.room ? state.rooms.get(p.room)?.players : state.public;
        if (notifySet) {
          broadcast(notifySet, {
            type: 'player_traded',
            player: { id:playerId, name:p.name, avatar:p.avatar },
            trade: { side, ticker, qty, price }
          }, playerId);
        }
        break;
      }

      // ── Chat globale ─────────────────────────────────────
      case 'chat_global': {
        if (!msg.text || !msg.text.trim()) break;
        const chatMsg = {
          id: genId(),
          playerId,
          name: p.name,
          avatar: p.avatar,
          text: msg.text.trim().slice(0,120).replace(/[<>]/g,''),
          time: new Date().toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit'}),
          room: null,
        };
        state.chat.push(chatMsg);
        if (state.chat.length > 50) state.chat.shift();
        broadcastAll({ type:'chat', msg:chatMsg });
        break;
      }

      // ── Chat stanza ──────────────────────────────────────
      case 'chat_room': {
        if (!p.room || !msg.text?.trim()) break;
        const room = state.rooms.get(p.room);
        if (!room) break;
        const chatMsg = {
          id: genId(), playerId, name:p.name, avatar:p.avatar,
          text: msg.text.trim().slice(0,120).replace(/[<>]/g,''),
          time: new Date().toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit'}),
          room: p.room,
        };
        broadcast(room.players, { type:'chat', msg:chatMsg });
        break;
      }

      // ── Lascia stanza ────────────────────────────────────
      case 'leave_room': {
        leaveRoom(playerId);
        send(ws, { type:'left_room' });
        break;
      }

      // ── Ping ─────────────────────────────────────────────
      case 'ping': {
        send(ws, { type:'pong', ts: Date.now(), onlineCount: state.players.size });
        break;
      }
    }
  });

  ws.on('close', () => {
    leaveRoom(playerId);
    state.public.delete(playerId);
    state.players.delete(playerId);
    console.log(`[-] Player disconnected: ${playerId} (total: ${state.players.size})`);
    broadcastAll({ type:'player_left', playerId, onlineCount: state.players.size });
  });

  ws.on('error', (err) => console.error('WS error:', err.message));
});

// ── Fine partita ──────────────────────────────────────────
function endMatch(roomCode) {
  const room = state.rooms.get(roomCode);
  if (!room || !room.started) return;
  const results = [];
  room.players.forEach(id => {
    const p = state.players.get(id);
    if (!p) return;
    const inv = Object.entries(p.portfolio).reduce((a,[tk,pos]) => a+state.prices[tk]*pos.qty, 0);
    results.push({ id, name:p.name, avatar:p.avatar, total: Math.round(p.wallet+inv), pnl:p.pnl });
  });
  results.sort((a,b) => b.total - a.total);
  // Ricompense
  if (results[0]) {
    const winner = state.players.get(results[0].id);
    if (winner) { winner.wallet += 5000; winner.xp += 500; }
  }
  broadcast(room.players, { type:'match_ended', results, winner: results[0] });
  room.started = false;
  console.log(`[MATCH] Ended in room ${roomCode}. Winner: ${results[0]?.name}`);
}

// ── Abbandona stanza ──────────────────────────────────────
function leaveRoom(playerId) {
  const p = state.players.get(playerId);
  if (!p || !p.room) return;
  const room = state.rooms.get(p.room);
  if (!room) { p.room = null; return; }
  room.players.delete(playerId);
  // Se era l'host, trasferisci o chiudi
  if (room.host === playerId) {
    if (room.players.size > 0) {
      room.host = [...room.players][0];
      broadcast(room.players, { type:'new_host', hostId: room.host, room: getRoomState(p.room) });
    } else {
      state.rooms.delete(p.room);
    }
  } else {
    broadcast(room.players, { type:'player_left_room', playerId, room: getRoomState(p.room) });
  }
  p.room = null;
}

// ── REST API ─────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    online: state.players.size,
    rooms:  state.rooms.size,
    prices: state.prices,
    uptime: process.uptime(),
  });
});

app.get('/api/leaderboard', (req, res) => {
  res.json(getLeaderboard());
});

// ── Start ─────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`💧 AquaTrade Server running on port ${PORT}`);
  console.log(`   Serve PWA from /public`);
  console.log(`   WebSocket ready`);
});
