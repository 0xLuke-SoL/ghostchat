// ===== STATE =====
let myCode = null;
let token = null;
let ws = null;

let currentChat = { type: null, id: null }; // { type: 'direct'|'group', id: '02'|groupId }

// DOM
const incomingRequestsEl = document.getElementById('incomingRequests');
const groupInvitesEl = document.getElementById('groupInvites');
const myGroupsEl = document.getElementById('myGroups');
const chatHeaderEl = document.getElementById('chatHeader');
const chatMessagesEl = document.getElementById('chatMessages');
const wsStatusEl = document.getElementById('wsStatus');

const chatInputEl = document.getElementById('chatInput');
const btnSendMsg = document.getElementById('btnSendMsg');

// small toast for status messages
let toastTimeout = null;
function showToast(text) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.style.position = 'fixed';
    el.style.left = '50%';
    el.style.bottom = '18px';
    el.style.transform = 'translateX(-50%)';
    el.style.background = 'rgba(15,20,40,0.96)';
    el.style.border = '1px solid rgba(115,129,190,0.8)';
    el.style.borderRadius = '999px';
    el.style.padding = '6px 14px';
    el.style.fontSize = '12px';
    el.style.color = '#f5f5f7';
    el.style.zIndex = '9999';
    el.style.boxShadow = '0 16px 32px rgba(0,0,0,0.9)';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.opacity = '1';

  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    el.style.opacity = '0';
  }, 2200);
}

// ===== HELPERS STORAGE =====
const STORAGE_KEY = 'ghostchat_auth';

function saveAuth(code, pin, token) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ code, pin, token }));
  } catch {}
}
function loadAuth() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function clearAuth() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

// ===== REGISTRAZIONE =====
document.getElementById('btnRegister').addEventListener('click', async () => {
  const res = await fetch('/api/register', { method: 'POST' });
  const data = await res.json();
  document.getElementById('registerResult').textContent =
    `Your code is ${data.code}, PIN ${data.pin}. Save them – you need both to come back.`;
});

// ===== LOGIN =====
document.getElementById('btnLogin').addEventListener('click', async () => {
  const code = document.getElementById('loginCode').value.trim();
  const pin = document.getElementById('loginPin').value.trim();
  if (!code || !pin) {
    alert('Enter code and PIN');
    return;
  }
  await doLogin(code, pin, true);
});

async function doLogin(code, pin, manual = false) {
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, pin })
    });

    if (!res.ok) {
      if (manual) alert('Invalid code or PIN');
      clearAuth();
      return;
    }

    const data = await res.json();
    token = data.token;
    myCode = code;
    saveAuth(code, pin, token);
    showToast(`Logged in as ${code}`);
    connectWS();
  } catch (e) {
    console.error(e);
    if (manual) alert('Login error');
  }
}

// ===== WEBSOCKET (auto‑reconnect) =====
let reconnectAttempts = 0;
const MAX_RECONNECT = 5;

function connectWS() {
  if (!token) return;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${token}`);

  wsStatusEl.textContent = 'connecting…';

  ws.onopen = () => {
    wsStatusEl.textContent = 'online';
    reconnectAttempts = 0;
    showToast('Connected');
  };

  ws.onclose = () => {
    wsStatusEl.textContent = 'offline';
    if (reconnectAttempts < MAX_RECONNECT && token) {
      reconnectAttempts++;
      const delay = 1000 + reconnectAttempts * 1000;
      showToast('Reconnecting…');
      setTimeout(connectWS, delay);
    } else {
      showToast('Connection lost');
    }
  };

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleWS(msg);
  };
}

// ===== HANDLER MESSAGGI WS =====
function handleWS(msg) {
  if (msg.type === 'hello') {
    // nothing special
  }

  // 1:1
  if (msg.type === 'pair_request') {
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `
      <span>Request from <strong>${msg.from}</strong></span>
      <div>
        <button class="btn small accent btn-accept">Accept</button>
        <button class="btn small" data-type="decline">Decline</button>
      </div>
    `;
    const acceptBtn = item.querySelector('.btn-accept');
    const declineBtn = item.querySelector('[data-type="decline"]');

    acceptBtn.addEventListener('click', () => {
      ws.send(JSON.stringify({ type: 'pair_accept', from: msg.from }));
      item.remove();
      selectDirectChat(msg.from);
    });

    declineBtn.addEventListener('click', () => {
      ws.send(JSON.stringify({ type: 'pair_decline', to: msg.from }));
      item.remove();
    });

    incomingRequestsEl.appendChild(item);
  } else if (msg.type === 'pair_accept') {
    selectDirectChat(msg.from);
  } else if (msg.type === 'pair_decline') {
    alert(`Your request to ${msg.from} was declined`);
  } else if (msg.type === 'direct_msg') {
    addMessageBubble({
      from: msg.from,
      isMe: msg.from === myCode,
      text: msg.text,
      ts: msg.ts
    });
  }

  // GROUPS
  else if (msg.type === 'group_invite') {
    const g = msg.group;
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `
      <span>Invite to <strong>${g.name}</strong></span>
      <div>
        <button class="btn small accent">Join</button>
      </div>
    `;
    item.querySelector('button').addEventListener('click', () => {
      ws.send(JSON.stringify({ type: 'group_accept', groupId: g.id }));
      item.remove();
    });
    groupInvitesEl.appendChild(item);
  } else if (msg.type === 'group_created' || msg.type === 'group_join') {
    renderOrUpdateGroup(msg.group || {
      id: msg.groupId,
      members: msg.members,
      pending: msg.pending
    });
  } else if (msg.type === 'group_msg') {
    addMessageBubble({
      from: msg.from,
      isMe: msg.from === myCode,
      text: msg.text,
      ts: msg.ts
    });
  } else if (msg.type === 'group_closed') {
    const el = document.querySelector(`[data-group-id="${msg.groupId}"]`);
    if (el) {
      const badge = el.querySelector('.badge');
      if (badge) badge.textContent = 'Closed';
    }
    if (currentChat.type === 'group' && currentChat.id === msg.groupId) {
      chatHeaderEl.textContent = 'Group closed';
    }
  }
}

// ===== INVIO RICHIESTE / MESSAGGI =====
document.getElementById('btnPairReq').addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return alert('Not connected');
  const to = document.getElementById('pairTarget').value.trim();
  if (!to) return;
  ws.send(JSON.stringify({ type: 'pair_request', to }));
});

btnSendMsg.addEventListener('click', sendCurrentMessage);
chatInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    sendCurrentMessage();
  }
});

function sendCurrentMessage() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const text = chatInputEl.value.trim();
  if (!text) return;
  chatInputEl.value = '';

  if (currentChat.type === 'direct') {
    ws.send(JSON.stringify({
      type: 'direct_msg',
      to: currentChat.id,
      text
    }));
  } else if (currentChat.type === 'group') {
    ws.send(JSON.stringify({
      type: 'group_msg',
      groupId: currentChat.id,
      text
    }));
  }
}

function selectDirectChat(code) {
  currentChat = { type: 'direct', id: code };
  chatHeaderEl.textContent = `Chat with ${code}`;
  clearMessages();
}

// GROUP CREATE
document.getElementById('btnCreateGroup').addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return alert('Not connected');
  const name = document.getElementById('groupName').value.trim() || '';
  const membersRaw = document.getElementById('groupMembers').value.trim();
  if (!membersRaw) return alert('Enter at least one code');

  const members = membersRaw.split(',').map(s => s.trim()).filter(Boolean);
  ws.send(JSON.stringify({
    type: 'group_create',
    name,
    members
  }));
});

// Render/aggiorna gruppo
function renderOrUpdateGroup(groupLike) {
  const id = groupLike.id || groupLike.groupId;
  if (!id) return;

  let el = document.querySelector(`[data-group-id="${id}"]`);
  if (!el) {
    el = document.createElement('div');
    el.className = 'list-item';
    el.dataset.groupId = id;
    el.innerHTML = `
      <span class="group-label"></span>
      <div>
        <span class="badge">Active</span>
        <button class="btn small accent">Open</button>
      </div>
    `;
    el.querySelector('button').addEventListener('click', () => {
      currentChat = { type: 'group', id };
      chatHeaderEl.textContent = groupLike.name ? groupLike.name : `Group ${id}`;
      clearMessages();
    });
    myGroupsEl.appendChild(el);
  }
  const lbl = el.querySelector('.group-label');
  lbl.textContent = groupLike.name ? `${groupLike.name}` : `Group ${id}`;
}

// Chat bubbles
function addMessageBubble({ from, isMe, text, ts }) {
  const d = new Date(ts || Date.now());
  const time = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

  const el = document.createElement('div');
  el.className = 'msg' + (isMe ? ' me' : '');
  el.innerHTML = `
    <div class="msg-meta">${isMe ? 'You' : from} · ${time}</div>
    <div class="msg-text"></div>
  `;
  el.querySelector('.msg-text').textContent = text;

  chatMessagesEl.appendChild(el);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function clearMessages() {
  chatMessagesEl.innerHTML = '';
}

// ===== AUTO‑LOGIN ALL’APERTURA =====
window.addEventListener('load', async () => {
  const saved = loadAuth();
  if (!saved) return;

  // Pre‑riempi i campi (utile su desktop)
  document.getElementById('loginCode').value = saved.code;
  document.getElementById('loginPin').value = saved.pin;

  // Prova login automatico
  await doLogin(saved.code, saved.pin, false);
});
