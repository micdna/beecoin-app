// ═══════════════════════════════════════════════════════════
//  AQUATRADE — Multiplayer WebSocket Server
//  Node.js + ws + Express
// ═══════════════════════════════════════════════════════════

const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const path    = require('path');
const crypto  = require('crypto');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const PORT   = process.env.PORT || 3000;

// ── Static: serve la PWA ─────────────────────────────────
// __dirname = /app/server → public è in /app/public
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.json());

// ── Stato globale ─────────────────────────────────────────
const players = new Map();  // id → player
const rooms   = new Map();  // code → room
const pubSet  = new Set();  // playerIds in lobby pubblica

// ── Stocks e prezzi ───────────────────────────────────────
const STOCKS = {
  AWK:  { base: 134.20 }, XYL:  { base: 112.50 },
  VIE:  { base: 28.74  }, WTRG: { base: 24.18  },
  FIW:  { base: 38.92  }, SGS:  { base: 11.30  },
  PRMW: { base: 17.85  }, PHO:  { base: 54.60  },
};
const prices = {};
Object.keys(STOCKS).forEach(k => prices[k] = STOCKS[k].base);

const NEWS = [
  { h:"AWK revenue +4.2% beats estimates",     imp:"bull", tk:"AWK",  mag:1.012 },
  { h:"XYL wins $800M Asia-Pacific deal",       imp:"bull", tk:"XYL",  mag:1.018 },
  { h:"SGS faces antitrust inquiry",            imp:"bear", tk:"SGS",  mag:0.985 },
  { h:"Global water stress at decade high",     imp:"bull", tk:"FIW",  mag:1.009 },
  { h:"VIE announces 8% dividend increase",     imp:"bull", tk:"VIE",  mag:1.015 },
  { h:"WTRG spending forecast cut",             imp:"bear", tk:"WTRG", mag:0.988 },
  { h:"PHO ETF record $2.1B inflows Q3",        imp:"bull", tk:"PHO",  mag:1.011 },
  { h:"UN Water Summit: $500B needed by 2030",  imp:"bull", tk:null,   mag:1.004 },
  { h:"Rising rates pressure utility plays",    imp:"bear", tk:null,   mag:0.993 },
  { h:"Drought emergency: 8 US states",         imp:"bull", tk:"AWK",  mag:1.022 },
];

let newsIdx = 0;
const newsHistory = [];
const chatHistory = [];

// ── Helpers ───────────────────────────────────────────────
const genId   = () => crypto.randomBytes(8).toString('hex');
const genCode = () => Math.random().toString(36).slice(2,7).toUpperCase();
const rnd     = (a,b) => a + Math.random()*(b-a);

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify(msg));
}

function broadcast(idSet, msg, exclude=null) {
  const data = JSON.stringify(msg);
  idSet.forEach(id => {
    if (id === exclude) return;
    const p = players.get(id);
    if (p && p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
  });
}

function broadcastAll(msg, exclude=null) {
  broadcast(pubSet, msg, exclude);
  rooms.forEach(r => broadcast(r.players, msg, exclude));
}

function leaderboard() {
  const out = [];
  players.forEach((p, id) => {
    const inv = Object.entries(p.portfolio)
      .reduce((a,[k,v]) => a + prices[k]*v.qty, 0);
    out.push({ id, name:p.name, avatar:p.avatar,
               wallet:p.wallet, pnl:p.pnl, total:Math.round(p.wallet+inv) });
  });
  return out.sort((a,b) => b.total-a.total).slice(0,20);
}

function roomState(code) {
  const r = rooms.get(code); if (!r) return null;
  const pl = [];
  r.players.forEach(id => {
    const p = players.get(id);
    if (p) pl.push({ id, name:p.name, avatar:p.avatar,
                     wallet:p.wallet, pnl:p.pnl, isHost: id===r.host });
  });
  return { code, players:pl, mode:r.mode,
           maxPlayers:r.maxPlayers, started:r.started };
}

function leaveRoom(playerId) {
  const p = players.get(playerId); if (!p || !p.room) return;
  const r = rooms.get(p.room); if (!r) { p.room=null; return; }
  r.players.delete(playerId);
  if (r.host === playerId) {
    if (r.players.size > 0) {
      r.host = [...r.players][0];
      broadcast(r.players, { type:'new_host', hostId:r.host, room:roomState(p.room) });
    } else {
      rooms.delete(p.room);
    }
  } else if (r.players.size > 0) {
    broadcast(r.players, { type:'player_left_room', playerId, room:roomState(p.room) });
  }
  p.room = null;
}

// ── Tick prezzi ogni 2s ──────────────────────────────────
setInterval(() => {
  Object.keys(STOCKS).forEach(k => {
    const mv = (Math.random()-.49)*STOCKS[k].base*.004;
    prices[k] = parseFloat(Math.max(
      STOCKS[k].base*.55,
      Math.min(STOCKS[k].base*1.45, prices[k]+mv)
    ).toFixed(3));
  });
  // Aggiorna P&L aperto
  players.forEach(p => {
    const upnl = Object.entries(p.portfolio)
      .reduce((a,[k,v]) => a+(prices[k]-v.avg)*v.qty, 0);
    p.pnl = Math.round(upnl);
  });
  broadcastAll({ type:'prices', prices, ts:Date.now() });
}, 2000);

// ── Leaderboard ogni 5s ───────────────────────────────────
setInterval(() => {
  broadcastAll({ type:'leaderboard', data: leaderboard() });
}, 5000);

// ── News ogni ~40s ────────────────────────────────────────
setInterval(() => {
  const n = NEWS[newsIdx % NEWS.length]; newsIdx++;
  const news = { ...n, time: new Date().toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit'}) };
  if (n.tk) prices[n.tk] = parseFloat((prices[n.tk]*n.mag).toFixed(3));
  newsHistory.unshift(news); if (newsHistory.length>10) newsHistory.pop();
  broadcastAll({ type:'news', news });
}, 38000 + Math.random()*20000);

// ── WebSocket ─────────────────────────────────────────────
wss.on('connection', ws => {
  const playerId = genId();
  const player = {
    ws, id:playerId,
    name: 'Trader_' + playerId.slice(0,4).toUpperCase(),
    avatar: '💧',
    wallet: 50000, pnl: 0,
    portfolio: {}, history: [],
    room: null, inPublic: false,
  };
  players.set(playerId, player);
  console.log(`[+] ${player.name} connected (total: ${players.size})`);

  send(ws, {
    type: 'welcome', playerId,
    prices, news: newsHistory,
    chat: chatHistory.slice(-20),
    leaderboard: leaderboard(),
    onlineCount: players.size,
  });

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const p = players.get(playerId); if (!p) return;

    switch (msg.type) {

      case 'set_profile':
        if (msg.name)   p.name   = msg.name.slice(0,20).replace(/[<>]/g,'');
        if (msg.avatar) p.avatar = msg.avatar;
        break;

      case 'join_public':
        if (p.room) leaveRoom(playerId);
        p.inPublic = true; pubSet.add(playerId);
        send(ws, {
          type: 'public_state',
          players: [...pubSet].map(id => {
            const pp = players.get(id);
            return pp ? { id, name:pp.name, avatar:pp.avatar,
                          wallet:pp.wallet, pnl:pp.pnl } : null;
          }).filter(Boolean),
          onlineCount: players.size,
        });
        break;

      case 'create_room': {
        if (p.room) leaveRoom(playerId);
        pubSet.delete(playerId); p.inPublic = false;
        const code = genCode();
        const dur  = msg.mode==='race'?180000 : msg.mode==='free'?600000 : 300000;
        rooms.set(code, {
          code, host:playerId,
          players: new Set([playerId]),
          mode: msg.mode||'tournament',
          maxPlayers: msg.maxPlayers||8,
          duration: dur, started:false,
        });
        p.room = code;
        send(ws, { type:'room_created', room:roomState(code) });
        break;
      }

      case 'join_room': {
        const code = msg.code?.toUpperCase();
        const r = rooms.get(code);
        if (!r)                       { send(ws,{type:'error',msg:'Stanza non trovata'}); break; }
        if (r.players.size>=r.maxPlayers){ send(ws,{type:'error',msg:'Stanza piena'}); break; }
        if (r.started)                { send(ws,{type:'error',msg:'Partita già iniziata'}); break; }
        if (p.room) leaveRoom(playerId);
        pubSet.delete(playerId); p.inPublic=false;
        r.players.add(playerId); p.room=code;
        broadcast(r.players, { type:'player_joined_room',
          player:{id:playerId,name:p.name,avatar:p.avatar}, room:roomState(code) });
        send(ws, { type:'room_joined', room:roomState(code) });
        break;
      }

      case 'start_match': {
        const r = rooms.get(p.room);
        if (!r || r.host!==playerId) break;
        if (r.players.size<2) { send(ws,{type:'error',msg:'Servono almeno 2 giocatori'}); break; }
        r.started = true; r.startTime = Date.now();
        r.players.forEach(id => {
          const pp = players.get(id);
          if (pp) { pp.wallet=50000; pp.pnl=0; pp.portfolio={}; pp.history=[]; }
        });
        broadcast(r.players, { type:'match_started',
          duration:r.duration, mode:r.mode, startTime:r.startTime });
        setTimeout(() => endMatch(p.room), r.duration);
        break;
      }

      case 'trade': {
        const { side, ticker, qty } = msg;
        if (!ticker||!qty||qty<10||!prices[ticker]) {
          send(ws,{type:'trade_error',msg:'Trade non valido'}); break;
        }
        const pr=prices[ticker], cost=Math.round(pr*qty), fee=Math.round(cost*.001);
        if (side==='buy') {
          if (p.wallet<cost+fee) { send(ws,{type:'trade_error',msg:'Fondi insufficienti'}); break; }
          p.wallet -= cost+fee;
          if (!p.portfolio[ticker]) p.portfolio[ticker]={qty:0,avg:0};
          const pos=p.portfolio[ticker];
          pos.avg=(pos.avg*pos.qty+pr*qty)/(pos.qty+qty);
          pos.qty+=qty;
          p.history.push({side:'buy',ticker,qty,price:pr,t:Date.now()});
          send(ws,{type:'trade_ok',side:'buy',ticker,qty,price:pr,wallet:p.wallet,portfolio:p.portfolio});
        } else {
          const pos=p.portfolio[ticker];
          if (!pos||pos.qty<qty) { send(ws,{type:'trade_error',msg:'Posizione insufficiente'}); break; }
          const pnl=Math.round((pr-pos.avg)*qty);
          p.wallet+=Math.round(pr*qty)-fee;
          pos.qty-=qty; if(pos.qty<=0) delete p.portfolio[ticker];
          p.history.push({side:'sell',ticker,qty,price:pr,pnl,t:Date.now()});
          send(ws,{type:'trade_ok',side:'sell',ticker,qty,price:pr,pnl,wallet:p.wallet,portfolio:p.portfolio});
        }
        const notifySet = p.room ? rooms.get(p.room)?.players : pubSet;
        if (notifySet) broadcast(notifySet,{type:'player_traded',
          player:{id:playerId,name:p.name,avatar:p.avatar},
          trade:{side,ticker,qty,price:prices[ticker]}},playerId);
        break;
      }

      case 'chat_global':
      case 'chat_room': {
        if (!msg.text?.trim()) break;
        const cm = { id:genId(), playerId, name:p.name, avatar:p.avatar,
          text:msg.text.trim().slice(0,120).replace(/[<>]/g,''),
          time:new Date().toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit'}),
          room: msg.type==='chat_room'?p.room:null };
        chatHistory.push(cm); if(chatHistory.length>50) chatHistory.shift();
        if (msg.type==='chat_room' && p.room) {
          broadcast(rooms.get(p.room)?.players||new Set(), {type:'chat',msg:cm});
        } else {
          broadcastAll({type:'chat',msg:cm});
        }
        break;
      }

      case 'leave_room':
        leaveRoom(playerId);
        send(ws,{type:'left_room'});
        break;

      case 'ping':
        send(ws,{type:'pong',ts:Date.now(),onlineCount:players.size});
        break;
    }
  });

  ws.on('close', () => {
    leaveRoom(playerId); pubSet.delete(playerId); players.delete(playerId);
    console.log(`[-] ${player.name} disconnected (total: ${players.size})`);
    broadcastAll({type:'player_left',playerId,onlineCount:players.size});
  });

  ws.on('error', err => console.error('WS error:', err.message));
});

// ── Fine partita ──────────────────────────────────────────
function endMatch(code) {
  const r = rooms.get(code); if (!r||!r.started) return;
  const results = [];
  r.players.forEach(id => {
    const p = players.get(id); if (!p) return;
    const inv=Object.entries(p.portfolio).reduce((a,[k,v])=>a+prices[k]*v.qty,0);
    results.push({id,name:p.name,avatar:p.avatar,total:Math.round(p.wallet+inv),pnl:p.pnl});
  });
  results.sort((a,b)=>b.total-a.total);
  if (results[0]) {
    const w=players.get(results[0].id);
    if (w) { w.wallet+=5000; }
  }
  broadcast(r.players,{type:'match_ended',results,winner:results[0]});
  r.started=false;
  console.log(`[MATCH] Ended room ${code} — winner: ${results[0]?.name}`);
}

// ── REST API ──────────────────────────────────────────────
app.get('/api/status', (req,res) => res.json({
  status:'ok', online:players.size, rooms:rooms.size,
  prices, uptime:Math.round(process.uptime()),
}));
app.get('/api/leaderboard', (req,res) => res.json(leaderboard()));

// ── Start ─────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`💧 AquaTrade Server on port ${PORT}`);
});
