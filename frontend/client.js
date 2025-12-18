let myCode = null;
let token = null;
let ws = null;

let currentChat = { type: null, id: null }; // { type: 'direct'|'group', id: '02'|groupId }

const incomingRequestsEl = document.getElementById('incomingRequests');
const groupInvitesEl = document.getElementById('groupInvites');
const myGroupsEl = document.getElementById('myGroups');
const chatHeaderEl = document.getElementById('chatHeader');
const chatMessagesEl = document.getElementById('chatMessages');
const wsStatusEl = document.getElementById('wsStatus');

const chatInputEl = document.getElementById('chatInput');
const btnSendMsg = document.getElementById('btnSendMsg');

// Registrazione
document.getElementById('btnRegister').addEventListener('click', async () => {
  const res = await fetch('/api/register', { method: 'POST' });
  const data = await res.json();
  document.getElementById('registerResult').textContent =
    `Il tuo codice è ${data.code}, PIN ${data.pin}. Salvali!`;
});

// Login
document.getElementById('btnLogin').addEventListener('click', async () => {
  const code = document.getElementById('loginCode').value.trim();
  const pin = document.getElementById('loginPin').value.trim();
  if (!code || !pin) return alert('Inserisci codice e PIN');

  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, pin })
  });

  if (!res.ok) {
    alert('Codice o PIN non validi');
    return;
  }

  const data = await res.json();
  token = data.token;
  myCode = code;
  connectWS();
});

function connectWS() {
  if (!token) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${token}`);

  wsStatusEl.textContent = 'connessione...';

  ws.onopen = () => {
    wsStatusEl.textContent = 'online';
  };

  ws.onclose = () => {
    wsStatusEl.textContent = 'offline';
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

function handleWS(msg) {
  if (msg.type === 'hello') {
    console.log('Logged as', msg.code);
  }

  // === 1:1 ===
  if (msg.type === 'pair_request') {
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `
      <span>Richiesta da <strong>${msg.from}</strong></span>
      <div>
        <button class="btn small accent btn-accept">Accetta</button>
        <button class="btn small" data-type="decline">Rifiuta</button>
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
  }

  else if (msg.type === 'pair_accept') {
    selectDirectChat(msg.from);
  }

  else if (msg.type === 'pair_decline') {
    alert(`La tua richiesta a ${msg.from} è stata rifiutata`);
  }

  else if (msg.type === 'direct_msg') {
    if (currentChat.type !== 'direct' || currentChat.id !== msg.from) {
      // se non è la chat aperta, puoi aggiungere logica di "notifica"
    }
    addMessageBubble({
      from: msg.from,
      isMe: msg.from === myCode,
      text: msg.text,
      ts: msg.ts
    });
  }

  // === GRUPPI ===
  else if (msg.type === 'group_invite') {
    const g = msg.group;
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `
      <span>Invito a <strong>${g.name}</strong> (id ${g.id})</span>
      <div>
        <button class="btn small accent">Entra</button>
      </div>
    `;
    item.querySelector('button').addEventListener('click', () => {
      ws.send(JSON.stringify({ type: 'group_accept', groupId: g.id }));
      item.remove();
    });
    groupInvitesEl.appendChild(item);
  }

  else if (msg.type === 'group_created' || msg.type === 'group_join') {
    renderOrUpdateGroup(msg.group || {
      id: msg.groupId,
      members: msg.members,
      pending: msg.pending
    });
  }

  else if (msg.type === 'group_msg') {
    if (currentChat.type !== 'group' || currentChat.id !== msg.groupId) {
      // eventuale notifica
    }
    addMessageBubble({
      from: msg.from,
      isMe: msg.from === myCode,
      text: msg.text,
      ts: msg.ts
    });
  }

  else if (msg.type === 'group_closed') {
    const el = document.querySelector(`[data-group-id="${msg.groupId}"]`);
    if (el) {
      el.querySelector('.badge').textContent = 'Chiuso';
    }
    if (currentChat.type === 'group' && currentChat.id === msg.groupId) {
      chatHeaderEl.textContent = 'Gruppo chiuso';
    }
  }

  else if (msg.type === 'group_leave') {
    // qui potresti aggiornare UI, per ora solo log
    console.log('group_leave', msg.groupId, msg.code);
  }
}

// Invia richiesta 1:1
document.getElementById('btnPairReq').addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return alert('Non sei connesso');
  const to = document.getElementById('pairTarget').value.trim();
  if (!to) return;
  ws.send(JSON.stringify({ type: 'pair_request', to }));
});

// Invio messaggio corrente (1:1 o gruppo)
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

// Seleziona chat 1:1
function selectDirectChat(code) {
  currentChat = { type: 'direct', id: code };
  chatHeaderEl.textContent = `Chat con ${code}`;
  clearMessages();
}

// Gruppi: creazione
document.getElementById('btnCreateGroup').addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return alert('Non sei connesso');
  const name = document.getElementById('groupName').value.trim() || '';
  const membersRaw = document.getElementById('groupMembers').value.trim();
  if (!membersRaw) return alert('Inserisci almeno un codice');

  const members = membersRaw.split(',').map(s => s.trim()).filter(Boolean);
  ws.send(JSON.stringify({
    type: 'group_create',
    name,
    members
  }));
});

// Render/aggiorna un gruppo nella lista "I miei gruppi"
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
        <span class="badge">Attivo</span>
        <button class="btn small accent">Apri</button>
      </div>
    `;
    el.querySelector('button').addEventListener('click', () => {
      currentChat = { type: 'group', id };
      chatHeaderEl.textContent = `Gruppo ${id}`;
      clearMessages();
    });
    myGroupsEl.appendChild(el);
  }
  const lbl = el.querySelector('.group-label');
  lbl.textContent = groupLike.name ? `${groupLike.name} (${id})` : `Gruppo ${id}`;
}

// Chat bubbles
function addMessageBubble({ from, isMe, text, ts }) {
  const d = new Date(ts || Date.now());
  const time = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

  const el = document.createElement('div');
  el.className = 'msg' + (isMe ? ' me' : '');
  el.innerHTML = `
    <div class="msg-meta">${isMe ? 'Tu' : from} · ${time}</div>
    <div class="msg-text"></div>
  `;
  el.querySelector('.msg-text').textContent = text;

  chatMessagesEl.appendChild(el);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function clearMessages() {
  chatMessagesEl.innerHTML = '';
}
