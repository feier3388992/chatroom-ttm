/* ================= talktome Windows-like Desktop ================= */
(function () {
'use strict';

const API = window.location.origin;
const token = localStorage.getItem('token');
if (!Array.isArray(window.qtFileClipboard)) window.qtFileClipboard = [];

const CAT_META = {
    audio:   { icon: '', title: '音频' },
    video:   { icon: '', title: '视频' },
    text:    { icon: '', title: '文本 / 代码' },
    image:   { icon: '', title: '图片' },
    pdf:     { icon: '', title: 'PDF' },
    office:  { icon: '', title: '文档 / 表格' },
    archive: { icon: '', title: '压缩包' },
    other:   { icon: '', title: '其他' },
};
const CAT_ORDER = ['audio', 'video', 'text', 'image', 'pdf', 'office', 'archive', 'other'];


const state = {
    folders: [], fileItems: [], messages: [], messagesById: {},
    categories: CAT_ORDER, username: '', isSuper: false,
    clipboard: null, selection: new Set(), entryMap: {},
    zoom: parseInt(localStorage.getItem('qt_zoom') || '130', 10) || 130,
    wallpaper: '', wallpaperMode: 'cover', wallpaperUploads: [],
};
const openFolders = {};   // folderId -> {el, folder}
const appWindows = {};    // 'music' | 'video' | 'image' | 'pdf' | 'zip' -> {el, ...}
const videoEls = [];      // registered <video> elements (only one plays at a time)
let zipPending = [];      // entry keys queued in the compression tool
let audio = null;
let textSaveRef = null, textItem = null;
let zCounter = 50;
let renameCtx = null;

/* ---------------- utils ---------------- */
function headers() { return { 'Content-Type': 'application/json', 'X-Auth-Token': token }; }
function extOf(name) { return name && name.lastIndexOf('.') > 0 ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''; }
function catOf(ext) { for (const c of CAT_ORDER) { if (CAT_META[c] && extInCat(ext, c)) return c; } return 'other'; }
function extInCat(ext, cat) { return (CAT_EXT[cat] || []).indexOf(ext) >= 0; }
const CAT_EXT = {
    audio: ['mp3','wav','flac','m4a','aac','ogg','oga','wma','opus','ape','amr'],
    video: ['mp4','avi','mkv','mov','wmv','flv','webm','m4v','mpg','mpeg','3gp','ts'],
    image: ['png','jpg','jpeg','gif','bmp','webp','svg','ico','tif','tiff'],
    pdf: ['pdf'],
    text: ['txt','md','markdown','json','xml','csv','log','ini','yml','yaml','py','js','css','html','htm','sh','bat','c','cpp','h','hpp','java','go','rs','php','sql','conf','toml','env','vue','ts','tsx','jsx'],
    office: ['doc','docx','xls','xlsx','ppt','pptx','wps','et','dps','odt','ods','odp','rtf'],
    archive: ['zip','rar','7z','tar','gz','bz2','xz','tgz','war','jar'],
    other: [],
};
function iconOf(entry) { return (entry.ext || 'FILE').toString().toUpperCase(); }
function fmtSize(s) {
    if (!s) return '0B';
    if (s < 1024) return s + 'B';
    if (s < 1024 * 1024) return (s / 1024).toFixed(1) + 'KB';
    if (s < 1024 * 1024 * 1024) return (s / 1024 / 1024).toFixed(1) + 'MB';
    return (s / 1024 / 1024 / 1024).toFixed(2) + 'GB';
}
function fmtClock(sec) { sec = Math.floor(sec || 0); return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); }
function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; }
function toast(m) { window.showToast && window.showToast(m); }

/* ---------------- file location model ---------------- */
function folderById(id) { return state.folders.find(f => f.id === id); }
function systemFolderId(cat) { const f = state.folders.find(x => x.system_key === cat); return f ? f.id : null; }
function fileItemOf(msgId) { return state.fileItems.find(x => x.msg_id === msgId); }
function fileLocation(msgId) {
    const it = fileItemOf(msgId);
    if (it) return it.parent_id;
    const m = state.messagesById[msgId];
    return m ? systemFolderId(m.category) : null;
}
function entriesForParent(parentId) {
    const out = [];
    state.folders.filter(f => f.parent_id === parentId).forEach(f => out.push({ type: 'folder', id: f.id, key: 'f' + f.id, f }));
    state.messages.forEach(m => { if (fileLocation(m.id) === parentId) out.push({ type: 'msg', id: m.id, key: 'm' + m.id, m }); });
    state.fileItems.filter(it => !it.msg_id && it.parent_id === parentId).forEach(it => {
        const ext = extOf(it.name);
        out.push({ type: 'copy', id: it.id, key: 'c' + it.id, copy: it, name: it.name, ext, category: catOf(ext), size: it.file_size || 0, path: it.file_path, sender_name: '副本' });
    });
    return out;
}
function entryDisplay(e) {
    if (e.type === 'folder') {
        const meta = e.f.system_key && CAT_META[e.f.system_key];
        return { emoji: '', name: meta ? meta.title : e.f.name, isFolder: true };
    }
    if (e.type === 'msg') return { emoji: iconOf({ ext: e.m.ext, category: e.m.category }), name: e.m.name, isFolder: false };
    return { emoji: iconOf(e), name: e.name, isFolder: false };
}

/* ---------------- load / refresh ---------------- */
async function load() {
    try {
        const r = await fetch(API + '/api/desktop', { headers: headers() });
        const d = await r.json();
        if (d.code !== 200) { toast(d.msg || '加载失败'); return; }
        state.folders = d.data.folders || [];
        state.fileItems = d.data.file_items || [];
        state.messages = d.data.messages || [];
        state.messagesById = {};
        state.messages.forEach(m => { state.messagesById[m.id] = m; });
        state.username = d.data.username;
        if (!_listsLoaded) { _listsLoaded = true; loadLists(); }
        state.isSuper = !!d.data.is_super;
        state.wallpaper = d.data.wallpaper || '';
        state.wallpaperMode = d.data.wallpaper_mode || 'cover';
        state.wallpaperUploads = d.data.wallpaper_uploads || [];
        applyWallpaper(state.wallpaper, state.wallpaperMode);
        refreshAll();
    } catch (e) { toast('加载失败，请检查网络'); }
}
function refreshAll() {
    renderDesktopIcons();
    Object.keys(openFolders).forEach(fid => { const o = openFolders[fid]; if (o) renderFolder(o); });
    updatePasteButtons();
}

/* ---------------- desktop icons (auto-arrange grid) ---------------- */
const nameCollator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
function renderDesktopIcons() {
    const layer = document.getElementById('desktopIcons');
    layer.innerHTML = '';
    state.entryMap = {};
    let entries = entriesForParent(0);
    entries.forEach(e => { state.entryMap[e.key] = e; });

    const H = layer.clientHeight || (window.innerHeight * 2);
    const dy = 106, dx = 94;
    const rows = Math.max(1, Math.floor((H - 18 - 46) / dy));

    entries.sort(function (a, b) { return nameCollator.compare(entryDisplay(a).name, entryDisplay(b).name); });

    entries.forEach(function (e, idx) {
        const d = entryDisplay(e);
        const el = document.createElement('div');
        el.className = 'dt-icon' + (e.type === 'folder' ? ' system' : '') + (state.selection.has(e.key) ? ' selected' : '');
        el.dataset.key = e.key;
        el.dataset.kind = e.type;
        el.dataset.folder = d.isFolder ? '1' : '0';
        const count = d.isFolder ? entriesForParent(e.id).length : 0;
        el.innerHTML =
            (d.isFolder && count ? '<span class="dt-count">' + count + '</span>' : '') +
            (d.isFolder
                ? '<span class="dt-folder"></span>'
                : (d.emoji ? '<span class="dt-emoji">' + d.emoji + '</span>' : '')) +
            '<span class="dt-label" title="' + esc(d.name) + '">' + esc(d.name) + '</span>';

        const col = Math.floor(idx / rows);
        const row = idx % rows;
        el.style.left = (16 + col * dx) + 'px';
        el.style.top = (14 + row * dy) + 'px';

        el.addEventListener('mousedown', function (ev) { iconMouseDown(ev, el, e); });
        el.addEventListener('dblclick', function () { openEntry(e); });
        el.addEventListener('contextmenu', function (ev) {
            ev.preventDefault(); ev.stopPropagation();
            if (!state.selection.has(e.key)) { state.selection.clear(); state.selection.add(e.key); }
            renderDesktopIcons();
            openContextMenu(ev.clientX, ev.clientY, { scope: 'item' });
        });
        const sysFolder = e.type === 'folder' && !!e.f.system_key;
        if (d.isFolder && sysFolder) {
            el.addEventListener('dragover', function (ev) { ev.preventDefault(); });
            el.addEventListener('drop', function (ev) { ev.preventDefault(); ev.stopPropagation(); toast('系统文件夹不可写入'); });
        } else if (d.isFolder) {
            el.addEventListener('dragover', function (ev) { ev.preventDefault(); el.classList.add('drop-target'); });
            el.addEventListener('dragleave', function () { el.classList.remove('drop-target'); });
            el.addEventListener('drop', function (ev) {
                ev.preventDefault(); ev.stopPropagation(); el.classList.remove('drop-target');
                if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files.length) { uploadExternalFiles(ev.dataTransfer.files, e.id, false); return; }
                const p = window._qtDragPayload;
                if (p && p.kind === 'msg-file') { placeChatFile(p.msgId, e.id); return; }
                const keys = dragKeys(ev);
                if (keys.length) moveKeysTo(keys, e.id);
            });
        }
        layer.appendChild(el);
    });
    layer.appendChild(buildSharedIcon());
    Object.keys(openFolders).forEach(fid => {
        const o = openFolders[fid];
        if (o && o.el) entriesForParent(o.folder.id).forEach(e => { state.entryMap[e.key] = e; });
    });
    bindDesktopBackground();
}

function selectedEntries() { return Array.from(state.selection).map(k => state.entryMap[k]).filter(Boolean); }

function applySelectionClasses() {
    document.querySelectorAll('.dt-icon[data-key]').forEach(function (x) {
        x.classList.toggle('selected', state.selection.has(x.dataset.key));
    });
}

function iconMouseDown(ev, el, entry) {
    if (ev.button !== 0) return;
    if (!state.selection.has(entry.key)) {
        if (!(ev.ctrlKey || ev.metaKey)) state.selection.clear();
        state.selection.add(entry.key);
    }
    applySelectionClasses();
    const startX = ev.clientX, startY = ev.clientY;
    const els = document.querySelectorAll('.dt-icon.selected');
    const starts = Array.from(els).map(e => ({ el: e, x: parseFloat(e.style.left) || 0, y: parseFloat(e.style.top) || 0 }));
    let dragging = false;
    function move(e) {
        const ddx = e.clientX - startX, ddy = e.clientY - startY;
        if (!dragging && Math.abs(ddx) + Math.abs(ddy) < 5) return;
        dragging = true;
        starts.forEach(s => { s.el.style.left = (s.x + ddx) + 'px'; s.el.style.top = (s.y + ddy) + 'px'; s.el.classList.add('dragging'); });
        const f = folderUnderPoint(e.clientX, e.clientY, entry);
        document.querySelectorAll('.dt-icon.drop-target').forEach(x => x.classList.remove('drop-target'));
        if (f) f.el.classList.add('drop-target');
        e.preventDefault();
    }
    function up(e) {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        if (!dragging) {
            if (ev.ctrlKey || ev.metaKey) { state.selection.has(entry.key) && state.selection.delete(entry.key); applySelectionClasses(); }
            return;
        }
        starts.forEach(s => s.el.classList.remove('dragging'));
        document.querySelectorAll('.dt-icon.drop-target').forEach(x => x.classList.remove('drop-target'));
        const f = folderUnderPoint(e.clientX, e.clientY, entry);
        if (f) {
            if (f.shared) { addEntriesToShared(Array.from(state.selection)); return; }
            moveKeysTo(Array.from(state.selection), f.entry.id);
            return;
        }
        renderDesktopIcons();
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
}

function folderUnderPoint(x, y, self) {
    const icons = document.querySelectorAll('.dt-icon[data-folder="1"], #dtSharedFolder');
    for (const el of icons) {
        if (el.dataset.key === self.key) continue;
        const r = el.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
            if (el.id === 'dtSharedFolder') return { el: el, shared: true, entry: null };
            const entry = state.entryMap[el.dataset.key];
            if (entry && entry.type === 'folder' && entry.f.system_key) continue;
            return { el: el, shared: false, entry: entry };
        }
    }
    return null;
}

/* ---------------- folder windows ---------------- */
function isSystemFolder(f) { return !!f.system_key; }

function openFolder(folder) {
    let o = openFolders[folder.id];
    let el = (o && o.el && document.body.contains(o.el)) ? o.el : document.getElementById('fw-' + folder.id);
    if (!el || !document.body.contains(el)) {
        el = document.createElement('div');
        el.className = 'qt-window folder-window';
        el.id = 'fw-' + folder.id;
        const meta = folder.system_key && CAT_META[folder.system_key];
        const title = meta ? meta.title : folder.name;
        el.dataset.icon = '';
        const pasteBtn = isSystemFolder(folder) ? '' : '<button class="fw-paste" title="粘帖" disabled>粘帖</button>';
        const bar = '<div class="qt-titlebar folder-bar">' +
                '<span class="win-title" style="text-align:left;padding-left:6px">' + esc(title) + '</span>' +
                '<div class="fw-tools">' + pasteBtn + '<button class="fw-refresh" title="刷新">⟳</button><button class="win-min" title="最小化">—</button><button class="win-close" title="关闭">✕</button></div>' +
            '</div>';
        const bodyHtml = isSystemFolder(folder)
            ? '<div class="qt-body fw-cols"><div class="fw-sources"></div><div class="fw-list"></div></div>'
            : '<div class="qt-body dl-body"><div class="dl-head">' +
                  '<span class="dl-c-name">名称</span><span class="dl-c-size">大小</span><span class="dl-c-type">类型</span><span class="dl-c-time">修改日期</span>' +
              '</div><div class="dl-rows"></div></div>';
        el.innerHTML = bar + bodyHtml;
        document.getElementById('folderWindows').appendChild(el);
        el.querySelector('.fw-refresh').addEventListener('click', function (ev) { ev.stopPropagation(); load(); });
        const pb = el.querySelector('.fw-paste');
        if (pb) pb.addEventListener('click', function (ev) { ev.stopPropagation(); pasteTo(folder.id); });
        el.querySelector('.win-min').addEventListener('click', function (ev) { ev.stopPropagation(); minimizeFolder(folder.id); });
        el.querySelector('.win-close').addEventListener('click', function () { closeFolder(folder.id); });
        makeWindow(el, {
            minW: isSystemFolder(folder) ? 720 : 480,
            minH: 320,
            storageKey: 'qt_fw_' + folder.id,
            top: 70 + (Object.keys(openFolders).length % 6) * 26,
            left: 130 + (Object.keys(openFolders).length % 6) * 28
        });
        const body = el.querySelector('.qt-body');
        body.addEventListener('contextmenu', function (ev) {
            if (ev.target.closest('.fw-row') || ev.target.closest('.dl-row') || ev.target.closest('.fw-src')
                || ev.target.closest('.dl-head')) return;
            ev.preventDefault(); openContextMenu(ev.clientX, ev.clientY, { scope: 'folder', parentId: folder.id, isSystem: isSystemFolder(folder) });
        });
    }
    const prev = openFolders[folder.id];
    el.classList.remove('hidden');
    openFolders[folder.id] = {
        el: el, folder: folder,
        source: (prev && prev.source) || 'all',
        selectedKey: (prev && prev.selectedKey) || null,
        minimized: false
    };
    bringToFront(el);
    renderFolder(openFolders[folder.id]);
    updatePasteButtons();
    updateTaskButtons();
}

function closeFolder(fid) { const o = openFolders[fid]; if (o && o.el) o.el.remove(); delete openFolders[fid]; updateTaskButtons(); }

function minimizeFolder(fid) {
    const o = openFolders[fid];
    if (!o || !o.el) return;
    o.minimized = true; o.el.classList.add('hidden');
    updateTaskButtons();
}

function renderFolder(o) {
    if (!o || !o.el) return;
    o.folder = folderById(o.folder.id) || o.folder;
    if (isSystemFolder(o.folder)) renderCategoryFolder(o);
    else renderDetailsFolder(o);
}

function bindDropTarget(el, targetId) {
    el.addEventListener('dragover', function (ev) { ev.preventDefault(); el.classList.add('drop-target'); });
    el.addEventListener('dragleave', function () { el.classList.remove('drop-target'); });
    el.addEventListener('drop', function (ev) {
        ev.preventDefault(); ev.stopPropagation(); el.classList.remove('drop-target');
        const keys = dragKeys(ev); if (keys.length) moveKeysTo(keys, targetId);
    });
}

/* ----- system category folder: sources | files | panel ----- */
function folderUploaders(fid) {
    const out = [];
    entriesForParent(fid).forEach(e => { if (e.type === 'msg' && out.indexOf(e.m.sender_name) === -1) out.push(e.m.sender_name); });
    return out;
}
function filteredEntries(fid, source) {
    return entriesForParent(fid).filter(e => {
        if (e.type === 'folder') return true;
        if (!source || source === 'all') return true;
        return e.type === 'msg' && e.m.sender_name === source;
    });
}
function srcRowHtml(key, emoji, name, count, active) {
    return '<div class="fw-src' + (active ? ' active' : '') + '" data-src="' + esc(key) + '">' +
        '<span class="s-emoji">' + emoji + '</span><span class="s-name" title="' + esc(name) + '">' + esc(name) + '</span>' +
        '<span class="s-count">' + count + '</span></div>';
}
function renderCategoryFolder(o) {
    const srcEl = o.el.querySelector('.fw-sources');
    const listEl = o.el.querySelector('.fw-list');
    const all = entriesForParent(o.folder.id);
    const fileCount = all.filter(e => e.type !== 'folder').length;
    let sh = '<div class="fw-src-title">来源</div>' + srcRowHtml('all', '', '全部', fileCount, o.source === 'all');
    folderUploaders(o.folder.id).forEach(u => {
        const c = all.filter(e => e.type === 'msg' && e.m.sender_name === u).length;
        sh += srcRowHtml(u, '', u, c, o.source === u);
    });
    srcEl.innerHTML = sh;
    srcEl.querySelectorAll('.fw-src').forEach(el => el.addEventListener('click', function () {
        o.source = el.dataset.src; o.selectedKey = null; renderCategoryFolder(o);
    }));

    const entries = filteredEntries(o.folder.id, o.source);
    if (!entries.length) { listEl.innerHTML = '<div class="fw-empty">此文件夹为空<br>可把文件拖进来</div>'; }
    else {
        listEl.innerHTML = '';
        entries.forEach(e => listEl.appendChild(buildCategoryRow(o, e)));
    }
    bindFolderDrop(o.el, o.folder.id);
}
function buildCategoryRow(o, e) {
    state.entryMap[e.key] = e;
    const d = entryDisplay(e);
    const size = e.type === 'msg' ? e.m.size : (e.type === 'copy' ? e.size : '');
    const sender = e.type === 'msg' ? e.m.sender_name : (e.type === 'copy' ? '副本' : '');
    const time = e.type === 'folder' ? (e.f.create_time || '') : (e.type === 'msg' ? e.m.time : (e.copy.create_time || ''));
    const meta = d.isFolder ? (entriesForParent(e.id).length + ' 项') : (sender + (size != null && size !== '' ? ' · ' + fmtSize(size) : '') + (time ? ' · ' + fmtTime(time) : ''));
    const row = document.createElement('div');
    row.className = 'fw-row' + (o.selectedKey === e.key || state.selection.has(e.key) ? ' selected' : '');
    row.draggable = true;
    row.dataset.key = e.key;
    row.innerHTML =
        '<span class="r-emoji">' + d.emoji + '</span>' +
        '<div class="r-info"><div class="r-name" title="' + esc(d.name) + '">' + esc(d.name) + '</div>' +
        '<div class="r-meta">' + esc(meta) + '</div></div>';
    row.addEventListener('click', function (ev) {
        if (ev.ctrlKey || ev.metaKey) {
            if (state.selection.has(e.key)) state.selection.delete(e.key); else state.selection.add(e.key);
        } else { state.selection.clear(); state.selection.add(e.key); }
        o.selectedKey = e.key;
        o.el.querySelectorAll('.fw-list .fw-row').forEach(function (x) { x.classList.toggle('selected', state.selection.has(x.dataset.key)); });
    });
    row.addEventListener('dblclick', function () {
        if (e.type === 'folder') openFolder(e.f);
        else openFile(e.type === 'msg' ? e.m : e);
    });
    row.addEventListener('dragstart', function (ev) {
        if (!state.selection.has(e.key)) { state.selection.clear(); state.selection.add(e.key); }
        ev.dataTransfer.setData('text/plain', JSON.stringify(Array.from(state.selection)));
        ev.dataTransfer.effectAllowed = 'move'; row.classList.add('dragging');
    });
    row.addEventListener('dragend', function () { row.classList.remove('dragging'); });
    row.addEventListener('contextmenu', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        if (!state.selection.has(e.key)) { state.selection.clear(); state.selection.add(e.key); o.selectedKey = e.key; renderCategoryFolder(o); }
        openContextMenu(ev.clientX, ev.clientY, { scope: 'item' });
    });
    if (d.isFolder) bindDropTarget(row, e.id);
    return row;
}

/* ----- user folder: Explorer details list ----- */
function fmtTime(t) { if (!t) return ''; return String(t).replace('T', ' ').slice(0, 19); }
function renderDetailsFolder(o) {
    const rowsEl = o.el.querySelector('.dl-rows');
    const entries = entriesForParent(o.folder.id);
    if (!entries.length) { rowsEl.innerHTML = '<div class="fw-empty">此文件夹为空<br>可把文件拖进来</div>'; bindFolderDrop(o.el, o.folder.id); return; }
    rowsEl.innerHTML = '';
    entries.forEach(e => rowsEl.appendChild(buildDetailRow(o, e)));
    bindFolderDrop(o.el, o.folder.id);
}
function buildDetailRow(o, e) {
    state.entryMap[e.key] = e;
    const d = entryDisplay(e);
    const size = e.type === 'folder' ? '' : (e.type === 'msg' ? e.m.size : e.size);
    const type = d.isFolder ? '文件夹' : (e.ext ? e.ext.toUpperCase() + ' 文件' : '文件');
    const time = e.type === 'folder' ? (e.f.create_time || '') : (e.type === 'msg' ? e.m.time : (e.copy.create_time || ''));
    const row = document.createElement('div');
    row.className = 'dl-row' + (o.selectedKey === e.key || state.selection.has(e.key) ? ' selected' : '');
    row.draggable = true; row.dataset.key = e.key;
    row.innerHTML =
        '<div class="dl-c-name"><span class="r-emoji">' + d.emoji + '</span><span class="r-name" title="' + esc(d.name) + '">' + esc(d.name) + '</span></div>' +
        '<div class="dl-c-size">' + esc(d.isFolder ? '' : fmtSize(size)) + '</div>' +
        '<div class="dl-c-type">' + esc(type) + '</div>' +
        '<div class="dl-c-time">' + esc(fmtTime(time)) + '</div>';
    row.addEventListener('click', function (ev) {
        if (ev.ctrlKey || ev.metaKey) {
            if (state.selection.has(e.key)) state.selection.delete(e.key); else state.selection.add(e.key);
        } else { state.selection.clear(); state.selection.add(e.key); }
        o.selectedKey = e.key;
        o.el.querySelectorAll('.dl-rows .dl-row').forEach(function (x) { x.classList.toggle('selected', state.selection.has(x.dataset.key)); });
    });
    row.addEventListener('dblclick', function () { if (e.type === 'folder') openFolder(e.f); else openFile(e.type === 'msg' ? e.m : e); });
    row.addEventListener('dragstart', function (ev) {
        if (!state.selection.has(e.key)) { state.selection.clear(); state.selection.add(e.key); }
        ev.dataTransfer.setData('text/plain', JSON.stringify(Array.from(state.selection)));
        ev.dataTransfer.effectAllowed = 'move'; row.classList.add('dragging');
    });
    row.addEventListener('dragend', function () { row.classList.remove('dragging'); });
    row.addEventListener('contextmenu', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        if (!state.selection.has(e.key)) { state.selection.clear(); state.selection.add(e.key); o.selectedKey = e.key; renderDetailsFolder(o); }
        openContextMenu(ev.clientX, ev.clientY, { scope: 'item' });
    });
    if (d.isFolder) bindDropTarget(row, e.id);
    return row;
}

/* ----- right panel: per-type viewer / editor ----- */
function panelHead(item) {
    return '<div class="panel-head"><span class="p-name" title="' + esc(item.name) + '">' + esc(item.name) + '</span>' +
        '<a href="' + esc(item.path) + '" download="' + esc(item.name) + '" onclick="if(window.downloadWithProgress){event.preventDefault();downloadWithProgress(new URL(this.getAttribute(\'href\'),location.origin).href,this.getAttribute(\'download\'),token);}">下载</a></div>';
}
function renderPanel(o, panelEl, e) {
    if (!panelEl) return;
    if (!e) { panelEl.innerHTML = '<div class="panel-placeholder">选择左侧文件查看 / 编辑<br>双击音频可播放</div>'; return; }
    if (e.type === 'folder') { panelEl.innerHTML = '<div class="panel-placeholder">' + esc(entryDisplay(e).name) + '<br>双击打开文件夹</div>'; return; }
    const item = e.type === 'msg' ? e.m : e;
    switch (e.category) {
        case 'audio': return renderAudioPanel(o, panelEl, item);
        case 'video': return renderVideoPanel(o, panelEl, item, e);
        case 'image': return renderImagePanel(o, panelEl, item, e);
        case 'pdf':
            panelEl.innerHTML = panelHead(item) + '<div class="panel-stage"><iframe src="' + esc(item.path) + '"></iframe></div>';
            return;
        case 'text': return renderTextPanel(o, panelEl, e, item);
        default:
            panelEl.innerHTML = panelHead(item) + '<div class="panel-placeholder">该类型不支持预览<br>请点击右上角「下载」</div>';
    }
}
function playerCoreHtml() {
    return '<div class="panel-player">' +
            '<div class="player-now">未在播放</div>' +
            '<div class="player-progress"><span class="pcur">0:00</span><input class="pseek" type="range" min="0" max="1000" value="0"><span class="pdur">0:00</span></div>' +
            '<div class="player-controls"><button class="pprev" title="上一首">上一首</button><button class="pplay play-btn" title="播放/暂停">播放</button><button class="pnext" title="下一首">下一首</button><button class="pmode mode-btn" title="循环模式">循环</button></div>' +
            '<div class="player-vol">音量<input class="pvol" type="range" min="0" max="100" value="80"></div>' +
        '</div>' +
        '<div class="playlist-head">' +
            '<select class="pl-select" title="切换播放列表"></select>' +
            '<button class="pl-add" title="新建播放列表">＋</button>' +
            '<button class="pl-rename" title="重命名当前列表">✎</button>' +
            '<button class="pl-del" title="删除当前列表">🗑</button>' +
        '</div>' +
        '<div class="panel-playlist"></div>';
}
function bindPlayerCore(scopeEl) {
    const a = ensureAudio();
    scopeEl.querySelector('.pplay').addEventListener('click', togglePlay);
    scopeEl.querySelector('.pprev').addEventListener('click', prevTrack);
    scopeEl.querySelector('.pnext').addEventListener('click', nextTrack);
    scopeEl.querySelector('.pmode').addEventListener('click', cycleMode);
    const vol = scopeEl.querySelector('.pvol');
    vol.value = Math.round((a.volume || 0.8) * 100);
    vol.addEventListener('input', function () { a.volume = this.value / 100; });
    scopeEl.querySelector('.pseek').addEventListener('input', function () { if (a.src && a.duration) a.currentTime = (this.value / 1000) * a.duration; });
    const sel = scopeEl.querySelector('.pl-select');
    sel.addEventListener('change', function () { setActiveList(this.value); });
    sel.addEventListener('dblclick', function (e) { e.preventDefault(); renameActiveList(); });
    scopeEl.querySelector('.pl-add').addEventListener('click', function () { createList(); });
    scopeEl.querySelector('.pl-rename').addEventListener('click', function () { renameActiveList(); });
    scopeEl.querySelector('.pl-del').addEventListener('click', function () { deleteActiveList(); });
    const pl = scopeEl.querySelector('.panel-playlist');
    pl.addEventListener('dragover', function (ev) { ev.preventDefault(); pl.classList.add('drag-over'); });
    pl.addEventListener('dragleave', function () { pl.classList.remove('drag-over'); });
    pl.addEventListener('drop', function (ev) { ev.preventDefault(); pl.classList.remove('drag-over'); addAudioByKeys(dragKeys(ev)); });
}
function renderAudioPanel(o, panelEl, item) {
    panelEl.innerHTML = panelHead(item) +
        '<div class="panel-actions"><button class="pa-add">＋ 加入播放列表</button><button class="pa-open">在播放器中打开</button></div>' +
        playerCoreHtml();
    bindPlayerCore(panelEl);
    panelEl.querySelector('.pa-add').addEventListener('click', function () {
        addAudioToPlaylist({ name: item.name, path: item.path });
    });
    panelEl.querySelector('.pa-open').addEventListener('click', function () { openApp('music', buildMusicWindow); playAudioItem({ name: item.name, path: item.path }); });
    paintAudio(o);
}
function addAudioToPlaylist(item) {
    if (!state.playlist.some(x => x.path === item.path)) {
        state.playlist.push({ name: item.name, path: item.path });
        saveLists();
    }
    refreshPanels();
    toast('已加入播放列表');
}
function renderTextPanel(o, panelEl, e, item) {
    const editable = e.type === 'msg' && e.m.can_edit;
    const isMd = item.ext === 'md' || item.ext === 'markdown';
    panelEl.innerHTML = panelHead(item) +
        '<div class="panel-text">' +
            '<div class="pt-bar">' +
                (editable ? '<button class="pt-save primary">保存</button>' : '') +
                (isMd ? '<button class="pt-prev">预览</button>' : '') +
            '</div>' +
            '<textarea class="pt-editor" spellcheck="false"' + (editable ? '' : ' readonly') + ' placeholder="' + (editable ? '编辑内容…' : '只读（副本）') + '"></textarea>' +
            '<div class="pt-preview" style="display:none"></div>' +
        '</div>';
    const ta = panelEl.querySelector('.pt-editor');
    const preview = panelEl.querySelector('.pt-preview');
    if (e.type === 'msg') {
        fetch(API + '/api/files/content?msg_id=' + item.id, { headers: headers() })
            .then(r => r.json()).then(d => { ta.value = d.code === 200 ? d.data.content : '（' + (d.msg || '无法读取') + '）'; })
            .catch(() => { ta.value = '（读取失败）'; });
        if (editable) panelEl.querySelector('.pt-save').addEventListener('click', function () {
            const btn = this; btn.disabled = true; btn.textContent = '保存中…';
            fetch(API + '/api/files/content', { method: 'POST', headers: headers(), body: JSON.stringify({ msg_id: item.id, content: ta.value }) })
                .then(r => r.json()).then(d => toast(d.code === 200 ? '已保存到原文件' : (d.msg || '保存失败')))
                .catch(() => toast('保存失败')).finally(() => { btn.disabled = false; btn.textContent = '保存'; });
        });
    } else {
        fetch(API + item.path, { headers: headers() }).then(r => r.text()).then(t => { ta.value = t; }).catch(() => { ta.value = '（读取失败）'; });
    }
    if (isMd) panelEl.querySelector('.pt-prev').addEventListener('click', function () {
        if (preview.style.display === 'none') { preview.innerHTML = mdToHtml(ta.value); preview.style.display = ''; ta.style.display = 'none'; this.textContent = '原文'; }
        else { preview.style.display = 'none'; ta.style.display = ''; this.textContent = '预览'; }
    });
}

function bindFolderDrop(el, fid) {
    const body = el.querySelector('.qt-body');
    if (!body) return;
    if (body._dropBound) { body._fid = fid; return; }
    body._dropBound = true; body._fid = fid;
    const isSys = isSystemFolder(folderById(fid));
    body.addEventListener('dragover', function (ev) { ev.preventDefault(); });
    body.addEventListener('drop', function (ev) {
        ev.preventDefault();
        if (isSys) { toast('系统文件夹不可写入'); return; }
        if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files.length) { uploadExternalFiles(ev.dataTransfer.files, body._fid, false); return; }
        const keys = dragKeys(ev);
        if (keys.length) moveKeysTo(keys, body._fid);
    });
}

/* ---------------- move / clipboard ---------------- */
function dragKeys(ev) {
    try { const s = ev.dataTransfer.getData('text/plain'); if (s) { const a = JSON.parse(s); if (Array.isArray(a)) return a; } } catch (_) {}
    return Array.from(state.selection);
}

async function moveKeysTo(keys, parentId) {
    const target = folderById(parentId);
    if (target && target.system_key) { toast('系统文件夹不可写入'); return; }
    const all = keys.map(k => state.entryMap[k]).filter(Boolean);
    const entries = all.filter(e => !insideSystemFolder(e));
    if (entries.length < all.length) toast('系统文件夹内的内容不可移动');
    if (!entries.length) return;
    const msgIds = [], folderIds = [], copyIds = [];
    entries.forEach(e => {
        if (e.type === 'folder') { if (e.f.id !== parentId && !isDescendant(e.f.id, parentId)) folderIds.push(e.f.id); }
        else if (e.type === 'msg') msgIds.push(e.id);
        else copyIds.push(e.copy.id);
    });
    try {
        if (msgIds.length) await fetch(API + '/api/desktop/place', { method: 'POST', headers: headers(), body: JSON.stringify({ msg_ids: msgIds, parent_id: parentId }) });
        for (const fid of folderIds) await fetch(API + '/api/desktop/item/' + fid, { method: 'PATCH', headers: headers(), body: JSON.stringify({ parent_id: parentId }) });
        for (const cid of copyIds) await fetch(API + '/api/desktop/item/' + cid, { method: 'PATCH', headers: headers(), body: JSON.stringify({ parent_id: parentId }) });
    } catch (_) { toast('移动失败'); }
    state.selection.clear();
    await load();
}
function isDescendant(folderId, maybeParentId) {
    let cur = folderById(folderId);
    while (cur && cur.parent_id) {
        if (cur.parent_id === maybeParentId) return true;
        cur = folderById(cur.parent_id);
    }
    return false;
}

function buildClipRefs(entries) {
    const out = [];
    entries.forEach(e => {
        if (e.type === 'msg') out.push({ kind: 'msg', id: e.m.id, name: e.m.name, path: e.m.path, size: e.m.size || 0 });
        else if (e.type === 'copy') out.push({ kind: 'item', id: e.copy.id, name: e.copy.name, path: e.path, size: e.copy.file_size || e.size || 0 });
    });
    return out;
}
function cutSelection() {
    const sel = selectedEntries();
    if (sel.some(insideSystemFolder)) { toast('系统文件夹内的内容不可剪切'); return; }
    state.clipboard = { mode: 'cut', keys: Array.from(state.selection) };
    window.qtFileClipboard = [];
    toast('已剪切'); updatePasteButtons();
}
function copySelection() {
    const entries = selectedEntries().filter(e => e.type !== 'folder');
    if (!entries.length) { toast('文件夹暂不支持复制'); return; }
    const items = buildClipRefs(entries);
    state.clipboard = { mode: 'copy', keys: entries.map(e => e.key), items: items };
    window.qtFileClipboard = items;
    toast(items.length > 1 ? '已复制 ' + items.length + ' 个文件' : '已复制');
    updatePasteButtons();
}
function hasClipboard() { return !!state.clipboard && (state.clipboard.mode === 'cut' || (state.clipboard.items && state.clipboard.items.length)); }
function updatePasteButtons() {
    const enabled = hasClipboard();
    document.querySelectorAll('.fw-paste').forEach(function (b) { b.disabled = !enabled; });
    const shEnabled = !!(window.qtFileClipboard && window.qtFileClipboard.length);
    document.querySelectorAll('.sh-paste').forEach(function (b) { b.disabled = !shEnabled; });
}
async function pasteTo(parentId) {
    const target = folderById(parentId);
    if (target && target.system_key) { toast('系统文件夹不可写入'); return; }
    const cb = state.clipboard;
    if (!cb) return;
    if (cb.mode === 'cut') {
        await moveKeysTo(cb.keys, parentId);
        state.clipboard = null;
    } else {
        const items = cb.items || [];
        if (!items.length) return;
        const msgIds = items.filter(x => x.kind === 'msg').map(x => x.id);
        const itemIds = items.filter(x => x.kind === 'item').map(x => x.id);
        try {
            if (msgIds.length) await fetch(API + '/api/desktop/copy', { method: 'POST', headers: headers(), body: JSON.stringify({ msg_ids: msgIds, parent_id: parentId }) });
            if (itemIds.length) await fetch(API + '/api/desktop/copy', { method: 'POST', headers: headers(), body: JSON.stringify({ item_ids: itemIds, parent_id: parentId }) });
        } catch (_) { toast('粘贴失败'); }
    }
    state.selection.clear();
    await load();
    updatePasteButtons();
}
async function pasteToShared() {
    const items = window.qtFileClipboard || [];
    if (!items.length) { toast('剪贴板为空'); return; }
    let ok = 0;
    for (const it of items) {
        const body = it.kind === 'msg' ? { msg_id: it.id } : { item_id: it.id };
        try {
            const d = await (await fetch(API + '/api/shared/add', { method: 'POST', headers: headers(), body: JSON.stringify(body) })).json();
            if (d.code === 200) ok++;
        } catch (_) {}
    }
    toast('已添加 ' + ok + ' 个文件到共享文件夹');
    loadShared();
}

/* ---------------- external (OS) file upload ---------------- */
async function uploadDesktopFile(file, parentId) {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('parent_id', parentId || 0);
    try {
        const d = await (await fetch(API + '/api/desktop/upload', { method: 'POST', headers: { 'X-Auth-Token': token }, body: fd })).json();
        if (d.code !== 200) toast(d.msg || '上传失败');
        return d;
    } catch (_) { toast('上传失败'); return { code: 500 }; }
}
async function uploadExternalFiles(files, parentId, toShared) {
    const list = Array.from(files || []);
    if (!list.length) return;
    let ok = 0, fail = 0;
    for (const file of list) {
        const d = toShared ? await uploadSharedFile(file) : await uploadDesktopFile(file, parentId);
        if (d && d.code === 200) ok++; else fail++;
    }
    if (ok) toast('已上传 ' + ok + ' 个文件' + (fail ? '，' + fail + ' 个失败' : ''));
    else if (fail) toast('没有文件被上传');
    if (toShared) loadShared(); else await load();
}

/* ---------------- context menu ---------------- */
function openContextMenu(x, y, ctx) {
    const menu = document.getElementById('contextMenu');
    const items = [];
    if (ctx.scope === 'item') {
        const sel = selectedEntries();
        const single = sel.length === 1 ? sel[0] : null;
        items.push({ label: '打开', act: () => sel.forEach(openEntry) });
        if (sel.every(e => e.type !== 'folder')) items.push({ label: '下载', act: () => sel.forEach(downloadEntry) });
        if (sel.every(e => e.type !== 'folder')) {
            items.push({ label: '用浏览器打开', act: () => sel.forEach(e => {
                const path = e.type === 'msg' ? e.m.path : e.path;
                const url = path.startsWith('http') ? path : new URL(path, location.origin).href;
                window.open(url, '_blank');
            }) });
        }
        items.push({ sep: true });
        items.push({ label: '剪切', disabled: sel.some(insideSystemFolder), act: cutSelection });
        items.push({ label: '复制', disabled: sel.some(e => e.type === 'folder'), act: copySelection });
        items.push({ label: '删除', disabled: !sel.every(canDelete), act: () => deleteEntries(sel) });
        items.push({ label: '重命名', disabled: !(single && canRename(single)), act: () => single && openRename(single) });
        const placed = sel.filter(e => e.type === 'msg' && !insideSystemFolder(e) && fileItemOf(e.m.id));
        if (placed.length) items.push({ label: '移回分类文件夹', act: () => removePlacements(placed) });
        const fileSel = sel.filter(e => e.type !== 'folder');
        if (fileSel.length) {
            items.push({ sep: true });
            items.push({ label: '压缩为 ZIP', act: () => compressSelection(fileSel) });
            if (single && isArchive(single)) items.push({ label: '解压到桌面', act: () => extractSelection(single) });
        }
    } else if (ctx.scope === 'shared') {
        items.push({ label: '打开', act: openSharedFolder });
        items.push({ label: '上传文件', act: pickSharedUpload });
        items.push({ label: '刷新', act: loadShared });
    } else if (ctx.scope === 'folder' && ctx.isSystem) {
        items.push({ label: '系统文件夹（只读）', disabled: true });
        items.push({ sep: true });
        items.push({ label: '刷新', act: load });
    } else {
        items.push({ label: '新建文本文件 (.txt)', act: () => newTextFile(ctx.parentId || 0, 'txt') });
        items.push({ label: '新建 Markdown (.md)', act: () => newTextFile(ctx.parentId || 0, 'md') });
        items.push({ label: '新建 HTML (.html)', act: () => newTextFile(ctx.parentId || 0, 'html') });
        items.push({ sep: true });
        items.push({ label: '新建文件夹', act: () => newFolder(ctx.parentId || 0) });
        items.push({ label: '粘贴', disabled: !hasClipboard(), act: () => pasteTo(ctx.parentId || 0) });
        items.push({ sep: true });
        if (ctx.scope === 'desktop') {
            items.push({ label: '更换壁纸', act: openWallpaperDialog });
            items.push({ sep: true });
        }
        items.push({ label: '刷新', act: load });
    }
    menu.innerHTML = items.map((it, i) => it.sep ? '<div class="cm-sep"></div>'
        : '<div class="cm-item' + (it.disabled ? ' disabled' : '') + '" data-i="' + i + '">' + it.label + '</div>').join('');
    menu.classList.add('open');
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = Math.min(x, window.innerWidth - mw - 6) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - mh - 6) + 'px';
    menu.querySelectorAll('.cm-item').forEach(el => {
        el.addEventListener('click', function () {
            const it = items[parseInt(el.dataset.i)];
            closeContextMenu();
            if (it && !it.disabled && it.act) it.act();
        });
    });
}
function closeContextMenu() { document.getElementById('contextMenu').classList.remove('open'); }

function insideSystemFolder(e) {
    if (!e) return false;
    if (e.type === 'folder') return !!e.f.system_key;
    if (e.type === 'msg') { const f = folderById(fileLocation(e.m.id)); return !!(f && f.system_key); }
    if (e.type === 'copy') { const f = folderById(e.copy.parent_id); return !!(f && f.system_key); }
    return false;
}
function canDelete(e) { if (insideSystemFolder(e)) return false; return e.type === 'folder' ? true : (e.type === 'copy' || (e.m && e.m.can_edit)); }
function canRename(e) { if (insideSystemFolder(e)) return false; return e.type === 'folder' ? true : (e.type === 'copy' || (e.m && e.m.can_edit)); }

/* ---------------- operations ---------------- */
function newFolder(parentId) {
    const name = prompt('新建文件夹名称', '新建文件夹');
    if (!name || !name.trim()) return;
    fetch(API + '/api/desktop/folder', { method: 'POST', headers: headers(), body: JSON.stringify({ name: name.trim(), parent_id: parentId }) })
        .then(r => r.json()).then(d => { if (d.code === 200) load(); else toast(d.msg || '创建失败'); });
}
const NEW_EXT_LABEL = { txt: '文本文件 (.txt)', md: 'Markdown (.md)', html: 'HTML (.html)' };
function newTextFile(parentId, ext) {
    const name = prompt('新建' + NEW_EXT_LABEL[ext] + ' 的名称', '新建文档.' + ext);
    if (!name || !name.trim()) return;
    let fn = name.trim();
    if (!fn.toLowerCase().endsWith('.' + ext)) fn += '.' + ext;
    let content = '';
    if (ext === 'html') content = '<!DOCTYPE html>\n<html lang="zh">\n<head>\n<meta charset="utf-8">\n<title>' + esc(fn) + '</title>\n</head>\n<body>\n\n</body>\n</html>';
    fetch(API + '/api/desktop/newfile', { method: 'POST', headers: headers(), body: JSON.stringify({ name: fn, parent_id: parentId, content: content }) })
        .then(r => r.json()).then(d => { if (d.code === 200) { toast('已创建：' + fn); load(); } else toast(d.msg || '创建失败'); });
}
function openRename(e) {
    renameCtx = e;
    const d = entryDisplay(e);
    document.getElementById('renameLabel').textContent = '重命名为';
    document.getElementById('renameInput').value = d.name;
    document.getElementById('renameModal').classList.add('open');
    setTimeout(() => document.getElementById('renameInput').focus(), 80);
}
function hideRenameModal() { document.getElementById('renameModal').classList.remove('open'); }
async function submitRename() {
    const name = document.getElementById('renameInput').value.trim();
    if (!name || !renameCtx) { hideRenameModal(); return; }
    const e = renameCtx;
    try {
        if (e.type === 'folder') await fetch(API + '/api/desktop/item/' + e.f.id, { method: 'PATCH', headers: headers(), body: JSON.stringify({ name: name }) });
        else if (e.type === 'copy') await fetch(API + '/api/desktop/item/' + e.copy.id, { method: 'PATCH', headers: headers(), body: JSON.stringify({ name: name }) });
        else await fetch(API + '/api/files/rename', { method: 'POST', headers: headers(), body: JSON.stringify({ msg_id: e.m.id, new_name: name }) });
    } catch (_) {}
    hideRenameModal(); renameCtx = null; load();
}
async function deleteEntries(entries) {
    entries = entries.filter(e => !insideSystemFolder(e));
    if (!entries.length) return;
    const names = entries.map(e => entryDisplay(e).name).join('、');
    const sharedCount = entries.filter(e => e.type === 'msg').length;
    const msg = sharedCount ? '确认删除「' + names + '」？\n其中 ' + sharedCount + ' 个共享文件会被彻底删除（聊天记录也会移除）。'
                            : '确认删除「' + names + '」？';
    if (!confirm(msg)) return;
    for (const e of entries) {
        try {
            if (e.type === 'msg') await fetch(API + '/api/chat/messages/' + e.m.id, { method: 'DELETE', headers: headers() });
            else if (e.type === 'folder') await fetch(API + '/api/desktop/item/' + e.f.id, { method: 'DELETE', headers: headers() });
            else await fetch(API + '/api/desktop/item/' + e.copy.id, { method: 'DELETE', headers: headers() });
        } catch (_) {}
    }
    state.selection.clear();
    await load();
}
async function removePlacements(entries) {
    let ok = 0;
    for (const e of entries) {
        const it = e.type === 'msg' ? fileItemOf(e.m.id) : null;
        if (!it) continue;
        try {
            const r = await fetch(API + '/api/desktop/item/' + it.id, { method: 'DELETE', headers: headers() });
            if (r.ok) ok++;
        } catch (_) {}
    }
    if (ok) toast('已移回分类文件夹');
    state.selection.clear();
    await load();
}
window.hideRenameModal = hideRenameModal;
window.submitRename = submitRename;

/* 供 app.js 创建“独立聊天浮窗”使用 */
window.qtMakeAppWindow = makeAppWindow;
window.qtAppWindows = appWindows;
window.qtRegisterApp = function (key, o) { appWindows[key] = o; updateTaskButtons(); };
window.qtUnregisterApp = function (key) { delete appWindows[key]; updateTaskButtons(); };
window.qtCloseApp = closeApp;
window.qtBringToFront = bringToFront;
window.qtUpdateTaskButtons = updateTaskButtons;

/* ---------------- open ---------------- */
function openEntry(e) {
    if (e.type === 'folder') { openFolder(e.f); return; }
    if (e.type === 'msg') { openFile(e.m); return; }
    openFile(e);
}
function downloadEntry(e) {
    const path = e.type === 'msg' ? e.m.path : e.path;
    const name = e.type === 'msg' ? e.m.name : e.name;
    const url = path.startsWith('http') ? path : new URL(path, location.origin).href;
    if (window.downloadWithProgress) {
        downloadWithProgress(url, name, token);
    } else {
        const a = document.createElement('a');
        a.href = path; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
    }
}
function openFile(item) {
    switch (item.category) {
        case 'audio': openMusicFor(item); break;
        case 'video': openApp('video', buildVideoWindow, item); break;
        case 'image': openApp('image', buildImageWindow, item); break;
        case 'pdf': openApp('pdf', buildPdfWindow, item); break;
        case 'text': openTextViewer(item); break;
        default: toast('该类型暂不支持内置打开，开始下载'); downloadEntry(item.type ? item : { type: 'msg', m: item });
    }
}
function fileRef(item) {
    if (item.type === 'copy' || item.copy) return { itemId: (item.copy ? item.copy.id : item.id), msgId: 0, name: item.name, path: item.path, ext: item.ext || extOf(item.name) };
    return { msgId: item.id || 0, itemId: 0, name: item.name, path: item.path, ext: item.ext || extOf(item.name) };
}
function openMusicFor(item) {
    openApp('music', buildMusicWindow);
    playAudioItem({ name: item.name, path: item.path });
    toast('已加入播放列表');
}

/* ================= app windows (music / video / image / pdf / zip) ================= */
function openApp(key, buildFn, arg) {
    let o = appWindows[key];
    if (o && o.el && document.body.contains(o.el)) {
        o.el.classList.remove('hidden'); o.minimized = false;
        bringToFront(o.el);
        if (arg && typeof o.onArg === 'function') o.onArg(arg);
        updateTaskButtons();
        return o;
    }
    o = buildFn(arg);
    o.minimized = false;
    appWindows[key] = o;
    updateTaskButtons();
    return o;
}
function closeApp(key) { const o = appWindows[key]; if (o && typeof o.onClose === 'function') { try { o.onClose(); } catch (_) {} } if (o && o.el) o.el.remove(); delete appWindows[key]; updateTaskButtons(); }
function minimizeApp(key) { const o = appWindows[key]; if (!o || !o.el) return; o.minimized = true; o.el.classList.add('hidden'); updateTaskButtons(); }

function makeAppWindow(key, title, bodyHtml, opts) {
    opts = opts || {};
    const el = document.createElement('div');
    el.className = 'qt-window app-window app-' + key;
    el.id = 'app-' + key;
    el.dataset.icon = opts.icon || '';
    el.innerHTML =
        '<div class="qt-titlebar"><span class="win-title" style="text-align:left;padding-left:6px">' + esc(title) + '</span>' +
        '<div class="win-controls"><button class="win-btn win-min" title="最小化">—</button><button class="win-btn win-close" title="关闭">✕</button></div></div>' +
        '<div class="qt-body app-body">' + bodyHtml + '</div>';
    document.getElementById('folderWindows').appendChild(el);
    el.querySelector('.win-min').addEventListener('click', function () { minimizeApp(key); });
    el.querySelector('.win-close').addEventListener('click', function () { closeApp(key); });
    el.querySelector('.qt-body').addEventListener('contextmenu', function (ev) { ev.stopPropagation(); });
    if (opts.w) el.style.width = opts.w + 'px';
    if (opts.h) el.style.height = opts.h + 'px';
    el.style.left = (opts.left != null ? opts.left : (140 + Object.keys(appWindows).length * 32)) + 'px';
    el.style.top = (opts.top != null ? opts.top : (72 + Object.keys(appWindows).length * 30)) + 'px';
    makeWindow(el, { minW: opts.minW || 340, minH: opts.minH || 240, storageKey: 'qt_app_' + key });
    bringToFront(el);
    return { el: el };
}

/* ----- music player window ----- */
function buildMusicWindow() {
    const o = makeAppWindow('music', '音乐播放器', playerCoreHtml(), { w: 350, h: 520, minW: 300, minH: 360, icon: '' });
    o.el.querySelector('.app-body').classList.add('app-music');
    bindPlayerCore(o.el);
    paintAudio(o);
    return o;
}

/* ----- global video playlist + player ----- */
function vplKey() { return 'qt_videoplaylist_' + (state.username || 'me'); }
function saveVpl() { try { localStorage.setItem(vplKey(), JSON.stringify(state.vplaylist)); } catch (_) {} }
function loadVpl() { try { state.vplaylist = JSON.parse(localStorage.getItem(vplKey()) || '[]'); } catch (_) { state.vplaylist = []; } }
state.vplaylist = []; state.vcurrent = -1; state.vmode = 'all';

function registerVideoEl(v) {
    if (!v || v._reg) return;
    v._reg = true; videoEls.push(v);
    v.addEventListener('play', function () { videoEls.forEach(function (x) { if (x !== v && !x.paused) x.pause(); }); });
}
function addToVpl(item) {
    let i = state.vplaylist.findIndex(x => x.path === item.path);
    if (i === -1) { state.vplaylist.push({ name: item.name, path: item.path }); saveVpl(); i = state.vplaylist.length - 1; }
    return i;
}
function loadVideoSrc(v, i) { const it = state.vplaylist[i]; if (!it) return; v.src = API + it.path; v.loop = (state.vmode === 'single'); }
function playVideoIndex(i, v) {
    if (i < 0 || i >= state.vplaylist.length) return;
    state.vcurrent = i; loadVideoSrc(v, i); v.play().catch(function () {}); refreshVideoPanels();
}
function playVideoItem(item, v) { playVideoIndex(addToVpl(item), v); }
function vTogglePlay(v) { if (state.vcurrent === -1) { if (state.vplaylist.length) playVideoIndex(0, v); return; } v.paused ? v.play().catch(function () {}) : v.pause(); }
function vPrev(v) { const n = state.vplaylist.length; if (n) playVideoIndex((state.vcurrent - 1 + n) % n, v); }
function vNext(v) {
    const n = state.vplaylist.length; if (!n) return;
    if (state.vmode === 'shuffle') { if (n === 1) return playVideoIndex(0, v); let r; do { r = Math.floor(Math.random() * n); } while (r === state.vcurrent); return playVideoIndex(r, v); }
    playVideoIndex((state.vcurrent + 1) % n, v);
}
function vOnEnded(v) { if (state.vmode === 'single') playVideoIndex(state.vcurrent, v); else vNext(v); }
function vCycleMode() { state.vmode = state.vmode === 'all' ? 'shuffle' : state.vmode === 'shuffle' ? 'single' : 'all'; videoEls.forEach(function (x) { x.loop = (state.vmode === 'single'); }); refreshVideoPanels(); }
function vAddByKeys(keys) {
    const entries = keys.map(k => state.entryMap[k]).filter(Boolean); let added = 0;
    entries.forEach(e => {
        const it = e.type === 'msg' ? e.m : (e.type === 'copy' ? e : null);
        if (it && it.category === 'video' && !state.vplaylist.some(x => x.path === it.path)) { state.vplaylist.push({ name: it.name, path: it.path }); added++; }
    });
    if (added) { saveVpl(); refreshVideoPanels(); }
    return added;
}
function videoUiHtml() {
    return '<div class="video-panel">' +
        '<div class="video-stage"><video controls playsinline></video></div>' +
        '<div class="video-bar"><button class="vprev" title="上一个">上一个</button><button class="vplay" title="播放/暂停">播放</button><button class="vnext" title="下一个">下一个</button><button class="vmode" title="循环模式">循环</button></div>' +
        '<div class="vlist"></div>' +
    '</div>';
}
function bindVideoUi(scopeEl, initialItem, autoplay) {
    const v = scopeEl.querySelector('.video-stage video');
    registerVideoEl(v);
    scopeEl.querySelector('.vplay').addEventListener('click', function () { vTogglePlay(v); });
    scopeEl.querySelector('.vprev').addEventListener('click', function () { vPrev(v); });
    scopeEl.querySelector('.vnext').addEventListener('click', function () { vNext(v); });
    scopeEl.querySelector('.vmode').addEventListener('click', function () { vCycleMode(); });
    v.addEventListener('timeupdate', refreshVideoPanels);
    v.addEventListener('play', refreshVideoPanels);
    v.addEventListener('pause', refreshVideoPanels);
    v.addEventListener('ended', function () { vOnEnded(v); });
    if (initialItem) { const i = addToVpl({ name: initialItem.name, path: initialItem.path }); state.vcurrent = i; loadVideoSrc(v, i); if (autoplay) v.play().catch(function () {}); }
    else if (state.vcurrent >= 0 && state.vplaylist[state.vcurrent]) loadVideoSrc(v, state.vcurrent);
    return v;
}
function refreshVideoPanels() {
    for (let i = videoEls.length - 1; i >= 0; i--) { if (!document.body.contains(videoEls[i])) videoEls.splice(i, 1); }
    Object.keys(openFolders).forEach(fid => { const o = openFolders[fid]; if (o && o.el) paintVideo(o); });
    Object.keys(appWindows).forEach(k => { const o = appWindows[k]; if (o && o.el) paintVideo(o); });
}
function paintVideo(o) {
    if (!o || !o.el) return;
    const panel = o.el.querySelector('.video-panel'); if (!panel) return;
    const v = panel.querySelector('.video-stage video'); if (!v) return;
    panel.querySelector('.vplay').textContent = (!v.paused) ? '暂停' : '播放';
    const modeBtn = panel.querySelector('.vmode');
    modeBtn.textContent = { single: '单曲', all: '列表', shuffle: '随机' }[state.vmode];
    modeBtn.title = { single: '单集循环', all: '列表循环', shuffle: '随机播放' }[state.vmode];
    const list = panel.querySelector('.vlist');
    const sig = state.vcurrent + '|' + v.paused + '|' + state.vmode + '|' + state.vplaylist.length;
    if (o._vsig === sig) return;
    o._vsig = sig;
    if (!state.vplaylist.length) { list.innerHTML = '<div class="vempty">视频列表为空<br>双击视频文件或拖入视频</div>'; return; }
    list.innerHTML = state.vplaylist.map((it, i) =>
        '<div class="vitem' + (i === state.vcurrent ? ' active' : '') + '" data-i="' + i + '">' +
            '<span class="v-idx">' + (i === state.vcurrent && !v.paused ? '▶' : (i + 1)) + '</span>' +
            '<span class="v-name" title="' + esc(it.name) + '">' + esc(it.name) + '</span>' +
            '<button class="v-remove" data-r="' + i + '">✕</button></div>').join('');
    list.querySelectorAll('.vitem').forEach(el => el.addEventListener('click', function (ev) { if (!ev.target.classList.contains('v-remove')) playVideoIndex(parseInt(el.dataset.i), v); }));
    list.querySelectorAll('.v-remove').forEach(b => b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        const i = parseInt(b.dataset.r); state.vplaylist.splice(i, 1);
        if (i < state.vcurrent) state.vcurrent--; else if (i === state.vcurrent) { v.pause(); v.removeAttribute('src'); v.load(); state.vcurrent = state.vplaylist.length ? Math.min(i, state.vplaylist.length - 1) : -1; }
        if (state.vcurrent >= 0) loadVideoSrc(v, state.vcurrent);
        saveVpl(); refreshVideoPanels();
    }));
}
function renderVideoPanel(o, panelEl, item) {
    panelEl.innerHTML = panelHead(item) + videoUiHtml();
    bindVideoUi(panelEl, { name: item.name, path: item.path }, false);
    paintVideo(o);
}
function buildVideoWindow(arg) {
    const o = makeAppWindow('video', '视频播放器', videoUiHtml(), { w: 540, h: 540, minW: 360, minH: 320, icon: '' });
    const body = o.el.querySelector('.app-body');
    body.addEventListener('dragover', function (ev) { ev.preventDefault(); });
    body.addEventListener('drop', function (ev) { ev.preventDefault(); const keys = dragKeys(ev); const before = state.vplaylist.length; vAddByKeys(keys); if (state.vplaylist.length > before) playVideoIndex(before, o.el.querySelector('.video-stage video')); });
    bindVideoUi(o.el, arg || null, true);
    o.onArg = function (item) { if (item) playVideoItem({ name: item.name, path: item.path }, o.el.querySelector('.video-stage video')); };
    paintVideo(o);
    return o;
}

/* ----- image viewer / editor ----- */
function imageUiHtml() {
    return '<div class="img-tools">' +
        '<button class="im-zoomout" title="缩小">－</button><span class="zoom-label">100%</span><button class="im-zoomin" title="放大">＋</button>' +
        '<button class="im-ccw" title="左转 90°">⟲</button><button class="im-cw" title="右转 90°">⟳</button>' +
        '<button class="im-fliph" title="水平翻转">⇋</button><button class="im-flipv" title="垂直翻转">⇅</button>' +
        '<button class="im-reset" title="重置">重置</button>' +
        '<button class="im-save primary" title="保存为新文件">保存副本</button>' +
        '<button class="im-download" title="下载">下载</button>' +
    '</div><div class="img-stage"><img alt=""></div>';
}
function bindImageUi(scopeEl, ref, opts) {
    opts = opts || {};
    const img = scopeEl.querySelector('.img-stage img');
    img.src = ref.path;
    const st = { ops: [], zoom: 1 };
    function paint() {
        let rot = 0, sx = 1, sy = 1;
        st.ops.forEach(op => { if (op === 'rotate_cw') rot += 90; else if (op === 'rotate_ccw') rot -= 90; else if (op === 'flip_h') sx *= -1; else if (op === 'flip_v') sy *= -1; });
        img.style.transform = 'rotate(' + rot + 'deg) scale(' + (st.zoom * sx) + ',' + (st.zoom * sy) + ')';
        const zl = scopeEl.querySelector('.zoom-label'); if (zl) zl.textContent = Math.round(st.zoom * 100) + '%';
    }
    scopeEl.querySelector('.im-zoomin').addEventListener('click', function () { st.zoom = Math.min(6, st.zoom * 1.25); paint(); });
    scopeEl.querySelector('.im-zoomout').addEventListener('click', function () { st.zoom = Math.max(0.1, st.zoom / 1.25); paint(); });
    scopeEl.querySelector('.im-ccw').addEventListener('click', function () { st.ops.push('rotate_ccw'); paint(); });
    scopeEl.querySelector('.im-cw').addEventListener('click', function () { st.ops.push('rotate_cw'); paint(); });
    scopeEl.querySelector('.im-fliph').addEventListener('click', function () { st.ops.push('flip_h'); paint(); });
    scopeEl.querySelector('.im-flipv').addEventListener('click', function () { st.ops.push('flip_v'); paint(); });
    scopeEl.querySelector('.im-reset').addEventListener('click', function () { st.ops = []; st.zoom = 1; paint(); });
    scopeEl.querySelector('.im-download').addEventListener('click', function () {
        const url = ref.path.startsWith('http') ? ref.path : new URL(ref.path, location.origin).href;
        if (window.downloadWithProgress) downloadWithProgress(url, ref.name, token);
        else { const a = document.createElement('a'); a.href = ref.path; a.download = ref.name; document.body.appendChild(a); a.click(); a.remove(); }
    });
    scopeEl.querySelector('.im-save').addEventListener('click', async function () {
        const btn = this; btn.disabled = true; btn.textContent = '保存中…';
        const payload = { ops: st.ops, parent_id: opts.parentId || 0 };
        if (ref.msgId) payload.msg_id = ref.msgId; else if (ref.itemId) payload.item_id = ref.itemId;
        try {
            const d = await (await fetch(API + '/api/desktop/image-edit', { method: 'POST', headers: headers(), body: JSON.stringify(payload) })).json();
            if (d.code === 200) { toast('已保存副本：' + d.data.name); img.src = d.data.path; ref.path = d.data.path; st.ops = []; st.zoom = 1; paint(); load(); }
            else toast(d.msg || '保存失败');
        } catch (_) { toast('保存失败'); }
        btn.disabled = false; btn.textContent = '保存副本';
    });
    paint();
}
function renderImagePanel(o, panelEl, item) {
    const ref = fileRef(item);
    panelEl.innerHTML = panelHead(item) + imageUiHtml();
    bindImageUi(panelEl, ref, { parentId: o.folder.id });
}
function buildImageWindow(arg) {
    const o = makeAppWindow('image', '图片查看器', '', { w: 660, h: 540, minW: 380, minH: 320, icon: '' });
    const body = o.el.querySelector('.app-body');
    body.addEventListener('dragover', function (ev) { ev.preventDefault(); });
    body.addEventListener('drop', function (ev) { ev.preventDefault(); const keys = dragKeys(ev); const e = keys.map(k => state.entryMap[k]).find(x => x && x.category === 'image'); if (e) setImageWindow(o, e.type === 'msg' ? e.m : e); });
    if (arg) setImageWindow(o, arg);
    else body.innerHTML = '<div class="empty-hint">把图片拖到这里<br>或在文件夹中双击图片</div>';
    return o;
}
function setImageWindow(o, item) {
    const ref = fileRef(item);
    const body = o.el.querySelector('.app-body');
    body.innerHTML = imageUiHtml();
    o.el.querySelector('.win-title').textContent = ref.name;
    o.el.style.width = o.el.offsetWidth + 'px';
    bindImageUi(body, ref, { parentId: 0 });
}

/* ----- pdf reader ----- */
function buildPdfWindow(arg) {
    const o = makeAppWindow('pdf', 'PDF 阅读器', '', { w: 720, h: 560, minW: 360, minH: 320, icon: '' });
    const body = o.el.querySelector('.app-body');
    body.classList.add('pdf-body');
    body.addEventListener('dragover', function (ev) { ev.preventDefault(); });
    body.addEventListener('drop', function (ev) { ev.preventDefault(); const keys = dragKeys(ev); const e = keys.map(k => state.entryMap[k]).find(x => x && x.category === 'pdf'); if (e) setPdfWindow(o, e.type === 'msg' ? e.m : e); });
    if (arg) setPdfWindow(o, arg);
    else body.innerHTML = '<div class="empty-hint">把 PDF 文件拖到这里<br>或在文件夹中双击 PDF</div>';
    return o;
}
function setPdfWindow(o, item) {
    o.el.querySelector('.win-title').textContent = item.name;
    o.el.querySelector('.app-body').innerHTML = '<iframe src="' + esc(item.path) + '" title="pdf"></iframe>';
}

/* ----- compression tool ----- */
function buildZipWindow() {
    const o = makeAppWindow('zip', '压缩软件', '', { w: 430, h: 440, minW: 340, minH: 300, icon: '' });
    renderZipBody(o);
    return o;
}
function renderZipBody(o) {
    const body = o.el.querySelector('.app-body');
    body.innerHTML =
        '<div class="zip-body">' +
            '<div class="zip-drop"><div class="zip-hint">把文件 / 压缩包拖到这里<br>（也可在桌面右键选择压缩 / 解压）</div><div class="zip-files"></div></div>' +
            '<div class="zip-actions">' +
                '<button class="zip-make">压缩为 ZIP</button>' +
                '<button class="zip-extract ghost">解压压缩包</button>' +
                '<button class="zip-clear ghost">清空</button>' +
            '</div>' +
        '</div>';
    const drop = body.querySelector('.zip-drop');
    drop.addEventListener('dragover', function (ev) { ev.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });
    drop.addEventListener('drop', function (ev) { ev.preventDefault(); drop.classList.remove('over'); dragKeys(ev).forEach(k => { if (zipPending.indexOf(k) === -1) zipPending.push(k); }); paintZip(o); });
    body.querySelector('.zip-make').addEventListener('click', doCompress);
    body.querySelector('.zip-extract').addEventListener('click', doExtract);
    body.querySelector('.zip-clear').addEventListener('click', function () { zipPending = []; paintZip(o); });
    paintZip(o);
}
function entryCat(e) { return e.type === 'msg' ? e.m.category : e.category; }
function entryExt(e) { return e.type === 'msg' ? e.m.ext : e.ext; }
function isArchive(e) { return ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz'].indexOf(entryExt(e)) >= 0 || entryCat(e) === 'archive'; }
function paintZip(o) {
    const wrap = o.el.querySelector('.zip-files'); if (!wrap) return;
    const ents = zipPending.map(k => state.entryMap[k]).filter(Boolean);
    if (!ents.length) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = ents.map((e, i) => '<div class="zip-file"><span></span><span class="zf-name" title="' + esc(entryDisplay(e).name) + '">' + esc(entryDisplay(e).name) + '</span><button class="zf-remove" data-i="' + i + '">✕</button></div>').join('');
    wrap.querySelectorAll('.zf-remove').forEach(b => b.addEventListener('click', function (ev) { ev.stopPropagation(); zipPending.splice(parseInt(b.dataset.i), 1); paintZip(o); }));
}
async function doCompress() {
    const ents = zipPending.map(k => state.entryMap[k]).filter(Boolean);
    const msg_ids = ents.filter(e => e.type === 'msg').map(e => e.id);
    const item_ids = ents.filter(e => e.type === 'copy').map(e => e.copy.id);
    if (!msg_ids.length && !item_ids.length) { toast('请先拖入要压缩的文件'); return; }
    const name = prompt('压缩包名称', '新建压缩包'); if (name === null) return;
    try {
        const d = await (await fetch(API + '/api/desktop/compress', { method: 'POST', headers: headers(), body: JSON.stringify({ msg_ids: msg_ids, item_ids: item_ids, parent_id: 0, name: name }) })).json();
        if (d.code === 200) { toast('已生成：' + d.data.name); zipPending = []; const o = appWindows.zip; if (o) paintZip(o); load(); }
        else toast(d.msg || '压缩失败');
    } catch (_) { toast('压缩失败'); }
}
async function doExtract() {
    const ents = zipPending.map(k => state.entryMap[k]).filter(Boolean);
    const arc = ents.find(isArchive);
    if (!arc) { toast('请拖入 zip / tar / gz 压缩包'); return; }
    const payload = { parent_id: 0 };
    if (arc.type === 'msg') payload.msg_id = arc.id; else payload.item_id = arc.copy.id;
    try {
        const d = await (await fetch(API + '/api/desktop/extract', { method: 'POST', headers: headers(), body: JSON.stringify(payload) })).json();
        if (d.code === 200) { toast('解压出 ' + d.data.extracted + ' 个文件 → 文件夹「' + d.data.folder_name + '」'); zipPending = []; const o = appWindows.zip; if (o) paintZip(o); load(); }
        else toast(d.msg || '解压失败');
    } catch (_) { toast('解压失败'); }
}
async function compressSelection(entries) {
    const msg_ids = entries.filter(e => e.type === 'msg').map(e => e.id);
    const item_ids = entries.filter(e => e.type === 'copy').map(e => e.copy.id);
    if (!msg_ids.length && !item_ids.length) { toast('没有可压缩的文件'); return; }
    const name = prompt('压缩包名称', '新建压缩包'); if (name === null) return;
    try {
        const d = await (await fetch(API + '/api/desktop/compress', { method: 'POST', headers: headers(), body: JSON.stringify({ msg_ids: msg_ids, item_ids: item_ids, parent_id: 0, name: name }) })).json();
        toast(d.code === 200 ? ('已生成：' + d.data.name) : (d.msg || '压缩失败'));
        if (d.code === 200) load();
    } catch (_) { toast('压缩失败'); }
}
async function extractSelection(entry) {
    const payload = { parent_id: 0 };
    if (entry.type === 'msg') payload.msg_id = entry.id; else payload.item_id = entry.copy.id;
    try {
        const d = await (await fetch(API + '/api/desktop/extract', { method: 'POST', headers: headers(), body: JSON.stringify(payload) })).json();
        toast(d.code === 200 ? ('解压出 ' + d.data.extracted + ' 个文件') : (d.msg || '解压失败'));
        if (d.code === 200) load();
    } catch (_) { toast('解压失败'); }
}

/* ---------------- viewers (text only) ---------------- */
function openViewer(id) { document.getElementById(id).classList.add('open'); }
function closeViewer(id) { document.getElementById(id).classList.remove('open'); }
window.closeViewer = closeViewer;
async function openTextViewer(item) {
    try {
        const isMsg = item.type !== 'copy';
        let content;
        if (isMsg && item.id) {
            const d = await (await fetch(API + '/api/files/content?msg_id=' + item.id, { headers: headers() })).json();
            if (d.code !== 200) { toast(d.msg || '无法打开'); return; }
            content = d.data.content;
        } else {
            content = await (await fetch(API + item.path + '?t=' + Date.now(), { headers: headers() })).text();
        }
        textSaveRef = isMsg ? { msg_id: item.id } : { item_id: item.id };
        textItem = item;
        document.getElementById('textViewerName').textContent = item.name;
        document.getElementById('textEditor').value = content;
        const dl = document.getElementById('textViewerDl');
        dl.onclick = (ev) => {
            ev.preventDefault();
            const url = item.path.startsWith('http') ? item.path : new URL(item.path, location.origin).href;
            if (window.downloadWithProgress) downloadWithProgress(url, item.name, token);
            else { const a = document.createElement('a'); a.href = item.path; a.download = item.name; a.click(); }
        };
        document.getElementById('textSaveBtn').style.display = textSaveRef ? '' : 'none';
        document.getElementById('textPreviewBtn').style.display = (item.ext === 'md' || item.ext === 'markdown') ? '' : 'none';
        document.getElementById('textPreview').style.display = 'none';
        document.getElementById('textEditor').style.display = '';
        openViewer('textViewer');
    } catch (_) { toast('打开失败'); }
}
async function saveTextFile() {
    if (!textSaveRef) return;
    const body = { content: document.getElementById('textEditor').value };
    if (textSaveRef.msg_id) body.msg_id = textSaveRef.msg_id;
    if (textSaveRef.item_id) body.item_id = textSaveRef.item_id;
    const btn = document.getElementById('textSaveBtn'); btn.disabled = true; btn.textContent = '保存中…';
    try {
        const d = await (await fetch(API + '/api/files/content', { method: 'POST', headers: headers(), body: JSON.stringify(body) })).json();
        if (d.code === 200) { toast('已保存'); load(); } else toast(d.msg || '保存失败');
    } catch (_) { toast('保存失败'); }
    btn.disabled = false; btn.textContent = '保存';
}
window.saveTextFile = saveTextFile;
function toggleTextPreview() {
    const editor = document.getElementById('textEditor'), preview = document.getElementById('textPreview'), btn = document.getElementById('textPreviewBtn');
    if (preview.style.display === 'none') {
        const isMd = textItem && (textItem.ext === 'md' || textItem.ext === 'markdown');
        preview.innerHTML = isMd ? mdToHtml(editor.value) : '<pre style="white-space:pre-wrap;word-break:break-word">' + esc(editor.value) + '</pre>';
        preview.style.display = ''; editor.style.display = 'none'; btn.textContent = '原文';
    } else { preview.style.display = 'none'; editor.style.display = ''; btn.textContent = '预览'; }
}
window.toggleTextPreview = toggleTextPreview;

function mdToHtml(md) {
    let s = esc(md);
    const blocks = [];
    s = s.replace(/```([\s\S]*?)```/g, function (m, code) { blocks.push('<pre><code>' + code.replace(/^\w*\n/, '') + '</code></pre>'); return '\u0000B' + (blocks.length - 1) + '\u0000'; });
    s = s.replace(/^######\s?(.*)$/gm, '<h6>$1</h6>').replace(/^#####\s?(.*)$/gm, '<h5>$1</h5>')
         .replace(/^####\s?(.*)$/gm, '<h4>$1</h4>').replace(/^###\s?(.*)$/gm, '<h3>$1</h3>')
         .replace(/^##\s?(.*)$/gm, '<h2>$1</h2>').replace(/^#\s?(.*)$/gm, '<h1>$1</h1>');
    s = s.replace(/^\s*&gt;\s?(.*)$/gm, '<blockquote>$1</blockquote>');
    s = s.replace(/^\s*([-*+])\s+(.*)$/gm, '<li>$2</li>');
    s = s.replace(/^---$/gm, '<hr>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>')
         .replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    s = s.split(/\n{2,}/).map(p => /^\s*<\/?(h\d|ul|ol|li|pre|blockquote|hr)/.test(p) ? p : '<p>' + p.replace(/\n/g, '<br>') + '</p>').join('\n');
    return s.replace(/\u0000B(\d+)\u0000/g, (m, i) => blocks[+i]);
}

/* ---------------- music player (rendered inside folder panel) ---------------- */
/* 多播放列表：state.lists = [{id,name,items:[{name,path}]}], state.playlist 指向当前列表的 items */
function playlistsKey() { return 'qt_playlists_' + (state.username || 'me'); }
function legacyPlaylistKey() { return 'qt_playlist_' + (state.username || 'me'); }
function newListId() { return 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function activeList() { return state.lists.find(l => l.id === state.activeList) || null; }
function defaultListName() {
    const names = new Set(state.lists.map(l => l.name));
    let n = 1; while (names.has('播放列表' + n)) n++;
    return '播放列表' + n;
}
function saveLists() {
    try { localStorage.setItem(playlistsKey(), JSON.stringify({ lists: state.lists, active: state.activeList })); } catch (_) {}
}
function loadLists() {
    let data = null;
    try { data = JSON.parse(localStorage.getItem(playlistsKey()) || 'null'); } catch (_) {}
    if (data && Array.isArray(data.lists) && data.lists.length) {
        state.lists = data.lists.map(l => ({ id: l.id || newListId(), name: l.name || '播放列表', items: Array.isArray(l.items) ? l.items : [] }));
        state.activeList = state.lists.some(l => l.id === data.active) ? data.active : state.lists[0].id;
    } else {
        // 迁移旧的单列表数据
        let legacy = [];
        try { legacy = JSON.parse(localStorage.getItem(legacyPlaylistKey()) || '[]'); } catch (_) {}
        state.lists = [{ id: newListId(), name: '默认列表', items: Array.isArray(legacy) ? legacy : [] }];
        state.activeList = state.lists[0].id;
    }
    const l = activeList();
    state.playlist = l ? l.items : [];
}
function setActiveList(id) {
    if (!state.lists.some(l => l.id === id)) return;
    state.activeList = id;
    const l = activeList();
    state.playlist = l ? l.items : [];
    state.current = -1;
    saveLists();
    refreshPanels();
}
function createList(name) {
    const l = { id: newListId(), name: (name || defaultListName()), items: [] };
    state.lists.push(l);
    state.activeList = l.id;
    state.playlist = l.items;
    state.current = -1;
    saveLists();
    refreshPanels();
    return l;
}
function renameActiveList() {
    const l = activeList(); if (!l) return;
    const name = (window.prompt('重命名播放列表', l.name) || '').trim();
    if (!name) return;
    l.name = name.slice(0, 40);
    saveLists();
    refreshPanels();
}
function deleteActiveList() {
    if (state.lists.length <= 1) { toast('至少保留一个播放列表'); return; }
    const l = activeList(); if (!l) return;
    if (!window.confirm('删除播放列表「' + l.name + '」？')) return;
    const idx = state.lists.findIndex(x => x.id === l.id);
    state.lists.splice(idx, 1);
    const next = state.lists[Math.min(idx, state.lists.length - 1)];
    state.activeList = next.id;
    state.playlist = next.items;
    state.current = -1;
    saveLists();
    refreshPanels();
}

state.lists = []; state.activeList = null;
let _listsLoaded = false;
state.playlist = []; state.current = -1; state.mode = 'all'; state.playing = false;

function ensureAudio() {
    if (audio) return audio;
    audio = new Audio(); audio.volume = 0.8;
    audio.addEventListener('ended', onTrackEnded);
    audio.addEventListener('timeupdate', refreshPanels);
    audio.addEventListener('loadedmetadata', refreshPanels);
    audio.addEventListener('play', function () { state.playing = true; refreshPanels(); });
    audio.addEventListener('pause', function () { state.playing = false; refreshPanels(); });
    return audio;
}
function playAudioItem(item) {
    const key = item.path;
    let i = state.playlist.findIndex(x => x.path === key);
    if (i === -1) { state.playlist.push({ name: item.name, path: item.path }); saveLists(); i = state.playlist.length - 1; }
    playIndex(i);
}
function playIndex(i) {
    if (i < 0 || i >= state.playlist.length) return;
    state.current = i;
    const item = state.playlist[i];
    const a = ensureAudio(); a.src = API + item.path; a.loop = (state.mode === 'single'); a.play().catch(() => {});
    refreshPanels();
}
function togglePlay() { if (state.current === -1) { if (state.playlist.length) playIndex(0); return; } const a = ensureAudio(); a.paused ? a.play().catch(() => {}) : a.pause(); }
function stopAudio() { if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); } state.playing = false; refreshPanels(); }
function nextTrack() {
    const n = state.playlist.length; if (!n) return;
    if (state.mode === 'shuffle') { if (n === 1) return playIndex(0); let r; do { r = Math.floor(Math.random() * n); } while (r === state.current); return playIndex(r); }
    playIndex((state.current + 1) % n);
}
function prevTrack() { const n = state.playlist.length; if (n) playIndex((state.current - 1 + n) % n); }
function onTrackEnded() { if (state.mode === 'single') playIndex(state.current); else nextTrack(); }
function cycleMode() { state.mode = state.mode === 'all' ? 'shuffle' : state.mode === 'shuffle' ? 'single' : 'all'; if (audio) audio.loop = (state.mode === 'single'); refreshPanels(); }
function addAudioByKeys(keys) {
    const entries = keys.map(k => state.entryMap[k]).filter(Boolean);
    let added = 0;
    entries.forEach(e => {
        const item = e.type === 'msg' ? e.m : (e.type === 'copy' ? e : null);
        if (item && item.category === 'audio' && !state.playlist.some(x => x.path === item.path)) {
            state.playlist.push({ name: item.name, path: item.path }); added++;
        }
    });
    if (added) { saveLists(); refreshPanels(); toast('已加入播放列表'); }
}
function refreshPanels() {
    Object.keys(openFolders).forEach(fid => { const o = openFolders[fid]; if (o && o.el) paintAudio(o); });
    Object.keys(appWindows).forEach(k => { const o = appWindows[k]; if (o && o.el) paintAudio(o); });
}
function paintAudio(o) {
    if (!o || !o.el) return;
    const player = o.el.querySelector('.panel-player'); if (!player) return;
    const a = ensureAudio();
    const cur = state.current >= 0 ? state.playlist[state.current] : null;
    player.querySelector('.player-now').textContent = cur ? ('正在播放：' + cur.name) : '未在播放';
    player.querySelector('.pplay').textContent = state.playing ? '暂停' : '播放';
    player.querySelector('.pcur').textContent = fmtClock(a.currentTime);
    player.querySelector('.pdur').textContent = a.duration ? fmtClock(a.duration) : '0:00';
    const seek = player.querySelector('.pseek');
    if (a.src && a.duration) seek.value = (a.currentTime / a.duration) * 1000;
    const modeBtn = player.querySelector('.pmode');
    modeBtn.textContent = { single: '单曲', all: '列表', shuffle: '随机' }[state.mode];
    modeBtn.title = { single: '单曲循环', all: '列表循环', shuffle: '随机播放' }[state.mode];
    const pl = o.el.querySelector('.panel-playlist'); if (!pl) return;
    const sig = state.current + '|' + state.playing + '|' + state.mode + '|' + state.playlist.length +
        '|' + state.activeList + '|' + state.lists.map(l => l.name).join('\u0001');
    if (o._asig === sig) return;
    o._asig = sig;
    const sel = o.el.querySelector('.pl-select');
    if (sel) sel.innerHTML = state.lists.map(l =>
        '<option value="' + l.id + '"' + (l.id === state.activeList ? ' selected' : '') + '>' + esc(l.name) + '</option>').join('');
    const del = o.el.querySelector('.pl-del');
    if (del) del.disabled = state.lists.length <= 1;
    if (!state.playlist.length) { pl.innerHTML = '<div class="playlist-empty">当前列表为空<br>双击音频文件即可播放</div>'; return; }
    pl.innerHTML = state.playlist.map((it, i) =>
        '<div class="playlist-item' + (i === state.current ? ' active' : '') + '" data-i="' + i + '">' +
            '<span class="pl-idx">' + (i === state.current && state.playing ? '▶' : (i + 1)) + '</span>' +
            '<span class="pl-name" title="' + esc(it.name) + '">' + esc(it.name) + '</span>' +
            '<button class="pl-remove" data-r="' + i + '">✕</button></div>').join('');
    pl.querySelectorAll('.playlist-item').forEach(el => el.addEventListener('click', function (ev) { if (!ev.target.classList.contains('pl-remove')) playIndex(parseInt(el.dataset.i)); }));
    pl.querySelectorAll('.pl-remove').forEach(b => b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        const i = parseInt(b.dataset.r), wasCur = i === state.current;
        state.playlist.splice(i, 1);
        if (i < state.current) state.current--; else if (wasCur) { stopAudio(); state.current = -1; }
        saveLists(); refreshPanels();
    }));
}

/* ---------------- window manager ---------------- */
function bringToFront(el) { if (!el) return; if (el.id === 'wechatWindow') return; el.style.zIndex = ++zCounter; }
function makeWindow(el, opts) {
    opts = opts || {};
    const bar = el.querySelector('.qt-titlebar');
    const minW = opts.minW || 320, minH = opts.minH || 200;
    const KEY = opts.storageKey;
    let rect = null;
    if (KEY) { try { rect = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) {} }
    if (rect) { el.style.left = rect.x + 'px'; el.style.top = rect.y + 'px'; el.style.width = rect.w + 'px'; el.style.height = rect.h + 'px'; }
    else {
        const w = Math.min(parseFloat(getComputedStyle(el).width) || 720, window.innerWidth - 40);
        const h = Math.min(parseFloat(getComputedStyle(el).height) || 480, window.innerHeight - 100);
        el.style.width = w + 'px'; el.style.height = h + 'px';
        if (opts.left != null) el.style.left = opts.left + 'px';
        if (opts.top != null) el.style.top = opts.top + 'px';
    }
    function save() { if (KEY) localStorage.setItem(KEY, JSON.stringify({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight })); }

    el.addEventListener('mousedown', function () { bringToFront(el); });

    bar.addEventListener('mousedown', function (ev) {
        if (ev.target.closest('.win-controls') || ev.target.closest('.fw-tools')) return;
        if (el.classList.contains('maximized')) return;
        const sx = ev.clientX, sy = ev.clientY, ox = el.offsetLeft, oy = el.offsetTop;
        function mv(e) {
            el.style.left = Math.min(Math.max(ox + e.clientX - sx, -(el.offsetWidth - 120)), window.innerWidth - 80) + 'px';
            el.style.top = Math.min(Math.max(oy + e.clientY - sy, 0), window.innerHeight - 40) + 'px';
        }
        function up() { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); save(); }
        document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
        ev.preventDefault();
    });
    bar.addEventListener('dblclick', function (ev) { if (!ev.target.closest('.win-controls') && !ev.target.closest('.fw-tools') && opts.maximize) opts.maximize(); });

    ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'].forEach(dir => {
        const h = document.createElement('div');
        h.className = 'qt-resize'; h.dataset.dir = dir;
        h.addEventListener('mousedown', function (ev) {
            ev.preventDefault(); ev.stopPropagation(); bringToFront(el);
            const sx = ev.clientX, sy = ev.clientY;
            const r = { l: el.offsetLeft, t: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
            function mv(e) {
                let l = r.l, t = r.t, w = r.w, hh = r.h;
                const dx = e.clientX - sx, dy = e.clientY - sy;
                if (dir.includes('e')) w = Math.max(minW, r.w + dx);
                if (dir.includes('s')) hh = Math.max(minH, r.h + dy);
                if (dir.includes('w')) { w = Math.max(minW, r.w - dx); l = r.l + (r.w - w); }
                if (dir.includes('n')) { hh = Math.max(minH, r.h - dy); t = r.t + (r.h - hh); }
                el.style.left = l + 'px'; el.style.top = t + 'px'; el.style.width = w + 'px'; el.style.height = hh + 'px';
            }
            function up() { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); save(); }
            document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
        });
        el.appendChild(h);
    });
}

function showChat() { document.getElementById('wechatWindow').classList.remove('hidden'); updateTaskButtons(); }
function hideChat() { document.getElementById('wechatWindow').classList.add('hidden'); updateTaskButtons(); }
function toggleWin(id, showFn, hideFn) { const el = document.getElementById(id); if (el.classList.contains('hidden')) showFn(); else hideFn(); }
function updateTaskButtons() {
    const chatEl = document.getElementById('wechatWindow');
    const chatVisible = chatEl && !chatEl.classList.contains('hidden');
    const chatBtn = document.getElementById('taskChatBtn');
    if (chatBtn) chatBtn.classList.toggle('active', chatVisible);
    [['music', 'taskAppmusic'], ['video', 'taskAppvideo'], ['image', 'taskAppimage'], ['pdf', 'taskApppdf'], ['zip', 'taskAppzip']].forEach(function (p) {
        const btn = document.getElementById(p[1]); const o = appWindows[p[0]];
        if (btn) btn.classList.toggle('active', !!(o && !o.minimized));
    });
    renderTaskWindows();
}
function renderTaskWindows() {
    const wrap = document.getElementById('taskWindows');
    if (!wrap) return;
    wrap.innerHTML = '';
    const items = [];
    const chatEl = document.getElementById('wechatWindow');
    if (chatEl) items.push({ kind: 'chat', el: chatEl, minimized: chatEl.classList.contains('hidden') });
    Object.keys(openFolders).forEach(function (fid) {
        const o = openFolders[fid];
        if (o && o.el && document.body.contains(o.el)) items.push({ kind: 'folder', id: fid, el: o.el, minimized: !!o.minimized });
    });
    Object.keys(appWindows).forEach(function (k) {
        const o = appWindows[k];
        if (o && o.el && document.body.contains(o.el)) items.push({ kind: 'app', id: k, el: o.el, minimized: !!o.minimized });
    });
    items.forEach(function (it) {
        const btn = document.createElement('button');
        btn.className = 'task-win' + (it.minimized ? '' : ' active');
        const icon = it.el.dataset.icon || '';
        const t = it.el.querySelector('.win-title');
        const title = t ? t.textContent.trim() : '窗口';
        btn.innerHTML = (icon ? '<span>' + icon + '</span>' : '') + '<span class="tw-title" title="' + esc(title) + '">' + esc(title) + '</span>';
        btn.addEventListener('click', function () { toggleTaskWindow(it.kind, it.id); });
        wrap.appendChild(btn);
    });
}
function toggleTaskWindow(kind, id) {
    const el = kind === 'chat' ? document.getElementById('wechatWindow')
        : (kind === 'folder' ? (openFolders[id] && openFolders[id].el) : (appWindows[id] && appWindows[id].el));
    if (!el) return;
    if (el.classList.contains('hidden')) restoreTaskWindow(kind, id);
    else minimizeTaskWindow(kind, id);
}
function minimizeTaskWindow(kind, id) {
    if (kind === 'chat') { hideChat(); return; }
    if (kind === 'folder') minimizeFolder(parseInt(id, 10)); else minimizeApp(id);
}
function restoreTaskWindow(kind, id) {
    let el = null;
    if (kind === 'chat') { el = document.getElementById('wechatWindow'); el.classList.remove('hidden'); }
    else if (kind === 'folder') { const o = openFolders[id]; if (o) { o.minimized = false; o.el.classList.remove('hidden'); el = o.el; } }
    else { const o = appWindows[id]; if (o) { o.minimized = false; o.el.classList.remove('hidden'); el = o.el; } }
    if (el) bringToFront(el);
    updateTaskButtons();
}

/* ---------------- wallpaper ---------------- */
const WALLPAPER_MODES = {
    cover:      { size: 'cover',     repeat: 'no-repeat', position: 'center center' },
    contain:    { size: 'contain',   repeat: 'no-repeat', position: 'center center' },
    stretch:    { size: '100% 100%', repeat: 'no-repeat', position: 'center center' },
    tile:       { size: 'auto',      repeat: 'repeat',    position: 'left top' },
    center:     { size: 'auto',      repeat: 'no-repeat', position: 'center center' },
    'repeat-x': { size: 'auto',      repeat: 'repeat-x',  position: 'left top' },
    'repeat-y': { size: 'auto',      repeat: 'repeat-y',  position: 'left top' },
};
const WALLPAPER_MODE_LABEL = {
    cover: '填充（裁剪铺满）',
    contain: '适应（完整显示）',
    stretch: '拉伸',
    tile: '平铺',
    center: '居中',
    'repeat-x': '横向平铺',
    'repeat-y': '纵向平铺',
};
function applyWallpaperTo(el, wp, mode) {
    if (!el) return;
    if (wp) {
        const m = WALLPAPER_MODES[mode] || WALLPAPER_MODES.cover;
        el.style.backgroundImage = 'url("' + String(wp).replace(/"/g, '%22') + '")';
        el.style.backgroundRepeat = m.repeat;
        el.style.backgroundSize = m.size;
        el.style.backgroundPosition = m.position;
        el.classList.add('has-image');
    } else {
        el.style.backgroundImage = '';
        el.style.backgroundRepeat = '';
        el.style.backgroundSize = '';
        el.style.backgroundPosition = '';
        el.classList.remove('has-image');
    }
}
function applyWallpaper(wp, mode) {
    const el = document.querySelector('#desktopRoot .wallpaper') || document.querySelector('.wallpaper');
    applyWallpaperTo(el, wp, mode);
}

let wpDraft = null;

function openWallpaperDialog() {
    wpDraft = { wallpaper: state.wallpaper, mode: state.wallpaperMode, uploads: (state.wallpaperUploads || []).slice() };
    let overlay = document.getElementById('wpOverlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'wpOverlay';
        overlay.className = 'wp-overlay';
        overlay.innerHTML =
            '<div class="wp-dialog">' +
                '<div class="wp-head"><span>桌面壁纸</span><button type="button" class="wp-close">✕</button></div>' +
                '<div class="wp-body">' +
                    '<div class="wp-preview" id="wpPreview"></div>' +
                    '<div class="wp-label">布置方式</div>' +
                    '<div class="wp-row"><select id="wpMode"></select></div>' +
                    '<div class="wp-label">图片链接</div>' +
                    '<div class="wp-row"><input id="wpUrl" type="text" placeholder="https://example.com/bg.jpg"><button type="button" id="wpUseUrl">使用链接</button></div>' +
                    '<div class="wp-label">上传图片</div>' +
                    '<div class="wp-row"><label class="wp-upload-btn">选择图片<input type="file" id="wpFile" accept="image/*" hidden></label><span id="wpUploadHint" class="wp-hint"></span></div>' +
                    '<div class="wp-label">已上传的壁纸（点击选用）</div>' +
                    '<div class="wp-gallery" id="wpGallery"></div>' +
                '</div>' +
                '<div class="wp-foot">' +
                    '<button type="button" id="wpReset">恢复默认</button>' +
                    '<div class="wp-foot-right"><button type="button" id="wpCancel">取消</button><button type="button" id="wpApply" class="primary">应用</button></div>' +
                '</div>' +
            '</div>';
        document.body.appendChild(overlay);

        const modeSel = overlay.querySelector('#wpMode');
        Object.keys(WALLPAPER_MODES).forEach(function (k) {
            const opt = document.createElement('option');
            opt.value = k;
            opt.textContent = WALLPAPER_MODE_LABEL[k] || k;
            modeSel.appendChild(opt);
        });
        modeSel.value = wpDraft.mode || 'cover';
        modeSel.addEventListener('change', function () { wpDraft.mode = modeSel.value; renderWallpaperPreview(); });

        overlay.querySelector('#wpUseUrl').addEventListener('click', function () {
            const url = overlay.querySelector('#wpUrl').value.trim();
            if (!url) { toast('请输入图片链接'); return; }
            wpDraft.wallpaper = url;
            renderWallpaperPreview();
        });
        overlay.querySelector('#wpFile').addEventListener('change', function (ev) {
            const f = ev.target.files && ev.target.files[0];
            if (f) uploadWallpaper(f);
            ev.target.value = '';
        });
        overlay.querySelector('#wpReset').addEventListener('click', function () {
            wpDraft.wallpaper = '';
            wpDraft.mode = 'cover';
            modeSel.value = 'cover';
            renderWallpaperPreview();
        });
        overlay.querySelector('#wpCancel').addEventListener('click', closeWallpaperDialog);
        overlay.querySelector('.wp-close').addEventListener('click', closeWallpaperDialog);
        overlay.addEventListener('click', function (ev) { if (ev.target === overlay) closeWallpaperDialog(); });
        overlay.querySelector('#wpApply').addEventListener('click', saveWallpaper);
    }

    overlay.querySelector('#wpUrl').value = '';
    overlay.querySelector('#wpMode').value = wpDraft.mode || 'cover';
    overlay.classList.add('open');
    renderWallpaperGallery();
    renderWallpaperPreview();
}

function closeWallpaperDialog() {
    const overlay = document.getElementById('wpOverlay');
    if (overlay) overlay.classList.remove('open');
}

function renderWallpaperPreview() {
    const el = document.getElementById('wpPreview');
    if (!el) return;
    applyWallpaperTo(el, wpDraft.wallpaper, wpDraft.mode);
}

function renderWallpaperGallery() {
    const box = document.getElementById('wpGallery');
    if (!box) return;
    if (!wpDraft.uploads.length) { box.innerHTML = '<div class="wp-gallery-empty">暂无上传的壁纸</div>'; return; }
    box.innerHTML = wpDraft.uploads.map(function (u) {
        const active = u.file_path === wpDraft.wallpaper ? ' active' : '';
        return '<div class="wp-thumb' + active + '" data-path="' + esc(u.file_path) + '" data-id="' + u.id + '" title="' + esc(u.name || '') + '">' +
            '<img src="' + esc(u.file_path) + '" alt="">' +
            '<button type="button" class="wp-del" data-id="' + u.id + '">✕</button></div>';
    }).join('');
    box.querySelectorAll('.wp-thumb').forEach(function (t) {
        t.addEventListener('click', function (ev) {
            if (ev.target.closest('.wp-del')) return;
            wpDraft.wallpaper = t.dataset.path;
            renderWallpaperGallery();
            renderWallpaperPreview();
        });
    });
    box.querySelectorAll('.wp-del').forEach(function (b) {
        b.addEventListener('click', function (ev) {
            ev.stopPropagation();
            deleteWallpaper(parseInt(b.dataset.id, 10));
        });
    });
}

async function uploadWallpaper(file) {
    const hint = document.getElementById('wpUploadHint');
    if (hint) hint.textContent = '上传中...';
    const fd = new FormData();
    fd.append('file', file);
    try {
        const r = await fetch(API + '/api/desktop/wallpaper/upload', { method: 'POST', headers: { 'X-Auth-Token': token }, body: fd });
        const d = await r.json();
        if (d.code !== 200) { if (hint) hint.textContent = d.msg || '上传失败'; return; }
        wpDraft.uploads.unshift(d.data);
        wpDraft.wallpaper = d.data.path;
        if (hint) hint.textContent = '上传成功';
        renderWallpaperGallery();
        renderWallpaperPreview();
    } catch (e) { if (hint) hint.textContent = '上传失败'; }
}

async function deleteWallpaper(id) {
    try {
        const r = await fetch(API + '/api/desktop/wallpaper/upload/' + id, { method: 'DELETE', headers: headers() });
        const d = await r.json();
        if (d.code !== 200) { toast(d.msg || '删除失败'); return; }
        const gone = wpDraft.uploads.find(function (u) { return u.id === id; });
        wpDraft.uploads = wpDraft.uploads.filter(function (u) { return u.id !== id; });
        if (gone && wpDraft.wallpaper === gone.file_path) wpDraft.wallpaper = '';
        renderWallpaperGallery();
        renderWallpaperPreview();
    } catch (e) { toast('删除失败'); }
}

async function saveWallpaper() {
    try {
        const r = await fetch(API + '/api/desktop/wallpaper', {
            method: 'POST', headers: headers(),
            body: JSON.stringify({ wallpaper: wpDraft.wallpaper, mode: wpDraft.mode })
        });
        const d = await r.json();
        if (d.code !== 200) { toast(d.msg || '保存失败'); return; }
        state.wallpaper = d.wallpaper;
        state.wallpaperMode = d.mode;
        state.wallpaperUploads = wpDraft.uploads.slice();
        applyWallpaper(state.wallpaper, state.wallpaperMode);
        closeWallpaperDialog();
        toast('壁纸已更新');
    } catch (e) { toast('保存失败'); }
}

/* ---------------- background & selection ---------------- */
function bindDesktopBackground() {
    const layer = document.getElementById('desktopIcons');
    if (layer._bound) return;
    layer._bound = true;
    layer.addEventListener('contextmenu', function (ev) {
        if (ev.target !== layer) return;
        ev.preventDefault(); openContextMenu(ev.clientX, ev.clientY, { scope: 'desktop', parentId: 0 });
    });
    layer.addEventListener('click', function (ev) { if (ev.target === layer) { state.selection.clear(); renderDesktopIcons(); } });
    layer.addEventListener('dragover', function (ev) { ev.preventDefault(); });
    layer.addEventListener('drop', async function (ev) {
        ev.preventDefault();
        if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files.length) { await uploadExternalFiles(ev.dataTransfer.files, 0, false); return; }
        const p = window._qtDragPayload;
        if (p && p.kind === 'msg-file') { placeChatFile(p.msgId, 0); return; }
        const keys = dragKeys(ev);
        if (keys.length) moveKeysTo(keys, 0);
    });
}

/* ---------------- 公共共享文件夹 ---------------- */
let _sharedFiles = [];

function buildSharedIcon() {
    const el = document.createElement('div');
    el.className = 'dt-icon dt-shared system';
    el.id = 'dtSharedFolder';
    el.dataset.kind = 'shared';
    el.innerHTML = '<span class="dt-folder"></span><span class="dt-label" title="公共共享文件夹">共享</span>';
    el.style.left = 'auto';
    el.style.right = '16px';
    el.style.top = '14px';
    el.addEventListener('dblclick', function () { openSharedFolder(); });
    el.addEventListener('dragover', function (ev) { ev.preventDefault(); ev.stopPropagation(); el.classList.add('drop-target'); });
    el.addEventListener('dragleave', function () { el.classList.remove('drop-target'); });
    el.addEventListener('drop', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        el.classList.remove('drop-target');
        if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files.length) { uploadExternalFiles(ev.dataTransfer.files, 0, true); return; }
        const p = window._qtDragPayload;
        if (p && p.kind === 'msg-file') { addMsgToShared(p.msgId); window._qtDragPayload = null; try { _qtDragPayload = null; } catch (_) {} return; }
        const keys = dragKeys(ev);
        if (keys.length) addEntriesToShared(keys);
    });
    el.addEventListener('contextmenu', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        openContextMenu(ev.clientX, ev.clientY, { scope: 'shared' });
    });
    return el;
}

async function placeChatFile(msgId, parentId) {
    window._qtDragPayload = null;
    try { _qtDragPayload = null; } catch (_) {}
    try {
        await fetch(API + '/api/desktop/place', { method: 'POST', headers: headers(), body: JSON.stringify({ msg_ids: [msgId], parent_id: parentId }) });
        await load();
        toast(parentId ? '已放入文件夹' : '已放到桌面');
    } catch (_) { toast('操作失败'); }
}

async function addMsgToShared(msgId) {
    try {
        const d = await (await fetch(API + '/api/shared/add', { method: 'POST', headers: headers(), body: JSON.stringify({ msg_id: msgId }) })).json();
        toast(d.msg || (d.code === 200 ? '已添加' : '添加失败'));
        if (d.code === 200) loadShared();
    } catch (_) { toast('添加失败'); }
}

async function addEntriesToShared(keys) {
    const entries = keys.map(k => state.entryMap[k]).filter(Boolean);
    let ok = 0, fail = 0;
    for (const e of entries) {
        let body = null;
        if (e.type === 'msg') body = { msg_id: e.m.id };
        else if (e.type === 'copy') body = { item_id: e.copy.id };
        else { fail++; continue; }
        try {
            const d = await (await fetch(API + '/api/shared/add', { method: 'POST', headers: headers(), body: JSON.stringify(body) })).json();
            if (d.code === 200) ok++; else { fail++; toast(d.msg || '添加失败'); }
        } catch (_) { fail++; }
    }
    if (ok) toast('已添加 ' + ok + ' 个文件到共享文件夹');
    else if (fail) toast('没有可添加到共享的文件');
    loadShared();
}

function pickSharedUpload() {
    let inp = document.getElementById('sharedUploadInput');
    if (!inp) {
        inp = document.createElement('input');
        inp.type = 'file';
        inp.id = 'sharedUploadInput';
        inp.style.display = 'none';
        inp.addEventListener('change', async function () {
            for (const file of inp.files || []) { await uploadSharedFile(file); }
            inp.value = '';
            loadShared();
        });
        document.body.appendChild(inp);
    }
    inp.click();
}

async function uploadSharedFile(file) {
    const fd = new FormData();
    fd.append('file', file);
    try {
        const r = await fetch(API + '/api/shared/upload', { method: 'POST', headers: { 'X-Auth-Token': token }, body: fd });
        const d = await r.json();
        if (d.code !== 200) toast(d.msg || '上传失败');
        return d;
    } catch (_) { toast('上传失败'); return { code: 500 }; }
}

async function loadShared() {
    const rows = document.getElementById('sharedRows');
    if (!rows) return;
    try {
        const d = await (await fetch(API + '/api/shared/files', { headers: headers() })).json();
        if (d.code !== 200) { rows.innerHTML = '<div class="fw-empty">加载失败</div>'; return; }
        _sharedFiles = d.data || [];
        renderShared();
    } catch (_) { rows.innerHTML = '<div class="fw-empty">网络错误</div>'; }
}

function sharedEntry(s) {
    return { type: 'copy', id: s.id, copy: { id: null, name: s.name, file_path: s.path, file_size: s.size, msg_id: null },
        name: s.name, ext: s.ext, category: s.category, size: s.size, path: s.path, sender_name: s.sender_name };
}

function renderShared() {
    const rows = document.getElementById('sharedRows');
    if (!rows) return;
    if (!_sharedFiles.length) { rows.innerHTML = '<div class="fw-empty">共享文件夹为空，把文件拖到这里或点击「上传」</div>'; return; }
    rows.innerHTML = '';
    _sharedFiles.forEach(function (s) {
        const row = document.createElement('div');
        row.className = 'dl-row shared-row';
        row.innerHTML =
            '<span class="dl-c-name"><span class="r-emoji">' + esc((s.ext || 'FILE').toString().toUpperCase()) + '</span><span class="r-name">' + esc(s.name) + '</span></span>' +
            '<span class="dl-c-size">' + fmtSize(s.size) + '</span>' +
            '<span class="dl-c-type">' + esc(s.sender_name) + '</span>' +
            '<span class="dl-c-time">' + esc(fmtTime(s.time)) + '</span>' +
            '<span class="sh-actions">' +
                '<button class="sh-act" data-act="dl" title="下载">⬇</button>' +
                '<button class="sh-act" data-act="copy" title="复制到桌面">⧉</button>' +
                (s.can_delete ? '<button class="sh-act danger" data-act="del" title="删除">🗑</button>' : '') +
            '</span>';
        row.addEventListener('dblclick', function () { openFile(sharedEntry(s)); });
        row.querySelector('[data-act="dl"]').addEventListener('click', function (ev) {
            ev.stopPropagation();
            const url = s.path.startsWith('http') ? s.path : new URL(s.path, location.origin).href;
            if (window.downloadWithProgress) downloadWithProgress(url, s.name, token);
            else { const a = document.createElement('a'); a.href = s.path; a.download = s.name; document.body.appendChild(a); a.click(); a.remove(); }
        });
        row.querySelector('[data-act="copy"]').addEventListener('click', async function (ev) {
            ev.stopPropagation();
            try {
                const d = await (await fetch(API + '/api/shared/copy', { method: 'POST', headers: headers(), body: JSON.stringify({ id: s.id }) })).json();
                toast(d.msg || (d.code === 200 ? '已复制' : '复制失败'));
                if (d.code === 200) load();
            } catch (_) { toast('复制失败'); }
        });
        const delBtn = row.querySelector('[data-act="del"]');
        if (delBtn) delBtn.addEventListener('click', async function (ev) {
            ev.stopPropagation();
            if (!confirm('删除「' + s.name + '」？')) return;
            try {
                const d = await (await fetch(API + '/api/shared/files/' + s.id, { method: 'DELETE', headers: headers() })).json();
                toast(d.msg || '已删除');
                if (d.code === 200) loadShared();
            } catch (_) { toast('删除失败'); }
        });
        rows.appendChild(row);
    });
}

function openSharedFolder() { openApp('shared', buildSharedWindow); }
function buildSharedWindow() {
    const bodyHtml =
        '<div class="shared-toolbar">' +
            '<button class="sh-up" type="button">⬆ 上传</button>' +
            '<button class="sh-paste" type="button" title="粘帖已复制的文件到共享" disabled>粘帖</button>' +
            '<button class="sh-refresh" type="button">⟳ 刷新</button>' +
            '<span class="sh-hint">所有用户可查看·复制·下载，仅上传者或超管可删除</span>' +
        '</div>' +
        '<div class="dl-body"><div class="dl-head">' +
            '<span class="dl-c-name">名称</span><span class="dl-c-size">大小</span><span class="dl-c-type">上传者</span><span class="dl-c-time">时间</span><span class="sh-actions">操作</span>' +
        '</div><div class="dl-rows" id="sharedRows"></div></div>';
    const o = makeAppWindow('shared', '公共共享文件夹', bodyHtml, { w: 760, h: 520, minW: 520, minH: 320, icon: '' });
    o.el.classList.add('shared-window');
    const body = o.el.querySelector('.app-body');
    body.classList.add('shared-body');
    o.el.querySelector('.sh-up').addEventListener('click', function () { pickSharedUpload(); });
    o.el.querySelector('.sh-paste').addEventListener('click', function () { pasteToShared(); });
    o.el.querySelector('.sh-refresh').addEventListener('click', function () { loadShared(); });
    updatePasteButtons();
    body.addEventListener('dragover', function (ev) { ev.preventDefault(); });
    body.addEventListener('drop', async function (ev) {
        ev.preventDefault();
        const files = ev.dataTransfer.files;
        if (files && files.length) { for (const f of files) { await uploadSharedFile(f); } loadShared(); }
    });
    loadShared();
    return o;
}

/* ---------------- clock ---------------- */
function tickClock() {
    const el = document.getElementById('taskClock'); if (!el) return;
    const d = new Date(), p = n => String(n).padStart(2, '0');
    el.textContent = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/* ---------------- boot ---------------- */
document.addEventListener('DOMContentLoaded', function () {
    document.addEventListener('click', closeContextMenu);
    document.addEventListener('contextmenu', function (ev) { if (!ev.target.closest('.dt-icon') && !ev.target.closest('.fw-row') && !ev.target.closest('.dl-row') && !ev.target.closest('.folder-window') && ev.target.id !== 'desktopIcons') closeContextMenu(); });

    if (!token) return;

    const chatWin = document.getElementById('wechatWindow');
    makeWindow(chatWin, {
        minW: 620, minH: 420, storageKey: 'qt_chat_win_v3', maximize: function () {
            if (chatWin.classList.contains('maximized')) chatWin.classList.remove('maximized');
            else chatWin.classList.add('maximized');
        }
    });
    document.getElementById('winMinBtn').addEventListener('click', hideChat);
    document.getElementById('winCloseBtn').addEventListener('click', hideChat);
    document.getElementById('winMaxBtn').addEventListener('click', function () { chatWin.classList.toggle('maximized'); });

    document.getElementById('taskChatBtn').addEventListener('click', function () { toggleWin('wechatWindow', showChat, hideChat); });
    document.getElementById('taskFilesBtn').addEventListener('click', function () {
        state.selection.clear();
        if (Object.keys(openFolders).length) {
            Object.keys(openFolders).forEach(fid => closeFolder(parseInt(fid, 10)));
        } else {
            state.folders.forEach(f => { if (f.system_key) openFolder(f); });
        }
    });
    document.getElementById('taskAppmusic').addEventListener('click', function () { openApp('music', buildMusicWindow); });
    document.getElementById('taskAppvideo').addEventListener('click', function () { openApp('video', buildVideoWindow); });
    document.getElementById('taskAppimage').addEventListener('click', function () { openApp('image', buildImageWindow); });
    document.getElementById('taskApppdf').addEventListener('click', function () { openApp('pdf', buildPdfWindow); });
    document.getElementById('taskAppzip').addEventListener('click', function () { openApp('zip', buildZipWindow); });

    loadVpl();
    updateTaskButtons();

    load();
    document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') { closeContextMenu(); document.querySelectorAll('.viewer-overlay.open').forEach(el => closeViewer(el.id)); }
        if (ev.key === 'Delete' && state.selection.size) {
            const entries = selectedEntries().filter(canDelete);
            if (entries.length) deleteEntries(entries);
        }
    });

    tickClock(); setInterval(tickClock, 1000);
    window.addEventListener('resize', function () { if (!document.getElementById('wechatWindow').classList.contains('maximized')) renderDesktopIcons(); });
    setInterval(load, 60000);
});
})();
