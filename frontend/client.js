// ===== STATE =====
let myCode = null;
let token = null;
let ws = null;

// chat correntemente aperta: { type: 'direct'|'group', id: '02'|groupId }
let currentChat = { type: null, id: null };

// mappa delle chat 1:1: code -> { unread: number }
const directChats = new Map();

// memoria messaggi per chat: key = "direct:02" | "group:g_xxx"
const messagesByChat = new Map();

// DOM
const incomingRequestsEl = document.getElementById('incomingRequests');
const groupInvitesEl = document.getElementById('groupInvites');
const myGroupsEl = document.getElementById('myGroups');
const chatHeaderEl = document.getElementById('chatHeader');
const chatMessagesEl = document.getElementById('chatMessages');
const wsStatusEl = document.getElementById('wsStatus');

const chatInputEl = document.getElementById('chatInput');
const btnSendMsg = document.getElementById('btnSendMsg');
const chatListEl = document.getElementById('chatList');

// messaggi vocali
const btnRecordVoice = document.getElementById('btnRecordVoice');
const recordStatusEl = document.getElementById('recordStatus');

let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let recordTimeout = null;

// tema
const themeToggleBtn = document.getElementById('themeToggle');
const themeIconEl = document.getElementById('themeIcon');
const themeLabelEl = document.getElementById('themeLabel');

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
const THEME_KEY = 'ghostchat_theme';

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

function saveTheme(theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {}
}
function loadTheme() {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

// ===== TEMA CHIARO/SCURO =====
function applyTheme(theme) {
  const body = document.body;
  const t = theme === 'light' ? 'light' : 'dark';
  body.setAttribute('data-theme', t);
  if (t === 'light') {
    themeIconEl.textContent = '☀️';
    themeLabelEl.textContent = 'Tema chiaro';
  } else {
    themeIconEl.textContent = '🌙';
    themeLabelEl.textContent = 'Tema scuro';
  }
  saveTheme(t);
}

themeToggleBtn.addEventListener('click', () => {
  const current = document.body.getAttribute('data-theme') || 'dark';
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

// ===== REGISTRAZIONE =====
document.getElementById('btnRegister').addEventListener('click', async () => {
  const res = await fetch('/api/register', { method: 'POST' });
  const data = await res.json();
  const msg = `Your code is ${data.code}, PIN ${data.pin}. Save them – you need both to come back.`;
  document.getElementById('registerResult').textContent = msg;

  // auto-compila login
  const codeInput = document.getElementById('loginCode');
  const pinInput = document.getElementById('loginPin');
  codeInput.value = data.code;
  pinInput.value = data.pin;

  showToast('Codice e PIN compilati nel login');
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

// helper chiave mappa messaggi
function chatKey(type, id) {
  return `${type}:${id}`;
}
function pushMessageToStore(type, id, message) {
  const key = chatKey(type, id);
  const arr = messagesByChat.get(key) || [];
  arr.push(message);
  messagesByChat.set(key, arr);
}

// ===== HANDLER MESSAGGI WS =====
function handleWS(msg) {
  if (msg.type === 'hello') {
    return;
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
      addOrUpdateDirectChat(msg.from);
      selectDirectChat(msg.from);
    });

    declineBtn.addEventListener('click', () => {
      ws.send(JSON.stringify({ type: 'pair_decline', to: msg.from }));
      item.remove();
    });

    incomingRequestsEl.appendChild(item);
  } else if (msg.type === 'pair_accept') {
    addOrUpdateDirectChat(msg.from);
    selectDirectChat(msg.from);
  } else if (msg.type === 'pair_decline') {
    alert(`Your request to ${msg.from} was declined`);
  } else if (msg.type === 'direct_msg') {
    const other = msg.from === myCode ? msg.to : msg.from;
    addOrUpdateDirectChat(other);

    // salva sempre in memoria (solo qui)
    pushMessageToStore('direct', other, {
      kind: 'text',
      from: msg.from,
      isMe: msg.from === myCode,
      text: msg.text,
      ts: msg.ts
    });

    const isCurrent =
      currentChat.type === 'direct' && currentChat.id === other;

    if (!isCurrent) {
      const chatInfo = directChats.get(other) || { unread: 0 };
      chatInfo.unread = (chatInfo.unread || 0) + 1;
      directChats.set(other, chatInfo);
      renderChatList();
      showToast(`Nuovo messaggio da ${other}`);
    } else {
      addMessageBubble({
        from: msg.from,
        isMe: msg.from === myCode,
        text: msg.text,
        ts: msg.ts
      });
    }
  }

  // Vocals 1:1
  else if (msg.type === 'voice_msg') {
    const other = msg.from === myCode ? msg.to : msg.from;
    addOrUpdateDirectChat(other);

    pushMessageToStore('direct', other, {
      kind: 'voice',
      from: msg.from,
      isMe: msg.from === myCode,
      audio: msg.audio,
      ts: msg.ts
    });

    const isCurrent =
      currentChat.type === 'direct' && currentChat.id === other;

    if (!isCurrent) {
      const chatInfo = directChats.get(other) || { unread: 0 };
      chatInfo.unread = (chatInfo.unread || 0) + 1;
      directChats.set(other, chatInfo);
      renderChatList();
      showToast(`Nuovo vocale da ${other}`);
    } else {
      addVoiceMessageBubble({
        from: msg.from,
        isMe: msg.from === myCode,
        audio: msg.audio,
        ts: msg.ts
      });
    }
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
    pushMessageToStore('group', msg.groupId, {
      kind: 'text',
      from: msg.from,
      isMe: msg.from === myCode,
      text: msg.text,
      ts: msg.ts
    });

    if (currentChat.type === 'group' && currentChat.id === msg.groupId) {
      addMessageBubble({
        from: msg.from,
        isMe: msg.from === myCode,
        text: msg.text,
        ts: msg.ts
      });
    }
  } else if (msg.type === 'group_closed') {
    const el = document.querySelector(`[data-group-id="${msg.groupId}"]`);
    if (el) {
      const badge = el.querySelector('.badge');
      if (badge) badge.textContent = 'Closed';
    }
    if (currentChat.type === 'group' && currentChat.id === msg.groupId) {
      chatHeaderEl.querySelector('.chat-header-title').textContent = 'Group closed';
      const sub = chatHeaderEl.querySelector('.chat-header-sub');
      if (sub) sub.textContent = '';
    }
  }
}

// ===== CHAT 1:1 LISTA E INVIO =====
document.getElementById('btnPairReq').addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return alert('Not connected');
  const to = document.getElementById('pairTarget').value.trim();
  if (!to) return;
  ws.send(JSON.stringify({ type: 'pair_request', to }));
  showToast(`Richiesta inviata a ${to}`);
});

btnSendMsg.addEventListener('click', sendCurrentMessage);
chatInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    sendCurrentMessage();
  }
});

// bottone per il vocale
btnRecordVoice.addEventListener('click', toggleVoiceRecording);

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
    // niente push/add locale: si aggiorna quando torna il direct_msg

  } else if (currentChat.type === 'group') {
    ws.send(JSON.stringify({
      type: 'group_msg',
      groupId: currentChat.id,
      text
    }));
    // idem, solo via WS
  }
}

// crea o aggiorna una chat 1:1 in lista
function addOrUpdateDirectChat(code) {
  if (!directChats.has(code)) {
    directChats.set(code, { unread: 0 });
  }
  renderChatList();
}

function renderChatList() {
  chatListEl.innerHTML = '';
  const entries = Array.from(directChats.entries());
  entries.sort((a, b) => a[0].localeCompare(b[0]));

  for (const [code, info] of entries) {
    const item = document.createElement('div');
    item.className = 'chat-list-item';
    if (currentChat.type === 'direct' && currentChat.id === code) {
      item.classList.add('active');
    }
    item.dataset.code = code;

    const left = document.createElement('div');
    left.className = 'chat-list-left';

    const codeSpan = document.createElement('span');
    codeSpan.className = 'chat-code';
    codeSpan.textContent = code;

    left.appendChild(codeSpan);
    item.appendChild(left);

    if (info.unread && info.unread > 0) {
      const dot = document.createElement('div');
      dot.className = 'chat-unread-dot';
      item.appendChild(dot);
    }

    item.addEventListener('click', () => {
      selectDirectChat(code);
    });

    chatListEl.appendChild(item);
  }
}

function renderChatMessagesFromStore() {
  clearMessages();
  if (!currentChat.type || !currentChat.id) return;
  const key = chatKey(currentChat.type, currentChat.id);
  const arr = messagesByChat.get(key) || [];
  for (const m of arr) {
    if (m.kind === 'text') {
      addMessageBubble({
        from: m.from,
        isMe: m.isMe,
        text: m.text,
        ts: m.ts
      });
    } else if (m.kind === 'voice') {
      addVoiceMessageBubble({
        from: m.from,
        isMe: m.isMe,
        audio: m.audio,
        ts: m.ts
      });
    }
  }
}

function selectDirectChat(code) {
  currentChat = { type: 'direct', id: code };
  const info = directChats.get(code) || { unread: 0 };
  info.unread = 0;
  directChats.set(code, info);
  renderChatList();

  const titleEl = chatHeaderEl.querySelector('.chat-header-title');
  const subEl = chatHeaderEl.querySelector('.chat-header-sub');
  titleEl.textContent = `Chat con ${code}`;
  if (subEl) subEl.textContent = 'Messaggi e vocali 1:1';

  renderChatMessagesFromStore();
}

// ===== GRUPPI =====
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
      const titleEl = chatHeaderEl.querySelector('.chat-header-title');
      const subEl = chatHeaderEl.querySelector('.chat-header-sub');
      titleEl.textContent = groupLike.name ? groupLike.name : `Group ${id}`;
      if (subEl) subEl.textContent = 'Chat di gruppo';
      renderChatMessagesFromStore();
    });
    myGroupsEl.appendChild(el);
  }
  const lbl = el.querySelector('.group-label');
  lbl.textContent = groupLike.name ? `${groupLike.name}` : `Group ${id}`;
}

// ===== CHAT BUBBLES =====
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

function addVoiceMessageBubble({ from, isMe, audio, ts }) {
  const d = new Date(ts || Date.now());
  const time = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

  const el = document.createElement('div');
  el.className = 'msg' + (isMe ? ' me' : '');
  el.innerHTML = `
    <div class="msg-meta">${isMe ? 'You' : from} · ${time}</div>
  `;

  const audioEl = document.createElement('audio');
  audioEl.controls = true;
  audioEl.src = audio;

  el.appendChild(audioEl);
  chatMessagesEl.appendChild(el);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function clearMessages() {
  chatMessagesEl.innerHTML = '';
}

// ===== LOGICA MESSAGGI VOCALI =====
async function toggleVoiceRecording() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    alert('Not connected');
    return;
  }
  if (currentChat.type !== 'direct') {
    alert('Select a 1:1 chat to send voice messages');
    return;
  }

  if (!isRecording) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); // [web:195][web:193]
      audioChunks = [];
      mediaRecorder = new MediaRecorder(stream); // [web:202]

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          audioChunks.push(e.data);
        }
      };

      mediaRecorder.onstop = async () => {
        clearTimeout(recordTimeout);
        recordStatusEl.textContent = '';

        if (stream) {
          stream.getTracks().forEach(t => t.stop());
        }

        if (audioChunks.length === 0) {
          resetRecordingState();
          return;
        }

        const blob = new Blob(audioChunks, { type: 'audio/webm;codecs=opus' }); // [web:202]
        const base64 = await blobToBase64(blob);
        const audioDataUrl = `data:audio/webm;codecs=opus;base64,${base64}`;

        // niente push/add locale: lo farà handleWS quando arriva il voice_msg
        sendVoiceMessage(audioDataUrl);
        resetRecordingState();
      };

      mediaRecorder.start();
      isRecording = true;
      btnRecordVoice.textContent = '⏹';
      recordStatusEl.textContent = 'Registrazione... (max 30s)';

      recordTimeout = setTimeout(() => {
        if (mediaRecorder && mediaRecorder.state === 'recording') {
          mediaRecorder.stop();
        }
      }, 30000);
    } catch (err) {
      console.error('getUserMedia error', err);
      recordStatusEl.textContent = 'Microfono non disponibile.';
      resetRecordingState();
    }
  } else {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
    }
  }
}

function resetRecordingState() {
  isRecording = false;
  mediaRecorder = null;
  audioChunks = [];
  btnRecordVoice.textContent = '🎙';
  if (recordTimeout) {
    clearTimeout(recordTimeout);
    recordTimeout = null;
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); // [web:199]
    reader.onloadend = () => {
      const dataUrl = reader.result;
      const base64 = dataUrl.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob); // [web:198]
  });
}

function sendVoiceMessage(audioDataUrl) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (currentChat.type !== 'direct' || !currentChat.id) return;

  ws.send(JSON.stringify({
    type: 'voice_msg',
    to: currentChat.id,
    audio: audioDataUrl
  }));
}

// ===== AUTO‑LOGIN + TEMA ALL’APERTURA =====
window.addEventListener('load', async () => {
  const savedTheme = loadTheme();
  if (savedTheme) {
    applyTheme(savedTheme);
  } else {
    applyTheme('dark');
  }

  const saved = loadAuth();
  if (!saved) return;

  document.getElementById('loginCode').value = saved.code;
  document.getElementById('loginPin').value = saved.pin;

  await doLogin(saved.code, saved.pin, false);
});
