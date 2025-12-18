import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

// === MEMORIA (si azzera a ogni riavvio) ===
let seq = 1;
const users = new Map();   // code -> { pin, token, ws }
const pairs = new Map();   // code -> Set(codes)
const groups = new Map();  // id -> { id, name, creator, members:Set, pending:Set, closed:boolean }

const nextCode = () => (seq < 10 ? `0${seq++}` : String(seq++));
const randPin = () => String(Math.floor(1000 + Math.random() * 9000));
const mkToken = () => crypto.randomBytes(16).toString('hex');

// === EXPRESS + STATIC FRONTEND ===
const app = express();
app.use(express.json());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'frontend');
app.use(express.static(publicDir));

// Registrazione: genera CODE + PIN
app.post('/api/register', (req, res) => {
  const code = nextCode();
  const pin = randPin();
  users.set(code, { pin, token: null, ws: null });
  console.log('REGISTER', code, pin);
  res.json({ code, pin });
});

// Login: verifica CODE + PIN e genera token
app.post('/api/login', (req, res) => {
  const { code, pin } = req.body || {};
  const u = users.get(code);
  if (!u || u.pin !== pin) {
    return res.status(401).json({ error: 'Invalid' });
  }
  u.token = mkToken();
  console.log('LOGIN', code, 'token', u.token);
  res.json({ token: u.token });
});

// === HTTP + WEBSOCKET ===
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function codeFromToken(token) {
  for (const [code, u] of users.entries()) {
    if (u.token === token) return code;
  }
  return null;
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('token');
  const code = codeFromToken(token);

  if (!code) {
    ws.close();
    return;
  }

  const u = users.get(code);
  u.ws = ws;
  console.log('WS CONNECT', code);

  ws.send(JSON.stringify({ type: 'hello', code }));

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    // === CHAT 1:1 ===
    if (msg.type === 'pair_request') {
      const dest = users.get(msg.to);
      dest?.ws?.send(JSON.stringify({ type: 'pair_request', from: code }));

    } else if (msg.type === 'pair_accept') {
      if (!pairs.has(code)) pairs.set(code, new Set());
      if (!pairs.has(msg.from)) pairs.set(msg.from, new Set());
      pairs.get(code).add(msg.from);
      pairs.get(msg.from).add(code);

      users.get(code)?.ws?.send(JSON.stringify({ type: 'pair_accept', from: msg.from }));
      users.get(msg.from)?.ws?.send(JSON.stringify({ type: 'pair_accept', from: code }));

    } else if (msg.type === 'pair_decline') {
      users.get(msg.to)?.ws?.send(JSON.stringify({ type: 'pair_decline', from: code }));

    } else if (msg.type === 'direct_msg') {
      if (!pairs.get(code)?.has(msg.to)) return;
      const payload = {
        type: 'direct_msg',
        from: code,
        to: msg.to,
        text: msg.text,
        ts: Date.now()
      };
      users.get(msg.to)?.ws?.send(JSON.stringify(payload));
      ws.send(JSON.stringify(payload));
    }

    // === GRUPPI ===
    else if (msg.type === 'group_create') {
      const id = 'g_' + crypto.randomBytes(6).toString('hex');
      const membersSet = new Set([code]);            // creatore
      const pendingSet = new Set(msg.members || []); // invitati

      const g = {
        id,
        name: msg.name || `Gruppo di ${code}`,
        creator: code,
        members: membersSet,
        pending: pendingSet,
        closed: false
      };
      groups.set(id, g);

      // invia inviti
      for (const m of pendingSet) {
        users.get(m)?.ws?.send(JSON.stringify({
          type: 'group_invite',
          group: {
            id,
            name: g.name,
            creator: code,
            members: Array.from(membersSet),
            pending: Array.from(pendingSet)
          }
        }));
      }

      // notifica il creatore
      users.get(code)?.ws?.send(JSON.stringify({
        type: 'group_created',
        group: {
          id,
          name: g.name,
          creator: code,
          members: Array.from(membersSet),
          pending: Array.from(pendingSet)
        }
      }));
    }

    else if (msg.type === 'group_accept') {
      const g = groups.get(msg.groupId);
      if (!g || g.closed) return;

      if (g.pending.has(code)) {
        g.pending.delete(code);
        g.members.add(code);
      }

      const payload = {
        type: 'group_join',
        groupId: g.id,
        code,
        members: Array.from(g.members),
        pending: Array.from(g.pending)
      };

      for (const m of g.members) {
        users.get(m)?.ws?.send(JSON.stringify(payload));
      }
    }

    else if (msg.type === 'group_msg') {
      const g = groups.get(msg.groupId);
      if (!g || g.closed) return;
      if (!g.members.has(code)) return;

      const payload = {
        type: 'group_msg',
        groupId: g.id,
        from: code,
        text: msg.text,
        ts: Date.now()
      };

      for (const m of g.members) {
        users.get(m)?.ws?.send(JSON.stringify(payload));
      }
    }

    else if (msg.type === 'group_close') {
      const g = groups.get(msg.groupId);
      if (!g || g.closed) return;
      if (g.creator !== code) return;

      g.closed = true;
      const payload = { type: 'group_closed', groupId: g.id };
      for (const m of g.members) {
        users.get(m)?.ws?.send(JSON.stringify(payload));
      }
    }

    else if (msg.type === 'group_leave') {
      const g = groups.get(msg.groupId);
      if (!g || g.closed) return;

      if (g.members.has(code)) {
        g.members.delete(code);
        const payload = {
          type: 'group_leave',
          groupId: g.id,
          code
        };
        for (const m of g.members) {
          users.get(m)?.ws?.send(JSON.stringify(payload));
        }
      }
    }
  });

  ws.on('close', () => {
    const u2 = users.get(code);
    if (u2) u2.ws = null;
    console.log('WS DISCONNECT', code);
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`GhostChat ONEHOST on :${PORT}`);
});
