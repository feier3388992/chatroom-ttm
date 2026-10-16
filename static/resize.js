/* talktome 通用 div 拖拽缩放引擎
   用法：给任意 div 加 data-resizable 属性即可
     data-resizable="nsew"   可拖拽方向（n/s/e/w 任意组合，缺省 nsew）
     data-rz-min="20"        最小宽高（像素），缺省 20
   运行时：QTResize.make(el, {dir:'ns', min:20})
           QTResize.reset(el)  恢复默认大小
   特点：支持鼠标/触摸、越界限制、localStorage 记忆、双击手柄还原
*/
(function () {
    'use strict';

    var DEFAULT_MIN = 20;          // 比较小的边界值
    var MAX_FACTOR = 2;            // 最大不超过视口的 2 倍
    var STORE_KEY = 'qt_resize_sizes_v3';
    var ALL_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
    var CURSOR = {
        n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
        ne: 'nesw-resize', nw: 'nesw-resize', se: 'nwse-resize', sw: 'nwse-resize'
    };

    function loadStore() {
        try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; }
    }
    function saveStore(s) {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) {}
    }
    function clamp(v, min, max) {
        if (max < min) max = min;
        return v < min ? min : (v > max ? max : v);
    }
    function elKey(el) {
        if (el.id) return '#' + el.id;
        var parts = [], node = el, depth = 0;
        while (node && node.nodeType === 1 && depth < 6) {
            var seg = node.tagName.toLowerCase();
            if (node.id) { parts.unshift('#' + node.id); break; }
            var cls = (node.getAttribute('class') || '').trim().split(/\s+/)[0];
            if (cls) seg += '.' + cls;
            var parent = node.parentElement;
            if (parent) {
                var same = Array.prototype.filter.call(parent.children, function (c) {
                    return c.tagName === node.tagName;
                });
                if (same.length > 1) seg += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
            }
            parts.unshift(seg);
            node = node.parentElement;
            depth++;
        }
        return parts.join('>');
    }

    function readSaved(el) {
        var store = loadStore();
        return store[elKey(el)] || null;
    }
    function writeSaved(el, size) {
        var store = loadStore();
        var k = elKey(el);
        if (!size) delete store[k];
        else store[k] = size;
        saveStore(store);
    }

    function applyBox(el, box) {
        if (!box) return;
        if (box.mh != null) {
            el.style.maxHeight = box.mh + 'px';   // 贴合内容模式
            return;
        }
        if (box.w != null) {
            el.style.width = box.w + 'px';
            el.style.flex = '0 0 auto';   // 否则会被父级 flex 拉伸回去，存下的尺寸失效
        }
        if (box.h != null) {
            el.style.height = box.h + 'px';
            el.style.flex = '0 0 auto';
        }
        if (box.l != null) el.style.left = box.l + 'px';
        if (box.t != null) el.style.top = box.t + 'px';
    }
    function unlockLimits(el, dir) {
        // 解除样式表里的 max-width / min-height 等限制，真正做到“随意调整”
        if (dir.indexOf('e') > -1 || dir.indexOf('w') > -1) {
            el.style.maxWidth = 'none';
            el.style.minWidth = '0';
        }
        if (dir.indexOf('n') > -1 || dir.indexOf('s') > -1) {
            el.style.maxHeight = 'none';
            el.style.minHeight = '0';
        }
    }
    function captureBox(el, dir, outOfFlow) {
        var box = {};
        if (dir === 'mh') {
            // 贴合内容模式：记录的是 max-height 上限
            box.mh = Math.round(parseFloat(el.style.maxHeight) || el.offsetHeight);
            return box;
        }
        if (dir.indexOf('e') > -1 || dir.indexOf('w') > -1) box.w = Math.round(el.offsetWidth);
        if (dir.indexOf('n') > -1 || dir.indexOf('s') > -1) box.h = Math.round(el.offsetHeight);
        // 只有脱离文档流的元素才需要记录位移，普通流内元素由布局自动定位
        if (outOfFlow) {
            if (dir.indexOf('w') > -1) box.l = Math.round(parseFloat(el.style.left) || 0);
            if (dir.indexOf('n') > -1) box.t = Math.round(parseFloat(el.style.top) || 0);
        }
        return box;
    }

    function startDrag(e, el, dir) {
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();

        var rect = el.getBoundingClientRect();
        var sx = e.clientX, sy = e.clientY;
        var sw = rect.width, sh = rect.height, sl = rect.left, st = rect.top;
        var min = parseFloat(el.getAttribute('data-rz-min')) || DEFAULT_MIN;
        var hasW = dir.indexOf('e') > -1 || dir.indexOf('w') > -1;
        var hasH = dir.indexOf('n') > -1 || dir.indexOf('s') > -1;
        var maxW = window.innerWidth * MAX_FACTOR;
        var maxH = window.innerHeight * MAX_FACTOR;
        // 脱离文档流（fixed/absolute）才需要自己算 left/top；
        // 流内元素只改宽高，由 flex 布局自动重排，绝不会出现空白/错位
        var cs = window.getComputedStyle(el);
        var outOfFlow = (cs.position === 'fixed' || cs.position === 'absolute');
        // 已被 right/bottom 锚定的元素，改宽高时对侧会自动跟随，不能再写 left/top
        var anchorRight = cs.right !== 'auto';
        var anchorBottom = cs.bottom !== 'auto';
        var baseLeft = parseFloat(el.style.left) || 0;
        var baseTop = parseFloat(el.style.top) || 0;

        // 贴合内容模式（data-rz-fit="1"）：用 max-height 控制，
        // 元素高度始终 = min(内容高, 上限)，内容少时自动缩回去，绝不留空白
        var fitContent = el.getAttribute('data-rz-fit') === '1' && hasH && !hasW;
        if (fitContent) {
            var curMax = parseFloat(el.style.maxHeight);
            if (!curMax || !isFinite(curMax)) el.style.maxHeight = Math.max(sh, min) + 'px';
        }

        // 防止被 flex 压缩 / 过渡动画影响
        var prevTransition = el.style.transition;
        var prevMaxH = el.style.maxHeight;
        unlockLimits(el, dir);
        if (fitContent) el.style.maxHeight = prevMaxH || '';   // 保留 max-height 作为控制量
        if (hasW || hasH) el.style.flex = '0 0 auto';
        el.style.transition = 'none';
        el.classList.add('rz-active');
        document.documentElement.classList.add('rz-resizing');

        function onMove(ev) {
            var dx = ev.clientX - sx, dy = ev.clientY - sy;
            var w = sw, h = sh;
            if (hasW) w = dir.indexOf('e') > -1 ? sw + dx : sw - dx;
            if (hasH) h = dir.indexOf('s') > -1 ? sh + dy : sh - dy;
            w = clamp(w, min, maxW);
            h = clamp(h, min, maxH);
            if (hasW) el.style.width = Math.round(w) + 'px';
            if (hasH) {
                if (fitContent) el.style.maxHeight = Math.round(h) + 'px';
                else el.style.height = Math.round(h) + 'px';
            }
            if (outOfFlow) {
                if (dir.indexOf('w') > -1 && !anchorRight) {
                    var wantL = sl + (sw - w);
                    el.style.left = Math.round(baseLeft + (wantL - el.getBoundingClientRect().left)) + 'px';
                }
                if (dir.indexOf('n') > -1 && !anchorBottom) {
                    var wantT = st + (sh - h);
                    el.style.top = Math.round(baseTop + (wantT - el.getBoundingClientRect().top)) + 'px';
                }
            }
        }
        function onUp() {
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            document.removeEventListener('pointercancel', onUp);
            el.classList.remove('rz-active');
            document.documentElement.classList.remove('rz-resizing');
            el.style.transition = prevTransition;
            window.dispatchEvent(new Event('resize'));
            writeSaved(el, captureBox(el, fitContent ? 'mh' : dir));
        }
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        document.addEventListener('pointercancel', onUp);
    }

    // 在 container 里放一条操作 host 的分割线（container 默认为 host 自己）
    // 想让分割线画在相邻元素那一侧时，把 container 传成那个元素即可
    // 让元素可拖动移动（transform 位移，不影响 resize 的宽高与居中布局）
    function enableMove(el) {
        if (!el || el.getAttribute('data-move-ready') === '1') return el;
        el.setAttribute('data-move-ready', '1');
        var ox = 0, oy = 0;
        el.addEventListener('pointerdown', function (e) {
            if (e.button !== undefined && e.button !== 0) return;
            var t = e.target;
            if (t && t.closest && t.closest('input, textarea, select, button, a, label, [data-rz-dir]')) return;
            e.preventDefault();
            var sx = e.clientX, sy = e.clientY, bx = ox, by = oy;
            el.classList.add('rz-moving');
            el.style.transition = 'none';
            el.style.animation = 'none';
            function onMove(ev) {
                var maxX = window.innerWidth / 2, maxY = window.innerHeight / 2;
                ox = clamp(bx + (ev.clientX - sx), -maxX, maxX);
                oy = clamp(by + (ev.clientY - sy), -maxY, maxY);
                el.style.transform = 'translate(' + Math.round(ox) + 'px,' + Math.round(oy) + 'px)';
            }
            function onUp() {
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
                document.removeEventListener('pointercancel', onUp);
                el.classList.remove('rz-moving');
                el.style.transition = '';
            }
            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
            document.addEventListener('pointercancel', onUp);
        });
        return el;
    }

    function addHandle(host, container, dir) {
        var h = document.createElement('div');
        h.className = 'rz-handle rz-' + dir;
        h.setAttribute('data-rz-dir', dir);
        h.title = '拖拽调整大小';
        h.addEventListener('pointerdown', function (e) { startDrag(e, host, dir); });
        h.addEventListener('dblclick', function (e) { e.preventDefault(); reset(host); });
        h.addEventListener('click', function (e) { e.stopPropagation(); });
        (container || host).appendChild(h);
        return h;
    }

    // 行内 position:relative 会覆盖手机布局里样式表的 fixed 定位，
    // 侧栏一旦还在文档流里就会把主区挤窄，所以窄屏时要把行内定位撤掉交给样式表接管
    var _posFixed = [];
    var _mqNarrow = window.matchMedia ? window.matchMedia('(max-width: 768px)') : null;

    function applyPositionFix(el) {
        if (window.getComputedStyle(el).position === 'static') {
            el.style.position = 'relative';
            if (_posFixed.indexOf(el) < 0) _posFixed.push(el);
        }
    }

    function syncPositionFix() {
        if (!_mqNarrow) return;
        if (_mqNarrow.matches) {
            _posFixed.forEach(function (e) { e.style.position = ''; });
            _posFixed = [];
        } else {
            Array.prototype.forEach.call(document.querySelectorAll('[data-rz-ready]'), function (e) {
                if (!e.style.position) applyPositionFix(e);
            });
        }
    }

    if (_mqNarrow) {
        if (_mqNarrow.addEventListener) _mqNarrow.addEventListener('change', syncPositionFix);
        else if (_mqNarrow.addListener) _mqNarrow.addListener(syncPositionFix);
    }

    function make(el, opts) {
        if (!el || el.getAttribute('data-rz-ready') === '1') return el;
        opts = opts || {};
        var raw = (opts.dir || el.getAttribute('data-resizable') || 'nsew').toLowerCase();
        var dir = raw.replace(/[^nsew]/g, '');
        if (!dir) dir = 'nsew';
        if (opts.min) el.setAttribute('data-rz-min', opts.min);

        applyPositionFix(el);
        el.style.boxSizing = 'border-box';
        el.setAttribute('data-rz-ready', '1');
        if (el.classList.contains('modal-content') || el.hasAttribute('data-movable')) enableMove(el);

        var dirs;
        if (raw.indexOf(',') > -1) {
            // 显式列举手柄，如 "n,e"：上边一条 + 右边一条，不额外生成角手柄
            dirs = raw.split(',').map(function (s) { return s.trim(); })
                      .filter(function (s) { return ALL_DIRS.indexOf(s) > -1; });
        } else {
            dirs = ALL_DIRS.indexOf(dir) > -1 ? [dir] : ALL_DIRS.filter(function (d) {
                if (d.length === 1) return dir.indexOf(d) > -1;
                return dir.indexOf(d[0]) > -1 && dir.indexOf(d[1]) > -1;
            });
        }
        if (!dirs.length) dirs = ['se'];
        // data-rz-skip="e"：不要自动生成该方向的手柄（例如分割线改画在相邻元素那一侧）
        var skip = (el.getAttribute('data-rz-skip') || '').replace(/[^nsew]/g, '');
        if (skip) dirs = dirs.filter(function (d) { return skip.indexOf(d) < 0; });

        dirs.forEach(function (d) { addHandle(el, el, d); });

        var keepMaxH = el.style.maxHeight;
        unlockLimits(el, dir);
        if (el.getAttribute('data-rz-fit') === '1') el.style.maxHeight = keepMaxH;
        applyBox(el, readSaved(el));
        return el;
    }

    function reset(el) {
        if (!el) return;
        el.style.width = '';
        el.style.height = '';
        el.style.left = '';
        el.style.top = '';
        el.style.transform = '';
        el.style.flex = '';
        el.style.maxWidth = '';
        el.style.minWidth = '';
        el.style.maxHeight = '';
        el.style.minHeight = '';
        writeSaved(el, null);
        window.dispatchEvent(new Event('resize'));
    }

    function resetAll() {
        var nodes = document.querySelectorAll('[data-rz-ready="1"]');
        Array.prototype.forEach.call(nodes, function (n) { reset(n); });
        try { localStorage.removeItem(STORE_KEY); } catch (e) {}
        window.dispatchEvent(new Event('resize'));
    }

    function init() {
        var nodes = document.querySelectorAll('[data-resizable]');
        Array.prototype.forEach.call(nodes, function (n) { make(n); });
    }

    window.QTResize = {
        make: make,
        addHandle: addHandle,
        enableMove: enableMove,
        reset: reset,
        resetAll: resetAll,
        init: init,
        MIN: DEFAULT_MIN,
        makeAll: function (selector, opts) {
            Array.prototype.forEach.call(document.querySelectorAll(selector), function (n) { make(n, opts); });
        }
    };

    function boot() {
        init();
        syncPositionFix();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
