import os, re, uuid, shutil, threading, asyncio, subprocess, sys, zipfile, tarfile, json
from fastapi import FastAPI, HTTPException, Request, UploadFile, File, Query, Form, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response, JSONResponse
from pydantic import BaseModel
from utils import auth_util
from utils.auth_util import BOT_USERNAME, BOT_TOKEN, verify_bot, SUPER_ADMIN
from utils import file_config
from datetime import datetime
import sqlite3
import time as time_module

import platform
if platform.system() != 'Windows':
    try:
        subprocess.check_call(['apt-get', 'install', '-y', 'libgdiplus', 'libc6-dev'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass

for _pkg, _import in [('python-docx', 'docx'), ('openpyxl', 'openpyxl'), ('python-pptx', 'pptx'), ('spire.doc', 'spire.doc'), ('spire.xls', 'spire.xls')]:
    try:
        __import__(_import)
    except ImportError:
        try:
            subprocess.check_call([sys.executable, '-m', 'pip', 'install', _pkg], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass

VERSION = "3.1.0"
SERVER_PORT = 18675
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
WALLPAPER_DIR = os.path.join(BASE_DIR, "wallpapers")
MAX_FILE_SIZE = 500 * 1024 * 1024
MAX_WALLPAPER_SIZE = 20 * 1024 * 1024
WALLPAPER_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'avif', 'ico'}
ALLOWED_EXTENSIONS = file_config.get_all_extensions()


def get_config_size_mb(key, default_mb):
    """从后台配置读取大小限制（MB），无效时回退到默认值"""
    try:
        mb = int(auth_util.get_config(key))
        if mb >= 1:
            return mb
    except (TypeError, ValueError):
        pass
    return default_mb


def get_max_file_size():
    """上传大小限制（字节）"""
    return get_config_size_mb("upload_max_size_mb", 2048) * 1024 * 1024


def get_max_download_size():
    """下载大小限制（字节）"""
    return get_config_size_mb("download_max_size_mb", 2048) * 1024 * 1024

EDITABLE_DIRS = ["", "pages", "static", "utils"]
EDITABLE_EXTS = [".html", ".css", ".js", ".py", ".txt", ".md"]
EXCLUDED_DIRS = ["database", "__pycache__", "uploads", ".git", "pip_packages", "pip_packages_linux", "update_pending"]

_typing = {}
_typing_lock = threading.Lock()
TYPING_EXPIRE = 8

app = FastAPI(title="talktome")

def get_msg_db():
    conn = sqlite3.connect(os.path.join(BASE_DIR, "database", "messages.db"), check_same_thread=False)
    conn.row_factory = auth_util.dict_factory
    conn.execute("""CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id INTEGER DEFAULT 0,
        username TEXT NOT NULL,
        nickname TEXT DEFAULT '',
        content TEXT NOT NULL,
        msg_type TEXT DEFAULT 'text',
        file_path TEXT DEFAULT '',
        file_name TEXT DEFAULT '',
        file_size INTEGER DEFAULT 0,
        ref_msg_id INTEGER DEFAULT 0,
        ref_content TEXT DEFAULT '',
        ref_username TEXT DEFAULT '',
        msg_style TEXT DEFAULT '',
        forward_from TEXT DEFAULT '',
        create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS read_records (
        username TEXT,
        room_id INTEGER DEFAULT 0,
        last_read_id INTEGER DEFAULT 0,
        PRIMARY KEY(username, room_id)
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS msg_totals (
        username TEXT,
        room_id INTEGER DEFAULT 0,
        total INTEGER DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(username, room_id)
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS desktop_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        item_type TEXT NOT NULL,
        name TEXT DEFAULT '',
        system_key TEXT DEFAULT '',
        msg_id INTEGER DEFAULT NULL,
        file_path TEXT DEFAULT '',
        parent_id INTEGER DEFAULT 0,
        pos_x INTEGER DEFAULT NULL,
        pos_y INTEGER DEFAULT NULL,
        zoom INTEGER DEFAULT 0,
        file_size INTEGER DEFAULT 0,
        create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS user_prefs (
        username TEXT PRIMARY KEY,
        wallpaper TEXT DEFAULT '',
        wallpaper_mode TEXT DEFAULT 'cover',
        prefs TEXT DEFAULT '',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS wallpapers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        name TEXT DEFAULT '',
        file_path TEXT DEFAULT '',
        create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS shared_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uploader TEXT NOT NULL,
        uploader_name TEXT DEFAULT '',
        name TEXT DEFAULT '',
        file_path TEXT DEFAULT '',
        file_size INTEGER DEFAULT 0,
        source_msg_id INTEGER DEFAULT 0,
        create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )""")
    try:
        conn.execute("ALTER TABLE messages ADD COLUMN room_id INTEGER DEFAULT 0")
    except:
        pass
    try:
        conn.execute("ALTER TABLE desktop_items ADD COLUMN file_size INTEGER DEFAULT 0")
    except:
        pass
    try:
        conn.execute("ALTER TABLE messages ADD COLUMN ref_msg_id INTEGER DEFAULT 0")
    except:
        pass
    try:
        conn.execute("ALTER TABLE messages ADD COLUMN ref_content TEXT DEFAULT ''")
    except:
        pass
    try:
        conn.execute("ALTER TABLE messages ADD COLUMN ref_username TEXT DEFAULT ''")
    except:
        pass
    try:
        conn.execute("ALTER TABLE read_records ADD COLUMN room_id INTEGER DEFAULT 0")
    except:
        pass
    try:
        conn.execute("ALTER TABLE messages ADD COLUMN msg_style TEXT DEFAULT ''")
    except:
        pass
    try:
        conn.execute("ALTER TABLE messages ADD COLUMN forward_from TEXT DEFAULT ''")
    except:
        pass
    try:
        conn.execute("ALTER TABLE user_prefs ADD COLUMN prefs TEXT DEFAULT ''")
    except:
        pass
    conn.commit()
    return conn

get_msg_db()

class ConnectionManager:
    def __init__(self):
        self.connections: dict[int, dict] = {}
        self._counter = 0

    async def connect(self, ws: WebSocket, username: str) -> int:
        await ws.accept()
        self._counter += 1
        cid = self._counter
        self.connections[cid] = {"ws": ws, "username": username}
        auth_util.set_online(username)
        await self.broadcast_online()
        return cid

    def disconnect(self, cid: int):
        if cid in self.connections:
            username = self.connections[cid]["username"]
            del self.connections[cid]
            if not any(c["username"] == username for c in self.connections.values()):
                auth_util.remove_online(username)

    async def broadcast_online(self):
        users = list(set(c["username"] for c in self.connections.values()))
        await self._broadcast({"type": "online", "data": users})

    async def broadcast_message(self, msg: dict):
        room_id = msg.get("room_id", 0)
        msg = _enrich_msg_with_colors(dict(msg))
        await self._broadcast({"type": "message", "data": msg}, room_id=room_id)

    async def broadcast_typing(self, room_id: int, typing_users: list):
        await self._broadcast({"type": "typing", "data": {"room_id": room_id, "users": typing_users}}, room_id=room_id)

    async def _broadcast(self, data: dict, room_id: int = None):
        dead = []
        for cid, conn in self.connections.items():
            try:
                await conn["ws"].send_json(data)
            except:
                dead.append(cid)
        if dead:
            for cid in dead:
                self.disconnect(cid)
            await self.broadcast_online()

manager = ConnectionManager()

def _enrich_msg_with_colors(msg: dict) -> dict:
    """Add sender bubble colors to a message dict."""
    if 'sender_bubble_bg' not in msg:
        color = auth_util.get_user_color(msg.get('username', ''))
        msg['sender_bubble_bg'] = color['bg']
        msg['sender_bubble_text'] = color['text']
    return msg

_STYLE_HEX = re.compile(r"^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$")
_STYLE_FS = ("s", "l", "xl")          # 小/大/超大（空=标准）
_STYLE_AL = ("l", "c", "r")            # 左/中/右

def sanitize_msg_style(raw) -> str:
    """清洗单条消息样式串：bg/fg 十六进制色，fs 字号档，b/i/u 字形，al 对齐
    非法值一律丢弃，输出规范化字符串（空字符串=用发送者默认气泡样式）"""
    if not raw or not isinstance(raw, str):
        return ""
    out = []
    for part in raw.split(";")[:12]:
        if "=" not in part:
            continue
        k, v = part.split("=", 1)
        k, v = k.strip().lower(), v.strip()
        if k in ("bg", "fg"):
            if _STYLE_HEX.match(v):
                out.append(k + "=" + v.lower())
        elif k == "fs":
            if v in _STYLE_FS:
                out.append("fs=" + v)
        elif k in ("b", "i", "u"):
            if v == "1":
                out.append(k + "=1")
        elif k == "al":
            if v in _STYLE_AL:
                out.append("al=" + v)
    return ";".join(out)[:200]

def _attach_colors_to_messages(rows: list):
    """Batch-attach sender bubble colors to a list of message dicts."""
    usernames = set()
    for m in rows:
        usernames.add(m.get('username', ''))
    color_map = {}
    for u in usernames:
        if u:
            color_map[u] = auth_util.get_user_color(u)
    for m in rows:
        u = m.get('username', '')
        c = color_map.get(u, {'bg': '', 'text': ''})
        m['sender_bubble_bg'] = c['bg']
        m['sender_bubble_text'] = c['text']

@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    path = request.url.path
    whitelist = ['/api/auth/', '/api/bot/', '/api/chat/typing', '/api/rooms', '/api/config/', '/uploads/', '/wallpapers/', '/login', '/register', '/admin', '/favicon.ico', '/ws']
    if any(path.startswith(w) for w in whitelist):
        return await call_next(request)
    token = request.headers.get('X-Auth-Token', '') or request.query_params.get('token', '')
    username = auth_util.verify_session(token)
    if not username:
        if path.startswith('/api/'):
            return JSONResponse({"code": 401, "msg": "not logged in"}, status_code=401)
        return await call_next(request)
    request.state.username = username
    user = auth_util.get_user(username)
    request.state.nickname = user['nickname'] if user else username
    request.state.is_super = user['is_super'] if user else 0
    auth_util.update_online(username)
    return await call_next(request)

os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(WALLPAPER_DIR, exist_ok=True)

app.mount("/static", StaticFiles(directory="static"), name="static")
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")
app.mount("/wallpapers", StaticFiles(directory=WALLPAPER_DIR), name="wallpapers")

class LoginIn(BaseModel):
    username: str
    password: str

class RegisterIn(BaseModel):
    username: str
    password: str
    invite_code: str

class SendMsg(BaseModel):
    content: str
    room_id: int = 0
    ref_msg_id: int = 0
    msg_type: str = "text"
    style: str = ""

class ForwardIn(BaseModel):
    msg_id: int
    room_ids: list[int] = []

class SendFileIn(BaseModel):
    room_id: int = 0
    msg_id: int = 0
    item_id: int = 0

class GenCodesIn(BaseModel):
    count: int = 10

class BanIn(BaseModel):
    reason: str = ""

class CreateRoomIn(BaseModel):
    name: str
    description: str = ""
    is_public: int = 1
    password: str = ""

class JoinRoomIn(BaseModel):
    password: str = ""

class LogoutIn(BaseModel):
    token: str = ""

class RenameRoomIn(BaseModel):
    name: str

class ReorderRoomsIn(BaseModel):
    orders: list

class ConfigIn(BaseModel):
    auto_file_enabled: str = "1"
    auto_file_max_chars: str = "150"
    auto_file_max_lines: str = "10"
    upload_max_size_mb: str = "2048"
    download_max_size_mb: str = "2048"

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket, token: str = ""):
    username = auth_util.verify_session(token)
    if not username:
        await ws.close(code=4001)
        return
    user = auth_util.get_user(username)
    nickname = user['nickname'] if user else username
    cid = await manager.connect(ws, username)
    try:
        while True:
            data = await ws.receive_json()
            t = data.get("type", "")
            if t == "ping":
                await ws.send_json({"type": "pong"})
            elif t == "send":
                content = data.get("content", "").strip()
                room_id = data.get("room_id", 0)
                ref_msg_id = data.get("ref_msg_id", 0) or 0
                msg_type = data.get("msg_type", "text")
                msg_style = sanitize_msg_style(data.get("style", ""))
                if not content:
                    await ws.send_json({"type": "error", "msg": "content empty"})
                    continue

                # toast 消息：广播但不存 DB（进度提示、中间状态等废话）
                if msg_type == "toast":
                    await manager.broadcast_message({
                        "id": int(time_module.time() * 1000) + hash(content) % 10000,
                        "room_id": room_id,
                        "username": username,
                        "nickname": nickname,
                        "content": content,
                        "msg_type": "toast",
                        "file_path": "",
                        "file_name": "",
                        "file_size": 0,
                        "ref_msg_id": 0,
                        "ref_content": "",
                        "ref_username": "",
                        "create_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                    })
                    continue

                # 只对纯文本消息做自动转文件（menu/toast 等跳过）
                if msg_type == "text":
                    line_count = content.count('\n') + 1
                    _auto_file_enabled = auth_util.get_config("auto_file_enabled")
                    if _auto_file_enabled == "1":
                        _max_chars = int(auth_util.get_config("auto_file_max_chars") or "150")
                        _max_lines = int(auth_util.get_config("auto_file_max_lines") or "10")
                    else:
                        _max_chars, _max_lines = 999999999, 999999999
                    if len(content) > _max_chars or line_count > _max_lines:
                        import re as _re, uuid as _uuid
                        safe_name = _re.sub(r'[\\/:*?"<>|#\n\r\t]', '_', content[:20]).strip()
                        if not safe_name:
                            safe_name = "消息"
                        txt_name = f"{safe_name}_{_uuid.uuid4().hex[:8]}.txt"
                        txt_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads", txt_name)
                        os.makedirs(os.path.dirname(txt_path), exist_ok=True)
                        with open(txt_path, "w", encoding="utf-8") as f:
                            f.write(content)
                        file_size = os.path.getsize(txt_path)
                        conn_msg_db = get_msg_db()
                        conn_msg_db.execute(
                            "INSERT INTO messages (room_id, username, nickname, content, msg_type, file_name, file_path, file_size, msg_style) VALUES (?, ?, ?, ?, 'file', ?, ?, ?, ?)",
                            (room_id, username, nickname, content, txt_name, f"/uploads/{txt_name}", file_size, msg_style)
                        )
                        conn_msg_db.commit()
                        msg_id = conn_msg_db.execute("SELECT last_insert_rowid() as id").fetchone()['id']
                        msg = conn_msg_db.execute("SELECT * FROM messages WHERE id=?", (msg_id,)).fetchone()
                        conn_msg_db.close()
                        await manager.broadcast_message(msg)
                        continue

                ref_content = ""
                ref_username = ""
                conn_msg_db = get_msg_db()
                if ref_msg_id:
                    ref_msg = conn_msg_db.execute("SELECT content, username, msg_type, file_name FROM messages WHERE id=?", (ref_msg_id,)).fetchone()
                    if ref_msg:
                        if ref_msg['msg_type'] == 'image':
                            ref_content = '[图片] ' + (ref_msg['file_name'] or '')
                        elif ref_msg['msg_type'] == 'file':
                            ref_content = '[文件] ' + (ref_msg['file_name'] or '')
                        else:
                            ref_content = (ref_msg['content'] or '')[:200]
                        ref_username = ref_msg['username'] or ''
                conn_msg_db.execute(
                    "INSERT INTO messages (room_id, username, nickname, content, msg_type, ref_msg_id, ref_content, ref_username, msg_style) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (room_id, username, nickname, content, msg_type, ref_msg_id, ref_content, ref_username, msg_style)
                )
                conn_msg_db.commit()
                msg_id = conn_msg_db.execute("SELECT last_insert_rowid() as id").fetchone()['id']
                msg = conn_msg_db.execute("SELECT * FROM messages WHERE id=?", (msg_id,)).fetchone()
                conn_msg_db.close()
                await manager.broadcast_message(msg)
            elif t == "typing":
                room_id = data.get("room_id", 0)
                now = time_module.time()
                active = data.get("active", True)
                with _typing_lock:
                    if active:
                        _typing[username] = now + TYPING_EXPIRE
                    else:
                        _typing.pop(username, None)
                    expired = [k for k, v in _typing.items() if v < now]
                    for k in expired:
                        del _typing[k]
                    room_typing = [k for k, v in _typing.items() if v > now]
                await manager.broadcast_typing(room_id, room_typing)
            elif t == "unread":
                room_id = data.get("room_id", 0)
                conn = get_msg_db()
                row = conn.execute("SELECT last_read_id FROM read_records WHERE username=? AND room_id=?", (username, room_id)).fetchone()
                last_id = row['last_read_id'] if row else 0
                count = conn.execute("SELECT COUNT(*) as c FROM messages WHERE room_id=? AND id > ?", (room_id, last_id)).fetchone()['c']
                conn.close()
                await ws.send_json({"type": "unread", "data": {"room_id": room_id, "count": count}})
            elif t == "mark_read":
                room_id = data.get("room_id", 0)
                conn = get_msg_db()
                max_id = conn.execute("SELECT MAX(id) as m FROM messages WHERE room_id=?", (room_id,)).fetchone()['m'] or 0
                conn.execute("INSERT OR REPLACE INTO read_records (username, room_id, last_read_id) VALUES (?, ?, ?)",
                             (username, room_id, max_id))
                conn.commit()
                conn.close()
    except WebSocketDisconnect:
        pass
    except Exception as e:
        pass
    finally:
        manager.disconnect(cid)
        await manager.broadcast_online()

@app.get("/")
def home():
    return FileResponse("pages/chat.html")

@app.get("/admin")
def admin_page():
    return FileResponse("pages/admin.html")

@app.get("/admin/files")
def admin_files_page():
    return FileResponse("pages/admin_files.html")

@app.get("/login")
def login_page():
    return FileResponse("pages/login.html")

@app.get("/register")
def register_page():
    return FileResponse("pages/login.html")

@app.post("/api/auth/login")
def api_login(body: LoginIn):
    token, msg = auth_util.login(body.username, body.password)
    if token:
        return {"code": 200, "token": token, "username": body.username, "msg": msg}
    return {"code": 401, "msg": msg}

@app.post("/api/auth/register")
def api_register(body: RegisterIn):
    ok, msg = auth_util.register(body.username, body.password, body.invite_code)
    if ok:
        return {"code": 200, "msg": msg}
    return {"code": 400, "msg": msg}

@app.post("/api/auth/logout")
def api_logout(request: Request, body: LogoutIn = None):
    token = body.token if (body and body.token) else request.headers.get('X-Auth-Token', '')
    auth_util.logout(token)
    return {"code": 200, "msg": "ok"}

@app.get("/api/auth/me")
def api_me(request: Request):
    token = request.headers.get('X-Auth-Token', '')
    username = auth_util.verify_session(token)
    if username:
        user = auth_util.get_user(username)
        return {"code": 200, "data": user}
    return {"code": 401, "msg": "not logged in"}

@app.get("/api/chat/messages")
def get_messages(room_id: int = 0, after_id: int = 0, before_id: int = 0, request: Request = None):
    conn = get_msg_db()
    if after_id > 0:
        rows = conn.execute(
            "SELECT * FROM messages WHERE room_id=? AND id > ? ORDER BY id ASC",
            (room_id, after_id)
        ).fetchall()
    elif before_id > 0:
        rows = conn.execute(
            "SELECT * FROM messages WHERE room_id=? AND id < ? ORDER BY id DESC LIMIT 30",
            (room_id, before_id)
        ).fetchall()
        rows.reverse()
    else:
        rows = conn.execute(
            "SELECT * FROM messages WHERE room_id=? ORDER BY id DESC LIMIT 30",
            (room_id,)
        ).fetchall()
        rows.reverse()
    conn.close()
    _attach_colors_to_messages(rows)
    return {"code": 200, "data": rows}

@app.post("/api/chat/send")
async def send_message(body: SendMsg, request: Request):
    username = request.state.username
    nickname = request.state.nickname or username
    content = body.content.strip()
    room_id = body.room_id
    ref_msg_id = body.ref_msg_id
    if not content:
        return {"code": 400, "msg": "content is empty"}

    # toast 消息：广播但不存 DB（进度提示、中间状态等）
    if body.msg_type == "toast":
        msg_id = int(time_module.time() * 1000) + hash(content) % 10000
        msg = {
            "id": msg_id, "room_id": room_id, "username": username,
            "nickname": nickname, "content": content, "msg_type": "toast",
            "file_path": "", "file_name": "", "file_size": 0,
            "ref_msg_id": 0, "ref_content": "", "ref_username": "",
            "create_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
        await manager.broadcast_message(msg)
        return {"code": 200, "id": msg_id, "room_id": room_id, "msg_type": "toast"}

    # 只对纯文本消息做自动转文件（menu/toast 等跳过）
    if body.msg_type == "text":
        line_count = content.count('\n') + 1
        _auto_file_enabled = auth_util.get_config("auto_file_enabled")
        if _auto_file_enabled == "1":
            _max_chars = int(auth_util.get_config("auto_file_max_chars") or "150")
            _max_lines = int(auth_util.get_config("auto_file_max_lines") or "10")
        else:
            _max_chars, _max_lines = 999999999, 999999999
        if len(content) > _max_chars or line_count > _max_lines:
            # 保存为txt文件，文件名取内容前20字+随机后缀防覆盖
            import re as _re, uuid as _uuid
            safe_name = _re.sub(r'[\\/:*?"<>|#\n\r\t]', '_', content[:20]).strip()
            if not safe_name:
                safe_name = "消息"
            txt_name = f"{safe_name}_{_uuid.uuid4().hex[:8]}.txt"
            txt_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads", txt_name)
            os.makedirs(os.path.dirname(txt_path), exist_ok=True)
            with open(txt_path, "w", encoding="utf-8") as f:
                f.write(content)
            file_size = os.path.getsize(txt_path)
            conn = get_msg_db()
            conn.execute(
                "INSERT INTO messages (room_id, username, nickname, content, msg_type, file_name, file_path, file_size, msg_style) VALUES (?, ?, ?, ?, 'file', ?, ?, ?, ?)",
                (room_id, username, nickname, content, txt_name, f"/uploads/{txt_name}", file_size, msg_style)
            )
            conn.commit()
            msg_id = conn.execute("SELECT last_insert_rowid() as id").fetchone()['id']
            msg = conn.execute("SELECT * FROM messages WHERE id=?", (msg_id,)).fetchone()
            conn.close()
            await manager.broadcast_message(msg)
            return {"code": 200, "id": msg_id, "room_id": room_id, "msg_type": "file"}

    msg_style = sanitize_msg_style(body.style)
    ref_content = ""
    ref_username = ""
    if ref_msg_id:
        conn_ref = get_msg_db()
        ref_msg = conn_ref.execute("SELECT content, username, msg_type, file_name FROM messages WHERE id=?", (ref_msg_id,)).fetchone()
        if ref_msg:
            if ref_msg['msg_type'] == 'image':
                ref_content = '[图片] ' + (ref_msg['file_name'] or '')
            elif ref_msg['msg_type'] == 'file':
                ref_content = '[文件] ' + (ref_msg['file_name'] or '')
            else:
                ref_content = (ref_msg['content'] or '')[:200]
            ref_username = ref_msg['username'] or ''
        conn_ref.close()
    conn = get_msg_db()
    conn.execute(
        "INSERT INTO messages (room_id, username, nickname, content, msg_type, ref_msg_id, ref_content, ref_username, msg_style) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (room_id, username, nickname, content, body.msg_type, ref_msg_id, ref_content, ref_username, msg_style)
    )
    conn.commit()
    msg_id = conn.execute("SELECT last_insert_rowid() as id").fetchone()['id']
    msg = conn.execute("SELECT * FROM messages WHERE id=?", (msg_id,)).fetchone()
    conn.close()
    await manager.broadcast_message(msg)
    return {"code": 200, "id": msg_id, "room_id": room_id}

@app.post("/api/chat/upload")
async def upload_file(request: Request, file: UploadFile = File(...), room_id: int = Form(0)):
    username = request.state.username
    nickname = request.state.nickname or username
    ext = file.filename.split('.')[-1].lower() if '.' in file.filename else ''
    if ext not in ALLOWED_EXTENSIONS:
        return {"code": 400, "msg": f"file type .{ext} not allowed"}
    content = await file.read()
    max_size = get_max_file_size()
    if len(content) > max_size:
        return {"code": 400, "msg": f"文件过大，最大允许 {max_size // (1024 * 1024)}MB"}
    saved_name = f"{uuid.uuid4().hex}.{ext}"
    saved_path = os.path.join(UPLOAD_DIR, saved_name)
    with open(saved_path, 'wb') as f:
        f.write(content)
    msg_type = 'image' if ext in {'png','jpg','jpeg','gif','bmp','webp','svg'} else 'file'
    conn = get_msg_db()
    conn.execute(
        "INSERT INTO messages (room_id, username, nickname, content, msg_type, file_path, file_name, file_size) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (room_id, username, nickname, file.filename, msg_type, f"/uploads/{saved_name}", file.filename, len(content))
    )
    conn.commit()
    msg_id = conn.execute("SELECT last_insert_rowid() as id").fetchone()['id']
    msg = conn.execute("SELECT * FROM messages WHERE id=?", (msg_id,)).fetchone()
    conn.close()
    await manager.broadcast_message(msg)
    return {"code": 200, "id": msg_id, "msg_type": msg_type, "file_path": f"/uploads/{saved_name}"}

@app.post("/api/chat/forward")
async def forward_message(body: ForwardIn, request: Request):
    username = request.state.username
    nickname = request.state.nickname or username
    conn = get_msg_db()
    src = conn.execute(
        "SELECT * FROM messages WHERE id=? AND msg_type NOT IN ('system','toast')",
        (body.msg_id,)
    ).fetchone()
    if not src:
        conn.close()
        return {"code": 400, "msg": "该消息不支持转发"}
    forward_from = src['nickname'] or src['username'] or ''
    msg_type = src['msg_type']
    content = src['content'] or ''
    file_path = src['file_path'] or ''
    file_name = src['file_name'] or ''
    file_size = src['file_size'] or 0
    if msg_type in ('file', 'image') and not file_path:
        conn.close()
        return {"code": 400, "msg": "文件不存在"}
    targets, seen = [], set()
    for rid in body.room_ids:
        try:
            rid = int(rid)
        except (TypeError, ValueError):
            continue
        if rid in seen:
            continue
        seen.add(rid)
        targets.append(rid)
    if not targets:
        conn.close()
        return {"code": 400, "msg": "请选择至少一个转发目标"}
    sent = 0
    for rid in targets:
        conn.execute(
            "INSERT INTO messages (room_id, username, nickname, content, msg_type, file_path, file_name, file_size, forward_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (rid, username, nickname, content, msg_type, file_path, file_name, file_size, forward_from)
        )
        conn.commit()
        new_id = conn.execute("SELECT last_insert_rowid() as id").fetchone()['id']
        new_msg = conn.execute("SELECT * FROM messages WHERE id=?", (new_id,)).fetchone()
        await manager.broadcast_message(new_msg)
        sent += 1
    conn.close()
    return {"code": 200, "msg": f"已转发到 {sent} 个会话", "count": sent}


@app.post("/api/chat/send-file")
async def send_file_message(body: SendFileIn, request: Request):
    username = request.state.username
    nickname = request.state.nickname or username
    visible = _visible_rooms(username)
    conn = get_msg_db()
    file_path = file_name = ''
    file_size = 0
    if body.msg_id:
        m = conn.execute("SELECT * FROM messages WHERE id=?", (body.msg_id,)).fetchone()
        if m and m['file_path'] and m['room_id'] in visible:
            file_path = m['file_path']
            file_name = m['file_name'] or 'file'
            file_size = m['file_size'] or 0
    elif body.item_id:
        it = conn.execute(
            "SELECT * FROM desktop_items WHERE id=? AND username=? AND item_type='file' AND msg_id IS NULL",
            (body.item_id, username)).fetchone()
        if it and it['file_path']:
            file_path = it['file_path']
            file_name = it['name'] or 'file'
            file_size = it['file_size'] or 0
    if not file_path:
        conn.close()
        return {"code": 400, "msg": "文件不存在"}
    ext = _ext_of(file_name)
    msg_type = 'image' if ext in {'png','jpg','jpeg','gif','bmp','webp','svg'} else 'file'
    conn.execute(
        "INSERT INTO messages (room_id, username, nickname, content, msg_type, file_path, file_name, file_size) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (body.room_id, username, nickname, file_name, msg_type, file_path, file_name, file_size))
    conn.commit()
    msg_id = conn.execute("SELECT last_insert_rowid() as id").fetchone()['id']
    msg = conn.execute("SELECT * FROM messages WHERE id=?", (msg_id,)).fetchone()
    conn.close()
    await manager.broadcast_message(msg)
    return {"code": 200, "id": msg_id, "msg_type": msg_type}


def _e(s):
    if s is None:
        return ""
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;").replace("'", "&#39;")


def _v(val):
    if val is None:
        return ""
    return str(val)


def _parse_word(path):
    try:
        from spire.doc import Document, FileFormat
        import tempfile, os
        document = Document()
        document.LoadFromFile(path)
        document.HtmlExportOptions.ImageEmbedded = True
        document.HtmlExportOptions.IsTextInputFormFieldAsText = True
        document.HtmlExportOptions.HasHeadersFooters = False
        tmp = tempfile.NamedTemporaryFile(suffix='.html', delete=False, mode='w', encoding='utf-8')
        tmp.close()
        document.SaveToFile(tmp.name, FileFormat.Html)
        document.Close()
        document.Dispose()
        with open(tmp.name, 'r', encoding='utf-8', errors='replace') as f:
            html = f.read()
        os.unlink(tmp.name)
        body_match = __import__('re').search(r'<body[^>]*>(.*?)</body>', html, __import__('re').DOTALL | __import__('re').IGNORECASE)
        if body_match:
            return body_match.group(1)
        return html
    except ImportError:
        return "<p style='color:#d46b08'>需要安装 spire-doc: pip install spire-doc</p>"
    except Exception as ex:
        return f"<p style='color:red'>解析Word文档失败: {_e(str(ex))}</p>"


def _parse_excel(path):
    try:
        from spire.xls import Workbook
        import tempfile, os
        workbook = Workbook()
        workbook.LoadFromFile(path)
        parts = []
        for i in range(workbook.Worksheets.Count):
            sheet = workbook.Worksheets[i]
            sname = sheet.Name
            tmp = tempfile.NamedTemporaryFile(suffix='.html', delete=False, mode='w', encoding='utf-8')
            tmp.close()
            sheet.SaveToHtml(tmp.name)
            with open(tmp.name, 'r', encoding='utf-8', errors='replace') as f:
                html = f.read()
            os.unlink(tmp.name)
            body_match = __import__('re').search(r'<body[^>]*>(.*?)</body>', html, __import__('re').DOTALL | __import__('re').IGNORECASE)
            content = body_match.group(1) if body_match else html
            parts.append(f"<h3 style='margin:16px 0 8px'>{_e(sname)}</h3>")
            parts.append(f"<div style='overflow-x:auto'>{content}</div>")
        workbook.Dispose()
        if not parts:
            return "<p style='color:#999'>表格内容为空</p>"
        return "\n".join(parts)
    except ImportError:
        return "<p style='color:#d46b08'>需要安装 spire-xls: pip install spire-xls</p>"
    except Exception as ex:
        return f"<p style='color:red'>解析Excel失败: {_e(str(ex))}</p>"


def _parse_pptx(path):
    try:
        from pptx import Presentation
        prs = Presentation(path)
        parts = []
        for si, slide in enumerate(prs.slides, 1):
            parts.append(f"<h3 style='margin:16px 0 8px'>📄 第 {si} 页</h3>")
            texts = []
            for shape in slide.shapes:
                if shape.has_text_frame:
                    for para in shape.text_frame.paragraphs:
                        txt = para.text.strip()
                        if txt:
                            level = para.level or 0
                            fs = max(14, 20 - level * 2)
                            parts.append(f"<p style='font-size:{fs}px;line-height:1.6;margin:4px 0'>{_e(txt)}</p>")
                if shape.has_table:
                    rows_html = []
                    for ri, row in enumerate(shape.table.rows):
                        cells = []
                        tag = "th" if ri == 0 else "td"
                        for cell in row.cells:
                            cells.append(f"<{tag}>{_e(cell.text)}</{tag}>")
                        rows_html.append("<tr>" + "".join(cells) + "</tr>")
                    parts.append(
                        "<table style='width:100%;border-collapse:collapse;margin:8px 0;font-size:13px'>"
                        + "".join(rows_html) + "</table>"
                    )
        if not parts:
            return "<p style='color:#999'>幻灯片内容为空</p>"
        return "\n".join(parts)
    except ImportError:
        return "<p style='color:#d46b08'>需要安装 python-pptx: pip install python-pptx</p>"
    except Exception as ex:
        return f"<p style='color:red'>解析PPT失败: {_e(str(ex))}</p>"


def _parse_markdown(path):
    try:
        import html as _html_mod
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            text = f.read()
        lines = text.split('\n')
        out = []
        in_code = False
        in_list = False
        for line in lines:
            if line.startswith('```'):
                if in_code:
                    out.append('</code></pre>')
                    in_code = False
                else:
                    out.append('<pre style="background:#f5f5f5;padding:12px;border-radius:6px;overflow-x:auto;font-size:13px;line-height:1.5"><code>')
                    in_code = True
                continue
            if in_code:
                out.append(_e(line))
                continue
            stripped = line.strip()
            if not stripped:
                if in_list:
                    in_list = False
                out.append('<br>')
                continue
            if stripped.startswith('######'):
                out.append(f"<h6>{_e(stripped[6:].strip())}</h6>")
            elif stripped.startswith('#####'):
                out.append(f"<h5>{_e(stripped[5:].strip())}</h5>")
            elif stripped.startswith('####'):
                out.append(f"<h4>{_e(stripped[4:].strip())}</h4>")
            elif stripped.startswith('###'):
                out.append(f"<h3>{_e(stripped[3:].strip())}</h3>")
            elif stripped.startswith('##'):
                out.append(f"<h2>{_e(stripped[2:].strip())}</h2>")
            elif stripped.startswith('#'):
                out.append(f"<h1>{_e(stripped[1:].strip())}</h1>")
            elif stripped.startswith('- ') or stripped.startswith('* '):
                content = stripped[2:].strip()
                content = _e(content)
                content = __import__('re').sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', content)
                content = __import__('re').sub(r'\*(.+?)\*', r'<i>\1</i>', content)
                content = __import__('re').sub(r'`(.+?)`', r'<code style="background:#f0f0f0;padding:1px 4px;border-radius:3px;font-size:13px">\1</code>', content)
                out.append(f"<p style='margin:2px 0;padding-left:16px'>• {content}</p>")
                in_list = True
            elif stripped.startswith('>'):
                out.append(f"<blockquote style='border-left:3px solid var(--accent);padding:4px 12px;margin:4px 0;color:var(--text-secondary);background:var(--bg-quote);border-radius:4px'>{_e(stripped[1:].strip())}</blockquote>")
            elif stripped.startswith('---') or stripped.startswith('***'):
                out.append('<hr style="border:none;border-top:1px solid var(--border-color);margin:12px 0">')
            else:
                content = _e(stripped)
                content = __import__('re').sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', content)
                content = __import__('re').sub(r'\*(.+?)\*', r'<i>\1</i>', content)
                content = __import__('re').sub(r'`(.+?)`', r'<code style="background:#f0f0f0;padding:1px 4px;border-radius:3px;font-size:13px">\1</code>', content)
                out.append(f"<p style='line-height:1.7;margin:4px 0'>{content}</p>")
        if in_code:
            out.append('</code></pre>')
        return "\n".join(out) if out else "<p style='color:#999'>文档内容为空</p>"
    except Exception as ex:
        return f"<p style='color:red'>解析Markdown失败: {_e(str(ex))}</p>"


def _read_text(path):
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        return f.read()


def _read_as(path, resp_type, **extra):
    try:
        text = _read_text(path)
        return {"code": 200, "type": resp_type, "text": text, **extra}
    except Exception:
        return {"code": 500, "msg": f"failed to read file"}


# ===== 格式解析注册表 =====
# 扩展方法：往 FILE_PARSERS 里加一行即可
# 格式：'扩展名': (返回类型, 解析函数)
#   解析函数签名: func(abs_path, file_name, file_path) -> dict
#   返回类型决定前端如何渲染：
#     "html"  -> 前端渲染 HTML（用于 docx/xlsx/pptx/md 等复杂格式）
#     "code"  -> 前端 <pre> 显示代码（用于 py/js/css 等）
#     "text"  -> 前端 <pre> 显示纯文本
#     "pdf"   -> 前端 iframe 加载 PDF
#     "iframe"-> 前端 iframe 加载原文件（用于 html）
#     "image" -> 前端 <img> 显示图片
#     "video" -> 前端 <video> 播放视频
#     "audio" -> 前端 <audio> 播放音频
#     "download" -> 不支持预览，提供下载
#
# 要新增格式，只需：
#   1. 写一个解析函数（如果需要服务端解析）
#   2. 在 FILE_PARSERS 里加一行映射
#   3. 如果是新类型，前端 previewFile() 里加对应的渲染分支

def _parse_docx_as_html(path, fname, fpath):
    return {"code": 200, "type": "html", "html": _parse_word(path), "file_name": fname}

def _parse_xlsx_as_html(path, fname, fpath):
    return {"code": 200, "type": "html", "html": _parse_excel(path), "file_name": fname}

def _parse_pptx_as_html(path, fname, fpath):
    return {"code": 200, "type": "html", "html": _parse_pptx(path), "file_name": fname}

def _parse_md_as_html(path, fname, fpath):
    return {"code": 200, "type": "html", "html": _parse_markdown(path), "file_name": fname}

def _parse_code(path, fname, fpath):
    ext = fname.rsplit('.', 1)[-1] if '.' in fname else ''
    return _read_as(path, "code", lang=ext, file_name=fname)

def _parse_pdf(path, fname, fpath):
    return {"code": 200, "type": "pdf", "url": fpath, "file_name": fname}

def _parse_iframe(path, fname, fpath):
    return {"code": 200, "type": "iframe", "url": fpath, "file_name": fname}

def _parse_text(path, fname, fpath):
    return _read_as(path, "text", file_name=fname)

def _parse_download(path, fname, fpath):
    return {"code": 200, "type": "download", "file_name": fname}


def _build_file_parsers():
    cfg = file_config.load_config()
    parsers = {}
    _DOC_EXTS = {'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt'}
    for ext in cfg.get("document", []):
        if ext in _DOC_EXTS:
            parsers[ext] = _parse_docx_as_html
        elif ext == 'md':
            parsers[ext] = _parse_md_as_html
        else:
            parsers[ext] = _parse_docx_as_html
    for ext in cfg.get("code", []):
        parsers[ext] = _parse_code
    for ext in cfg.get("text", []):
        parsers[ext] = _parse_text
    for ext in cfg.get("special", []):
        parsers[ext] = _parse_pdf
    return parsers

FILE_PARSERS = _build_file_parsers()

# 默认处理器：未知扩展名降级为下载
PARSER_DEFAULT = _parse_download


@app.get("/api/file/parse/{msg_id}")
def parse_file(msg_id: int, request: Request):
    conn = get_msg_db()
    msg = conn.execute("SELECT * FROM messages WHERE id=?", (msg_id,)).fetchone()
    conn.close()
    if not msg or not msg['file_path']:
        return {"code": 404, "msg": "file not found"}
    abs_path = os.path.join(BASE_DIR, msg['file_path'].lstrip('/'))
    if not os.path.exists(abs_path):
        return {"code": 404, "msg": "file deleted"}
    fname = (msg['file_name'] or '').lower()
    ext = fname.rsplit('.', 1)[-1] if '.' in fname else ''
    handler = FILE_PARSERS.get(ext, PARSER_DEFAULT)
    try:
        return handler(abs_path, msg['file_name'], msg['file_path'])
    except Exception as ex:
        return {"code": 500, "msg": f"解析失败: {_e(str(ex))}"}

_TRANSCODE_DIR = os.path.join(BASE_DIR, "transcodes")
os.makedirs(_TRANSCODE_DIR, exist_ok=True)

_NATIVE_VIDEO = {'mp4', 'webm', 'ogg'}
_NATIVE_AUDIO = {'mp3', 'wav', 'ogg', 'flac', 'aac'}

def _get_media_type(ext):
    cfg = file_config.load_config()
    if ext in cfg.get("video", []):
        return "video"
    if ext in cfg.get("audio", []):
        return "audio"
    return None

def _needs_transcode(ext):
    mtype = _get_media_type(ext)
    if mtype == "video":
        return ext not in _NATIVE_VIDEO
    if mtype == "audio":
        return ext not in _NATIVE_AUDIO
    return False

def _get_duration(path):
    try:
        r = subprocess.run(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path],
            capture_output=True, text=True, timeout=10
        )
        return float(r.stdout.strip())
    except:
        return 0

_transcode_locks = {}

def _transcode_worker(src, dst, ffmpeg_args, msg_id):
    try:
        _transcode_with_progress(src, dst, ffmpeg_args, msg_id)
    finally:
        _transcode_locks.pop(msg_id, None)

def _transcode_with_progress(src, dst, ffmpeg_args, msg_id):
    duration = _get_duration(src)
    progress_file = os.path.join(_TRANSCODE_DIR, f"{msg_id}.progress")
    with open(progress_file, 'w') as pf:
        pf.write("0")
    cmd = ['ffmpeg', '-i', src] + ffmpeg_args + ['-progress', 'pipe:1', '-y', dst]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    for line in proc.stdout:
        if line.startswith('out_time_us='):
            try:
                us = int(line.strip().split('=')[1])
                pct = min(int(us / 1000000 / duration * 100), 99) if duration > 0 else 0
                with open(progress_file, 'w') as pf:
                    pf.write(str(pct))
            except:
                pass
    proc.wait()
    if proc.returncode == 0 and os.path.exists(dst):
        with open(progress_file, 'w') as pf:
            pf.write("100")
    else:
        with open(progress_file, 'w') as pf:
            pf.write("-1")
    return proc.returncode

@app.get("/api/file/transcode-progress/{msg_id}")
def transcode_progress(msg_id: int):
    progress_file = os.path.join(_TRANSCODE_DIR, f"{msg_id}.progress")
    if not os.path.exists(progress_file):
        return {"code": 200, "progress": -1, "msg": "未开始"}
    with open(progress_file, 'r') as pf:
        pct = pf.read().strip()
    return {"code": 200, "progress": int(pct) if pct.lstrip('-').isdigit() else -1}

@app.get("/api/file/transcode-start/{msg_id}")
def transcode_start(msg_id: int):
    conn = get_msg_db()
    msg = conn.execute("SELECT * FROM messages WHERE id=?", (msg_id,)).fetchone()
    conn.close()
    if not msg or not msg['file_path']:
        return JSONResponse({"code": 404, "msg": "file not found"}, status_code=404)
    abs_path = os.path.join(BASE_DIR, msg['file_path'].lstrip('/'))
    if not os.path.exists(abs_path):
        return JSONResponse({"code": 404, "msg": "file deleted"}, status_code=404)
    fname = (msg['file_name'] or '').lower()
    ext = fname.rsplit('.', 1)[-1] if '.' in fname else ''
    mtype = _get_media_type(ext)
    if mtype == "video":
        cache_name = f"{msg_id}.mp4"
        cache_media = "video/mp4"
        ffmpeg_args = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-tune', 'zerolatency', '-c:a', 'aac', '-b:a', '96k']
    elif mtype == "audio":
        cache_name = f"{msg_id}.mp3"
        cache_media = "audio/mpeg"
        ffmpeg_args = ['-c:a', 'libmp3lame', '-b:a', '96k']
    else:
        return JSONResponse({"code": 400, "msg": "不支持的格式"}, status_code=400)
    cache_path = os.path.join(_TRANSCODE_DIR, cache_name)
    if os.path.exists(cache_path):
        return {"code": 200, "msg": "already cached"}
    progress_file = os.path.join(_TRANSCODE_DIR, f"{msg_id}.progress")
    if os.path.exists(progress_file):
        with open(progress_file, 'r') as pf:
            p = pf.read().strip()
        if p != "100" and p != "-1":
            return {"code": 200, "msg": "already transcoding"}
    if msg_id in _transcode_locks:
        return {"code": 200, "msg": "already transcoding"}
    _transcode_locks[msg_id] = True
    t = threading.Thread(target=_transcode_worker, args=(abs_path, cache_path, ffmpeg_args, msg_id), daemon=True)
    t.start()
    return {"code": 200, "msg": "started"}

@app.get("/api/file/transcode/{msg_id}")
def transcode_file(msg_id: int):
    conn = get_msg_db()
    msg = conn.execute("SELECT * FROM messages WHERE id=?", (msg_id,)).fetchone()
    conn.close()
    if not msg or not msg['file_path']:
        return JSONResponse({"code": 404, "msg": "file not found"}, status_code=404)
    abs_path = os.path.join(BASE_DIR, msg['file_path'].lstrip('/'))
    if not os.path.exists(abs_path):
        return JSONResponse({"code": 404, "msg": "file deleted"}, status_code=404)
    fname = (msg['file_name'] or '').lower()
    ext = fname.rsplit('.', 1)[-1] if '.' in fname else ''
    mtype = _get_media_type(ext)
    if mtype == "video" and ext in _NATIVE_VIDEO:
        return FileResponse(abs_path, media_type="video/mp4")
    if mtype == "audio" and ext in _NATIVE_AUDIO:
        return FileResponse(abs_path, media_type="audio/mpeg")
    if not _needs_transcode(ext):
        return FileResponse(abs_path)
    if mtype == "video":
        cache_name = f"{msg_id}.mp4"
        cache_media = "video/mp4"
    elif mtype == "audio":
        cache_name = f"{msg_id}.mp3"
        cache_media = "audio/mpeg"
    else:
        return JSONResponse({"code": 400, "msg": "不支持的格式"}, status_code=400)
    cache_path = os.path.join(_TRANSCODE_DIR, cache_name)
    if os.path.exists(cache_path):
        return FileResponse(cache_path, media_type=cache_media)
    return JSONResponse({"code": 202, "msg": "transcoding in progress"})


@app.delete("/api/chat/messages/{msg_id}")
def delete_message(msg_id: int, request: Request):
    conn = get_msg_db()
    msg = conn.execute("SELECT * FROM messages WHERE id=?", (msg_id,)).fetchone()
    if not msg:
        conn.close()
        return {"code": 404, "msg": "not found"}
    if not request.state.is_super and msg['username'] != request.state.username:
        conn.close()
        return {"code": 403, "msg": "can only delete your own messages"}
    if msg['file_path']:
        fp = os.path.join(BASE_DIR, msg['file_path'].lstrip('/'))
        if os.path.exists(fp):
            os.remove(fp)
    conn.execute("DELETE FROM desktop_items WHERE msg_id=?", (msg_id,))
    conn.execute("DELETE FROM messages WHERE id=?", (msg_id,))
    conn.commit()
    conn.close()
    return {"code": 200, "msg": "deleted"}

@app.delete("/api/admin/messages")
def clear_messages(request: Request, room_id: int = 0):
    if not request.state.is_super:
        return {"code": 403, "msg": "admin only"}
    conn = get_msg_db()
    if room_id:
        conn.execute("DELETE FROM desktop_items WHERE msg_id IN (SELECT id FROM messages WHERE room_id=?)", (room_id,))
        conn.execute("DELETE FROM messages WHERE room_id=?", (room_id,))
    else:
        conn.execute("DELETE FROM desktop_items WHERE msg_id IS NOT NULL")
        conn.execute("DELETE FROM messages")
    conn.commit()
    conn.close()
    return {"code": 200, "msg": "all messages cleared"}

@app.get("/api/chat/online")
def online_users():
    users = auth_util.get_online_users()
    return {"code": 200, "data": users}

@app.get("/api/chat/unread")
def unread_count(request: Request, room_id: int = 0):
    username = request.state.username
    conn = get_msg_db()
    row = conn.execute("SELECT last_read_id FROM read_records WHERE username=? AND room_id=?", (username, room_id)).fetchone()
    last_id = row['last_read_id'] if row else 0
    count = conn.execute("SELECT COUNT(*) as c FROM messages WHERE room_id=? AND id > ?", (room_id, last_id)).fetchone()['c']
    conn.close()
    return {"code": 200, "count": count}

@app.post("/api/chat/read")
def mark_read(request: Request, body: dict = None):
    username = request.state.username
    room_id = (body or {}).get('room_id', 0)
    conn = get_msg_db()
    max_id = conn.execute("SELECT MAX(id) as m FROM messages WHERE room_id=?", (room_id,)).fetchone()['m'] or 0
    conn.execute("INSERT OR REPLACE INTO read_records (username, room_id, last_read_id) VALUES (?, ?, ?)",
                 (username, room_id, max_id))
    conn.commit()
    conn.close()
    return {"code": 200}

@app.get("/api/chat/msg-totals")
def get_msg_totals(request: Request):
    """返回该用户各会话的“消息总条数”。首次访问某会话时用真实条数初始化一次。"""
    username = request.state.username
    conn = get_msg_db()
    rows = conn.execute("SELECT room_id, total FROM msg_totals WHERE username=?", (username,)).fetchall()
    existing = {r['room_id']: r['total'] for r in rows}
    # 候选会话：大厅 + 用户所在房间 + 私聊
    candidate = {0}
    try:
        for r in auth_util.get_rooms(username):
            candidate.add(r['id'])
    except Exception:
        pass
    try:
        for c in auth_util.get_private_chats(username):
            candidate.add(c['room_id'])
    except Exception:
        pass
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    for rid in candidate:
        if rid not in existing:
            cnt = conn.execute("SELECT COUNT(*) as c FROM messages WHERE room_id=?", (rid,)).fetchone()['c']
            conn.execute("INSERT OR REPLACE INTO msg_totals (username, room_id, total, updated_at) VALUES (?, ?, ?, ?)",
                         (username, rid, cnt, now))
            existing[rid] = cnt
    conn.commit()
    conn.close()
    return {"code": 200, "data": {str(k): v for k, v in existing.items()}}

@app.post("/api/chat/msg-totals")
def update_msg_totals(request: Request, body: dict = None):
    """页面关闭前更新一次：批量写入各会话总条数。"""
    username = request.state.username
    totals = (body or {}).get('totals', {}) or {}
    conn = get_msg_db()
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    for rid, val in totals.items():
        try:
            rid_i = int(rid); val_i = int(val)
        except Exception:
            continue
        conn.execute("INSERT OR REPLACE INTO msg_totals (username, room_id, total, updated_at) VALUES (?, ?, ?, ?)",
                     (username, rid_i, val_i, now))
    conn.commit()
    conn.close()
    return {"code": 200}

@app.get("/api/admin/codes")
def admin_codes(request: Request):
    if not request.state.is_super:
        return {"code": 403, "msg": "admin only"}
    codes = auth_util.get_invite_codes()
    return {"code": 200, "data": codes}

@app.post("/api/admin/codes/generate")
def admin_generate_codes(request: Request, body: GenCodesIn):
    if not request.state.is_super:
        return {"code": 403, "msg": "admin only"}
    count = max(1, min(100, body.count))
    import secrets
    conn = auth_util.get_conn()
    codes = []
    for _ in range(count):
        code = f"{secrets.token_hex(2).upper()}-{secrets.token_hex(2).upper()}"
        conn.execute("INSERT INTO invite_codes (code) VALUES (?)", (code,))
        codes.append(code)
    conn.commit()
    conn.close()
    return {"code": 200, "data": codes}

@app.get("/api/admin/users")
def admin_users(request: Request):
    if not request.state.is_super:
        return {"code": 403, "msg": "admin only"}
    users = auth_util.get_all_users()
    online = auth_util.get_online_users()
    banned = {b['username'] for b in auth_util.get_banned_users()}
    result = []
    for u in users:
        result.append({
            "id": u['id'],
            "username": u['username'],
            "nickname": u['nickname'],
            "is_super": u['is_super'],
            "is_online": u['username'] in online,
            "is_banned": u['username'] in banned,
            "create_time": u['create_time']
        })
    return {"code": 200, "data": result}

@app.post("/api/admin/kick/{username}")
def admin_kick(username: str, request: Request):
    if not request.state.is_super:
        return {"code": 403, "msg": "admin only"}
    if username == SUPER_ADMIN:
        return {"code": 400, "msg": "cannot kick super admin"}
    auth_util.kick_user(username)
    return {"code": 200, "msg": f"{username} kicked"}

@app.post("/api/admin/ban/{username}")
def admin_ban(username: str, request: Request, body: BanIn = None):
    if not request.state.is_super:
        return {"code": 403, "msg": "admin only"}
    if username == SUPER_ADMIN:
        return {"code": 400, "msg": "cannot ban super admin"}
    reason = body.reason if body else ""
    auth_util.ban_user(username, banned_by=request.state.username, reason=reason)
    return {"code": 200, "msg": f"{username} banned"}

@app.post("/api/admin/unban/{username}")
def admin_unban(username: str, request: Request):
    if not request.state.is_super:
        return {"code": 403, "msg": "admin only"}
    auth_util.unban_user(username)
    return {"code": 200, "msg": f"{username} unbanned"}

@app.get("/api/admin/messages")
def admin_get_messages(request: Request, page: int = 1, per_page: int = 50, search: str = ""):
    if not request.state.is_super:
        return {"code": 403, "msg": "admin only"}
    conn = get_msg_db()
    offset = (page - 1) * per_page
    total = conn.execute("SELECT COUNT(*) as c FROM messages").fetchone()['c']
    if search:
        like = f"%{search}%"
        rows = conn.execute(
            "SELECT * FROM messages WHERE username LIKE ? OR content LIKE ? OR file_name LIKE ? ORDER BY id DESC LIMIT ? OFFSET ?",
            (like, like, like, per_page, offset)
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM messages ORDER BY id DESC LIMIT ? OFFSET ?",
            (per_page, offset)
        ).fetchall()
    conn.close()
    return {"code": 200, "data": rows, "total": total}

@app.post("/api/admin/messages/batch-delete")
def admin_batch_delete(request: Request, body: dict):
    if not request.state.is_super:
        return {"code": 403, "msg": "admin only"}
    ids = body.get('ids', [])
    if not ids:
        return {"code": 400, "msg": "no ids provided"}
    conn = get_msg_db()
    placeholders = ','.join('?' * len(ids))
    rows = conn.execute(f"SELECT * FROM messages WHERE id IN ({placeholders})", ids).fetchall()
    for msg in rows:
        if msg['file_path']:
            fp = os.path.join(BASE_DIR, msg['file_path'].lstrip('/'))
            if os.path.exists(fp):
                os.remove(fp)
    conn.execute(f"DELETE FROM messages WHERE id IN ({placeholders})", ids)
    conn.commit()
    conn.close()
    return {"code": 200, "msg": f"deleted {len(ids)} messages"}

@app.get("/api/admin/files")
def admin_get_files(request: Request):
    if not request.state.is_super:
        return {"code": 403, "msg": "admin only"}
    conn = get_msg_db()
    used = set()
    for row in conn.execute("SELECT file_path FROM messages WHERE file_path != ''").fetchall():
        used.add(row['file_path'].lstrip('/'))
    conn.close()
    orphans = []
    if os.path.isdir(UPLOAD_DIR):
        for fname in os.listdir(UPLOAD_DIR):
            fpath = f"uploads/{fname}"
            if fpath not in used:
                fsize = os.path.getsize(os.path.join(UPLOAD_DIR, fname))
                mtime = os.path.getmtime(os.path.join(UPLOAD_DIR, fname))
                orphans.append({"name": fname, "size": fsize, "mtime": mtime})
    total_files = len(os.listdir(UPLOAD_DIR)) if os.path.isdir(UPLOAD_DIR) else 0
    return {"code": 200, "total": total_files, "used": len(used), "orphans": orphans}

@app.post("/api/admin/files/cleanup")
def admin_cleanup_files(request: Request):
    if not request.state.is_super:
        return {"code": 403, "msg": "admin only"}
    conn = get_msg_db()
    used = set()
    for row in conn.execute("SELECT file_path FROM messages WHERE file_path != ''").fetchall():
        used.add(row['file_path'].lstrip('/'))
    conn.close()
    count = 0
    if os.path.isdir(UPLOAD_DIR):
        for fname in os.listdir(UPLOAD_DIR):
            fpath = f"uploads/{fname}"
            if fpath not in used:
                os.remove(os.path.join(UPLOAD_DIR, fname))
                count += 1
    return {"code": 200, "msg": f"cleaned {count} orphaned files"}

# ===== Private Chat =====

@app.get("/api/users")
def api_users(request: Request):
    if not request.state.username:
        return {"code": 401, "msg": "not logged in"}
    users = auth_util.get_all_non_banned_users(request.state.username)
    return {"code": 200, "data": users}

@app.get("/api/user/color")
def api_get_user_color(request: Request):
    if not request.state.username:
        return {"code": 401, "msg": "not logged in"}
    color = auth_util.get_user_color(request.state.username)
    return {"code": 200, "data": color}

class UserColorIn(BaseModel):
    bg: str = ''
    text: str = ''

@app.post("/api/user/color")
def api_set_user_color(request: Request, body: UserColorIn):
    if not request.state.username:
        return {"code": 401, "msg": "not logged in"}
    auth_util.set_user_color(request.state.username, body.bg, body.text)
    return {"code": 200, "msg": "ok"}

@app.get("/api/chat/private-chats")
def api_private_chats(request: Request):
    if not request.state.username:
        return {"code": 401, "msg": "not logged in"}
    chats = auth_util.get_private_chats(request.state.username)
    return {"code": 200, "data": chats}

class AddFriendIn(BaseModel):
    username: str

@app.post("/api/chat/private-chats")
def api_add_private_chat(request: Request, body: AddFriendIn):
    if not request.state.username:
        return {"code": 401, "msg": "not logged in"}
    room_id, msg = auth_util.add_private_chat(request.state.username, body.username)
    if room_id:
        return {"code": 200, "room_id": room_id, "msg": msg}
    return {"code": 400, "msg": msg}

@app.delete("/api/chat/private-chats/{friend}")
def api_delete_private_chat(request: Request, friend: str):
    if not request.state.username:
        return {"code": 401, "msg": "not logged in"}
    ok, msg = auth_util.delete_private_chat(request.state.username, friend)
    if ok:
        return {"code": 200, "msg": msg}
    return {"code": 400, "msg": msg}

# ===== Code Editor =====

def _validate_path(path: str):
    if ".." in path or path.startswith("/") or path.startswith("\\"):
        return False
    for d in EXCLUDED_DIRS:
        if path.startswith(d + "/") or path.startswith(d + "\\") or path == d:
            return False
    ext = os.path.splitext(path)[1].lower()
    if ext not in EDITABLE_EXTS:
        return False
    parts = path.replace("\\", "/").split("/")
    if len(parts) > 1 and parts[0] not in EDITABLE_DIRS:
        return False
    return True

@app.get("/api/admin/code-files")
def admin_code_files(request: Request):
    if not request.state.is_super:
        return {"code": 403, "msg": "admin only"}
    files = []
    for item in sorted(os.listdir(BASE_DIR)):
        full = os.path.join(BASE_DIR, item)
        if os.path.isfile(full):
            ext = os.path.splitext(item)[1].lower()
            if ext in EDITABLE_EXTS:
                files.append({"name": item, "type": "file", "path": item})
        elif os.path.isdir(full) and item in EDITABLE_DIRS[1:]:
            children = []
            for sub in sorted(os.listdir(full)):
                sub_full = os.path.join(full, sub)
                if os.path.isfile(sub_full):
                    sub_ext = os.path.splitext(sub)[1].lower()
                    if sub_ext in EDITABLE_EXTS:
                        children.append({"name": sub, "type": "file", "path": item + "/" + sub})
            files.append({"name": item, "type": "dir", "path": item, "children": children})
    return {"code": 200, "data": files}

@app.get("/api/admin/code-file")
def admin_read_code_file(request: Request, path: str = ""):
    if not request.state.is_super:
        return {"code": 403, "msg": "admin only"}
    if not path:
        return {"code": 400, "msg": "路径不能为空"}
    if not _validate_path(path):
        return {"code": 400, "msg": "非法路径"}
    full = os.path.join(BASE_DIR, path)
    if not os.path.isfile(full):
        return {"code": 404, "msg": "文件不存在"}
    try:
        with open(full, "r", encoding="utf-8") as f:
            content = f.read()
    except UnicodeDecodeError:
        return {"code": 400, "msg": "不支持的文件编码"}
    return {"code": 200, "data": {"path": path, "content": content}}

class CodeFileWriteIn(BaseModel):
    path: str
    content: str

@app.post("/api/admin/code-file")
def admin_write_code_file(request: Request, body: CodeFileWriteIn):
    if not request.state.is_super:
        return {"code": 403, "msg": "admin only"}
    if not body.path:
        return {"code": 400, "msg": "路径不能为空"}
    if not _validate_path(body.path):
        return {"code": 400, "msg": "非法路径"}
    full = os.path.join(BASE_DIR, body.path)
    if os.path.isfile(full):
        bak = full + ".bak"
        try:
            with open(full, "r", encoding="utf-8") as f:
                old = f.read()
            with open(bak, "w", encoding="utf-8") as f:
                f.write(old)
        except Exception:
            pass
    parent = os.path.dirname(full)
    if not os.path.exists(parent):
        os.makedirs(parent, exist_ok=True)
    try:
        with open(full, "w", encoding="utf-8") as f:
            f.write(body.content)
    except Exception as e:
        return {"code": 500, "msg": f"保存失败: {str(e)}"}
    return {"code": 200, "msg": "已保存"}

@app.post("/api/admin/restart")
def admin_restart_server(request: Request):
    if not request.state.is_super:
        return {"code": 403, "msg": "admin only"}
    import platform, subprocess
    system = platform.system()
    try:
        if system == "Windows":
            subprocess.Popen(
                f'start cmd /k "cd /d {os.getcwd()} && python main.py"',
                shell=True
            )
        else:
            subprocess.Popen(
                f'nohup python3 main.py > server.log 2>&1 &',
                shell=True,
                cwd=os.getcwd()
            )
        os._exit(0)
    except Exception as e:
        return {"code": 500, "msg": f"重启失败: {str(e)}"}

# ===== File Type Config =====

@app.get("/api/config/file-types")
def get_file_types():
    data = file_config.get_frontend_config()
    data["max_file_size_mb"] = get_max_file_size() // (1024 * 1024)
    data["max_download_size_mb"] = get_max_download_size() // (1024 * 1024)
    return {"code": 200, "data": data}

# ===== Admin Room Endpoints =====

@app.get("/api/admin/rooms")
def admin_rooms(request: Request):
    if not request.state.is_super:
        return {"code": 403, "msg": "admin only"}
    rooms = auth_util.admin_get_all_rooms()
    return {"code": 200, "data": rooms}

@app.put("/api/admin/rooms/{room_id}")
def admin_rename_room(room_id: int, body: RenameRoomIn, request: Request):
    if not request.state.is_super:
        return {"code": 403, "msg": "admin only"}
    name = body.name.strip()
    if not name or len(name) > 50:
        return {"code": 400, "msg": "房间名无效 (1-50字符)"}
    ok, msg = auth_util.admin_rename_room(room_id, name)
    if ok:
        return {"code": 200, "msg": msg}
    return {"code": 400, "msg": msg}

@app.post("/api/admin/rooms/reorder")
def admin_reorder_rooms(body: ReorderRoomsIn, request: Request):
    if not request.state.is_super:
        return {"code": 403, "msg": "admin only"}
    ok, msg = auth_util.admin_reorder_rooms(body.orders)
    if ok:
        return {"code": 200, "msg": msg}
    return {"code": 400, "msg": msg}

@app.delete("/api/admin/rooms/{room_id}")
def admin_delete_room(room_id: int, request: Request):
    if not request.state.is_super:
        return {"code": 403, "msg": "admin only"}
    ok, msg = auth_util.admin_delete_room(room_id)
    if ok:
        return {"code": 200, "msg": msg}
    return {"code": 400, "msg": msg}

@app.get("/api/admin/config")
def admin_get_config(request: Request):
    if not request.state.is_super:
        return {"code": 403, "msg": "admin only"}
    return {"code": 200, "data": auth_util.get_all_config()}

@app.post("/api/admin/config")
def admin_set_config(request: Request, body: ConfigIn):
    if not request.state.is_super:
        return {"code": 403, "msg": "admin only"}
    auth_util.set_config("auto_file_enabled", body.auto_file_enabled)
    auth_util.set_config("auto_file_max_chars", body.auto_file_max_chars)
    auth_util.set_config("auto_file_max_lines", body.auto_file_max_lines)
    for key, val in (("upload_max_size_mb", body.upload_max_size_mb),
                     ("download_max_size_mb", body.download_max_size_mb)):
        try:
            mb = int(val)
            if mb < 1 or mb > 102400:
                return {"code": 400, "msg": "大小限制需在 1-102400 MB 之间"}
        except (TypeError, ValueError):
            return {"code": 400, "msg": "大小限制必须是整数 (MB)"}
        auth_util.set_config(key, str(mb))
    return {"code": 200, "msg": "配置已保存"}

class BatchDeleteIn(BaseModel):
    ids: list[int]

class RenameFileIn(BaseModel):
    name: str

class SearchIn(BaseModel):
    keyword: str = ""
    room_id: int = 0
    type: str = "all"
    date_from: str = ""
    date_to: str = ""
    page: int = 1
    page_size: int = 50

@app.get("/api/chat/search")
def search_messages(keyword: str = "", room_id: int = 0, type: str = "all",
                    date_from: str = "", date_to: str = "", page: int = 1, page_size: int = 50,
                    request: Request = None):
    username = request.state.username
    conn = get_msg_db()
    conditions = ["m.room_id=?"]
    params = [room_id]
    if type == "text":
        if keyword:
            conditions.append("((m.msg_type='text' AND m.content LIKE ?) OR (m.msg_type='file' AND (m.content LIKE ? OR m.file_name LIKE ?)))")
            params.extend([f"%{keyword}%", f"%{keyword}%", f"%{keyword}%"])
        else:
            conditions.append("(m.msg_type='text' OR (m.msg_type='file' AND m.file_name LIKE '%.txt%'))")
    elif type == "file":
        conditions.append("m.msg_type='file' AND m.file_name NOT LIKE '%.txt%'")
        if keyword:
            conditions.append("m.file_name LIKE ?")
            params.append(f"%{keyword}%")
    else:
        if keyword:
            conditions.append("((m.msg_type='text' AND m.content LIKE ?) OR (m.msg_type='file' AND (m.content LIKE ? OR m.file_name LIKE ?)))")
            params.extend([f"%{keyword}%", f"%{keyword}%", f"%{keyword}%"])
    sender = request.query_params.get("sender", "")
    if sender:
        conditions.append("m.username=?")
        params.append(sender)
    if date_from:
        conditions.append("m.create_time >= ?")
        params.append(date_from)
    if date_to:
        conditions.append("m.create_time <= ?")
        params.append(date_to)
    where = " AND ".join(conditions)
    count = conn.execute(f"SELECT COUNT(*) as c FROM messages m WHERE {where}", params).fetchone()['c']
    offset = (page - 1) * page_size
    rows = conn.execute(
        f"SELECT m.* FROM messages m WHERE {where} ORDER BY m.id DESC LIMIT ? OFFSET ?",
        params + [page_size, offset]
    ).fetchall()
    conn.close()
    _attach_colors_to_messages(rows)
    return {"code": 200, "data": rows, "total": count, "page": page, "page_size": page_size}

@app.post("/api/chat/files/{msg_id}/rename")
def rename_file(msg_id: int, body: RenameFileIn, request: Request):
    username = request.state.username
    conn = get_msg_db()
    msg = conn.execute("SELECT * FROM messages WHERE id=? AND msg_type='file'", (msg_id,)).fetchone()
    if not msg:
        conn.close()
        return {"code": 404, "msg": "file not found"}
    if msg['username'] != username and not request.state.is_super:
        conn.close()
        return {"code": 403, "msg": "can only rename your own files"}
    new_name = body.name.strip()
    if not new_name:
        conn.close()
        return {"code": 400, "msg": "name is empty"}
    old_path = msg['file_path']
    ext = os.path.splitext(msg['file_name'])[1]
    if not os.path.splitext(new_name)[1]:
        new_name += ext
    conn.execute("UPDATE messages SET file_name=? WHERE id=?", (new_name, msg_id))
    conn.commit()
    conn.close()
    return {"code": 200, "msg": "renamed", "file_name": new_name}

@app.post("/api/chat/messages/batch-delete")
def batch_delete_messages(body: BatchDeleteIn, request: Request):
    username = request.state.username
    ids = body.ids
    if not ids:
        return {"code": 400, "msg": "no ids"}
    conn = get_msg_db()
    placeholders = ','.join('?' * len(ids))
    rows = conn.execute(f"SELECT * FROM messages WHERE id IN ({placeholders})", ids).fetchall()
    to_delete = []
    for msg in rows:
        if msg['username'] == username or request.state.is_super:
            to_delete.append(msg['id'])
            if msg['file_path']:
                fp = os.path.join(BASE_DIR, msg['file_path'].lstrip('/'))
                if os.path.exists(fp):
                    os.remove(fp)
    if to_delete:
        ph = ','.join('?' * len(to_delete))
        conn.execute(f"DELETE FROM desktop_items WHERE msg_id IN ({ph})", to_delete)
        conn.execute(f"DELETE FROM messages WHERE id IN ({ph})", to_delete)
    conn.commit()
    conn.close()
    return {"code": 200, "msg": f"deleted {len(to_delete)} messages"}

# ================================================================
# ===== Desktop / 文件桌面（由桌面版升级包合并） =====
# ================================================================

# ===== File Desktop =====

FILE_CATEGORIES = {
    'audio': {'mp3','wav','flac','m4a','aac','ogg','oga','wma','opus','ape','amr'},
    'video': {'mp4','avi','mkv','mov','wmv','flv','webm','m4v','mpg','mpeg','3gp','ts'},
    'image': {'png','jpg','jpeg','gif','bmp','webp','svg','ico','tif','tiff'},
    'pdf': {'pdf'},
    'text': {'txt','md','markdown','json','xml','csv','log','ini','yml','yaml','py','js','css','html','htm','sh','bat','c','cpp','h','hpp','java','go','rs','php','sql','conf','toml','env','vue','ts','tsx','jsx'},
    'office': {'doc','docx','xls','xlsx','ppt','pptx','wps','et','dps','odt','ods','odp','rtf'},
    'archive': {'zip','rar','7z','tar','gz','bz2','xz','tgz','war','jar'},
}
ALL_CATEGORIES = ['audio','video','image','pdf','text','office','archive','other']
TEXT_EDIT_EXTS = FILE_CATEGORIES['text']

def _ext_of(name):
    return name.rsplit('.', 1)[-1].lower() if name and '.' in name else ''

def _category_of(ext):
    for cat in ALL_CATEGORIES:
        if ext in FILE_CATEGORIES.get(cat, set()):
            return cat
    return 'other'

def _visible_rooms(username):
    conn = auth_util.get_conn()
    member_rooms = {r['room_id'] for r in conn.execute("SELECT room_id FROM room_members WHERE username=?", (username,)).fetchall()}
    room_rows = conn.execute("SELECT id, name, is_public FROM rooms").fetchall()
    visible = {0: '大厅'}
    for r in room_rows:
        if r['is_public'] or r['id'] in member_rooms:
            visible[r['id']] = r['name']
    for pr in conn.execute("SELECT * FROM private_chats WHERE user1=? OR user2=?", (username, username)).fetchall():
        friend = pr['user2'] if pr['user1'] == username else pr['user1']
        finfo = conn.execute("SELECT nickname FROM users WHERE username=?", (friend,)).fetchone()
        visible[pr['room_id']] = '@' + (finfo['nickname'] if finfo and finfo['nickname'] else friend)
    conn.close()
    return visible

@app.get("/api/files/desktop")
def api_files_desktop(request: Request):
    username = request.state.username
    visible = _visible_rooms(username)
    conn = get_msg_db()
    rows = conn.execute("SELECT * FROM messages WHERE file_path != '' AND file_path IS NOT NULL ORDER BY id DESC").fetchall()
    conn.close()
    data = {cat: [] for cat in ALL_CATEGORIES}
    for m in rows:
        rid = m['room_id']
        if rid not in visible:
            continue
        ext = _ext_of(m['file_name'])
        cat = _category_of(ext)
        data[cat].append({
            'id': m['id'],
            'name': m['file_name'],
            'path': m['file_path'],
            'size': m['file_size'],
            'ext': ext,
            'category': cat,
            'sender': m['username'],
            'sender_name': m['nickname'] or m['username'],
            'room_id': rid,
            'folder': visible[rid],
            'time': m['create_time'],
        })
    return {"code": 200, "data": data}

def _get_visible_msg(username, msg_id):
    conn = get_msg_db()
    msg = conn.execute("SELECT * FROM messages WHERE id=?", (msg_id,)).fetchone()
    conn.close()
    if not msg or not msg['file_path']:
        return None, "文件不存在"
    visible = _visible_rooms(username)
    if msg['room_id'] not in visible:
        return None, "无权访问该文件"
    return msg, None

@app.get("/api/files/content")
def api_file_content(request: Request, msg_id: int = 0):
    msg, err = _get_visible_msg(request.state.username, msg_id)
    if err:
        return {"code": 403 if "无权" in err else 404, "msg": err}
    ext = _ext_of(msg['file_name'])
    if ext not in TEXT_EDIT_EXTS:
        return {"code": 400, "msg": "该文件不支持编辑"}
    full = os.path.join(BASE_DIR, msg['file_path'].lstrip('/'))
    if not os.path.isfile(full):
        return {"code": 404, "msg": "文件缺失"}
    try:
        with open(full, 'r', encoding='utf-8') as f:
            content = f.read()
    except UnicodeDecodeError:
        return {"code": 400, "msg": "不支持的文件编码（非纯文本）"}
    except Exception as e:
        return {"code": 500, "msg": str(e)}
    return {"code": 200, "data": {"id": msg_id, "name": msg['file_name'], "ext": ext, "content": content}}

class FileSaveIn(BaseModel):
    msg_id: int = 0
    item_id: int = 0
    content: str = ''

@app.post("/api/files/content")
def api_file_save(request: Request, body: FileSaveIn):
    username = request.state.username
    conn = get_msg_db()
    if body.msg_id:
        msg, err = _get_visible_msg(username, body.msg_id)
        if err:
            conn.close()
            return {"code": 403 if "无权" in err else 404, "msg": err}
        ext = _ext_of(msg['file_name'])
        full = os.path.join(BASE_DIR, msg['file_path'].lstrip('/'))
        save_key = ('msg', body.msg_id)
    else:
        item = conn.execute(
            "SELECT * FROM desktop_items WHERE id=? AND username=? AND item_type='file' AND msg_id IS NULL",
            (body.item_id, username)).fetchone()
        if not item:
            conn.close()
            return {"code": 404, "msg": "文件不存在"}
        ext = _ext_of(item['name'])
        full = os.path.join(BASE_DIR, item['file_path'].lstrip('/')) if item['file_path'] else ''
        save_key = ('item', body.item_id)
    if ext not in TEXT_EDIT_EXTS:
        conn.close()
        return {"code": 400, "msg": "该文件不支持编辑"}
    if not full or not os.path.isfile(full):
        conn.close()
        return {"code": 404, "msg": "文件缺失"}
    try:
        with open(full, 'w', encoding='utf-8') as f:
            f.write(body.content)
        new_size = os.path.getsize(full)
    except Exception as e:
        conn.close()
        return {"code": 500, "msg": f"保存失败: {e}"}
    if save_key[0] == 'msg':
        conn.execute("UPDATE messages SET file_size=? WHERE id=?", (new_size, save_key[1]))
    else:
        conn.execute("UPDATE desktop_items SET file_size=? WHERE id=?", (new_size, save_key[1]))
    conn.commit()
    conn.close()
    return {"code": 200, "msg": "已保存", "size": new_size}

# ===== 公共共享文件夹 =====

def _shared_public(r, username, is_super):
    ext = _ext_of(r['name'])
    return {
        'id': r['id'],
        'name': r['name'],
        'path': r['file_path'],
        'size': r['file_size'],
        'ext': ext,
        'category': _category_of(ext),
        'sender': r['uploader'],
        'sender_name': r['uploader_name'] or r['uploader'],
        'time': r['create_time'],
        'can_delete': (r['uploader'] == username or is_super == 1),
    }


@app.get("/api/shared/files")
def api_shared_files(request: Request):
    username = request.state.username
    is_super = request.state.is_super
    conn = get_msg_db()
    rows = conn.execute("SELECT * FROM shared_files ORDER BY id DESC").fetchall()
    conn.close()
    return {"code": 200, "data": [_shared_public(r, username, is_super) for r in rows]}


class SharedAddIn(BaseModel):
    msg_id: int = 0
    item_id: int = 0


@app.post("/api/shared/add")
def api_shared_add(request: Request, body: SharedAddIn):
    username = request.state.username
    nickname = request.state.nickname or username
    conn = get_msg_db()
    file_path = ''
    file_name = ''
    file_size = 0
    if body.msg_id:
        visible = _visible_rooms(username)
        m = conn.execute("SELECT * FROM messages WHERE id=?", (body.msg_id,)).fetchone()
        if not m or not m['file_path'] or m['room_id'] not in visible:
            conn.close()
            return {"code": 403, "msg": "无权访问该文件"}
        file_path = m['file_path']
        file_name = m['file_name'] or os.path.basename(file_path)
        file_size = m['file_size'] or 0
    elif body.item_id:
        it = conn.execute("SELECT * FROM desktop_items WHERE id=? AND username=? AND item_type='file' AND msg_id IS NULL",
                          (body.item_id, username)).fetchone()
        if not it or not it['file_path']:
            conn.close()
            return {"code": 404, "msg": "文件不存在"}
        file_path = it['file_path']
        file_name = it['name'] or os.path.basename(file_path)
        file_size = it['file_size'] or 0
    else:
        conn.close()
        return {"code": 400, "msg": "缺少文件参数"}
    full = os.path.join(BASE_DIR, file_path.lstrip('/'))
    if not os.path.isfile(full):
        conn.close()
        return {"code": 404, "msg": "文件缺失"}
    exist = conn.execute("SELECT id FROM shared_files WHERE file_path=?", (file_path,)).fetchone()
    if exist:
        conn.close()
        return {"code": 200, "msg": "该文件已在共享文件夹中", "id": exist['id']}
    conn.execute(
        "INSERT INTO shared_files (uploader, uploader_name, name, file_path, file_size, source_msg_id) VALUES (?, ?, ?, ?, ?, ?)",
        (username, nickname, file_name, file_path, file_size, body.msg_id or 0))
    conn.commit()
    sid = conn.execute("SELECT last_insert_rowid() AS id").fetchone()['id']
    conn.close()
    return {"code": 200, "msg": "已添加到共享文件夹", "id": sid}


@app.post("/api/shared/upload")
async def api_shared_upload(request: Request, file: UploadFile = File(...)):
    username = request.state.username
    nickname = request.state.nickname or username
    ext = file.filename.split('.')[-1].lower() if file.filename and '.' in file.filename else ''
    if ext not in ALLOWED_EXTENSIONS:
        return {"code": 400, "msg": f"不支持的文件类型 .{ext}"}
    content = await file.read()
    max_size = get_max_file_size()
    if len(content) > max_size:
        return {"code": 400, "msg": f"文件过大，最大允许 {max_size // (1024 * 1024)}MB"}
    saved_name = f"{uuid.uuid4().hex}.{ext}"
    with open(os.path.join(UPLOAD_DIR, saved_name), 'wb') as f:
        f.write(content)
    conn = get_msg_db()
    conn.execute(
        "INSERT INTO shared_files (uploader, uploader_name, name, file_path, file_size) VALUES (?, ?, ?, ?, ?)",
        (username, nickname, file.filename, f"/uploads/{saved_name}", len(content)))
    conn.commit()
    sid = conn.execute("SELECT last_insert_rowid() AS id").fetchone()['id']
    conn.close()
    return {"code": 200, "msg": "上传成功", "id": sid}


@app.delete("/api/shared/files/{sid}")
def api_shared_delete(request: Request, sid: int):
    username = request.state.username
    is_super = request.state.is_super
    conn = get_msg_db()
    row = conn.execute("SELECT * FROM shared_files WHERE id=?", (sid,)).fetchone()
    if not row:
        conn.close()
        return {"code": 404, "msg": "文件不存在"}
    if row['uploader'] != username and is_super != 1:
        conn.close()
        return {"code": 403, "msg": "只有上传者或管理员可以删除"}
    file_path = row['file_path']
    conn.execute("DELETE FROM shared_files WHERE id=?", (sid,))
    conn.commit()
    if file_path.startswith('/uploads/'):
        still = conn.execute("SELECT COUNT(*) AS c FROM shared_files WHERE file_path=?", (file_path,)).fetchone()['c']
        used = conn.execute("SELECT COUNT(*) AS c FROM messages WHERE file_path=?", (file_path,)).fetchone()['c']
        if not still and not used:
            try:
                os.remove(os.path.join(BASE_DIR, file_path.lstrip('/')))
            except Exception:
                pass
    conn.close()
    return {"code": 200, "msg": "已删除"}


class SharedCopyIn(BaseModel):
    id: int = 0
    parent_id: int = 0


@app.post("/api/shared/copy")
def api_shared_copy(request: Request, body: SharedCopyIn):
    username = request.state.username
    conn = get_msg_db()
    if _is_system_folder(conn, username, body.parent_id):
        conn.close()
        return {"code": 400, "msg": "系统文件夹不可写入"}
    row = conn.execute("SELECT * FROM shared_files WHERE id=?", (body.id,)).fetchone()
    if not row:
        conn.close()
        return {"code": 404, "msg": "文件不存在"}
    new_path, size = _duplicate_upload(row['file_path'])
    if not new_path:
        conn.close()
        return {"code": 404, "msg": "文件缺失"}
    conn.execute(
        "INSERT INTO desktop_items (username, item_type, name, msg_id, file_path, parent_id, file_size) VALUES (?, 'file', ?, NULL, ?, ?, ?)",
        (username, row['name'], new_path, body.parent_id, size))
    conn.commit()
    conn.close()
    return {"code": 200, "msg": "已复制到桌面"}


# ===== Interactive Desktop =====

def _ensure_system_folders(username):
    conn = get_msg_db()
    have = {r['system_key'] for r in conn.execute(
        "SELECT system_key FROM desktop_items WHERE username=? AND item_type='folder' AND system_key!=''",
        (username,)).fetchall()}
    for key in ALL_CATEGORIES:
        if key not in have:
            conn.execute(
                "INSERT INTO desktop_items (username, item_type, name, system_key, parent_id) VALUES (?, 'folder', ?, ?, 0)",
                (username, key, key))
    conn.commit()
    conn.close()

def _is_system_folder(conn, username, fid):
    """系统分类文件夹受保护：不可写入 / 移动 / 删除。"""
    if not fid:
        return False
    row = conn.execute(
        "SELECT system_key FROM desktop_items WHERE id=? AND username=? AND item_type='folder'",
        (fid, username)).fetchone()
    return bool(row and row['system_key'])

def _msg_public(m, visible, username, is_super):
    ext = _ext_of(m['file_name'])
    return {
        'id': m['id'],
        'name': m['file_name'],
        'path': m['file_path'],
        'size': m['file_size'],
        'ext': ext,
        'category': _category_of(ext),
        'sender': m['username'],
        'sender_name': m['nickname'] or m['username'],
        'room_id': m['room_id'],
        'folder': visible.get(m['room_id'], ''),
        'time': m['create_time'],
        'can_edit': (m['username'] == username or is_super == 1),
    }

@app.get("/api/desktop")
def api_desktop(request: Request):
    username = request.state.username
    is_super = request.state.is_super
    _ensure_system_folders(username)
    visible = _visible_rooms(username)
    conn = get_msg_db()
    folders = [dict(f) for f in conn.execute(
        "SELECT * FROM desktop_items WHERE username=? AND item_type='folder'", (username,)).fetchall()]
    file_items = [dict(f) for f in conn.execute(
        "SELECT * FROM desktop_items WHERE username=? AND item_type='file'", (username,)).fetchall()]
    msgs = conn.execute("SELECT * FROM messages WHERE file_path != '' AND file_path IS NOT NULL ORDER BY id DESC").fetchall()
    prefs = conn.execute("SELECT wallpaper, wallpaper_mode FROM user_prefs WHERE username=?", (username,)).fetchone()
    wp_uploads = [dict(r) for r in conn.execute(
        "SELECT id, name, file_path FROM wallpapers WHERE username=? ORDER BY id DESC", (username,)).fetchall()]
    conn.close()
    messages = [_msg_public(m, visible, username, is_super) for m in msgs if m['room_id'] in visible]
    return {"code": 200, "data": {
        "folders": folders,
        "file_items": file_items,
        "messages": messages,
        "categories": ALL_CATEGORIES,
        "username": username,
        "is_super": is_super,
        "wallpaper": prefs['wallpaper'] if prefs else '',
        "wallpaper_mode": prefs['wallpaper_mode'] if prefs else 'cover',
        "wallpaper_uploads": wp_uploads,
    }}

class WallpaperIn(BaseModel):
    wallpaper: str = ''
    mode: str = 'cover'

WALLPAPER_MODES = {'cover', 'contain', 'stretch', 'tile', 'center', 'repeat-x', 'repeat-y'}

@app.get("/api/desktop/wallpaper")
def api_wallpaper_get(request: Request):
    username = request.state.username
    conn = get_msg_db()
    prefs = conn.execute("SELECT wallpaper, wallpaper_mode FROM user_prefs WHERE username=?", (username,)).fetchone()
    uploads = [dict(r) for r in conn.execute(
        "SELECT id, name, file_path FROM wallpapers WHERE username=? ORDER BY id DESC", (username,)).fetchall()]
    conn.close()
    return {"code": 200, "data": {
        "wallpaper": prefs['wallpaper'] if prefs else '',
        "mode": prefs['wallpaper_mode'] if prefs else 'cover',
        "uploads": uploads,
    }}

@app.post("/api/desktop/wallpaper")
def api_wallpaper_set(request: Request, body: WallpaperIn):
    username = request.state.username
    wallpaper = (body.wallpaper or '').strip()
    mode = body.mode if body.mode in WALLPAPER_MODES else 'cover'
    if wallpaper and not (wallpaper.startswith('http://') or wallpaper.startswith('https://') or wallpaper.startswith('/wallpapers/') or wallpaper.startswith('/uploads/')):
        return {"code": 400, "msg": "无效的壁纸地址"}
    conn = get_msg_db()
    conn.execute("""INSERT INTO user_prefs (username, wallpaper, wallpaper_mode, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(username) DO UPDATE SET wallpaper=excluded.wallpaper, wallpaper_mode=excluded.wallpaper_mode, updated_at=CURRENT_TIMESTAMP""",
        (username, wallpaper, mode))
    conn.commit()
    conn.close()
    return {"code": 200, "wallpaper": wallpaper, "mode": mode}

class PrefsIn(BaseModel):
    prefs: dict = {}

PREFS_MAX_BYTES = 256 * 1024

@app.get("/api/user/prefs")
def api_prefs_get(request: Request):
    username = request.state.username
    conn = get_msg_db()
    row = conn.execute("SELECT prefs FROM user_prefs WHERE username=?", (username,)).fetchone()
    conn.close()
    data = {}
    if row and row['prefs']:
        try:
            data = json.loads(row['prefs'])
        except Exception:
            data = {}
    return {"code": 200, "prefs": data}

@app.post("/api/user/prefs")
def api_prefs_set(request: Request, body: PrefsIn):
    username = request.state.username
    data = body.prefs if isinstance(body.prefs, dict) else {}
    try:
        raw = json.dumps(data, ensure_ascii=False)
    except Exception:
        return {"code": 400, "msg": "无效的偏好数据"}
    if len(raw.encode("utf-8")) > PREFS_MAX_BYTES:
        return {"code": 400, "msg": "偏好数据过大"}
    conn = get_msg_db()
    conn.execute("""INSERT INTO user_prefs (username, prefs, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(username) DO UPDATE SET prefs=excluded.prefs, updated_at=CURRENT_TIMESTAMP""",
        (username, raw))
    conn.commit()
    conn.close()
    return {"code": 200, "msg": "ok"}

@app.post("/api/desktop/wallpaper/upload")
async def api_wallpaper_upload(request: Request, file: UploadFile = File(...)):
    username = request.state.username
    ext = file.filename.split('.')[-1].lower() if file.filename and '.' in file.filename else ''
    if ext not in WALLPAPER_EXTENSIONS:
        return {"code": 400, "msg": f"不支持的图片格式 .{ext}"}
    content = await file.read()
    if len(content) > MAX_WALLPAPER_SIZE:
        return {"code": 400, "msg": "图片过大（最大 20MB）"}
    saved_name = f"{uuid.uuid4().hex}.{ext}"
    with open(os.path.join(WALLPAPER_DIR, saved_name), 'wb') as f:
        f.write(content)
    path = '/wallpapers/' + saved_name
    conn = get_msg_db()
    conn.execute("INSERT INTO wallpapers (username, name, file_path) VALUES (?, ?, ?)",
                 (username, file.filename, path))
    conn.commit()
    wid = conn.execute("SELECT last_insert_rowid() AS id").fetchone()['id']
    conn.close()
    return {"code": 200, "data": {"id": wid, "name": file.filename, "path": path}}

@app.delete("/api/desktop/wallpaper/upload/{wid}")
def api_wallpaper_delete(request: Request, wid: int):
    username = request.state.username
    conn = get_msg_db()
    row = conn.execute("SELECT * FROM wallpapers WHERE id=? AND username=?", (wid, username)).fetchone()
    if not row:
        conn.close()
        return {"code": 404, "msg": "未找到该壁纸"}
    if row['file_path'].startswith('/wallpapers/'):
        full = os.path.join(WALLPAPER_DIR, os.path.basename(row['file_path']))
        try:
            if os.path.isfile(full):
                os.remove(full)
        except Exception:
            pass
    conn.execute("DELETE FROM wallpapers WHERE id=?", (wid,))
    conn.execute("UPDATE user_prefs SET wallpaper='' WHERE username=? AND wallpaper=?", (username, row['file_path']))
    conn.commit()
    conn.close()
    return {"code": 200}

class PlaceIn(BaseModel):
    msg_ids: list = []
    parent_id: int = 0

@app.post("/api/desktop/place")
def api_desktop_place(request: Request, body: PlaceIn):
    username = request.state.username
    visible = _visible_rooms(username)
    conn = get_msg_db()
    if _is_system_folder(conn, username, body.parent_id):
        conn.close()
        return {"code": 400, "msg": "系统文件夹不可写入"}
    moved = 0
    for mid in body.msg_ids:
        m = conn.execute("SELECT * FROM messages WHERE id=?", (mid,)).fetchone()
        if not m or not m['file_path'] or m['room_id'] not in visible:
            continue
        row = conn.execute("SELECT id FROM desktop_items WHERE username=? AND item_type='file' AND msg_id=?",
                           (username, mid)).fetchone()
        if row:
            conn.execute("UPDATE desktop_items SET parent_id=? WHERE id=?", (body.parent_id, row['id']))
        else:
            conn.execute("INSERT INTO desktop_items (username, item_type, name, msg_id, parent_id) VALUES (?, 'file', ?, ?, ?)",
                         (username, m['file_name'], mid, body.parent_id))
        moved += 1
    conn.commit()
    conn.close()
    return {"code": 200, "moved": moved}

class CopyIn(BaseModel):
    msg_ids: list = []
    item_ids: list = []
    parent_id: int = 0

def _duplicate_upload(src_path):
    if not src_path:
        return None, 0
    src_full = os.path.join(BASE_DIR, src_path.lstrip('/'))
    if not os.path.isfile(src_full):
        return None, 0
    ext = _ext_of(src_path)
    new_name = uuid.uuid4().hex + ('.' + ext if ext else '')
    dst_full = os.path.join(UPLOAD_DIR, new_name)
    shutil.copyfile(src_full, dst_full)
    return '/uploads/' + new_name, os.path.getsize(dst_full)

@app.post("/api/desktop/copy")
def api_desktop_copy(request: Request, body: CopyIn):
    username = request.state.username
    visible = _visible_rooms(username)
    conn = get_msg_db()
    if _is_system_folder(conn, username, body.parent_id):
        conn.close()
        return {"code": 400, "msg": "系统文件夹不可写入"}
    copied = 0
    for mid in body.msg_ids:
        m = conn.execute("SELECT * FROM messages WHERE id=?", (mid,)).fetchone()
        if not m or not m['file_path'] or m['room_id'] not in visible:
            continue
        new_path, size = _duplicate_upload(m['file_path'])
        if not new_path:
            continue
        conn.execute(
            "INSERT INTO desktop_items (username, item_type, name, msg_id, file_path, parent_id, file_size) VALUES (?, 'file', ?, NULL, ?, ?, ?)",
            (username, m['file_name'], new_path, body.parent_id, size))
        copied += 1
    for iid in body.item_ids:
        it = conn.execute("SELECT * FROM desktop_items WHERE id=? AND username=? AND item_type='file' AND msg_id IS NULL",
                          (iid, username)).fetchone()
        if not it:
            continue
        new_path, size = _duplicate_upload(it['file_path'])
        if not new_path:
            continue
        conn.execute(
            "INSERT INTO desktop_items (username, item_type, name, msg_id, file_path, parent_id, file_size) VALUES (?, 'file', ?, NULL, ?, ?, ?)",
            (username, it['name'], new_path, body.parent_id, size))
        copied += 1
    conn.commit()
    conn.close()
    return {"code": 200, "copied": copied}

def _resolve_archives(conn, username, visible, msg_ids, item_ids):
    files = []
    for mid in msg_ids:
        m = conn.execute("SELECT * FROM messages WHERE id=?", (mid,)).fetchone()
        if m and m['file_path'] and m['room_id'] in visible:
            full = os.path.join(BASE_DIR, m['file_path'].lstrip('/'))
            if os.path.isfile(full):
                files.append((m['file_name'] or 'file', full))
    for iid in item_ids:
        it = conn.execute("SELECT * FROM desktop_items WHERE id=? AND username=? AND item_type='file' AND msg_id IS NULL",
                          (iid, username)).fetchone()
        if it and it['file_path']:
            full = os.path.join(BASE_DIR, it['file_path'].lstrip('/'))
            if os.path.isfile(full):
                files.append((it['name'] or 'file', full))
    return files

def _insert_copy(conn, username, name, src_full, parent_id):
    ext = _ext_of(name)
    new_name = uuid.uuid4().hex + ('.' + ext if ext else '')
    dst_full = os.path.join(UPLOAD_DIR, new_name)
    shutil.copyfile(src_full, dst_full)
    size = os.path.getsize(dst_full)
    conn.execute(
        "INSERT INTO desktop_items (username, item_type, name, msg_id, file_path, parent_id, file_size) VALUES (?, 'file', ?, NULL, ?, ?, ?)",
        (username, name, '/uploads/' + new_name, parent_id, size))
    return size

class CompressIn(BaseModel):
    msg_ids: list = []
    item_ids: list = []
    parent_id: int = 0
    name: str = ''

@app.post("/api/desktop/compress")
def api_desktop_compress(request: Request, body: CompressIn):
    username = request.state.username
    visible = _visible_rooms(username)
    conn = get_msg_db()
    if _is_system_folder(conn, username, body.parent_id):
        conn.close()
        return {"code": 400, "msg": "系统文件夹不可写入"}
    files = _resolve_archives(conn, username, visible, body.msg_ids, body.item_ids)
    if not files:
        conn.close()
        return {"code": 400, "msg": "没有可压缩的文件"}
    zip_name = uuid.uuid4().hex + '.zip'
    zip_full = os.path.join(UPLOAD_DIR, zip_name)
    try:
        with zipfile.ZipFile(zip_full, 'w', zipfile.ZIP_DEFLATED) as zf:
            used = {}
            for arc, full in files:
                base = arc or os.path.basename(full)
                if base in used:
                    used[base] += 1
                    stem, ext = os.path.splitext(base)
                    base = f"{stem}({used[base]}){ext}"
                else:
                    used[base] = 0
                zf.write(full, base)
    except Exception as e:
        conn.close()
        return {"code": 500, "msg": f"压缩失败: {e}"}
    size = os.path.getsize(zip_full)
    display = (body.name.strip()[:120] or '压缩包') + '.zip'
    conn.execute(
        "INSERT INTO desktop_items (username, item_type, name, msg_id, file_path, parent_id, file_size) VALUES (?, 'file', ?, NULL, ?, ?, ?)",
        (username, display, '/uploads/' + zip_name, body.parent_id, size))
    conn.commit()
    conn.close()
    return {"code": 200, "data": {"name": display, "size": size}}

class ExtractIn(BaseModel):
    msg_id: int = 0
    item_id: int = 0
    parent_id: int = 0

@app.post("/api/desktop/extract")
def api_desktop_extract(request: Request, body: ExtractIn):
    username = request.state.username
    visible = _visible_rooms(username)
    conn = get_msg_db()
    if _is_system_folder(conn, username, body.parent_id):
        conn.close()
        return {"code": 400, "msg": "系统文件夹不可写入"}
    path = None
    name = ''
    if body.msg_id:
        m = conn.execute("SELECT * FROM messages WHERE id=?", (body.msg_id,)).fetchone()
        if m and m['file_path'] and m['room_id'] in visible:
            path, name = m['file_path'], m['file_name'] or ''
    elif body.item_id:
        it = conn.execute("SELECT * FROM desktop_items WHERE id=? AND username=? AND item_type='file' AND msg_id IS NULL",
                          (body.item_id, username)).fetchone()
        if it:
            path, name = it['file_path'], it['name'] or ''
    if not path:
        conn.close()
        return {"code": 404, "msg": "文件不存在"}
    full = os.path.join(BASE_DIR, path.lstrip('/'))
    if not os.path.isfile(full):
        conn.close()
        return {"code": 404, "msg": "文件缺失"}
    folder_name = (os.path.splitext(name)[0] or '解压')[:60] or '解压'
    conn.execute("INSERT INTO desktop_items (username, item_type, name, parent_id) VALUES (?, 'folder', ?, ?)",
                 (username, folder_name, body.parent_id))
    fid = conn.execute("SELECT last_insert_rowid() as id").fetchone()['id']
    extracted = 0
    low = name.lower()
    try:
        entries = []
        if low.endswith('.zip'):
            with zipfile.ZipFile(full) as zf:
                for info in zf.infolist():
                    if info.is_dir():
                        continue
                    base = os.path.basename(info.filename.strip('/'))
                    if not base:
                        continue
                    entries.append((base, zf.read(info)))
        elif low.endswith(('.tar', '.tar.gz', '.tgz', '.gz', '.bz2', '.xz')):
            with tarfile.open(full) as tf:
                for member in tf.getmembers():
                    if not member.isfile():
                        continue
                    fobj = tf.extractfile(member)
                    if not fobj:
                        continue
                    base = os.path.basename(member.name.strip('/'))
                    if not base:
                        continue
                    entries.append((base, fobj.read()))
        else:
            conn.execute("DELETE FROM desktop_items WHERE id=?", (fid,))
            conn.commit()
            conn.close()
            return {"code": 400, "msg": "暂不支持该格式（支持 zip / tar / gz）"}
        for base, data in entries:
            ext = _ext_of(base)
            new = uuid.uuid4().hex + ('.' + ext if ext else '')
            with open(os.path.join(UPLOAD_DIR, new), 'wb') as f:
                f.write(data)
            conn.execute(
                "INSERT INTO desktop_items (username, item_type, name, msg_id, file_path, parent_id, file_size) VALUES (?, 'file', ?, NULL, ?, ?, ?)",
                (username, base, '/uploads/' + new, fid, len(data)))
            extracted += 1
    except Exception as e:
        conn.execute("DELETE FROM desktop_items WHERE id=?", (fid,))
        conn.commit()
        conn.close()
        return {"code": 500, "msg": f"解压失败: {e}"}
    conn.commit()
    conn.close()
    return {"code": 200, "data": {"folder_id": fid, "folder_name": folder_name, "extracted": extracted}}

class ImageEditIn(BaseModel):
    msg_id: int = 0
    item_id: int = 0
    parent_id: int = 0
    ops: list = []

@app.post("/api/desktop/image-edit")
def api_image_edit(request: Request, body: ImageEditIn):
    username = request.state.username
    visible = _visible_rooms(username)
    conn = get_msg_db()
    if _is_system_folder(conn, username, body.parent_id):
        conn.close()
        return {"code": 400, "msg": "系统文件夹不可写入"}
    src_path = None
    orig_name = ''
    if body.msg_id:
        m = conn.execute("SELECT * FROM messages WHERE id=?", (body.msg_id,)).fetchone()
        if m and m['file_path'] and m['room_id'] in visible:
            src_path, orig_name = m['file_path'], m['file_name'] or ''
    elif body.item_id:
        it = conn.execute("SELECT * FROM desktop_items WHERE id=? AND username=? AND item_type='file' AND msg_id IS NULL",
                          (body.item_id, username)).fetchone()
        if it:
            src_path, orig_name = it['file_path'], it['name'] or ''
    if not src_path:
        conn.close()
        return {"code": 404, "msg": "文件不存在"}
    full = os.path.join(BASE_DIR, src_path.lstrip('/'))
    if not os.path.isfile(full):
        conn.close()
        return {"code": 404, "msg": "文件缺失"}
    try:
        from PIL import Image, ImageOps
        im = Image.open(full)
        for op in body.ops:
            if op == 'rotate_cw':
                im = im.rotate(-90, expand=True)
            elif op == 'rotate_ccw':
                im = im.rotate(90, expand=True)
            elif op == 'flip_h':
                im = ImageOps.mirror(im)
            elif op == 'flip_v':
                im = ImageOps.flip(im)
        ext = _ext_of(orig_name) or 'png'
        out_name = uuid.uuid4().hex + '.' + ext
        out_full = os.path.join(UPLOAD_DIR, out_name)
        if ext in ('jpg', 'jpeg'):
            im = im.convert('RGB')
            im.save(out_full, 'JPEG', quality=92)
        else:
            im.save(out_full)
        size = os.path.getsize(out_full)
        cur = conn.execute(
            "INSERT INTO desktop_items (username, item_type, name, msg_id, file_path, parent_id, file_size) VALUES (?, 'file', ?, NULL, ?, ?, ?)",
            (username, orig_name, '/uploads/' + out_name, body.parent_id, size))
        item_id = cur.lastrowid
        conn.commit()
        conn.close()
        return {"code": 200, "data": {"name": orig_name, "path": '/uploads/' + out_name, "size": size, "item_id": item_id}}
    except Exception as e:
        conn.close()
        return {"code": 500, "msg": f"图片处理失败: {e}"}

class FolderIn(BaseModel):
    name: str
    parent_id: int = 0

@app.post("/api/desktop/folder")
def api_desktop_folder(request: Request, body: FolderIn):
    name = body.name.strip()
    if not name or len(name) > 60:
        return {"code": 400, "msg": "名称无效（1-60字符）"}
    conn = get_msg_db()
    if _is_system_folder(conn, request.state.username, body.parent_id):
        conn.close()
        return {"code": 400, "msg": "系统文件夹不可写入"}
    conn.execute("INSERT INTO desktop_items (username, item_type, name, parent_id) VALUES (?, 'folder', ?, ?)",
                 (request.state.username, name, body.parent_id))
    conn.commit()
    fid = conn.execute("SELECT last_insert_rowid() as id").fetchone()['id']
    conn.close()
    return {"code": 200, "data": {"id": fid, "name": name}}

class NewFileIn(BaseModel):
    name: str = ''
    parent_id: int = 0
    content: str = ''

@app.post("/api/desktop/newfile")
def api_desktop_newfile(request: Request, body: NewFileIn):
    name = body.name.strip()
    ext = _ext_of(name)
    if not name or len(name) > 60 or ext not in ('txt', 'md', 'html'):
        return {"code": 400, "msg": "仅支持新建 .txt / .md / .html 文件"}
    new_name = uuid.uuid4().hex + '.' + ext
    dst_full = os.path.join(UPLOAD_DIR, new_name)
    with open(dst_full, 'w', encoding='utf-8') as f:
        f.write(body.content or '')
    size = os.path.getsize(dst_full)
    conn = get_msg_db()
    if _is_system_folder(conn, request.state.username, body.parent_id):
        conn.close()
        return {"code": 400, "msg": "系统文件夹不可写入"}
    conn.execute(
        "INSERT INTO desktop_items (username, item_type, name, msg_id, file_path, parent_id, file_size) VALUES (?, 'file', ?, NULL, ?, ?, ?)",
        (request.state.username, name, '/uploads/' + new_name, body.parent_id, size))
    conn.commit()
    conn.close()
    return {"code": 200, "data": {"name": name, "size": size}}

@app.post("/api/desktop/upload")
async def api_desktop_upload(request: Request, file: UploadFile = File(...), parent_id: int = Form(0)):
    username = request.state.username
    ext = _ext_of(file.filename or '')
    if ext not in ALLOWED_EXTENSIONS:
        return {"code": 400, "msg": f"不支持的文件类型 .{ext}"}
    content = await file.read()
    max_size = get_max_file_size()
    if len(content) > max_size:
        return {"code": 400, "msg": f"文件过大，最大允许 {max_size // (1024 * 1024)}MB"}
    conn = get_msg_db()
    if parent_id:
        parent = conn.execute(
            "SELECT id, system_key FROM desktop_items WHERE id=? AND username=? AND item_type='folder'",
            (parent_id, username)).fetchone()
        if not parent:
            parent_id = 0
        elif parent['system_key']:
            conn.close()
            return {"code": 400, "msg": "系统文件夹不可写入"}
    saved_name = f"{uuid.uuid4().hex}" + ('.' + ext if ext else '')
    with open(os.path.join(UPLOAD_DIR, saved_name), 'wb') as f:
        f.write(content)
    display_name = os.path.basename(file.filename or saved_name)[:200]
    conn.execute(
        "INSERT INTO desktop_items (username, item_type, name, msg_id, file_path, parent_id, file_size) VALUES (?, 'file', ?, NULL, ?, ?, ?)",
        (username, display_name, '/uploads/' + saved_name, parent_id, len(content)))
    conn.commit()
    iid = conn.execute("SELECT last_insert_rowid() as id").fetchone()['id']
    conn.close()
    return {"code": 200, "data": {"id": iid, "name": display_name, "size": len(content)}}

class ItemPatchIn(BaseModel):
    name: str = None
    parent_id: int = None
    pos_x: int = None
    pos_y: int = None

@app.patch("/api/desktop/item/{item_id}")
def api_desktop_patch(item_id: int, request: Request, body: ItemPatchIn):
    username = request.state.username
    conn = get_msg_db()
    item = conn.execute("SELECT * FROM desktop_items WHERE id=? AND username=?", (item_id, username)).fetchone()
    if not item:
        conn.close()
        return {"code": 404, "msg": "项目不存在"}
    if item['item_type'] == 'folder' and item['system_key'] and body.parent_id is not None:
        conn.close()
        return {"code": 400, "msg": "系统文件夹不可移动"}
    if body.parent_id is not None and _is_system_folder(conn, username, body.parent_id):
        conn.close()
        return {"code": 400, "msg": "系统文件夹不可写入"}
    if body.name is not None and item['item_type'] == 'folder':
        nm = body.name.strip()[:60]
        if nm:
            conn.execute("UPDATE desktop_items SET name=? WHERE id=?", (nm, item_id))
    if body.name is not None and item['item_type'] == 'file' and item['msg_id'] is None:
        nm = body.name.strip()[:200]
        if nm:
            old_ext = _ext_of(item['name'])
            new_ext = _ext_of(nm)
            if new_ext and new_ext != old_ext:
                old_full = os.path.join(BASE_DIR, item['file_path'].lstrip('/')) if item['file_path'] else ''
                if old_full and os.path.isfile(old_full):
                    try:
                        new_full = os.path.join(UPLOAD_DIR, uuid.uuid4().hex + '.' + new_ext)
                        os.rename(old_full, new_full)
                        conn.execute("UPDATE desktop_items SET name=?, file_path=? WHERE id=?",
                                     (nm, '/uploads/' + os.path.basename(new_full), item_id))
                    except Exception:
                        conn.execute("UPDATE desktop_items SET name=? WHERE id=?", (nm, item_id))
                else:
                    conn.execute("UPDATE desktop_items SET name=? WHERE id=?", (nm, item_id))
            else:
                conn.execute("UPDATE desktop_items SET name=? WHERE id=?", (nm, item_id))
    if body.parent_id is not None:
        conn.execute("UPDATE desktop_items SET parent_id=? WHERE id=?", (body.parent_id, item_id))
    if body.pos_x is not None and body.pos_y is not None:
        conn.execute("UPDATE desktop_items SET pos_x=?, pos_y=? WHERE id=?", (body.pos_x, body.pos_y, item_id))
    conn.commit()
    conn.close()
    return {"code": 200}

@app.delete("/api/desktop/item/{item_id}")
def api_desktop_delete(item_id: int, request: Request):
    username = request.state.username
    conn = get_msg_db()
    item = conn.execute("SELECT * FROM desktop_items WHERE id=? AND username=?", (item_id, username)).fetchone()
    if not item:
        conn.close()
        return {"code": 404, "msg": "项目不存在"}
    if item['system_key']:
        conn.close()
        return {"code": 400, "msg": "系统分类文件夹不能删除"}
    to_del = [item_id]
    i = 0
    while i < len(to_del):
        pid = to_del[i]
        i += 1
        for c in conn.execute("SELECT id FROM desktop_items WHERE username=? AND parent_id=?", (username, pid)).fetchall():
            to_del.append(c['id'])
    placeholders = ','.join('?' * len(to_del))
    copy_paths = [r['file_path'] for r in conn.execute(
        "SELECT file_path FROM desktop_items WHERE id IN (" + placeholders + ") AND msg_id IS NULL AND file_path!=''",
        to_del).fetchall()]
    conn.execute("DELETE FROM desktop_items WHERE id IN (" + placeholders + ")", to_del)
    conn.commit()
    conn.close()
    for p in set(copy_paths):
        full = os.path.join(BASE_DIR, p.lstrip('/'))
        try:
            if os.path.isfile(full):
                os.remove(full)
        except Exception:
            pass
    return {"code": 200, "deleted": len(to_del)}

class FileRenameIn(BaseModel):
    msg_id: int
    new_name: str

@app.post("/api/files/rename")
def api_file_rename(request: Request, body: FileRenameIn):
    username = request.state.username
    conn = get_msg_db()
    m = conn.execute("SELECT * FROM messages WHERE id=?", (body.msg_id,)).fetchone()
    if not m or not m['file_path']:
        conn.close()
        return {"code": 404, "msg": "文件不存在"}
    visible = _visible_rooms(username)
    if m['room_id'] not in visible:
        conn.close()
        return {"code": 403, "msg": "无权访问该文件"}
    if m['username'] != username and request.state.is_super != 1:
        conn.close()
        return {"code": 403, "msg": "只有上传者本人或管理员可以重命名"}
    name = body.new_name.strip()
    if not name or len(name) > 200:
        conn.close()
        return {"code": 400, "msg": "文件名无效"}
    new_ext = _ext_of(name)
    old_ext = _ext_of(m['file_name'])
    try:
        if new_ext and new_ext != old_ext:
            old_full = os.path.join(BASE_DIR, m['file_path'].lstrip('/'))
            if os.path.isfile(old_full):
                new_full = os.path.join(UPLOAD_DIR, uuid.uuid4().hex + '.' + new_ext)
                os.rename(old_full, new_full)
                conn.execute("UPDATE messages SET file_name=?, file_path=? WHERE id=?",
                             (name, '/uploads/' + os.path.basename(new_full), body.msg_id))
            else:
                conn.execute("UPDATE messages SET file_name=? WHERE id=?", (name, body.msg_id))
        else:
            conn.execute("UPDATE messages SET file_name=? WHERE id=?", (name, body.msg_id))
        conn.commit()
    except Exception as e:
        conn.close()
        return {"code": 500, "msg": f"重命名失败: {e}"}
    conn.close()
    return {"code": 200, "data": {"name": name}}


# ===== Room Endpoints =====

@app.get("/api/rooms")
def list_rooms(request: Request):
    token = request.headers.get('X-Auth-Token', '')
    username = auth_util.verify_session(token)
    if not username:
        return {"code": 401, "msg": "not logged in"}
    rooms = auth_util.get_rooms(username)
    result = []
    for r in rooms:
        members = auth_util.get_room_members(r['id'])
        result.append({
            "id": r['id'],
            "name": r['name'],
            "description": r['description'],
            "created_by": r['created_by'],
            "is_public": r['is_public'],
            "member_count": r['member_count'],
            "is_member": username in members,
            "has_password": bool(r['password']),
            "created_at": r['created_at']
        })
    return {"code": 200, "data": result}

@app.post("/api/rooms")
def create_room(body: CreateRoomIn, request: Request):
    token = request.headers.get('X-Auth-Token', '')
    username = auth_util.verify_session(token)
    if not username:
        return {"code": 401, "msg": "not logged in"}
    name = body.name.strip()
    if not name or len(name) > 50:
        return {"code": 400, "msg": "room name invalid (1-50 chars)"}
    room_id, err = auth_util.create_room(name, body.description.strip(), username, body.is_public, body.password)
    if err:
        return {"code": 400, "msg": err}
    return {"code": 200, "data": {"id": room_id, "name": name}}

@app.post("/api/rooms/{room_id}/join")
def join_room(room_id: int, body: JoinRoomIn = None, request: Request = None):
    token = request.headers.get('X-Auth-Token', '')
    username = auth_util.verify_session(token)
    if not username:
        return {"code": 401, "msg": "not logged in"}
    password = body.password if body else ""
    ok, msg = auth_util.join_room(room_id, username, password)
    if ok:
        return {"code": 200, "msg": msg}
    return {"code": 400, "msg": msg}

@app.post("/api/rooms/{room_id}/leave")
def leave_room(room_id: int, request: Request):
    token = request.headers.get('X-Auth-Token', '')
    username = auth_util.verify_session(token)
    if not username:
        return {"code": 401, "msg": "not logged in"}
    auth_util.leave_room(room_id, username)
    return {"code": 200, "msg": "left room"}

@app.delete("/api/rooms/{room_id}")
def delete_room(room_id: int, request: Request):
    token = request.headers.get('X-Auth-Token', '')
    username = auth_util.verify_session(token)
    if not username:
        return {"code": 401, "msg": "not logged in"}
    ok, msg = auth_util.delete_room(room_id, username)
    if ok:
        return {"code": 200, "msg": msg}
    return {"code": 400, "msg": msg}

@app.get("/api/rooms/{room_id}/members")
def room_members(room_id: int, request: Request):
    token = request.headers.get('X-Auth-Token', '')
    username = auth_util.verify_session(token)
    if not username:
        return {"code": 401, "msg": "not logged in"}
    members = auth_util.get_room_members(room_id)
    online = auth_util.get_online_users()
    return {"code": 200, "data": [{"username": m, "is_online": m in online} for m in members]}

# ===== Bot Endpoints =====

class BotSendIn(BaseModel):
    content: str

@app.post("/api/bot/send")
async def bot_send(body: BotSendIn, request: Request):
    token = request.headers.get('X-Bot-Token', '')
    if not verify_bot(token):
        return {"code": 401, "msg": "invalid bot token"}
    auth_util.update_online(BOT_USERNAME)
    content = body.content.strip()
    if not content:
        return {"code": 400, "msg": "content empty"}
    conn = get_msg_db()
    conn.execute(
        "INSERT INTO messages (room_id, username, nickname, content, msg_type) VALUES (?, ?, ?, ?, 'text')",
        (0, BOT_USERNAME, BOT_USERNAME, content)
    )
    conn.commit()
    msg_id = conn.execute("SELECT last_insert_rowid() as id").fetchone()['id']
    msg = conn.execute("SELECT * FROM messages WHERE id=?", (msg_id,)).fetchone()
    conn.close()
    await manager.broadcast_message(msg)
    return {"code": 200, "id": msg_id}

@app.get("/api/bot/messages")
def bot_messages(after_id: int = 0, request: Request = None):
    token = request.headers.get('X-Bot-Token', '')
    if not verify_bot(token):
        return {"code": 401, "msg": "invalid bot token"}
    auth_util.update_online(BOT_USERNAME)
    conn = get_msg_db()
    rows = conn.execute(
        "SELECT * FROM messages WHERE room_id=0 AND id > ? ORDER BY id ASC LIMIT 50",
        (after_id,)
    ).fetchall()
    conn.close()
    _attach_colors_to_messages(rows)
    return {"code": 200, "data": rows}

@app.post("/api/bot/typing")
def bot_typing(request: Request):
    token = request.headers.get('X-Bot-Token', '')
    if not verify_bot(token):
        return {"code": 401, "msg": "invalid bot token"}
    with _typing_lock:
        _typing[BOT_USERNAME] = time_module.time() + TYPING_EXPIRE
    return {"code": 200}

@app.get("/api/chat/typing")
def get_typing():
    now = time_module.time()
    with _typing_lock:
        expired = [k for k, v in _typing.items() if v < now]
        for k in expired:
            del _typing[k]
        return {"code": 200, "data": list(_typing.keys())}

# ===== Lobby (room 0) auto-creation =====
try:
    conn = auth_util.get_conn()
    conn.execute("DELETE FROM rooms WHERE id=1 AND created_by='system'")
    conn.execute("INSERT OR IGNORE INTO rooms (id, name, description, created_by, is_public) VALUES (0, '大厅', '默认聊天房间', 'system', 1)")
    conn.execute("INSERT OR IGNORE INTO room_members (room_id, username) VALUES (0, ?)", (SUPER_ADMIN,))
    conn.commit()
    conn.close()
except:
    pass

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=SERVER_PORT)
