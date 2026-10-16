/* ================= 跨设备偏好同步 =================
   把「除 token/username 外的所有 localStorage」按账号同步到服务端。
   服务端为准；本地 localStorage 作为工作缓存；变更防抖上传。 */
(function () {
  'use strict';

  var TOKEN_KEY = 'token';
  var RELOAD_FLAG = 'qt_prefs_applied';
  var EXACT = ['theme', 'qt_zoom', 'qt_msg_style_v1', 'qt_resize_sizes_v3', 'qt_unread_ids'];
  var PREFIX = ['qt_playlists_', 'qt_playlist_', 'qt_videoplaylist_', 'qt_sidebar_w_', 'qt_app_', 'qt_fw_'];

  function isSync(k) {
    if (!k || k === 'token' || k === 'username') return false;
    if (EXACT.indexOf(k) >= 0) return true;
    for (var i = 0; i < PREFIX.length; i++) if (k.indexOf(PREFIX[i]) === 0) return true;
    return false;
  }

  function hasToken() { try { return !!localStorage.getItem(TOKEN_KEY); } catch (e) { return false; } }

  function collect() {
    var o = {};
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (isSync(k)) o[k] = localStorage.getItem(k);
      }
    } catch (e) {}
    return o;
  }

  var RAW_SET = Storage.prototype.setItem;
  var RAW_REMOVE = Storage.prototype.removeItem;
  var SUPPRESS = false;

  function rawSet(k, v) { RAW_SET.call(localStorage, k, String(v)); }
  function rawRemove(k) { RAW_REMOVE.call(localStorage, k); }

  function headers() {
    return { 'Content-Type': 'application/json', 'X-Auth-Token': localStorage.getItem(TOKEN_KEY) || '' };
  }
  function post(prefs) {
    if (!hasToken()) return;
    try {
      fetch('/api/user/prefs', { method: 'POST', headers: headers(), body: JSON.stringify({ prefs: prefs }) });
    } catch (e) {}
  }
  function get() {
    return fetch('/api/user/prefs', { headers: headers() }).then(function (r) { return r.json(); });
  }

  var timer = null;
  function schedule() {
    if (!hasToken()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { timer = null; post(collect()); }, 800);
  }

  Storage.prototype.setItem = function (k, v) {
    RAW_SET.call(this, k, v);
    if (this === localStorage && !SUPPRESS && isSync(k)) schedule();
  };
  Storage.prototype.removeItem = function (k) {
    RAW_REMOVE.call(this, k);
    if (this === localStorage && !SUPPRESS && isSync(k)) schedule();
  };

  function sync() {
    var local = collect();
    get().then(function (d) {
      var server = (d && d.prefs && typeof d.prefs === 'object') ? d.prefs : {};
      var merged = {}, k;
      for (k in local) if (local.hasOwnProperty(k)) merged[k] = local[k];
      for (k in server) if (server.hasOwnProperty(k)) merged[k] = server[k];

      var changed = false;
      SUPPRESS = true;
      try {
        for (k in merged) {
          if (localStorage.getItem(k) !== merged[k]) { rawSet(k, merged[k]); changed = true; }
        }
      } finally { SUPPRESS = false; }

      if (changed && !sessionStorage.getItem(RELOAD_FLAG)) {
        try { sessionStorage.setItem(RELOAD_FLAG, '1'); } catch (e) {}
        location.reload();
        return;
      }

      var localOnly = false;
      for (k in local) if (!(k in server)) { localOnly = true; break; }
      if (localOnly || (Object.keys(server).length === 0 && Object.keys(local).length > 0)) {
        post(merged);
      }
    }).catch(function () {});
  }

  if (hasToken()) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sync);
    else sync();
  }
})();
