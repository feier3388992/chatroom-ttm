const API = window.location.origin;
const WS_PROTO = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL = `${WS_PROTO}//${window.location.host}/ws?token=${localStorage.getItem('token')}`;
const token = localStorage.getItem('token');
const username = localStorage.getItem('username');

let lastMsgId = 0;
let isAtBottom = true;
let unreadCount = 0;
let currentRoomId = 0;
let currentRoomName = '大厅';
let currentRoomCreatedBy = null;
let roomsData = {};
let ws = null;
let wsReconnectTimer = null;
let pingInterval = null;
let _quotedMsgId = null;
let currentChatType = 'room';
let currentPrivateFriend = '';
let privateChatsData = {};

// ===== 未读（本地 localStorage） 与 消息总条数（后台数据库） =====
const _QT_UNREAD_KEY = 'qt_unread_ids';   // { "roomId": [msgId, ...] }
let unreadIds = {};
let msgTotals = {};   // { "roomId": 总条数 } —— 打开时从后台初始化，关闭页面时回写

function loadUnreadState() {
    try { unreadIds = JSON.parse(localStorage.getItem(_QT_UNREAD_KEY) || '{}') || {}; } catch(e) { unreadIds = {}; }
}
function saveUnreadState() {
    try { localStorage.setItem(_QT_UNREAD_KEY, JSON.stringify(unreadIds)); } catch(e) {}
}
function getUnreadCount(roomId) {
    const a = unreadIds[String(roomId)];
    return a ? a.length : 0;
}
function getTotalCount(roomId) {
    return msgTotals[String(roomId)] || 0;
}
function isUnreadMsg(roomId, msgId) {
    const a = unreadIds[String(roomId)];
    return !!(a && a.indexOf(msgId) >= 0);
}
function addUnreadMsg(roomId, msgId) {
    const k = String(roomId);
    if (!unreadIds[k]) unreadIds[k] = [];
    if (msgId != null && unreadIds[k].indexOf(msgId) < 0) unreadIds[k].push(msgId);
    saveUnreadState();
}
function bumpTotal(roomId, n) {
    const k = String(roomId);
    msgTotals[k] = (msgTotals[k] || 0) + (n || 1);
}
async function loadMsgTotals() {
    try {
        const r = await fetch(`${API}/api/chat/msg-totals`, {headers: getHeaders()});
        const d = await r.json();
        if (d.code === 200 && d.data) {
            msgTotals = {};
            for (const k in d.data) msgTotals[k] = d.data[k];
        }
    } catch(e) {}
}
function flushMsgTotals() {
    if (!token) return;
    try {
        const blob = new Blob([JSON.stringify({totals: msgTotals})], {type: 'application/json'});
        const ok = navigator.sendBeacon(`${API}/api/chat/msg-totals?token=${encodeURIComponent(token)}`, blob);
        if (!ok) {
            fetch(`${API}/api/chat/msg-totals?token=${encodeURIComponent(token)}`, {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({totals: msgTotals}), keepalive: true
            }).catch(() => {});
        }
    } catch(e) {}
}
function revealMessage(roomId, msgId) {
    const k = String(roomId);
    const a = unreadIds[k];
    if (a) {
        const i = a.indexOf(msgId);
        if (i >= 0) { a.splice(i, 1); if (!a.length) delete unreadIds[k]; saveUnreadState(); }
    }
    document.querySelectorAll(`.msg-item[data-msg-id="${msgId}"] .msg-bubble`).forEach(el => el.classList.remove('blurred'));
    updateUnreadIndicators();
}

// ===== 多聊天视图：主窗口('main') + 独立浮窗('det-<roomId>') =====
const chatContexts = {};
function mainChatCtx() {
    return {
        id: 'main', isMain: true,
        get roomId() { return currentRoomId; },
        get roomName() { return currentRoomName; },
        get chatType() { return currentChatType; },
        get privateFriend() { return currentPrivateFriend; },
        get messagesEl() { return document.getElementById('chatMessages'); },
        get inputEl() { return document.getElementById('msgInput'); },
        get quoteBar() { return document.getElementById('quoteBar'); },
        get quoteBarText() { return document.getElementById('quoteBarText'); },
        get quotedId() { return _quotedMsgId; },
        set quotedId(v) { _quotedMsgId = v; },
        get lastMsgId() { return lastMsgId; },
        set lastMsgId(v) { lastMsgId = v; }
    };
}
function ctxById(id) {
    if (!id || id === 'main') return mainChatCtx();
    return chatContexts[id] || mainChatCtx();
}
function ctxAtBottom(ctx) {
    const el = ctx.messagesEl;
    if (!el) return true;
    if (ctx.isMain) return isAtBottom;
    return (el.scrollHeight - el.scrollTop - el.clientHeight) < 60;
}

function switchSidebarTab(name) {
    const map = { friends: 'panelFriends', rooms: 'panelRooms' };
    for (const k in map) {
        const panel = document.getElementById(map[k]);
        const tab = document.getElementById(k === 'friends' ? 'tabFriends' : 'tabRooms');
        if (panel) panel.style.display = (k === name) ? '' : 'none';
        if (tab) tab.classList.toggle('active', k === name);
    }
}

function updateUnreadIndicators() {
    const seen = new Set();
    let friendsUnread = 0, roomsUnread = 0;
    for (const key in privateChatsData) {
        const rid = privateChatsData[key].room_id;
        friendsUnread += getUnreadCount(rid);
        seen.add(String(rid));
    }
    for (const id in roomsData) {
        if (!seen.has(String(id))) roomsUnread += getUnreadCount(id);
    }
    const total = friendsUnread + roomsUnread;
    const fb = document.getElementById('tabBadgeFriends');
    const rb = document.getElementById('tabBadgeRooms');
    const gb = document.getElementById('unreadBadge');
    if (fb) { fb.textContent = friendsUnread; fb.style.display = friendsUnread > 0 ? '' : 'none'; }
    if (rb) { rb.textContent = roomsUnread; rb.style.display = roomsUnread > 0 ? '' : 'none'; }
    if (gb) {
        gb.textContent = total;
        gb.style.display = total > 0 ? 'inline-block' : 'none';
        gb.title = total > 0 ? `共 ${total} 条未读消息` : '';
    }
    document.title = (total > 0 ? `(${total}) ` : '') + `${currentRoomName} - QuickTalk`;
    renderPrivateChatList();
    renderRooms();
}

// 聊天头部高度 = 文本输入框高度的 80%
function applyHeaderHeight() {
    const header = document.querySelector('.chat-main .chat-header');
    const wrap = document.getElementById('chatInputWrap');
    if (!header || !wrap) return;
    const h = wrap.offsetHeight;
    if (h > 0) header.style.height = Math.round(h * 0.8) + 'px';
}

const EMOJIS = ['😀','😃','😄','😁','😅','😂','🤣','😊','😇','🙂','🙃','😉','😌','😍','🥰','😘','😗','😙','😚','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🥴','😵','🤯','🤠','🥳','😎','🤓','🧐','😕','😟','🙁','😮','😯','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','👋','🤚','🖐','✋','🖖','👌','🤌','🤏','✌','🤞','🤟','🤘','🤙','👈','👉','👆','🖕','👇','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','✍','💅','👂','👃','👣','👀','👁','🧠','🫀','🫁','🗣','👤','👥','💔','❤','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💕','💞','💓','💗','💖','💘','💝','💟','👍','👎','👊','✊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏'];

function isMobile() {
    const ua = navigator.userAgent;
    const uaMobile = /Mobile|Android|iPhone|iPad|iPod/i.test(ua);
    const narrowScreen = window.innerWidth <= 768;
    const hasTouch = 'ontouchstart' in window;
    return uaMobile || (narrowScreen && hasTouch);
}

function getHeaders() {
    return {'Content-Type':'application/json', 'X-Auth-Token': token};
}

function connectWS() {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    try {
        ws = new WebSocket(WS_URL);
    } catch(e) {
        scheduleReconnect();
        return;
    }
    ws.onopen = function() {
        if (pingInterval) clearInterval(pingInterval);
        pingInterval = setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({type: 'ping'}));
        }, 15000);
    };
    ws.onmessage = function(e) {
        try {
            const data = JSON.parse(e.data);
            handleWSMessage(data);
        } catch(_) {}
    };
    ws.onclose = function() {
        if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
        scheduleReconnect();
    };
    ws.onerror = function() {
        ws.close();
    };
}

function scheduleReconnect() {
    if (wsReconnectTimer) return;
    wsReconnectTimer = setTimeout(() => {
        wsReconnectTimer = null;
        connectWS();
    }, 3000);
}

function handleWSMessage(data) {
    switch (data.type) {
        case 'pong':
            break;
        case 'message': {
            const msg = data.data;
            const rid = msg.room_id;
            if (msg.username !== username && msg.content && msg.content.includes('@' + username)) {
                playAtSound();
            }
            if (msg.msg_type !== 'toast') {
                bumpTotal(rid);
                if (msg.username !== username && !isUnreadMsg(rid, msg.id)) {
                    addUnreadMsg(rid, msg.id);
                }
            }
            let shown = false;
            const ctxs = [mainChatCtx()].concat(Object.values(chatContexts));
            for (const c of ctxs) {
                if (c.roomId === rid) {
                    renderMessage(msg, c);
                    c.lastMsgId = msg.id;
                    if (ctxAtBottom(c)) scrollToBottom(c);
                    shown = true;
                }
            }
            if (!shown && msg.username !== username) {
                playAtSound();
                loadPrivateChats();
            }
            updateUnreadIndicators();
            break;
        }
        case 'online':
            renderOnline(data.data);
            break;
        case 'typing':
            if (data.data.room_id === currentRoomId) {
                const el = document.getElementById('typingIndicator');
                const users = data.data.users.filter(u => u !== username);
                if (users.length > 0) {
                    el.textContent = users.join(', ') + ' 正在输入...';
                    el.classList.add('show');
                } else {
                    el.classList.remove('show');
                }
            }
            break;
    }
}

function wsSend(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

let _onlineUsers = [];

function renderOnline(users) {
    _onlineUsers = users;
}

async function _fetchAndRenderAtList() {
    const el = document.getElementById('atPopup');
    if (!el) return;
    try {
        const r = await fetch(`${API}/api/users`, {headers: getHeaders()});
        const d = await r.json();
        if (d.code !== 200 || !d.data || d.data.length === 0) {
            el.innerHTML = '<div style="padding:12px 16px;color:#999;font-size:13px;">暂无用户</div>';
            return;
        }
        el.innerHTML = d.data.map(u => {
            const isS = u.is_super === 1;
            return `<div class="at-popup-item" onclick="insertAtUser('${esc(u.username)}')">
                <span class="at-dot${u.is_online ? ' online' : ''}"></span>
                <span class="at-name">${esc(u.nickname || u.username)}</span>
                ${isS ? '<span class="at-badge">admin</span>' : ''}
            </div>`;
        }).join('');
    } catch(_) {
        el.innerHTML = '<div style="padding:12px 16px;color:#999;font-size:13px;">加载失败</div>';
    }
}

function toggleAtPopup() {
    const popup = document.getElementById('atPopup');
    const btn = document.getElementById('atBtn');
    const isOpen = popup.classList.contains('open');
    if (isOpen) {
        popup.classList.remove('open');
        btn.classList.remove('active');
    } else {
        _fetchAndRenderAtList();
        popup.classList.add('open');
        btn.classList.add('active');
    }
}

function syncChatLayout(ctx) {
    const el = ctx.messagesEl;
    if (!el) return;
    el.classList.toggle('is-priv', ctx.chatType === 'private');
}

async function loadMessages(afterId, ctx) {
    ctx = ctx || mainChatCtx();
    syncChatLayout(ctx);
    try {
        const r = await fetch(`${API}/api/chat/messages?room_id=${ctx.roomId}&after_id=${afterId}`, {headers: getHeaders()});
        const d = await r.json();
        if (d.code === 200 && d.data.length > 0) {
            d.data.forEach(m => renderMessage(m, ctx));
            ctx.lastMsgId = d.data[d.data.length - 1].id;
            if (ctxAtBottom(ctx)) scrollToBottom(ctx);
        }
        updateLoadMoreBtn(ctx);
        updateUnreadIndicators();
    } catch(e) {}
}

async function loadMoreMessages(ctx) {
    ctx = ctx || mainChatCtx();
    const el = ctx.messagesEl;
    const firstMsg = el.querySelector('.msg-item:not(.load-more-row)');
    if (!firstMsg) return;
    const beforeId = parseInt(firstMsg.getAttribute('data-msg-id'));
    if (!beforeId) return;
    try {
        const r = await fetch(`${API}/api/chat/messages?room_id=${ctx.roomId}&before_id=${beforeId}`, {headers: getHeaders()});
        const d = await r.json();
        if (d.code === 200 && d.data.length > 0) {
            const loadBtn = el.querySelector('.load-more-row');
            if (loadBtn) loadBtn.remove();
            const frag = document.createDocumentFragment();
            d.data.forEach(m => frag.appendChild(buildMessageEl(m, ctx)));
            el.insertBefore(frag, el.firstChild);
            updateLoadMoreBtn(ctx);
        } else {
            const loadBtn = el.querySelector('.load-more-row');
            if (loadBtn) loadBtn.textContent = '— 已加载全部消息 —';
        }
    } catch(e) {}
}

function updateLoadMoreBtn(ctx) {
    ctx = ctx || mainChatCtx();
    const el = ctx.messagesEl;
    if (!el) return;
    const old = el.querySelector('.load-more-row');
    if (old) old.remove();
    const first = el.querySelector('.msg-item:not(.load-more-row)');
    if (!first || parseInt(first.getAttribute('data-msg-id')) <= 1) return;
    const row = document.createElement('div');
    row.className = 'msg-item load-more-row';
    row.style.cssText = 'text-align:center;padding:8px 0;';
    const btn = document.createElement('button');
    btn.textContent = '↑ 加载更多历史消息';
    btn.className = 'btn btn-default btn-sm';
    btn.onclick = function() { loadMoreMessages(ctx); };
    row.appendChild(btn);
    el.insertBefore(row, el.firstChild);
}

const USER_COLORS = [
    { bg: '#e6f4ff', text: '#1677ff' },
    { bg: '#fff0f0', text: '#cf1322' },
    { bg: '#f0fff0', text: '#389e0d' },
    { bg: '#fff7e6', text: '#d46b08' },
    { bg: '#f0f0ff', text: '#531dab' },
    { bg: '#fff0f6', text: '#c41d7f' },
    { bg: '#e6fffb', text: '#08979c' },
    { bg: '#f6ffed', text: '#52c41a' },
    { bg: '#fffbe6', text: '#ad8b00' },
    { bg: '#f0f5ff', text: '#1d39c4' },
    { bg: '#fff2e8', text: '#d4380d' },
    { bg: '#e6f7ff', text: '#096dd9' },
    { bg: '#f9f0ff', text: '#722ed1' },
    { bg: '#fcffe6', text: '#7cb305' },
    { bg: '#e6ffee', text: '#237804' },
    { bg: '#fff5f5', text: '#a8071a' },
];

function getUserColor(uname) {
    const map = window._userColorMap || {};
    if (!map[uname]) {
        const idx = Math.abs(hashCode(uname)) % USER_COLORS.length;
        map[uname] = USER_COLORS[idx];
        window._userColorMap = map;
    }
    return map[uname];
}

function hashCode(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) - h) + s.charCodeAt(i);
        h |= 0;
    }
    return h;
}

function buildMessageEl(m, ctx) {
    ctx = ctx || mainChatCtx();
    const div = document.createElement('div');
    const isOwn = m.username === username;
    const isSuper = m.username === 'admin';
    div.className = 'msg-item' + (isOwn ? ' own' : '') + (m.msg_type === 'system' ? ' system' : '');
    div.setAttribute('data-msg-id', m.id);
    div.setAttribute('data-view-id', ctx.id);
    let body = '';
    let isText = false;
    let quoteRefHtml = '';
    let quoteCardHtml = '';
    if (m.msg_type === 'text' || m.msg_type === 'menu') {
        if (m.ref_msg_id && m.ref_msg_id > 0) {
            body = highlightAtMentions(esc(m.content)).replace(/\n/g, '<br>') || '&nbsp;';
            isText = true;
            const preview = esc((m.ref_content || '').substring(0, 80));
            const refUser = esc(m.ref_username || '');
            quoteCardHtml = `<div class="quote-card" onclick="event.stopPropagation();scrollToMessage(${m.ref_msg_id},'${ctx.id}')"><div class="quote-card-user">${refUser}</div><div class="quote-card-content">${preview}</div></div>`;
        } else {
            const qm = m.content.match(/^>>(\d+)\s*/);
            if (qm) {
                const refId = qm[1];
                const rest = m.content.substring(qm[0].length);
                body = highlightAtMentions(esc(rest)).replace(/\n/g, '<br>') || '&nbsp;';
                isText = true;
                const refEl = ctx.messagesEl ? ctx.messagesEl.querySelector(`[data-msg-id="${refId}"]`) : null;
                let preview = `#${refId}`;
                if (refEl) {
                    const bubble = refEl.querySelector('.msg-bubble');
                    if (bubble) {
                        const txt = bubble.textContent.replace(/\s+/g, ' ').trim().substring(0, 40);
                        if (txt) preview += ` ${txt}`;
                    }
                }
                quoteRefHtml = `<div class="quote-ref" onclick="event.stopPropagation();scrollToMessage(${refId},'${ctx.id}')">↩ ${esc(preview)}</div>`;
            } else {
                body = renderQuoteBlocks(esc(m.content), ctx);
                body = highlightAtMentions(body).replace(/\n/g, '<br>');
                isText = true;
            }
        }
    } else if (m.msg_type === 'image') {
        const safeName = esc(m.file_name || 'image').replace(/'/g, "&#39;");
        body = `<img src="${m.file_path}" alt="${esc(m.file_name)}" style="width:80px;height:80px;object-fit:cover" onclick="event.stopPropagation();previewFile(${m.id},'${safeName}','${m.file_path}')">`;
        if (m.ref_msg_id && m.ref_msg_id > 0) {
            const preview = esc((m.ref_content || '').substring(0, 80));
            const refUser = esc(m.ref_username || '');
            quoteCardHtml = `<div class="quote-card" onclick="event.stopPropagation();scrollToMessage(${m.ref_msg_id},'${ctx.id}')"><div class="quote-card-user">${refUser}</div><div class="quote-card-content">${preview}</div></div>`;
        }
    } else if (m.msg_type === 'file') {
        const icon = getFileIcon(m.file_name);
        const typeLabel = getFileTypeLabel(m.file_name);
        const safeName = esc(m.file_name).replace(/'/g, "&#39;");
        body = `<div class="file-card" onclick="event.stopPropagation();previewFile(${m.id},'${safeName}','${m.file_path}')"><div class="file-card-icon">${icon}</div><div class="file-card-info"><div class="file-card-name">${esc(m.file_name)}</div><div class="file-card-meta"><span class="file-card-type">${typeLabel}</span><span class="file-card-size">${formatSize(m.file_size)}</span></div></div><div class="file-card-download" onclick="event.stopPropagation();downloadFile(${m.id},'${safeName}','${m.file_path}',${m.file_size})">下载</div></div>`;
        if (m.ref_msg_id && m.ref_msg_id > 0) {
            const preview = esc((m.ref_content || '').substring(0, 80));
            const refUser = esc(m.ref_username || '');
            quoteCardHtml = `<div class="quote-card" onclick="event.stopPropagation();scrollToMessage(${m.ref_msg_id},'${ctx.id}')"><div class="quote-card-user">${refUser}</div><div class="quote-card-content">${preview}</div></div>`;
        }
    }
    if (m.msg_type === 'system') {
        div.innerHTML = `<div class="msg-bubble">${body}</div>`;
    } else {
        const isSuper = m.username === 'admin';
        // 本条消息自带样式就用它，否则回退到发送者的默认气泡色
        const bubbleStyle = msgStyleCss(
            m.msg_style ? parseMsgStyle(m.msg_style) : null,
            { bg: m.sender_bubble_bg || '', text: m.sender_bubble_text || '' }
        );
        const userStyle = isSuper ? 'color:var(--warning)' : '';
        let bubbleContent = body;
        if (quoteCardHtml) {
            bubbleContent = quoteCardHtml + (isText ? `<div class="msg-content">${body}</div>` : body);
        } else if (isText) {
            bubbleContent = `<div class="msg-content">${body}</div>`;
        }
        if (m.forward_from && m.msg_type !== 'system' && m.msg_type !== 'toast') {
            bubbleContent = `<div class="forward-label">转发自 ${esc(m.forward_from)}</div>` + bubbleContent;
        }
        const displayName = m.nickname || m.username || '';
        const avColor = getUserColor(m.username || displayName);
        const avChar = esc((displayName || '?').trim().charAt(0) || '?');
        div.innerHTML = `<div class="msg-avatar" style="background:${avColor.bg};color:${avColor.text}">${avChar}</div><div class="msg-body"><div class="msg-meta"><span class="msg-user${isSuper?' super':''}" style="${userStyle}">${esc(displayName)}</span><span class="msg-time">${formatTime(m.create_time)}</span></div><div class="msg-bubble"${bubbleStyle ? ` style="${bubbleStyle}"` : ''}>${bubbleContent}</div>${quoteRefHtml}</div>`;
    }
    div.dataset.msgType = m.msg_type || 'text';
    // 文件卡片：可拖到桌面 / 共享文件夹
    if (m.msg_type === 'file') {
        const card = div.querySelector('.file-card');
        if (card) {
            card.draggable = true;
            card.addEventListener('dragstart', function(ev) {
                const payload = { kind: 'msg-file', msgId: m.id, name: m.file_name, path: m.file_path, size: m.file_size };
                _qtDragPayload = payload;
                window._qtDragPayload = payload;
                try { ev.dataTransfer.effectAllowed = 'copy'; ev.dataTransfer.setData('application/x-qt-msgfile', String(m.id)); ev.dataTransfer.setData('text/plain', m.file_name || ''); } catch (_) {}
            });
            card.addEventListener('dragend', function() { _qtDragPayload = null; window._qtDragPayload = null; });
        }
    }
    // 右键菜单：复制 / 引用 / 删除（替代原先气泡上的小按钮）
    if (m.msg_type !== 'system') {
        const canDelete = isOwn || window.isSuper;
        const canQuote = (m.msg_type === 'text' || m.msg_type === 'menu');
        div.addEventListener('contextmenu', function(ev) {
            ev.preventDefault();
            ev.stopPropagation();
            const items = [{ label: '📋 复制', onClick: function() { copyMsgContent(m.id, ctx.id); } }];
            if (canQuote) items.push({ label: '引用', onClick: function() { insertQuote(m.id, ctx.id); } });
            if (m.msg_type === 'file' || m.msg_type === 'image') {
                items.push({ label: '🌐 用浏览器打开', onClick: function() {
                    const p = m.file_path || '';
                    window.open(p.startsWith('http') ? p : API + p, '_blank');
                } });
            }
            const canForward = (m.msg_type !== 'system' && m.msg_type !== 'toast');
            if (canForward) items.push({ label: '↗ 转发', onClick: function() { openForwardModal(m); } });
            if (canDelete) items.push({ label: '删除', danger: true, onClick: function() { deleteMsg(m.id, ctx.id); } });
            showChatMenu(ev.clientX, ev.clientY, items);
        });
    }
    // 未读新消息：气泡模糊，点击后才变清晰（并递减未读数）
    const _blurRoom = (m.room_id != null ? m.room_id : ctx.roomId);
    if (m.msg_type !== 'system' && m.username !== username && isUnreadMsg(_blurRoom, m.id)) {
        const _bubble = div.querySelector('.msg-bubble');
        if (_bubble) {
            _bubble.classList.add('blurred');
            _bubble.title = '点击查看该未读消息';
        }
        div.classList.add('has-unread');
        div.addEventListener('click', function(ev) {
            const b = div.querySelector('.msg-bubble');
            if (b && b.classList.contains('blurred')) {
                ev.stopPropagation();
                ev.preventDefault();
                revealMessage(_blurRoom, m.id);
            }
        }, true);
    }
    // 菜单消息：生成可点击按钮
    if (m.msg_type === 'menu' && m.content) {
        var btns = document.createElement('div');
        btns.className = 'menu-buttons';
        var lines = m.content.split('\n');
        for (var i = 0; i < lines.length; i++) {
            var ln = lines[i].trim();
            var match = ln.match(/^(\d+)\.\s/);
            if (match) {
                var num = match[1];
                var label = ln.replace(/^\d+\.\s*/, '');
                var btn = document.createElement('button');
                btn.className = 'menu-btn';
                btn.textContent = num + '. ' + label;
                btn.onclick = function(n) { return function(e) {
                    e.stopPropagation();
                    wsSend({type:'send', room_id:ctx.roomId, content:n, ref_msg_id:0});
                }; }(num);
                btns.appendChild(btn);
            }
        }
        if (btns.children.length > 0) {
            div.appendChild(btns);
        }
    }
    return div;
}

function renderMessage(m, ctx) {
    ctx = ctx || mainChatCtx();
    // toast 消息：渲染为临时浮动通知，不插入聊天框
    if (m.msg_type === 'toast') {
        showToast(m.content);
        return;
    }

    const el = ctx.messagesEl;
    const div = buildMessageEl(m, ctx);
    const isText = div.dataset.msgType === 'text';
    el.appendChild(div);

    if (m.msg_type !== 'system') {
        const bubble = div.querySelector('.msg-bubble');
        if (bubble) {
            bubble.addEventListener('click', function(e) {
                if (e.target.closest('.msg-delete') || e.target.closest('.file-card')) return;
                if (this._flashTimer) clearTimeout(this._flashTimer);
                const cls = this.classList;
                const isA = cls.contains('flash-a');
                cls.remove('flash-a', 'flash-b');
                void this.offsetWidth;
                cls.add(isA ? 'flash-b' : 'flash-a');
                this._flashTimer = setTimeout(() => {
                    cls.remove('flash-a', 'flash-b');
                }, 5000);
            });
        }
    }

    if (isText && m.msg_type !== 'system') {
        const content = div.querySelector('.msg-content');
        if (content) {
            const lineH = parseFloat(getComputedStyle(content).lineHeight) || 21;
            if (content.scrollHeight > lineH * 7) {
                content.classList.add('collapsed');
                const collapsedH = lineH * 7 + 'px';
                content.style.maxHeight = collapsedH;
                content.style.overflow = 'hidden';
                const btn = document.createElement('button');
                btn.className = 'msg-toggle-btn';
                btn.textContent = '▼';
                btn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    const isCollapsed = content.classList.contains('collapsed');
                    if (isCollapsed) {
                        content.classList.remove('collapsed');
                        content.style.maxHeight = '';
                        content.style.overflow = '';
                        btn.textContent = '▲';
                        setTimeout(() => {
                            content.closest('.msg-item').scrollIntoView({ behavior: 'smooth', block: 'center' });
                        }, 100);
                    } else {
                        content.classList.add('collapsed');
                        content.style.maxHeight = collapsedH;
                        content.style.overflow = 'hidden';
                        btn.textContent = '▼';
                    }
                });
                const meta = div.querySelector('.msg-meta');
                if (meta) meta.appendChild(btn);
            }
        }
    }
}

function sendMessage(ctx) {
    ctx = ctx || mainChatCtx();
    const ta = ctx.inputEl;
    if (!ta) return;
    let text = ta.value.trim();
    if (!text) return;
    const refId = ctx.quotedId || 0;
    if (ctx.quotedId) {
        clearQuote(ctx);
    }
    ta.value = '';
    ta.style.height = 'auto';
    wsSend({type: 'send', room_id: ctx.roomId, content: text, ref_msg_id: refId, style: ctx.isMain ? serializePendingStyle() : ''});
    sendTypingStop();
}

// ─── 传输状态提示条（上传/下载共用） ───
function formatBytes(n) {
    if (n == null || isNaN(n)) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
}

function createTransferBar(title) {
    let container = document.getElementById('transferBarContainer');
    if (!container) {
        container = document.createElement('div');
        container.id = 'transferBarContainer';
        document.body.appendChild(container);
    }
    const el = document.createElement('div');
    el.className = 'transfer-bar';
    el.innerHTML = `
        <div class="transfer-bar-title"></div>
        <div class="transfer-bar-track"><div class="transfer-bar-fill"></div></div>
        <div class="transfer-bar-info"><span class="transfer-bar-text">准备中...</span></div>`;
    el.querySelector('.transfer-bar-title').textContent = title;
    container.appendChild(el);
    const fill = el.querySelector('.transfer-bar-fill');
    const text = el.querySelector('.transfer-bar-text');
    let closed = false;
    const close = (delay) => setTimeout(() => {
        if (closed) return;
        closed = true;
        el.classList.add('transfer-bar-hide');
        setTimeout(() => el.remove(), 300);
    }, delay);
    return {
        update(pct, txt) {
            if (closed) return;
            if (pct >= 0) {
                fill.style.width = Math.min(100, pct) + '%';
                el.classList.remove('transfer-bar-indeterminate');
                text.textContent = pct + '%' + (txt ? '  ' + txt : '');
            } else {
                el.classList.add('transfer-bar-indeterminate');
                text.textContent = txt || '处理中...';
            }
        },
        finish(txt) {
            if (closed) return;
            el.classList.add('transfer-bar-done');
            fill.style.width = '100%';
            text.textContent = txt || '完成';
            close(1500);
        },
        fail(txt) {
            if (closed) return;
            el.classList.add('transfer-bar-fail');
            fill.style.width = '100%';
            text.textContent = txt || '失败';
            close(3000);
        },
        abort() { closed = true; el.remove(); }
    };
}

function downloadWithProgress(url, fileName, authToken) {
    const bar = createTransferBar('下载 ' + fileName);
    bar.update(-1, '准备下载...');
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    if (authToken) xhr.setRequestHeader('X-Auth-Token', authToken);
    xhr.responseType = 'blob';
    xhr.onprogress = (e) => {
        if (e.lengthComputable) {
            const pct = Math.round(e.loaded / e.total * 100);
            bar.update(pct, formatBytes(e.loaded) + ' / ' + formatBytes(e.total));
        } else {
            bar.update(-1, '下载中 ' + formatBytes(e.loaded));
        }
    };
    xhr.onload = () => {
        if (xhr.status !== 200) {
            bar.fail('下载失败 (HTTP ' + xhr.status + ')');
            return;
        }
        const blob = xhr.response;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        bar.finish('下载完成 ' + formatBytes(blob.size));
    };
    xhr.onerror = () => bar.fail('下载失败，请检查网络');
    xhr.onabort = () => bar.fail('下载已取消');
    xhr.send();
}

function uploadFile(file) {
    if (!file) return Promise.resolve();
    if (!ALLOWED_EXT.has(getExt(file.name))) {
        file = new File([file], file.name + '.zip', {type: file.type});
    }
    const maxMb = window._fileTypeConfig && window._fileTypeConfig.max_file_size_mb;
    if (maxMb && file.size > maxMb * 1024 * 1024) {
        showToast('文件过大，最大允许 ' + maxMb + 'MB');
        return Promise.resolve();
    }
    const bar = createTransferBar('上传 ' + file.name);
    bar.update(0, formatBytes(0) + ' / ' + formatBytes(file.size));
    return new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${API}/api/chat/upload`);
        xhr.setRequestHeader('X-Auth-Token', token);
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
                const pct = Math.round(e.loaded / e.total * 100);
                bar.update(pct, formatBytes(e.loaded) + ' / ' + formatBytes(e.total));
            } else {
                bar.update(-1, '上传中 ' + formatBytes(e.loaded));
            }
        };
        xhr.onload = () => {
            let d = {};
            try { d = JSON.parse(xhr.responseText); } catch (_) {}
            if (d.code === 200) {
                bar.finish('上传完成 ' + formatBytes(file.size));
                loadMessages(lastMsgId);
            } else {
                bar.fail('上传失败: ' + (d.msg || ''));
                showToast('上传失败: ' + (d.msg || ''));
            }
            resolve();
        };
        xhr.onerror = () => {
            bar.fail('上传失败，请检查网络');
            showToast('上传失败，请检查网络');
            resolve();
        };
        xhr.onabort = () => { bar.fail('上传已取消'); resolve(); };
        const fd = new FormData();
        fd.append('file', file);
        fd.append('room_id', currentRoomId);
        xhr.send(fd);
    });
}

async function clearMessages() {
    if (!window.isSuper) return;
    if (!confirm(`确认清除当前房间「${currentRoomName}」的所有消息？此操作不可恢复！`)) return;
    try {
        const r = await fetch(`${API}/api/admin/messages?room_id=${currentRoomId}`, {
            method:'DELETE', headers:getHeaders()
        });
        const d = await r.json();
        if (d.code === 200) {
            document.getElementById('chatMessages').innerHTML = '';
            lastMsgId = 0;
        } else {
            alert(d.msg);
        }
    } catch(e) {}
}

async function deleteMsg(id, vid) {
    if (!confirm('Delete this message?')) return;
    try {
        await fetch(`${API}/api/chat/messages/${id}`, {
            method:'DELETE', headers:getHeaders()
        });
        document.querySelectorAll(`.msg-item[data-msg-id="${id}"]`).forEach(el => el.remove());
    } catch(e) {}
}

function insertAtUser(uname) {
    const ta = document.getElementById('msgInput');
    ta.value += '@' + uname + ' ';
    ta.focus();
    document.getElementById('atPopup').classList.remove('open');
    document.getElementById('atBtn').classList.remove('active');
}

async function loadRooms() {
    try {
        const r = await fetch(`${API}/api/rooms`, {headers:getHeaders()});
        const d = await r.json();
        if (d.code === 200) {
            roomsData = {};
            d.data.forEach(room => { roomsData[room.id] = room; });
            updateDeleteBtn();
            updateUnreadIndicators();
        }
    } catch(e) {}
}

function renderRooms() {
    const el = document.getElementById('roomList');
    if (!el) return;
    el.innerHTML = Object.values(roomsData).map(room => {
        const active = room.id === currentRoomId ? ' room-active' : '';
        const icon = room.has_password ? '🔒' : (room.is_public ? '🌐' : '🔒');
        const total = getTotalCount(room.id);
        const unread = getUnreadCount(room.id);
        const unreadHtml = unread > 0 ? `<span class="unread-badge">${unread}</span>` : '';
        return `<div class="room-item${active}${unread > 0 ? ' has-unread' : ''}" data-room-id="${room.id}" data-name="${esc(room.name)}" draggable="true" onclick="onRoomClick(${room.id})">
            <span class="room-icon">${icon}</span>
            <span class="room-name">${esc(room.name)}</span>
            <span class="msg-total">${total}</span>
            ${unreadHtml}
        </div>`;
    }).join('');
}

async function loadPrivateChats() {
    try {
        const r = await fetch(`${API}/api/chat/private-chats`, {headers: getHeaders()});
        const d = await r.json();
        if (d.code === 200) {
            const oldData = {...privateChatsData};
            privateChatsData = {};
            d.data.forEach(c => {
                if (oldData[c.room_id] && oldData[c.room_id].unread > 0 && !(currentChatType === 'private' && currentRoomId === c.room_id)) {
                    c.unread = oldData[c.room_id].unread;
                }
                privateChatsData[c.room_id] = c;
            });
            updateUnreadIndicators();
        }
    } catch(e) {}
}

function renderPrivateChatList() {
    const el = document.getElementById('privateChatList');
    if (!el) return;
    const chats = Object.values(privateChatsData);
    if (chats.length === 0) {
        el.innerHTML = '<div style="padding:8px 16px;font-size:12px;color:#999;">暂无私聊</div>';
        return;
    }
    el.innerHTML = chats.map(c => {
        const active = (currentChatType === 'private' && currentPrivateFriend === c.friend) ? ' room-active' : '';
        const icon = c.is_online ? '🟢' : '⚪';
        const nickname = c.nickname || c.friend;
        const total = getTotalCount(c.room_id);
        const unread = getUnreadCount(c.room_id);
        const unreadHtml = unread > 0 ? `<span class="unread-badge">${unread}</span>` : '';
        return `<div class="room-item friend-item${active}${unread > 0 ? ' has-unread' : ''}" data-room-id="${c.room_id}" data-friend="${esc(c.friend)}" data-name="${esc(nickname)}" draggable="true" onclick="openPrivateChat('${esc(c.friend)}')">
            <span class="room-icon">${icon}</span>
            <span class="room-name">${esc(nickname)}</span>
            <span class="msg-total">${total}</span>
            ${unreadHtml}
        </div>`;
    }).join('');
}

async function openPrivateChat(friendName) {
    let chat = null;
    for (const key in privateChatsData) {
        if (privateChatsData[key].friend === friendName) {
            chat = privateChatsData[key];
            break;
        }
    }
    if (!chat) return;
    currentChatType = 'private';
    currentPrivateFriend = friendName;
    currentRoomId = chat.room_id;
    currentRoomName = chat.nickname || friendName;
    document.getElementById('currentRoomTitle').textContent = chat.nickname || friendName;
    document.getElementById('chatMessages').innerHTML = '';
    lastMsgId = 0;
    chat.unread = 0;
    loadMessages(0);
    fetch(`${API}/api/chat/read`, {method:'POST',headers:{...getHeaders(),'Content-Type':'application/json'},body:JSON.stringify({room_id:chat.room_id})}).catch(()=>{});
    updateDeleteBtn();
    if (isMobile()) toggleSidebar();
}

function showAddFriendModal() {
    document.getElementById('addFriendModal').classList.add('open');
    loadAddFriendList();
}

function hideAddFriendModal() {
    document.getElementById('addFriendModal').classList.remove('open');
}

async function loadAddFriendList() {
    try {
        const r = await fetch(`${API}/api/users`, {headers: getHeaders()});
        const d = await r.json();
        if (d.code !== 200) return;
        const existingFriends = new Set();
        for (const key in privateChatsData) {
            existingFriends.add(privateChatsData[key].friend);
        }
        const users = d.data.filter(u => !existingFriends.has(u.username));
        const el = document.getElementById('addFriendList');
        if (users.length === 0) {
            el.innerHTML = '<div style="padding:12px;color:#999;text-align:center;">已添加所有用户</div>';
            return;
        }
        el.innerHTML = users.map(u => {
            const statusIcon = u.is_online ? '🟢' : '⚪';
            const superBadge = u.is_super ? ' <span style="font-size:10px;background:#fff7e6;color:#d46b08;padding:0 4px;border-radius:3px;">admin</span>' : '';
            return `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid #f0f0f0;">
                <span>${statusIcon} ${esc(u.nickname)}${superBadge}</span>
                <button class="btn btn-primary btn-sm" onclick="addFriend('${esc(u.username)}')">添加</button>
            </div>`;
        }).join('');
    } catch(e) {}
}

async function addFriend(friendName) {
    try {
        const r = await fetch(`${API}/api/chat/private-chats`, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({username: friendName})
        });
        const d = await r.json();
        if (d.code === 200) {
            await loadPrivateChats();
            openPrivateChat(friendName);
            hideAddFriendModal();
        } else {
            alert(d.msg);
        }
    } catch(e) {
        alert('添加失败');
    }
}

async function deleteFriend(friendName) {
    if (!confirm(`确定删除好友 ${friendName}？\n将会删除所有聊天记录。`)) return;
    try {
        const r = await fetch(`${API}/api/chat/private-chats/${encodeURIComponent(friendName)}`, {
            method: 'DELETE',
            headers: getHeaders()
        });
        const d = await r.json();
        if (d.code === 200) {
            closeDetachedByFriend(friendName);
            if (currentChatType === 'private' && currentPrivateFriend === friendName) {
                currentChatType = 'room';
                currentPrivateFriend = '';
                currentRoomId = 0;
                currentRoomName = '大厅';
                document.getElementById('currentRoomTitle').textContent = '# 大厅';
                document.getElementById('chatMessages').innerHTML = '';
                lastMsgId = 0;
                loadMessages(0);
            }
            loadPrivateChats();
        } else {
            alert(d.msg);
        }
    } catch(e) {
        alert('删除失败');
    }
}

function onRoomClick(roomId) {
    const room = roomsData[roomId];
    if (!room) return;
    if (room.is_member) {
        switchRoom(roomId, room.name);
        return;
    }
    if (room.has_password) {
        showJoinPasswordModal(roomId);
    } else {
        doJoinRoom(roomId, room.name, '');
    }
}

async function doJoinRoom(roomId, roomName, password) {
    try {
        const r = await fetch(`${API}/api/rooms/${roomId}/join`, {
            method:'POST', headers:getHeaders(),
            body: JSON.stringify({password: password || ''})
        });
        const d = await r.json();
        if (d.code === 200) {
            switchRoom(roomId, roomName);
            loadRooms();
        } else {
            alert(d.msg);
        }
    } catch(e) {
        alert('加入房间失败');
    }
}

function showJoinPasswordModal(roomId) {
    document.getElementById('joinRoomId').value = roomId;
    document.getElementById('joinRoomTitle').textContent = '请输入房间「' + (roomsData[roomId]?.name || '') + '」的密码';
    document.getElementById('joinPasswordInput').value = '';
    document.getElementById('joinPasswordModal').classList.add('open');
    setTimeout(() => document.getElementById('joinPasswordInput').focus(), 100);
}

function hideJoinPasswordModal() {
    document.getElementById('joinPasswordModal').classList.remove('open');
}

function submitJoinPassword() {
    const roomId = parseInt(document.getElementById('joinRoomId').value);
    const password = document.getElementById('joinPasswordInput').value;
    const room = roomsData[roomId];
    if (!room) return;
    doJoinPassword(roomId, room.name, password);
}

async function doJoinPassword(roomId, roomName, password) {
    try {
        const r = await fetch(`${API}/api/rooms/${roomId}/join`, {
            method:'POST', headers:getHeaders(),
            body: JSON.stringify({password: password || ''})
        });
        const d = await r.json();
        if (d.code === 200) {
            hideJoinPasswordModal();
            switchRoom(roomId, roomName);
            loadRooms();
        } else {
            alert(d.msg);
        }
    } catch(e) {
        alert('加入房间失败');
    }
}

function showInviteModal() {
    document.getElementById('inviteUsername').value = '';
    document.getElementById('inviteModal').classList.add('open');
    setTimeout(() => document.getElementById('inviteUsername').focus(), 100);
}

function hideInviteModal() {
    document.getElementById('inviteModal').classList.remove('open');
}

let _forwardMsg = null;
let _forwardTargets = [];

function _fwFreqKey() { return 'qt_forward_freq_' + (username || 'anon'); }
function _fwLoadFreq() {
    try { return JSON.parse(localStorage.getItem(_fwFreqKey())) || {}; } catch(e) { return {}; }
}
function _fwBumpFreq(ids) {
    const f = _fwLoadFreq();
    ids.forEach(id => { f[id] = (f[id] || 0) + 1; });
    try { localStorage.setItem(_fwFreqKey(), JSON.stringify(f)); } catch(e) {}
}
function _fwShortName(name) { return (name || '').replace(/^群聊 · /, '').replace(/^好友 · /, ''); }

function _fwSelectedIds() {
    return Array.from(document.querySelectorAll('#forwardTargetList input[type=checkbox]:checked'))
        .map(cb => parseInt(cb.value, 10));
}
function _fwUpdateConfirm() {
    const btn = document.getElementById('forwardConfirmBtn');
    if (!btn) return;
    const n = _fwSelectedIds().length;
    btn.textContent = n ? ('转发 (' + n + ')') : '转发';
}
function _fwSyncChips() {
    const sel = new Set(_fwSelectedIds());
    document.querySelectorAll('#forwardRecent .fw-chip').forEach(ch => {
        ch.classList.toggle('active', sel.has(parseInt(ch.dataset.rid, 10)));
    });
}
function _fwToggleChip(el) {
    const rid = parseInt(el.dataset.rid, 10);
    const cb = document.querySelector('#forwardTargetList input[type=checkbox][value="' + rid + '"]');
    if (!cb) return;
    cb.checked = !cb.checked;
    _fwSyncChips();
    _fwUpdateConfirm();
}
function _fwRenderRecent() {
    const box = document.getElementById('forwardRecent');
    if (!box) return;
    const freq = _fwLoadFreq();
    const map = {};
    _forwardTargets.forEach(t => { map[t.room_id] = t; });
    const items = Object.keys(freq).map(k => parseInt(k, 10))
        .filter(id => map[id] && id !== currentRoomId)
        .sort((a, b) => freq[b] - freq[a])
        .slice(0, 8);
    if (!items.length) { box.innerHTML = ''; box.style.display = 'none'; return; }
    box.style.display = '';
    box.innerHTML = '<span class="fw-recent-label">常用</span>' + items.map(id => {
        const t = map[id];
        const icon = t.type === 'room' ? '🏠' : '👤';
        return `<span class="fw-chip" data-rid="${id}" onclick="_fwToggleChip(this)" title="${esc(t.name)}"><span class="fw-chip-ico">${icon}</span><span class="fw-chip-text">${esc(_fwShortName(t.name))}</span></span>`;
    }).join('');
}

function openForwardModal(m) {
    _forwardMsg = m;
    const h = document.querySelector('#forwardModal h3');
    if (h) h.textContent = (m && m.msg_type === 'file') ? '转发文件' : (m && m.msg_type === 'image' ? '转发图片' : '转发消息');
    const list = document.getElementById('forwardTargetList');
    list.innerHTML = '';
    _forwardTargets = [];
    Object.values(roomsData).forEach(r => _forwardTargets.push({
        room_id: r.id,
        name: '群聊 · ' + (r.name || ('#' + r.id)),
        type: 'room',
        key: ((r.name || '') + ' ' + r.id).toLowerCase()
    }));
    Object.values(privateChatsData).forEach(c => _forwardTargets.push({
        room_id: c.room_id,
        name: '好友 · ' + (c.nickname || c.friend || c.room_id),
        type: 'private',
        key: ((c.nickname || '') + ' ' + (c.friend || '')).toLowerCase()
    }));
    const addSection = (title, items) => {
        if (!items.length) return;
        const sec = document.createElement('div');
        sec.className = 'forward-section';
        const hh = document.createElement('div');
        hh.className = 'forward-section-title';
        hh.textContent = title;
        sec.appendChild(hh);
        items.forEach(it => {
            const row = document.createElement('label');
            row.className = 'forward-item';
            row.dataset.rid = it.room_id;
            row.dataset.search = it.key;
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.value = it.room_id;
            cb.addEventListener('change', function() { _fwSyncChips(); _fwUpdateConfirm(); });
            const name = document.createElement('span');
            name.className = 'forward-name';
            name.textContent = it.name + (it.room_id === currentRoomId ? '（当前）' : '');
            row.appendChild(cb);
            row.appendChild(name);
            sec.appendChild(row);
        });
        list.appendChild(sec);
    };
    addSection('群聊 / 房间', _forwardTargets.filter(t => t.type === 'room'));
    addSection('好友私聊', _forwardTargets.filter(t => t.type === 'private'));
    if (!list.children.length) {
        list.innerHTML = '<div class="fw-empty">暂无可转发目标</div>';
    }
    const s = document.getElementById('forwardSearch');
    if (s) s.value = '';
    _fwRenderRecent();
    _fwUpdateConfirm();
    document.getElementById('forwardModal').classList.add('open');
    if (s && list.children.length) setTimeout(() => s.focus(), 50);
}

function filterForwardTargets() {
    const q = (document.getElementById('forwardSearch').value || '').trim().toLowerCase();
    document.querySelectorAll('#forwardTargetList .forward-section').forEach(sec => {
        let visible = 0;
        sec.querySelectorAll('.forward-item').forEach(row => {
            const hit = !q || (row.dataset.search || '').includes(q);
            row.style.display = hit ? '' : 'none';
            if (hit) visible++;
        });
        sec.style.display = visible ? '' : 'none';
    });
}

function hideForwardModal() {
    document.getElementById('forwardModal').classList.remove('open');
    _forwardMsg = null;
}

async function submitForward() {
    if (!_forwardMsg) return;
    const ids = _fwSelectedIds();
    if (!ids.length) { alert('请选择至少一个转发目标'); return; }
    const btn = document.getElementById('forwardConfirmBtn');
    btn.disabled = true;
    btn.textContent = '转发中...';
    try {
        const r = await fetch(`${API}/api/chat/forward`, {
            method: 'POST', headers: getHeaders(),
            body: JSON.stringify({ msg_id: _forwardMsg.id, room_ids: ids })
        });
        const d = await r.json();
        if (d.code === 200) {
            _fwBumpFreq(ids);
            showToast(d.msg || '转发成功');
            hideForwardModal();
        } else {
            alert('转发失败: ' + (d.msg || ''));
        }
    } catch (e) {
        alert('转发失败，请检查网络');
    } finally {
        btn.disabled = false;
        _fwUpdateConfirm();
    }
}

async function submitInvite() {
    const username = document.getElementById('inviteUsername').value.trim();
    if (!username) { alert('请输入用户名'); return; }
    const r = await fetch(`${API}/api/rooms/${currentRoomId}/invite`, {
        method:'POST', headers:getHeaders(),
        body: JSON.stringify({username})
    });
    const d = await r.json();
    if (d.code === 200) {
        alert(d.msg);
        hideInviteModal();
        loadRooms();
    } else {
        alert(d.msg);
    }
}

function switchRoom(roomId, roomName) {
    if (roomId === currentRoomId && currentChatType === 'room') return;
    currentChatType = 'room';
    currentPrivateFriend = '';
    currentRoomId = roomId;
    currentRoomName = roomName;
    currentRoomCreatedBy = (roomsData[roomId] || {}).created_by || null;
    document.getElementById('currentRoomTitle').textContent = '# ' + roomName;
    document.getElementById('chatMessages').innerHTML = '';
    lastMsgId = 0;
    loadMessages(0);
    markRead();
    loadRooms();
    loadPrivateChats();
    updateDeleteBtn();
    if (isMobile()) toggleSidebar();
}

function showCreateRoom() {
    document.getElementById('createRoomModal').classList.add('open');
}

function hideCreateRoom() {
    document.getElementById('createRoomModal').classList.remove('open');
}

async function createRoom() {
    const name = document.getElementById('newRoomName').value.trim();
    const desc = document.getElementById('newRoomDesc').value.trim();
    const isPublic = document.getElementById('newRoomPublic').checked ? 1 : 0;
    const pwd = document.getElementById('newRoomPwd').value;
    if (!name) { alert('请输入房间名称'); return; }
    const r = await fetch(`${API}/api/rooms`, {
        method:'POST', headers:getHeaders(),
        body:JSON.stringify({name, description: desc, is_public: isPublic, password: pwd})
    });
    const d = await r.json();
    if (d.code === 200) {
        hideCreateRoom();
        document.getElementById('newRoomName').value = '';
        document.getElementById('newRoomDesc').value = '';
        document.getElementById('newRoomPwd').value = '';
        switchRoom(d.data.id, d.data.name);
        loadRooms();
    } else {
        alert(d.msg);
    }
}

function updateDeleteBtn() {
    const btn = document.getElementById('deleteRoomBtn');
    const inviteBtn = document.getElementById('inviteBtn');
    const leaveBtn = document.getElementById('leaveRoomBtn');
    if (leaveBtn) {
        // 大厅(0) 和 私聊 不需要“离开房间”按钮，仅普通房间显示
        const showLeave = currentRoomId !== 0 && currentChatType === 'room';
        leaveBtn.style.display = showLeave ? '' : 'none';
    }
    if (!btn) return;
    if (currentRoomId === 0 || currentChatType !== 'room' || currentRoomCreatedBy !== username) {
        btn.style.display = 'none';
        if (inviteBtn) inviteBtn.style.display = 'none';
    } else {
        btn.style.display = '';
        if (inviteBtn) inviteBtn.style.display = '';
    }
}

async function leaveRoom() {
    if (currentRoomId === 0) { alert('不能离开大厅'); return; }
    if (!confirm(`离开房间 ${currentRoomName}？`)) return;
    await fetch(`${API}/api/rooms/${currentRoomId}/leave`, {
        method:'POST', headers:getHeaders()
    });
    switchRoom(0, '大厅');
    loadRooms();
}

async function deleteCurrentRoom() {
    if (currentRoomId === 0) { alert('不能删除大厅'); return; }
    if (!confirm(`确认删除房间 ${currentRoomName}？此操作不可恢复！`)) return;
    const r = await fetch(`${API}/api/rooms/${currentRoomId}`, {
        method:'DELETE', headers:getHeaders()
    });
    const d = await r.json();
    if (d.code === 200) {
        switchRoom(0, '大厅');
        loadRooms();
    } else {
        alert(d.msg);
    }
}

function markRead() {
    wsSend({type: 'mark_read', room_id: currentRoomId});
    updateUnreadIndicators();
}

function scrollToBottom(ctx) {
    ctx = ctx || mainChatCtx();
    const el = ctx.messagesEl;
    if (el) el.scrollTop = el.scrollHeight;
}

function toggleSidebar() {
    document.getElementById('chatSidebar').classList.toggle('open');
    document.getElementById('sidebarOverlay').classList.toggle('open');
}

/* ===== 左右两盒中间分割线：拖拽调整宽度 + 记忆（按用户，localStorage） ===== */
const SIDEBAR_MIN_W = 140;
const SIDEBAR_MAX_RESERVE = 320;   // 右侧聊天区至少保留的宽度
function sidebarWidthKey() { return 'qt_sidebar_w_' + (username || 'me'); }
function applySidebarWidth() {
    const sb = document.getElementById('chatSidebar');
    if (!sb) return;
    if (window.innerWidth <= 768) { sb.style.width = ''; return; }
    const saved = parseInt(localStorage.getItem(sidebarWidthKey()) || '', 10);
    sb.style.width = saved ? saved + 'px' : '';
}
function initSidebarSplitter() {
    const sp = document.getElementById('chatSplitter');
    const sb = document.getElementById('chatSidebar');
    const layout = document.querySelector('.chat-layout');
    if (!sp || !sb || sp._init) return;
    sp._init = true;
    sp.addEventListener('pointerdown', function (e) {
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        const startX = e.clientX;
        const startW = sb.getBoundingClientRect().width;
        const layoutW = layout ? layout.clientWidth : window.innerWidth;
        const max = Math.max(SIDEBAR_MIN_W, layoutW - SIDEBAR_MAX_RESERVE);
        document.body.classList.add('qt-col-resizing');
        sp.classList.add('rz-active');
        function onMove(ev) {
            const w = Math.min(Math.max(startW + ev.clientX - startX, SIDEBAR_MIN_W), max);
            sb.style.width = Math.round(w) + 'px';
        }
        function onUp() {
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            document.removeEventListener('pointercancel', onUp);
            document.body.classList.remove('qt-col-resizing');
            sp.classList.remove('rz-active');
            try { localStorage.setItem(sidebarWidthKey(), String(Math.round(sb.getBoundingClientRect().width))); } catch (_) {}
        }
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        document.addEventListener('pointercancel', onUp);
    });
    sp.addEventListener('dblclick', function (e) {
        e.preventDefault();
        sb.style.width = '';
        try { localStorage.removeItem(sidebarWidthKey()); } catch (_) {}
    });
}
document.addEventListener('DOMContentLoaded', function () {
    applySidebarWidth();
    initSidebarSplitter();
});

function renderQuoteBlocks(text, ctx) {
    ctx = ctx || mainChatCtx();
    return text.replace(/(^|[\s\n])>>(\d+)/g, (match, prefix, id) => {
        const refEl = ctx.messagesEl ? ctx.messagesEl.querySelector(`[data-msg-id="${id}"]`) : null;
        let preview = `#${id}`;
        if (refEl) {
            const bubble = refEl.querySelector('.msg-bubble');
            if (bubble) {
                const txt = bubble.textContent.replace(/\s+/g, ' ').trim().substring(0, 40);
                if (txt) preview += ` ${txt}`;
            }
        }
        return `${prefix}<span class="quote-block" data-ref-id="${id}" onclick="event.stopPropagation();scrollToMessage(${id},'${ctx.id}')">↩ ${esc(preview)}</span>`;
    });
}

function insertQuote(msgId, vid) {
    const ctx = ctxById(vid);
    ctx.quotedId = msgId;
    const refEl = ctx.messagesEl ? ctx.messagesEl.querySelector(`[data-msg-id="${msgId}"]`) : null;
    let preview = `#${msgId}`;
    if (refEl) {
        const bubble = refEl.querySelector('.msg-bubble');
        if (bubble) {
            const txt = bubble.textContent.replace(/\s+/g, ' ').trim().substring(0, 50);
            if (txt) preview += ` ${txt}`;
        }
    }
    const bar = ctx.quoteBar;
    const text = ctx.quoteBarText;
    if (bar && text) {
        text.innerHTML = `引用 ${esc(preview)}`;
        bar.style.display = 'flex';
    }
    if (ctx.inputEl) ctx.inputEl.focus();
}

function clearQuote(vid) {
    const ctx = ctxById(vid);
    ctx.quotedId = null;
    const bar = ctx.quoteBar;
    if (bar) bar.style.display = 'none';
}

function scrollToMessage(msgId, vid) {
    const ctx = ctxById(vid);
    const scope = ctx.messagesEl || document;
    const el = scope.querySelector(`[data-msg-id="${msgId}"]`);
    if (!el) return;
    el.scrollIntoView({behavior: 'smooth', block: 'center'});
    const bubble = el.querySelector('.msg-bubble');
    if (bubble) {
        if (bubble._flashTimer) clearTimeout(bubble._flashTimer);
        const cls = bubble.classList;
        const isA = cls.contains('flash-a');
        cls.remove('flash-a', 'flash-b');
        void bubble.offsetWidth;
        cls.add(isA ? 'flash-b' : 'flash-a');
        bubble._flashTimer = setTimeout(() => {
            cls.remove('flash-a', 'flash-b');
        }, 5000);
    }
}

/* ---- Copy message ---- */
function copyMsgContent(msgId, vid) {
    const ctx = ctxById(vid);
    const scope = ctx.messagesEl || document;
    const el = scope.querySelector(`[data-msg-id="${msgId}"]`);
    if (!el) return;
    let text = '';
    const content = el.querySelector('.msg-content');
    if (content) {
        text = content.textContent.replace(/\s+/g, ' ').trim();
    } else {
        const bubble = el.querySelector('.msg-bubble');
        if (bubble) {
            text = bubble.textContent.replace(/\s+/g, ' ').trim();
        }
    }
    if (!text) return;
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => {
                showToast('已复制到剪贴板');
            }).catch(() => {
                fallbackCopy(text);
            });
        } else {
            fallbackCopy(text);
        }
    } catch(e) {
        fallbackCopy(text);
    }
}

function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '0';
    ta.style.top = '0';
    ta.style.opacity = '0';
    ta.style.pointerEvents = 'none';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
        document.execCommand('copy');
        showToast('已复制到剪贴板');
    } catch(e) {
        showToast('复制失败，请手动复制');
    }
    document.body.removeChild(ta);
}

let _atAudio = new Audio('/static/wechat_notify.mp3');
_atAudio.volume = 0.7;
let _audioUnlocked = false;

function _unlockAudio() {
    if (_audioUnlocked) return;
    _atAudio.play().then(() => {
        _atAudio.pause();
        _atAudio.currentTime = 0;
        _audioUnlocked = true;
    }).catch(() => {});
}

function playAtSound() {
    if (!_audioUnlocked) return;
    try {
        _atAudio.currentTime = 0;
        _atAudio.play().catch(() => {});
    } catch(e) {}
}

function highlightAtMentions(text) {
    return text.replace(/@(\S+)/g, '<span class="at-mention">@$1</span>');
}

function esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
}

function formatTime(t) {
    if (!t) return '';
    // 服务端给的是 "YYYY-MM-DD HH:MM:SS"（空格分隔、无时区）。
    // Safari 不认这种格式，直接 new Date() 会得到 Invalid Date（显示成 NaN），
    // 所以先规范成标准 ISO 字符串再解析，Chrome/Safari 结果一致。
    let s = String(t).trim().replace(' ', 'T');
    if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) s += 'Z';
    const d = new Date(s);
    if (isNaN(d.getTime())) return String(t);
    const pad = n => String(n).padStart(2, '0');
    const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    const ds = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    const ts = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return `${ds}-${weekdays[d.getDay()]}-${ts}`;
}

function formatSize(s) {
    if (!s) return '';
    if (s < 1024) return s + 'B';
    if (s < 1024*1024) return (s/1024).toFixed(1) + 'KB';
    return (s/1024/1024).toFixed(1) + 'MB';
}

function getFileIcon(name) {
    return '';
}

function getFileTypeLabel(name) {
    const ext = (name || '').split('.').pop().toUpperCase();
    return ext || 'FILE';
}

function previewImage(src) {
    const el = document.getElementById('previewOverlay');
    el.querySelector('img').src = src;
    el.classList.add('open');
}

function toggleEmoji() {
    const panel = document.getElementById('emojiPanel');
    const btn = document.getElementById('emojiBtn');
    const isOpen = panel.classList.contains('open');
    // 与 @提及弹窗 互斥：开一个关另一个
    const atPopup = document.getElementById('atPopup');
    const atBtn = document.getElementById('atBtn');
    if (isOpen) {
        panel.classList.remove('open');
        btn.classList.remove('active');
    } else {
        atPopup.classList.remove('open');
        atBtn.classList.remove('active');
        panel.classList.add('open');
        btn.classList.add('active');
    }
}

function closeEmojiPanel() {
    const panel = document.getElementById('emojiPanel');
    const btn = document.getElementById('emojiBtn');
    if (panel) panel.classList.remove('open');
    if (btn) btn.classList.remove('active');
}

function toggleAppDrawer() {
    const drawer = document.getElementById('appDrawer');
    const btn = document.getElementById('plusBtn');
    if (!drawer) return;
    const open = drawer.classList.toggle('open');
    if (btn) btn.classList.toggle('active', open);
}

function closeAppDrawer() {
    const drawer = document.getElementById('appDrawer');
    const btn = document.getElementById('plusBtn');
    if (drawer) drawer.classList.remove('open');
    if (btn) btn.classList.remove('active');
}

/* 输入框高度调整：每次点击 +50px，加到 260px 后再点复位（重新从 +50 计） */
let _inputHeightAdd = 0;
let _inputHeightBase = null;
const INPUT_HEIGHT_STEP = 50;
const INPUT_HEIGHT_MAX = 260;
function cycleInputHeight() {
    const wrap = document.getElementById('chatInputWrap');
    const ta = document.getElementById('msgInput');
    if (!wrap) return;
    if (_inputHeightBase == null) _inputHeightBase = wrap.offsetHeight;
    if (_inputHeightAdd >= INPUT_HEIGHT_MAX) {
        _inputHeightAdd = 0;
    } else {
        _inputHeightAdd = Math.min(_inputHeightAdd + INPUT_HEIGHT_STEP, INPUT_HEIGHT_MAX);
    }
    if (_inputHeightAdd === 0) {
        wrap.style.height = '';
        if (ta) ta.style.maxHeight = '';
    } else {
        wrap.style.height = (_inputHeightBase + _inputHeightAdd) + 'px';
        if (ta) ta.style.maxHeight = 'none';
    }
}

const BUBBLE_COLORS = [
    { bg: '#ffffff', text: '#333333' },
    { bg: '#e74c3c', text: '#ffffff' },
    { bg: '#27ae60', text: '#ffffff' },
    { bg: '#2980b9', text: '#ffffff' },
    { bg: '#f39c12', text: '#333333' },
    { bg: '#8e44ad', text: '#ffffff' },
    { bg: '#ecf0f1', text: '#555555' },
    { bg: '#fdedec', text: '#c0392b' },
    { bg: '#d6eaf8', text: '#1a5276' },
    { bg: '#fef9e7', text: '#7d6608' },
];

const TEXT_COLORS = [
    { v: '', c: '#888', t: '默认' },
    { v: '#ffffff', c: '#ffffff', t: '#ffffff' },
    { v: '#1a1a1a', c: '#1a1a1a', t: '#1a1a1a' },
    { v: '#e74c3c', c: '#e74c3c', t: '#e74c3c' },
    { v: '#e67e22', c: '#e67e22', t: '#e67e22' },
    { v: '#f1c40f', c: '#f1c40f', t: '#f1c40f' },
    { v: '#27ae60', c: '#27ae60', t: '#27ae60' },
    { v: '#2980b9', c: '#2980b9', t: '#2980b9' },
    { v: '#8e44ad', c: '#8e44ad', t: '#8e44ad' },
];

const FONT_SIZE_MAP = { s: '0.85em', '': '', l: '1.2em', xl: '1.6em' };
const ALIGN_MAP = { l: 'left', c: 'center', r: 'right' };
const MSG_STYLE_KEY = 'qt_msg_style_v1';

// 待发送的单条消息样式（只影响这一条，不影响历史消息和别人的消息）
let pendingStyle = { bg: '', fg: '', fs: '', b: 0, i: 0, u: 0, al: '' };

function loadPendingStyle() {
    try {
        const raw = localStorage.getItem(MSG_STYLE_KEY);
        if (raw) pendingStyle = Object.assign(pendingStyle, parseMsgStyle(raw));
    } catch (e) { }
    renderStylePanel();
    applyStylePreview();
}

function savePendingStyle() {
    try { localStorage.setItem(MSG_STYLE_KEY, serializePendingStyle()); } catch (e) { }
}

function serializePendingStyle() {
    const s = pendingStyle, out = [];
    if (s.bg) out.push('bg=' + s.bg);
    if (s.fg) out.push('fg=' + s.fg);
    if (s.fs) out.push('fs=' + s.fs);
    if (s.b) out.push('b=1');
    if (s.i) out.push('i=1');
    if (s.u) out.push('u=1');
    if (s.al) out.push('al=' + s.al);
    return out.join(';');
}

// 解析消息样式串（与服务端 sanitize_msg_style 同样的白名单）
function parseMsgStyle(str) {
    const s = { bg: '', fg: '', fs: '', b: 0, i: 0, u: 0, al: '' };
    if (!str || typeof str !== 'string') return s;
    str.split(';').forEach(part => {
        const idx = part.indexOf('=');
        if (idx < 0) return;
        const k = part.slice(0, idx).trim().toLowerCase();
        const v = part.slice(idx + 1).trim();
        if ((k === 'bg' || k === 'fg') && /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v)) s[k] = v.toLowerCase();
        else if (k === 'fs' && (v === 's' || v === 'l' || v === 'xl')) s.fs = v;
        else if (k === 'al' && (v === 'l' || v === 'c' || v === 'r')) s.al = v;
        else if ((k === 'b' || k === 'i' || k === 'u') && v === '1') s[k] = 1;
    });
    return s;
}

// 样式对象 -> 内联 style 串（只输出白名单里的值）
function msgStyleCss(st, fallback) {
    let css = '';
    if (st && (st.bg || st.fg || st.fs || st.b || st.i || st.u || st.al)) {
        if (st.bg) css += `--bub-color:${st.bg};`;
        if (st.fg) css += `color:${st.fg};`;
        if (st.fs) css += `font-size:${FONT_SIZE_MAP[st.fs]};`;
        if (st.b) css += 'font-weight:700;';
        if (st.i) css += 'font-style:italic;';
        if (st.u) css += 'text-decoration:underline;';
        if (st.al) css += `text-align:${ALIGN_MAP[st.al]};`;
        return css;
    }
    // 没设样式：用发送者的默认气泡色
    if (fallback) {
        if (fallback.bg) css += `--bub-color:${fallback.bg};`;
        if (fallback.text) css += `color:${fallback.text};`;
    }
    return css;
}

function setPendingStyle(patch) {
    pendingStyle = Object.assign({}, pendingStyle, patch);
    savePendingStyle();
    renderStylePanel();
    applyStylePreview();
}

function resetPendingStyle() {
    pendingStyle = { bg: '', fg: '', fs: '', b: 0, i: 0, u: 0, al: '' };
    savePendingStyle();
    renderStylePanel();
    applyStylePreview();
}

function buildStylePanel() {
    const bgGrid = document.getElementById('msBgGrid');
    const fgGrid = document.getElementById('msFgGrid');
    if (!bgGrid || bgGrid.childElementCount) return;
    bgGrid.innerHTML = BUBBLE_COLORS.map((c, i) =>
        `<div class="palette-swatch" data-bg="${i}" title="背景 ${c.bg}" style="background:${c.bg};border-color:${c.bg}"></div>`).join('');
    fgGrid.innerHTML = TEXT_COLORS.map((c, i) =>
        `<div class="palette-swatch fg" data-fg="${i}" title="文字 ${c.t}" style="background:${c.c};border-color:${c.c}">${c.v ? '' : '默认'}</div>`).join('');
    bgGrid.addEventListener('click', e => {
        const el = e.target.closest('[data-bg]');
        if (el) setPendingStyle({ bg: BUBBLE_COLORS[parseInt(el.dataset.bg)].bg });
    });
    fgGrid.addEventListener('click', e => {
        const el = e.target.closest('[data-fg]');
        if (el) setPendingStyle({ fg: TEXT_COLORS[parseInt(el.dataset.fg)].v });
    });
    document.getElementById('msSizeSeg').addEventListener('click', e => {
        const el = e.target.closest('[data-fs]');
        if (el) setPendingStyle({ fs: el.dataset.fs });
    });
    document.getElementById('msFontSeg').addEventListener('click', e => {
        const el = e.target.closest('[data-fk]');
        if (el) setPendingStyle({ [el.dataset.fk]: pendingStyle[el.dataset.fk] ? 0 : 1 });
    });
    document.getElementById('msAlignSeg').addEventListener('click', e => {
        const el = e.target.closest('[data-al]');
        if (el) setPendingStyle({ al: el.dataset.al });
    });
}

function renderStylePanel() {
    const bgGrid = document.getElementById('msBgGrid');
    const fgGrid = document.getElementById('msFgGrid');
    if (bgGrid) {
        bgGrid.querySelectorAll('[data-bg]').forEach(el =>
            el.classList.toggle('selected', !!pendingStyle.bg && BUBBLE_COLORS[parseInt(el.dataset.bg)].bg === pendingStyle.bg));
    }
    if (fgGrid) {
        fgGrid.querySelectorAll('[data-fg]').forEach(el =>
            el.classList.toggle('selected', (pendingStyle.fg || '') === TEXT_COLORS[parseInt(el.dataset.fg)].v));
    }
    document.querySelectorAll('#msSizeSeg [data-fs]').forEach(el =>
        el.classList.toggle('on', el.dataset.fs === pendingStyle.fs));
    document.querySelectorAll('#msFontSeg [data-fk]').forEach(el =>
        el.classList.toggle('on', !!pendingStyle[el.dataset.fk]));
    document.querySelectorAll('#msAlignSeg [data-al]').forEach(el =>
        el.classList.toggle('on', el.dataset.al === pendingStyle.al));
    const tip = document.getElementById('msTip');
    if (tip) tip.textContent = serializePendingStyle() ? '已设置，作用于本条消息' : '未设置，跟随默认样式';
}

// 输入框实时预览：文字样式直接作用在输入框上，背景色用输入框外框提示
function applyStylePreview() {
    const ta = document.getElementById('msgInput');
    const wrap = document.getElementById('chatInputWrap');
    if (!ta) return;
    ta.style.color = pendingStyle.fg || '';
    ta.style.fontSize = FONT_SIZE_MAP[pendingStyle.fs] || '';
    ta.style.fontWeight = pendingStyle.b ? '700' : '';
    ta.style.fontStyle = pendingStyle.i ? 'italic' : '';
    ta.style.textDecoration = pendingStyle.u ? 'underline' : '';
    ta.style.textAlign = ALIGN_MAP[pendingStyle.al] || '';
    if (wrap) wrap.style.boxShadow = pendingStyle.bg ? `0 0 0 2px ${pendingStyle.bg}` : '';
}

function togglePalette() {
    const drawer = document.getElementById('paletteDrawer');
    const btn = document.getElementById('paletteBtn');
    if (drawer.classList.contains('open')) { closePaletteDrawer(); return; }
    // 与 @提及弹窗、表情面板 互斥
    document.getElementById('atPopup').classList.remove('open');
    document.getElementById('atBtn').classList.remove('active');
    document.getElementById('emojiPanel').classList.remove('open');
    document.getElementById('emojiBtn').classList.remove('active');
    renderStylePanel();
    drawer.classList.add('open');
    btn.classList.add('active');
}

function closePaletteDrawer() {
    const d = document.getElementById('paletteDrawer');
    const b = document.getElementById('paletteBtn');
    if (d) d.classList.remove('open');
    if (b) b.classList.remove('active');
}

function insertEmoji(e) {
    const ta = document.getElementById('msgInput');
    ta.value += e;
    ta.focus();
    closeEmojiPanel();
}

const ALLOWED_EXT = new Set();

async function loadFileTypeConfig() {
    try {
        const r = await fetch(`${API}/api/config/file-types`, {headers: getHeaders()});
        const d = await r.json();
        if (d.code === 200) {
            const cfg = d.data;
            window._fileTypeConfig = cfg;
            const all = [...(cfg.image||[]),...(cfg.video||[]),...(cfg.audio||[]),...(cfg.document||[]),...(cfg.code||[]),...(cfg.text||[]),...(cfg.special||[]),...(cfg.archive||[])];
            all.forEach(e => ALLOWED_EXT.add(e));
        }
    } catch(_) {}
}

function getExt(name) {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

function showToast(msg) {
    let el = document.getElementById('toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'toast';
        el.className = 'toast';
        document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    setTimeout(() => { el.style.opacity = '0'; }, 3000);
}

function toggleTheme() {
    const html = document.documentElement;
    const isDark = html.getAttribute('data-theme') === 'dark';
    if (isDark) {
        html.removeAttribute('data-theme');
        localStorage.setItem('theme', 'light');
    } else {
        html.setAttribute('data-theme', 'dark');
        localStorage.setItem('theme', 'dark');
    }
    updateThemeIcon();
}

function updateThemeIcon() {
    const btn = document.getElementById('themeToggle');
    if (!btn) return;
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    btn.setAttribute('alt', isDark ? '浅色' : '深色');
    btn.setAttribute('title', isDark ? '切换到浅色' : '切换到深色');
}

function handleInputFocus() {
    setTimeout(() => {
        const ta = document.getElementById('msgInput');
        ta.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 300);
}

function handleFileSelect(e) {
    const file = e.target.files[0];
    if (file) uploadFile(file);
    e.target.value = '';
}

function clearAuthStorage() {
    try { localStorage.removeItem('token'); } catch (_) {}
    try { localStorage.removeItem('username'); } catch (_) {}
    try { localStorage.removeItem('qt_unread_ids'); } catch (_) {}
}

async function doLogout() {
    try {
        await fetch(`${API}/api/auth/logout`, {method:'POST', headers:getHeaders()});
    } catch(e) {}
    if (ws) ws.close();
    clearAuthStorage();
    location.href = '/login';
}

let typingTimer = null;

function sendTyping() {
    if (typingTimer) return;
    typingTimer = setTimeout(() => { typingTimer = null; }, 3000);
    wsSend({type: 'typing', room_id: currentRoomId, active: true});
}

function sendTypingStop() {
    if (typingTimer) { clearTimeout(typingTimer); typingTimer = null; }
    wsSend({type: 'typing', room_id: currentRoomId, active: false});
}

let _fpZIndex = 500;
let _fpWindows = {};

function _fpBringToFront(win) {
    _fpZIndex++;
    win.style.zIndex = _fpZIndex;
    document.querySelectorAll('.fp-window').forEach(w => w.classList.remove('fp-active'));
    win.classList.add('fp-active');
}

function _fpCreateWindow(msgId, fileName) {
    const ext = (fileName || '').split('.').pop().toLowerCase();
    const icon = '';
    const win = document.createElement('div');
    win.className = 'fp-window';
    win.id = 'fp-' + msgId;
    const cx = Math.max(0, (window.innerWidth - 400) / 2);
    const cy = Math.max(0, (window.innerHeight - 400) / 2);
    win.style.cssText = `left:${cx}px;top:${cy}px;width:400px;height:400px;`;
    win.innerHTML = `<div class="fp-titlebar"><span class="fp-titlebar-icon">${icon}</span><span class="fp-titlebar-name">${esc(fileName)}</span><div class="fp-titlebar-btns"><button class="fp-maximize" title="最大化">□</button><button class="fp-close" title="关闭">✕</button></div></div><div class="fp-body"><div class="fp-loading">加载中...</div></div><div class="fp-toolbar"><button class="fp-download-btn">下载</button></div><div class="fp-resize-handle fp-rb"></div>`;
    document.body.appendChild(win);
    _fpBringToFront(win);
    const titlebar = win.querySelector('.fp-titlebar');
    const resizeHandle = win.querySelector('.fp-resize-handle.fp-rb');
    let isDragging = false, isResizing = false;
    let dragOffX = 0, dragOffY = 0;
    let startW = 0, startH = 0, startMX = 0, startMY = 0;
    titlebar.addEventListener('mousedown', function(e) {
        if (e.target.closest('.fp-titlebar-btns')) return;
        isDragging = true;
        dragOffX = e.clientX - win.offsetLeft;
        dragOffY = e.clientY - win.offsetTop;
        _fpBringToFront(win);
        e.preventDefault();
    });
    resizeHandle.addEventListener('mousedown', function(e) {
        isResizing = true;
        startW = win.offsetWidth;
        startH = win.offsetHeight;
        startMX = e.clientX;
        startMY = e.clientY;
        _fpBringToFront(win);
        e.preventDefault();
        e.stopPropagation();
    });
    document.addEventListener('mousemove', function(e) {
        if (isDragging) {
            win.style.left = (e.clientX - dragOffX) + 'px';
            win.style.top = (e.clientY - dragOffY) + 'px';
            win.style.right = 'auto';
        }
        if (isResizing) {
            const nw = Math.max(300, startW + e.clientX - startMX);
            const nh = Math.max(300, startH + e.clientY - startMY);
            win.style.width = nw + 'px';
            win.style.height = nh + 'px';
        }
    });
    document.addEventListener('mouseup', function() {
        isDragging = false;
        isResizing = false;
    });
    win.addEventListener('mousedown', function() { _fpBringToFront(win); });
    win.querySelector('.fp-close').addEventListener('click', function() {
        win.remove();
        delete _fpWindows[msgId];
    });
    let isMaximized = false;
    let prevRect = null;
    win.querySelector('.fp-maximize').addEventListener('click', function() {
        if (isMaximized) {
            win.style.left = prevRect.left;
            win.style.top = prevRect.top;
            win.style.width = prevRect.width;
            win.style.height = prevRect.height;
            this.textContent = '□';
            isMaximized = false;
        } else {
            prevRect = { left: win.style.left, top: win.style.top, width: win.style.width, height: win.style.height };
            win.style.left = '0';
            win.style.top = '0';
            win.style.width = '100vw';
            win.style.height = '100vh';
            this.textContent = '❐';
            isMaximized = true;
        }
    });
    _fpWindows[msgId] = win;
    return win;
}

function _startTranscodePolling(msgId, mediaType, bodyEl) {
    const pctEl = bodyEl.querySelector(`#fp-pct-${msgId}`);
    const poll = setInterval(async () => {
        try {
            const r = await fetch(`${API}/api/file/transcode-progress/${msgId}`, {headers: getHeaders()});
            const d = await r.json();
            if (d.code === 200) {
                if (d.progress >= 100) {
                    clearInterval(poll);
                    if (pctEl) pctEl.textContent = '100%';
                    setTimeout(() => {
                        const src = `${API}/api/file/transcode/${msgId}?token=${encodeURIComponent(token)}`;
                        if (mediaType === 'video') {
                            bodyEl.innerHTML = `<div class="fp-media"><video src="${src}" controls autoplay></video></div>`;
                        } else {
                            bodyEl.innerHTML = `<div class="fp-media fp-audio-wrap"><div class="fp-audio-icon">音频</div><audio src="${src}" controls autoplay></audio></div>`;
                        }
                    }, 300);
                } else if (d.progress < 0) {
                    if (pctEl) pctEl.textContent = '准备中...';
                } else {
                    if (pctEl) pctEl.textContent = d.progress + '%';
                }
            }
        } catch(_) {}
    }, 1000);
}

function downloadFile(msgId, fileName, filePath, fileSize) {
    const maxMb = window._fileTypeConfig && window._fileTypeConfig.max_download_size_mb;
    if (maxMb && fileSize && fileSize > maxMb * 1024 * 1024) {
        showToast('文件过大，超过下载限制 ' + maxMb + 'MB');
        return;
    }
    const url = filePath.startsWith('http') ? filePath : `${API}${filePath}`;
    downloadWithProgress(url, fileName, token);
}

async function previewFile(msgId, fileName, filePath) {
    if (_fpWindows[msgId]) {
        _fpBringToFront(_fpWindows[msgId]);
        return;
    }
    const ext = (fileName || '').split('.').pop().toLowerCase();
    const win = _fpCreateWindow(msgId, fileName);
    const body = win.querySelector('.fp-body');
    const dlBtn = win.querySelector('.fp-download-btn');
    const NATIVE_VIDEO = window._fileTypeConfig?.video?.filter(e => ['mp4','webm','ogg'].includes(e)) || ['mp4','webm','ogg'];
    const NATIVE_AUDIO = window._fileTypeConfig?.audio?.filter(e => ['mp3','wav','ogg','flac','aac'].includes(e)) || ['mp3','wav','ogg','flac','aac'];
    const allVideo = window._fileTypeConfig?.video || [];
    const allAudio = window._fileTypeConfig?.audio || [];
    const needTranscode = (allVideo.includes(ext) && !NATIVE_VIDEO.includes(ext)) || (allAudio.includes(ext) && !NATIVE_AUDIO.includes(ext));
    const dlHref = needTranscode ? `${API}/api/file/transcode/${msgId}?token=${encodeURIComponent(token)}` : filePath;
    const dlName = needTranscode ? fileName.replace(/\.[^.]+$/, allVideo.includes(ext) ? '.mp4' : '.mp3') : fileName;
    dlBtn.addEventListener('click', function() {
        const url = dlHref.startsWith('http') ? dlHref : `${API}${dlHref}`;
        downloadWithProgress(url, dlName, token);
    });
    const IMG_EXTS = window._fileTypeConfig?.image || [];
    const SPECIAL_EXTS = window._fileTypeConfig?.special || [];
    const TEXT_EXTS = window._fileTypeConfig?.text || [];
    const DOC_EXTS = window._fileTypeConfig?.document || [];
    const CODE_EXTS = window._fileTypeConfig?.code || [];
    if (SPECIAL_EXTS.includes(ext) || ext === 'html') {
        body.innerHTML = `<iframe src="${filePath}"></iframe>`;
    } else if (IMG_EXTS.includes(ext)) {
        body.innerHTML = `<div class="fp-media"><img src="${filePath}" alt="${esc(fileName)}"></div>`;
    } else if (allVideo.includes(ext)) {
        if (NATIVE_VIDEO.includes(ext)) {
            body.innerHTML = `<div class="fp-media"><video src="${filePath}" controls autoplay></video></div>`;
        } else {
            body.innerHTML = `<div class="fp-transcode-loading"><div class="fp-transcode-spinner"></div><div class="fp-transcode-text">正在转码，请稍候...</div><div class="fp-transcode-pct" id="fp-pct-${msgId}">0%</div></div>`;
            fetch(`${API}/api/file/transcode-start/${msgId}`, {headers: getHeaders()}).catch(()=>{});
            _startTranscodePolling(msgId, 'video', body);
        }
    } else if (allAudio.includes(ext)) {
        if (NATIVE_AUDIO.includes(ext)) {
            body.innerHTML = `<div class="fp-media fp-audio-wrap"><div class="fp-audio-icon">音频</div><div class="fp-audio-name">${esc(fileName)}</div><audio src="${filePath}" controls autoplay></audio></div>`;
        } else {
            body.innerHTML = `<div class="fp-transcode-loading"><div class="fp-transcode-spinner"></div><div class="fp-transcode-text">正在转码，请稍候...</div><div class="fp-transcode-pct" id="fp-pct-${msgId}">0%</div></div>`;
            fetch(`${API}/api/file/transcode-start/${msgId}`, {headers: getHeaders()}).catch(()=>{});
            _startTranscodePolling(msgId, 'audio', body);
        }
    } else if (TEXT_EXTS.includes(ext)) {
        try {
            const r = await fetch(encodeURI(filePath));
            const text = await r.text();
            body.innerHTML = `<div class="fp-text-content">${esc(text)}</div>`;
        } catch(_) {
            body.innerHTML = `<div class="fp-loading" style="color:var(--danger)">加载失败</div>`;
        }
    } else if (DOC_EXTS.includes(ext)) {
        try {
            const r = await fetch(`${API}/api/file/parse/${msgId}`, {headers: getHeaders()});
            const d = await r.json();
            if (d.code === 200 && d.html) {
                body.innerHTML = `<div class="fp-html-content">${d.html}</div>`;
            } else {
                body.innerHTML = `<div class="fp-loading" style="color:var(--danger)">${esc(d.msg || '无法解析该文件')}</div>`;
            }
        } catch(_) {
            body.innerHTML = `<div class="fp-loading" style="color:var(--danger)">加载失败</div>`;
        }
    } else if (CODE_EXTS.includes(ext)) {
        try {
            const r = await fetch(`${API}/api/file/parse/${msgId}`, {headers: getHeaders()});
            const d = await r.json();
            if (d.code === 200 && d.text !== undefined) {
                body.innerHTML = `<pre class="fp-code-content">${esc(d.text)}</pre>`;
            } else {
                body.innerHTML = `<div class="fp-loading" style="color:var(--danger)">${esc(d.msg || '无法读取文件')}</div>`;
            }
        } catch(_) {
            body.innerHTML = `<div class="fp-loading" style="color:var(--danger)">加载失败</div>`;
        }
    } else {
        body.innerHTML = `<div class="fp-loading">该格式暂不支持预览<br><small>请使用下载按钮</small></div>`;
    }
}

// ===== Right Sidebar / Search =====
function toggleRightSidebar() {
    const sb = document.getElementById('rightSidebar');
    sb.classList.toggle('open');
    if (sb.classList.contains('open')) {
        document.getElementById('searchInput').focus();
    }
}

let _searchPage = 1;
function doSearch() {
    const keyword = document.getElementById('searchInput').value.trim();
    const typeEl = document.querySelector('input[name="searchType"]:checked');
    const type = typeEl ? typeEl.value : 'all';
    const sender = document.getElementById('searchSender').value.trim();
    if (!keyword && type !== 'file' && !sender) return;
    _searchPage = 1;
    _executeSearch();
}

function _executeSearch() {
    const keyword = document.getElementById('searchInput').value.trim();
    const typeEl = document.querySelector('input[name="searchType"]:checked');
    const type = typeEl ? typeEl.value : 'all';
    const dateFrom = document.getElementById('searchDateFrom').value;
    const dateTo = document.getElementById('searchDateTo').value;
    const sender = document.getElementById('searchSender').value.trim();
    const resultsEl = document.getElementById('searchResults');
    const totalEl = document.getElementById('searchTotal');
    resultsEl.innerHTML = '<div class="search-loading">搜索中...</div>';
    const params = new URLSearchParams({
        keyword, room_id: currentRoomId, type,
        page: _searchPage, page_size: 50
    });
    if (dateFrom) params.set('date_from', dateFrom);
    if (dateTo) params.set('date_to', dateTo);
    if (sender) params.set('sender', sender);
    fetch(`${API}/api/chat/search?${params}`, {headers: getHeaders()})
        .then(r => r.json())
        .then(d => {
            if (d.code !== 200) {
                resultsEl.innerHTML = '<div class="search-no-results">搜索失败</div>';
                return;
            }
            if (d.data.length === 0) {
                resultsEl.innerHTML = '<div class="search-no-results">未找到匹配结果</div>';
                totalEl.textContent = '共 0 条结果';
                return;
            }
            totalEl.textContent = `共 ${d.total} 条结果`;
            resultsEl.innerHTML = '';
            const batchBar = document.createElement('div');
            batchBar.className = 'search-batch-bar';
            batchBar.innerHTML = `<label class="search-select-all"><input type="checkbox" id="selectAllCb" onchange="toggleSelectAll()"> 全选</label>
                <button class="batch-del-btn" id="batchDelBtn" onclick="batchDeleteSelected()" disabled>批量删除</button>`;
            resultsEl.appendChild(batchBar);
            d.data.forEach(m => {
                const item = document.createElement('div');
                item.className = 'search-result-item';
                const canDelete = m.username === username || window.isSuper;
                const isText = m.msg_type === 'text';
                const isFile = m.msg_type === 'file';
                let preview = '';
                if (isText) {
                    preview = esc(m.content || '');
                } else if (isFile) {
                    preview = esc(m.file_name || '');
                } else if (m.msg_type === 'image') {
                    preview = esc(m.file_name || 'image');
                } else {
                    preview = esc(m.content || '');
                }
                let highlightPreview = highlightKeyword(preview, keyword);
                let actionsHtml = '';
                if (isFile && canDelete) {
                    const safeName = esc(m.file_name).replace(/'/g, "&#39;");
                    actionsHtml = `<div class="sr-file-actions">
                        <button onclick="event.stopPropagation();previewFile(${m.id},'${safeName}','${m.file_path}')">预览</button>
                        <button onclick="event.stopPropagation();renameFile(${m.id})">重命名</button>
                        <button class="sr-del" onclick="event.stopPropagation();deleteOwnFile(${m.id})">删除</button>
                    </div>`;
                } else if (isFile) {
                    const safeName = esc(m.file_name).replace(/'/g, "&#39;");
                    actionsHtml = `<div class="sr-file-actions">
                        <button onclick="event.stopPropagation();previewFile(${m.id},'${safeName}','${m.file_path}')">预览</button>
                    </div>`;
                }
                const cbHtml = canDelete ? `<input type="checkbox" class="sr-cb" data-msg-id="${m.id}" onchange="updateBatchBtn()">` : '';
                item.innerHTML = `<div class="sr-row-top">${cbHtml}<div class="sr-user">${esc(m.nickname || m.username)}<span class="sr-time">${formatTime(m.create_time)}</span></div></div>
                    <div class="sr-preview">${highlightPreview}</div>${actionsHtml}`;
                item.onclick = function(e) {
                    if (e.target.closest('.sr-cb') || e.target.closest('.sr-file-actions') || e.target.closest('.search-batch-bar')) return;
                    if (m.room_id !== currentRoomId) return;
                    scrollToMessage(m.id);
                };
                resultsEl.appendChild(item);
            });
            if (_searchPage * 50 < d.total) {
                const moreBtn = document.createElement('button');
                moreBtn.className = 'search-btn';
                moreBtn.style.cssText = 'margin-top:8px;font-size:13px;padding:6px;';
                moreBtn.textContent = '加载更多...';
                moreBtn.onclick = function() {
                    _searchPage++;
                    _executeSearch();
                };
                resultsEl.appendChild(moreBtn);
            }
        })
        .catch(() => {
            resultsEl.innerHTML = '<div class="search-no-results">搜索出错</div>';
        });
}

function highlightKeyword(text, keyword) {
    if (!keyword) return text;
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(' + escaped + ')', 'gi');
    return text.replace(re, '<em>$1</em>');
}

async function renameFile(msgId) {
    const newName = prompt('输入新文件名：');
    if (!newName || !newName.trim()) return;
    try {
        const r = await fetch(`${API}/api/chat/files/${msgId}/rename`, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({name: newName.trim()})
        });
        const d = await r.json();
        if (d.code === 200) {
            showToast('重命名成功');
            const el = document.querySelector(`.msg-item[data-msg-id="${msgId}"]`);
            if (el) {
                const nameEl = el.querySelector('.file-card-name');
                if (nameEl) nameEl.textContent = d.file_name;
            }
            _executeSearch();
        } else {
            alert(d.msg || '重命名失败');
        }
    } catch(_) {
        alert('重命名失败');
    }
}

async function deleteOwnFile(msgId) {
    if (!confirm('确认删除此文件？')) return;
    try {
        const r = await fetch(`${API}/api/chat/messages/${msgId}`, {
            method: 'DELETE',
            headers: getHeaders()
        });
        const d = await r.json();
        if (d.code === 200) {
            showToast('文件已删除');
            const el = document.querySelector(`.msg-item[data-msg-id="${msgId}"]`);
            if (el) el.remove();
            _executeSearch();
        } else {
            alert(d.msg || '删除失败');
        }
    } catch(_) {
        alert('删除失败');
    }
}

function updateBatchBtn() {
    const cbs = document.querySelectorAll('#searchResults .sr-cb:checked');
    const btn = document.getElementById('batchDelBtn');
    const allCb = document.getElementById('selectAllCb');
    if (btn) btn.disabled = cbs.length === 0;
    if (allCb) {
        const total = document.querySelectorAll('#searchResults .sr-cb').length;
        allCb.checked = total > 0 && cbs.length === total;
    }
}

function toggleSelectAll() {
    const checked = document.getElementById('selectAllCb').checked;
    document.querySelectorAll('#searchResults .sr-cb').forEach(cb => cb.checked = checked);
    updateBatchBtn();
}

async function batchDeleteSelected() {
    const cbs = document.querySelectorAll('#searchResults .sr-cb:checked');
    if (cbs.length === 0) return;
    if (!confirm(`确认删除选中的 ${cbs.length} 条消息？`)) return;
    const ids = Array.from(cbs).map(cb => parseInt(cb.dataset.msgId));
    try {
        const r = await fetch(`${API}/api/chat/messages/batch-delete`, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({ids})
        });
        const d = await r.json();
        if (d.code === 200) {
            showToast(`已删除 ${d.msg}`);
            ids.forEach(id => {
                const el = document.querySelector(`.msg-item[data-msg-id="${id}"]`);
                if (el) el.remove();
            });
            _executeSearch();
        } else {
            alert(d.msg || '批量删除失败');
        }
    } catch(_) {
        alert('批量删除失败');
    }
}

/* ============================================================
   Phase 2：右键菜单 · 拖拽开窗 · 独立聊天浮窗
   ============================================================ */
let _qtDragPayload = null;
let _chatMenuEl = null;

async function pasteSendFiles(roomId) {
    const cb = (window.qtFileClipboard || []).slice();
    if (!cb.length) { showToast('剪贴板为空'); return; }
    let ok = 0;
    for (const it of cb) {
        const body = { room_id: roomId };
        if (it.kind === 'msg') body.msg_id = it.id; else body.item_id = it.id;
        try {
            const d = await (await fetch(`${API}/api/chat/send-file`, { method: 'POST', headers: getHeaders(), body: JSON.stringify(body) })).json();
            if (d.code === 200) ok++;
        } catch (_) {}
    }
    if (ok) showToast('已发送 ' + ok + ' 个文件');
}

function showChatMenu(x, y, items) {
    closeChatMenu();
    if (!items || !items.length) return;
    const menu = document.createElement('div');
    menu.className = 'chat-ctx-menu';
    items.forEach(function(it) {
        if (!it) return;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chat-ctx-item' + (it.danger ? ' danger' : '');
        b.textContent = it.label;
        b.addEventListener('click', function(ev) {
            ev.stopPropagation();
            closeChatMenu();
            if (typeof it.onClick === 'function') it.onClick();
        });
        menu.appendChild(b);
    });
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    menu.style.left = Math.max(4, Math.min(x, vw - rect.width - 6)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, vh - rect.height - 6)) + 'px';
    _chatMenuEl = menu;
}
function closeChatMenu() {
    if (_chatMenuEl) { _chatMenuEl.remove(); _chatMenuEl = null; }
}
window.showChatMenu = showChatMenu;
window.closeChatMenu = closeChatMenu;

/* ---- 列表项：右键菜单 + 拖拽 ---- */
function listItemPayload(item) {
    if (!item) return null;
    if (item.dataset.friend) {
        return { kind: 'private', roomId: parseInt(item.dataset.roomId, 10), friend: item.dataset.friend, name: item.dataset.name || item.dataset.friend };
    }
    if (item.dataset.roomId) {
        return { kind: 'room', roomId: parseInt(item.dataset.roomId, 10), name: item.dataset.name || ('#' + item.dataset.roomId) };
    }
    return null;
}

function bindListInteractions() {
    ['roomList', 'privateChatList'].forEach(function(id) {
        const el = document.getElementById(id);
        if (!el || el._qtBound) return;
        el._qtBound = true;
        el.addEventListener('contextmenu', function(ev) {
            const item = ev.target.closest('.room-item');
            if (!item) return;
            ev.preventDefault();
            ev.stopPropagation();
            if (item.dataset.friend) openFriendMenu(ev.clientX, ev.clientY, item.dataset.friend);
            else if (item.dataset.roomId != null && item.dataset.roomId !== '') openRoomMenu(ev.clientX, ev.clientY, parseInt(item.dataset.roomId, 10), item);
        });
        el.addEventListener('dragstart', function(ev) {
            const item = ev.target.closest('.room-item');
            if (!item) return;
            const payload = listItemPayload(item);
            if (!payload) { ev.preventDefault(); return; }
            _qtDragPayload = payload;
            try {
                ev.dataTransfer.effectAllowed = 'copy';
                ev.dataTransfer.setData('application/x-qt-chat', JSON.stringify(payload));
            } catch(_) {}
        });
        el.addEventListener('dragend', function() { _qtDragPayload = null; });
    });
}

function openRoomMenu(x, y, roomId, item) {
    const room = roomsData[roomId] || {};
    const isMember = roomId === 0 || room.is_member;
    const isOwner = room.created_by === username;
    const items = [];
    if (isMember) {
        items.push({ label: '单独开窗口聊天', onClick: function() { openDetachedChat({ kind: 'room', roomId: roomId, name: room.name || ('#' + roomId) }); } });
    }
    if (roomId !== 0 && isMember) {
        if (isOwner) items.push({ label: '删除群聊', danger: true, onClick: function() { confirmDeleteRoom(roomId); } });
        else items.push({ label: '退出群聊', danger: true, onClick: function() { confirmLeaveRoom(roomId); } });
    }
    showChatMenu(x, y, items);
}

function openFriendMenu(x, y, friend) {
    let roomId = 0, name = friend;
    for (const k in privateChatsData) {
        if (privateChatsData[k].friend === friend) { roomId = privateChatsData[k].room_id; name = privateChatsData[k].nickname || friend; break; }
    }
    showChatMenu(x, y, [
        { label: '单独开窗口聊天', onClick: function() { openDetachedChat({ kind: 'private', roomId: roomId, friend: friend, name: name }); } },
        { label: '删除好友', danger: true, onClick: function() { deleteFriend(friend); } }
    ]);
}

async function confirmDeleteRoom(roomId) {
    const room = roomsData[roomId] || {};
    if (!confirm('确认删除群聊 ' + (room.name || roomId) + '？此操作不可恢复！')) return;
    const r = await fetch(`${API}/api/rooms/${roomId}`, { method: 'DELETE', headers: getHeaders() });
    const d = await r.json();
    if (d.code === 200) {
        closeDetachedByRoom(roomId);
        if (currentChatType === 'room' && currentRoomId === roomId) switchRoom(0, '大厅');
        loadRooms();
    } else { alert(d.msg); }
}

async function confirmLeaveRoom(roomId) {
    if (roomId === 0) return;
    const room = roomsData[roomId] || {};
    if (!confirm('退出群聊 ' + (room.name || roomId) + '？')) return;
    await fetch(`${API}/api/rooms/${roomId}/leave`, { method: 'POST', headers: getHeaders() });
    closeDetachedByRoom(roomId);
    if (currentChatType === 'room' && currentRoomId === roomId) switchRoom(0, '大厅');
    loadRooms();
}

function closeDetachedByRoom(roomId) {
    const key = 'chat-det-room-' + roomId;
    if (window.qtAppWindows && window.qtAppWindows[key]) window.qtCloseApp(key);
}
function closeDetachedByFriend(friend) {
    for (const k in chatContexts) {
        const c = chatContexts[k];
        if (!c.isMain && c.chatType === 'private' && c.privateFriend === friend) {
            if (window.qtAppWindows && window.qtAppWindows[k]) window.qtCloseApp(k);
        }
    }
}

/* ---- 独立聊天浮窗：记忆已打开的浮窗，刷新后自动恢复 ---- */
function qtDetachedKey() { return 'qt_detached_chats_' + (username || 'me'); }
function qtLoadDetached() { try { return JSON.parse(localStorage.getItem(qtDetachedKey()) || '[]'); } catch (_) { return []; } }
function qtSaveDetached(list) { try { localStorage.setItem(qtDetachedKey(), JSON.stringify(list)); } catch (_) {} }
function qtRememberDetached(payload) {
    const id = payload.kind + '-' + payload.roomId;
    const list = qtLoadDetached();
    if (!list.some(x => (x.kind + '-' + x.roomId) === id)) {
        list.push({ kind: payload.kind, roomId: payload.roomId, name: payload.name || '', friend: payload.friend || '' });
        qtSaveDetached(list);
    }
}
function qtForgetDetached(payload) {
    const id = payload.kind + '-' + payload.roomId;
    qtSaveDetached(qtLoadDetached().filter(x => (x.kind + '-' + x.roomId) !== id));
}
function reopenDetachedChats() {
    qtLoadDetached().forEach(function (item) {
        openDetachedChat({ kind: item.kind, roomId: item.roomId, name: item.name, friend: item.friend });
    });
}
window.reopenDetachedChats = reopenDetachedChats;

function openDetachedChat(payload) {
    if (!payload || !payload.roomId && payload.roomId !== 0) return;
    if (!window.qtMakeAppWindow) { showToast('独立窗口暂不可用'); return; }
    const key = 'chat-det-' + payload.kind + '-' + payload.roomId;
    const reg = window.qtAppWindows || {};
    if (reg[key] && reg[key].el && document.body.contains(reg[key].el)) {
        reg[key].el.classList.remove('hidden');
        window.qtBringToFront(reg[key].el);
        window.qtUpdateTaskButtons();
        return;
    }
    const bodyHtml =
        '<div class="det-chat">' +
            '<div class="det-messages"></div>' +
            '<div class="det-quotebar" style="display:none"><span class="det-quotetext"></span><button class="det-quote-close" type="button" title="取消引用">✕</button></div>' +
            '<div class="det-input-row"><textarea class="det-input" placeholder="输入消息..." rows="1"></textarea><button class="det-send" type="button" title="发送">发送</button></div>' +
        '</div>';
    const o = window.qtMakeAppWindow(key, payload.name || '聊天', bodyHtml, { w: 420, h: 560, minW: 320, minH: 360, icon: '' });
    o.el.classList.add('wechat-window');
    o.el.dataset.icon = '';
    window.qtRegisterApp(key, o);
    qtRememberDetached(payload);

    const ctx = {
        id: key, isMain: false,
        roomId: payload.roomId,
        roomName: payload.name || '',
        chatType: payload.kind,
        privateFriend: payload.friend || '',
        messagesEl: o.el.querySelector('.det-messages'),
        inputEl: o.el.querySelector('.det-input'),
        quoteBar: o.el.querySelector('.det-quotebar'),
        quoteBarText: o.el.querySelector('.det-quotetext'),
        quotedId: null,
        lastMsgId: 0
    };
    chatContexts[ctx.id] = ctx;
    o.onClose = function() { delete chatContexts[ctx.id]; qtForgetDetached(payload); };

    const sendBtn = o.el.querySelector('.det-send');
    if (sendBtn) sendBtn.addEventListener('click', function() { sendMessage(ctx); });
    const closeQuoteBtn = o.el.querySelector('.det-quote-close');
    if (closeQuoteBtn) closeQuoteBtn.addEventListener('click', function() { clearQuote(ctx.id); });
    if (ctx.inputEl) {
        ctx.inputEl.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(ctx); }
        });
        ctx.inputEl.addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = Math.min(this.scrollHeight, 120) + 'px';
        });
        ctx.inputEl.addEventListener('contextmenu', function(e) {
            const cb = window.qtFileClipboard || [];
            if (!cb.length) return;
            e.preventDefault();
            showChatMenu(e.clientX, e.clientY, [{
                label: '📋 粘帖发送' + (cb.length > 1 ? '（' + cb.length + ' 个文件）' : ''),
                onClick: function() { pasteSendFiles(ctx.roomId); }
            }]);
        });
        setTimeout(function() { ctx.inputEl.focus(); }, 60);
    }
    if (ctx.messagesEl) {
        ctx.messagesEl.addEventListener('scroll', function() {
            if (ctx.messagesEl.scrollTop <= 4) loadMoreMessages(ctx);
        });
    }
    wsSend({ type: 'mark_read', room_id: ctx.roomId });
    loadMessages(0, ctx);
}
window.openDetachedChat = openDetachedChat;

/* ---- 拖到桌面空白处 -> 开独立浮窗 ---- */
function bindDesktopDetach() {
    const root = document.getElementById('desktopRoot') || document.body;
    if (root._qtDetachBound) return;
    root._qtDetachBound = true;
    root.addEventListener('dragover', function(ev) {
        if (!_qtDragPayload) return;
        const chatWin = document.getElementById('wechatWindow');
        if (chatWin && chatWin.contains(ev.target)) return;
        ev.preventDefault();
        try { ev.dataTransfer.dropEffect = 'copy'; } catch(_) {}
    }, true);
    root.addEventListener('drop', function(ev) {
        if (!_qtDragPayload || _qtDragPayload.kind === 'msg-file') return;
        const chatWin = document.getElementById('wechatWindow');
        if (chatWin && chatWin.contains(ev.target)) return;
        ev.preventDefault();
        ev.stopPropagation();
        const payload = _qtDragPayload;
        _qtDragPayload = null;
        openDetachedChat(payload);
    }, true);
}

document.addEventListener('DOMContentLoaded', async function() {
    if (!token) { location.href = '/login'; return; }

    loadUnreadState();
    updateThemeIcon();

    const r = await fetch(`${API}/api/auth/me`, {headers:getHeaders()});
    const d = await r.json();
    if (d.code !== 200) { clearAuthStorage(); location.href = '/login'; return; }
    window.isSuper = d.data && d.data.is_super === 1;
    document.getElementById('userName').textContent = d.data.username;
    if (window.isSuper) {
        document.getElementById('adminLink').style.display = '';
        document.getElementById('clearMsgsBtn').style.display = '';
    }

    const emojiPanel = document.getElementById('emojiPanel');
    EMOJIS.forEach(e => {
        const span = document.createElement('span');
        span.textContent = e;
        span.onclick = () => insertEmoji(e);
        emojiPanel.appendChild(span);
    });

    await loadFileTypeConfig();
    await loadMsgTotals();
    loadRooms();
    loadPrivateChats();
    buildStylePanel();
    loadPendingStyle();
    loadMessages(0);
    connectWS();
    bindListInteractions();
    bindDesktopDetach();
    reopenDetachedChats();

    window.addEventListener('pagehide', flushMsgTotals);
    window.addEventListener('beforeunload', flushMsgTotals);
    window.addEventListener('resize', applyHeaderHeight);
    requestAnimationFrame(applyHeaderHeight);
    setTimeout(applyHeaderHeight, 300);

    setInterval(loadRooms, 30000);
    setInterval(loadPrivateChats, 30000);

    const msgEl = document.getElementById('chatMessages');
    msgEl.addEventListener('scroll', () => {
        isAtBottom = msgEl.scrollHeight - msgEl.scrollTop - msgEl.clientHeight < 50;
        document.getElementById('scrollBottomBtn').classList.toggle('not-bottom', !isAtBottom);
        if (isAtBottom && unreadCount > 0 && currentChatType === 'room') markRead();
    });

    const ta = document.getElementById('msgInput');
    ta.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    ta.addEventListener('input', function() {
        this.style.height = 'auto';
        this.style.height = Math.min(this.scrollHeight, 120) + 'px';
        applyHeaderHeight();
        if (this.value.trim()) sendTyping(); else sendTypingStop();
    });
    ta.addEventListener('focus', handleInputFocus);
    ta.addEventListener('blur', sendTypingStop);
    window.addEventListener('blur', sendTypingStop);
    document.addEventListener('visibilitychange', function () { if (document.hidden) sendTypingStop(); });
    ta.addEventListener('paste', function(e) {
        const items = e.clipboardData.items;
        for (const item of items) {
            if (item.type.startsWith('image/')) {
                e.preventDefault();
                const file = item.getAsFile();
                if (file) uploadFile(file);
                return;
            }
        }
    });
    ta.addEventListener('contextmenu', function(e) {
        const cb = window.qtFileClipboard || [];
        if (!cb.length) return;
        e.preventDefault();
        showChatMenu(e.clientX, e.clientY, [{
            label: '📋 粘帖发送' + (cb.length > 1 ? '（' + cb.length + ' 个文件）' : ''),
            onClick: function() { pasteSendFiles(currentRoomId); }
        }]);
    });

    document.addEventListener('click', _unlockAudio, { once: true });
    document.addEventListener('keydown', _unlockAudio, { once: true });
    document.addEventListener('touchstart', _unlockAudio, { once: true });

    document.addEventListener('click', function(e) {
        closeChatMenu();
        const popup = document.getElementById('atPopup');
        const btn = document.getElementById('atBtn');
        if (popup && !popup.contains(e.target) && !btn.contains(e.target)) {
            popup.classList.remove('open');
            btn.classList.remove('active');
        }
        // 表情面板：点别处（不选表情）同样自动隐藏
        const emojiPanel = document.getElementById('emojiPanel');
        const emojiBtn = document.getElementById('emojiBtn');
        if (emojiPanel && !emojiPanel.contains(e.target) && !(emojiBtn && emojiBtn.contains(e.target))) {
            closeEmojiPanel();
        }
        // 气泡调色面板：同样点别处自动隐藏
        const palette = document.getElementById('paletteDrawer');
        const paletteBtn = document.getElementById('paletteBtn');
        if (palette && !palette.contains(e.target) && !(paletteBtn && paletteBtn.contains(e.target))) {
            closePaletteDrawer();
        }
        // 更多应用抽屉：仅在再次点击“＋”时收起，点其他处不自动隐藏
    });

    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') closeChatMenu();
    });

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            if (unreadCount > 0 && currentChatType === 'room') markRead();
        }
    });

    document.getElementById('createRoomModal').addEventListener('click', function(e) {
        if (e.target === this) hideCreateRoom();
    });
    document.getElementById('joinPasswordModal').addEventListener('click', function(e) {
        if (e.target === this) hideJoinPasswordModal();
    });
    document.getElementById('inviteModal').addEventListener('click', function(e) {
        if (e.target === this) hideInviteModal();
    });
    document.getElementById('addFriendModal').addEventListener('click', function(e) {
        if (e.target === this) hideAddFriendModal();
    });

    // --- Resize handle for chat-input-wrap ---
    const resizeHandle = document.getElementById('resizeHandle');
    const chatInputWrap = document.getElementById('chatInputWrap');
    if (resizeHandle && chatInputWrap) {
        let isResizing = false;

        resizeHandle.addEventListener('mousedown', function(e) {
            e.preventDefault();
            isResizing = true;
            const startY = e.clientY;
            const startHeight = chatInputWrap.offsetHeight;

            function onMouseMove(e) {
                if (!isResizing) return;
                const diff = startY - e.clientY;
                const newHeight = Math.max(80, Math.min(600, startHeight + diff));
                chatInputWrap.style.height = newHeight + 'px';
            }

            function onMouseUp() {
                isResizing = false;
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
            }

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    }

    // --- Drag & drop upload ---
    const overlay = document.getElementById('dropOverlay');
    const chatMain = document.querySelector('.chat-main');

    chatMain.addEventListener('dragenter', function(e) {
        e.preventDefault();
        e.stopPropagation();
        if (_qtDragPayload) return;
        if (!chatMain.contains(e.relatedTarget)) {
            overlay.classList.add('show');
        }
    });

    chatMain.addEventListener('dragleave', function(e) {
        e.preventDefault();
        e.stopPropagation();
        if (_qtDragPayload) return;
        if (!chatMain.contains(e.relatedTarget)) {
            overlay.classList.remove('show');
        }
    });

    chatMain.addEventListener('dragover', function(e) {
        e.preventDefault();
        e.stopPropagation();
    });

    function handleDrop(e) {
        e.preventDefault();
        e.stopPropagation();
        overlay.classList.remove('show');
        if (_qtDragPayload) return;
        const files = e.dataTransfer.files;
        if (files && files.length > 0) {
            for (const file of files) {
                uploadFile(file);
            }
        }
    }

    chatMain.addEventListener('drop', handleDrop);
    overlay.addEventListener('drop', handleDrop);
});

// ─── Toast 浮动通知 ───
function showToast(text, duration) {
    duration = duration || 4000;
    const container = document.getElementById('toastContainer');
    if (!container) {
        const c = document.createElement('div');
        c.id = 'toastContainer';
        c.style.cssText = 'position:fixed;top:60px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none';
        document.body.appendChild(c);
    }
    const el = document.createElement('div');
    el.textContent = text;
    el.style.cssText = `background:var(--toast-bg,#333);color:var(--toast-text,#fff);padding:10px 18px;border-radius:8px;font-size:13px;max-width:400px;word-break:break-word;box-shadow:0 4px 12px rgba(0,0,0,.2);opacity:0;transform:translateX(40px);transition:all .3s ease;pointer-events:auto`;
    document.getElementById('toastContainer').appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'translateX(0)'; });
    setTimeout(() => {
        el.style.opacity = '0'; el.style.transform = 'translateX(40px)';
        setTimeout(() => el.remove(), 300);
    }, duration);
}
