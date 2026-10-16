import sqlite3, os, hashlib, secrets, threading, shutil, time

SUPER_ADMIN = "admin"
SUPER_ADMIN_PASSWORD = os.environ.get("QUICKTALK_SUPER_PASSWORD", "admin")
BOT_USERNAME = "assistant"
BOT_TOKEN = os.environ.get("QUICKTALK_BOT_TOKEN", "change-this-bot-token")

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_DIR = os.path.join(BASE_DIR, "database")
AUTH_DB = os.path.join(DB_DIR, "users.db")
MSG_DB = os.path.join(DB_DIR, "messages.db")

ONLINE_TIMEOUT = 60

_sessions = {}
_sessions_lock = threading.Lock()
_online = {}
_online_lock = threading.Lock()

def dict_factory(cursor, row):
    return {col[0]: row[idx] for idx, col in enumerate(cursor.description)}

def get_conn():
    conn = sqlite3.connect(AUTH_DB, check_same_thread=False)
    conn.row_factory = dict_factory
    return conn

def get_msg_conn():
    conn = sqlite3.connect(MSG_DB, check_same_thread=False)
    conn.row_factory = dict_factory
    return conn

def _hash(pw):
    return hashlib.sha256(pw.encode()).hexdigest()

def init_db():
    os.makedirs(DB_DIR, exist_ok=True)
    conn = get_conn()
    conn.execute("""CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        nickname TEXT DEFAULT '',
        is_super INTEGER DEFAULT 0,
        create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS invite_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        used INTEGER DEFAULT 0,
        used_by TEXT DEFAULT '',
        active INTEGER DEFAULT 1,
        create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )""")
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
        create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS read_records (
        username TEXT PRIMARY KEY,
        last_read_id INTEGER DEFAULT 0
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS banned_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        banned_by TEXT DEFAULT '',
        reason TEXT DEFAULT '',
        create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS rooms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        created_by TEXT NOT NULL,
        is_public INTEGER DEFAULT 1,
        password TEXT DEFAULT '',
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS room_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id INTEGER NOT NULL,
        username TEXT NOT NULL,
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(room_id, username)
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS private_chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user1 TEXT NOT NULL,
        user2 TEXT NOT NULL,
        room_id INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user1, user2)
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )""")
    try:
        conn.execute("ALTER TABLE rooms ADD COLUMN sort_order INTEGER DEFAULT 0")
    except:
        pass
    try:
        conn.execute("ALTER TABLE messages ADD COLUMN room_id INTEGER DEFAULT 0")
    except:
        pass
    try:
        conn.execute("ALTER TABLE users ADD COLUMN bubble_bg TEXT DEFAULT ''")
    except:
        pass
    try:
        conn.execute("ALTER TABLE users ADD COLUMN bubble_text TEXT DEFAULT ''")
    except:
        pass
    for u, pw, super_flag in [(SUPER_ADMIN, SUPER_ADMIN_PASSWORD, 1)]:
        existing = conn.execute("SELECT id FROM users WHERE username=?", (u,)).fetchone()
        if not existing:
            conn.execute("INSERT INTO users (username, password_hash, is_super) VALUES (?, ?, ?)",
                         (u, _hash(pw), super_flag))
    count = conn.execute("SELECT COUNT(*) as c FROM invite_codes").fetchone()
    if count['c'] == 0:
        codes = [(f"{secrets.token_hex(2).upper()}-{secrets.token_hex(2).upper()}",) for _ in range(50)]
        conn.executemany("INSERT INTO invite_codes (code) VALUES (?)", codes)
        with open(os.path.join(BASE_DIR, 'invite_codes.txt'), 'w', encoding='utf-8') as f:
            f.write('\n'.join(c[0] for c in codes))
    defaults = {
        'auto_file_enabled': '1',
        'auto_file_max_chars': '150',
        'auto_file_max_lines': '10',
        'upload_max_size_mb': '2048',
        'download_max_size_mb': '2048',
    }
    for k, v in defaults.items():
        existing = conn.execute("SELECT key FROM config WHERE key=?", (k,)).fetchone()
        if not existing:
            conn.execute("INSERT INTO config (key, value) VALUES (?, ?)", (k, v))
    conn.commit()
    conn.close()

def register(username, password, invite_code):
    conn = get_conn()
    try:
        if conn.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone():
            return False, '用户名已存在'
        if username == SUPER_ADMIN:
            return False, '超级用户无需注册'
        code = conn.execute("SELECT * FROM invite_codes WHERE code=? AND used=0 AND active=1", (invite_code,)).fetchone()
        if not code:
            return False, '邀请码无效或已使用'
        conn.execute("UPDATE invite_codes SET used=1, used_by=? WHERE code=?", (username, invite_code))
        conn.execute("INSERT INTO users (username, password_hash) VALUES (?, ?)", (username, _hash(password)))
        conn.commit()
        return True, '注册成功'
    except Exception as e:
        return False, str(e)
    finally:
        conn.close()

def login(username, password):
    conn = get_conn()
    row = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    if not row or row['password_hash'] != _hash(password):
        conn.close()
        return None, '用户名或密码错误'
    if conn.execute("SELECT id FROM banned_users WHERE username=?", (username,)).fetchone():
        conn.close()
        return None, '账号已被封禁'
    conn.close()
    token = secrets.token_hex(32)
    with _sessions_lock:
        _sessions[token] = username
    set_online(username)
    return token, '登录成功'

def set_online(username):
    with _online_lock:
        _online[username] = time.time()

def remove_online(username):
    with _online_lock:
        _online.pop(username, None)

def verify_session(token):
    with _sessions_lock:
        return _sessions.get(token)

def logout(token):
    username = None
    with _sessions_lock:
        username = _sessions.pop(token, None)
    if username:
        remove_online(username)

def get_user(username):
    conn = get_conn()
    row = conn.execute("SELECT id, username, nickname, is_super, bubble_bg, bubble_text, create_time FROM users WHERE username=?", (username,)).fetchone()
    conn.close()
    return row

def get_user_color(username):
    conn = get_conn()
    row = conn.execute("SELECT bubble_bg, bubble_text FROM users WHERE username=?", (username,)).fetchone()
    conn.close()
    if row:
        return {'bg': row['bubble_bg'] or '', 'text': row['bubble_text'] or ''}
    return {'bg': '', 'text': ''}

def set_user_color(username, bg, text):
    conn = get_conn()
    conn.execute("UPDATE users SET bubble_bg=?, bubble_text=? WHERE username=?", (bg or '', text or '', username))
    conn.commit()
    conn.close()

def is_super(username):
    conn = get_conn()
    row = conn.execute("SELECT is_super FROM users WHERE username=?", (username,)).fetchone()
    conn.close()
    return row and row['is_super'] == 1

def update_online(username):
    with _online_lock:
        _online[username] = time.time()

def get_online_users():
    now = time.time()
    with _online_lock:
        expired = [k for k, v in _online.items() if isinstance(v, (int, float)) and now - v > ONLINE_TIMEOUT]
        for k in expired:
            del _online[k]
        return list(_online.keys())

def kick_user(username):
    with _sessions_lock:
        expired_tokens = [t for t, u in _sessions.items() if u == username]
        for t in expired_tokens:
            del _sessions[t]
    remove_online(username)

def get_all_users():
    conn = get_conn()
    rows = conn.execute("SELECT id, username, nickname, is_super, create_time FROM users ORDER BY id ASC").fetchall()
    conn.close()
    return rows

def ban_user(username, banned_by="admin", reason=""):
    conn = get_conn()
    try:
        conn.execute("INSERT OR IGNORE INTO banned_users (username, banned_by, reason) VALUES (?, ?, ?)",
                     (username, banned_by, reason))
        conn.commit()
    finally:
        conn.close()
    kick_user(username)

def unban_user(username):
    conn = get_conn()
    conn.execute("DELETE FROM banned_users WHERE username=?", (username,))
    conn.commit()
    conn.close()

def is_banned(username):
    conn = get_conn()
    row = conn.execute("SELECT id FROM banned_users WHERE username=?", (username,)).fetchone()
    conn.close()
    return row is not None

def get_banned_users():
    conn = get_conn()
    rows = conn.execute("SELECT * FROM banned_users ORDER BY id DESC").fetchall()
    conn.close()
    return rows

def create_room(name, description, created_by, is_public=1, password=""):
    conn = get_conn()
    try:
        cur = conn.execute("INSERT INTO rooms (name, description, created_by, is_public, password) VALUES (?, ?, ?, ?, ?)",
                          (name, description, created_by, is_public, password))
        room_id = cur.lastrowid
        conn.execute("INSERT OR IGNORE INTO room_members (room_id, username) VALUES (?, ?)", (room_id, created_by))
        conn.commit()
        return room_id, None
    except Exception as e:
        return None, str(e)
    finally:
        conn.close()

def get_rooms(username):
    conn = get_conn()
    rows = conn.execute("""SELECT r.*, 
        (SELECT COUNT(*) FROM room_members WHERE room_id=r.id) as member_count
        FROM rooms r 
        WHERE r.is_public=1 OR r.id IN (SELECT room_id FROM room_members WHERE username=?)
           OR (r.password != '' AND r.password IS NOT NULL)
        ORDER BY r.sort_order ASC, r.id ASC""", (username,)).fetchall()
    conn.close()
    return rows

def get_room(room_id):
    conn = get_conn()
    row = conn.execute("SELECT * FROM rooms WHERE id=?", (room_id,)).fetchone()
    conn.close()
    return row

def join_room(room_id, username, password=""):
    conn = get_conn()
    try:
        room = conn.execute("SELECT * FROM rooms WHERE id=?", (room_id,)).fetchone()
        if not room:
            return False, '房间不存在'
        if room['password']:
            if room['password'] != password:
                return False, '密码错误'
        conn.execute("INSERT OR IGNORE INTO room_members (room_id, username) VALUES (?, ?)", (room_id, username))
        conn.commit()
        return True, '已加入房间'
    except Exception as e:
        return False, str(e)
    finally:
        conn.close()

def invite_to_room(room_id, inviter, invitee):
    conn = get_conn()
    try:
        room = conn.execute("SELECT * FROM rooms WHERE id=?", (room_id,)).fetchone()
        if not room:
            return False, '房间不存在'
        if room['created_by'] != inviter and not is_super(inviter):
            return False, '只有群主才能邀请'
        user = conn.execute("SELECT username FROM users WHERE username=?", (invitee,)).fetchone()
        if not user:
            return False, '用户不存在'
        conn.execute("INSERT OR IGNORE INTO room_members (room_id, username) VALUES (?, ?)", (room_id, invitee))
        conn.commit()
        return True, f'已邀请 {invitee} 加入房间'
    except Exception as e:
        return False, str(e)
    finally:
        conn.close()

def leave_room(room_id, username):
    conn = get_conn()
    conn.execute("DELETE FROM room_members WHERE room_id=? AND username=?", (room_id, username))
    conn.execute("UPDATE rooms SET is_public=0 WHERE id=? AND created_by=?", (room_id, username))
    conn.commit()
    conn.close()

def delete_room(room_id, username):
    conn = get_conn()
    room = conn.execute("SELECT * FROM rooms WHERE id=?", (room_id,)).fetchone()
    if not room:
        conn.close()
        return False, '房间不存在'
    if room['created_by'] != username and not is_super(username):
        conn.close()
        return False, '无权限删除'
    conn.execute("DELETE FROM room_members WHERE room_id=?", (room_id,))
    conn.execute("DELETE FROM rooms WHERE id=?", (room_id,))
    conn.commit()
    conn.close()
    msg_conn = get_msg_conn()
    msg_conn.execute("DELETE FROM messages WHERE room_id=?", (room_id,))
    msg_conn.execute("DELETE FROM read_records WHERE room_id=?", (room_id,))
    msg_conn.commit()
    msg_conn.close()
    return True, '房间已删除'

def get_room_members(room_id):
    conn = get_conn()
    rows = conn.execute("SELECT username FROM room_members WHERE room_id=?", (room_id,)).fetchall()
    conn.close()
    return [r['username'] for r in rows]

def verify_bot(token):
    return token == BOT_TOKEN

def get_invite_codes():
    conn = get_conn()
    rows = conn.execute("SELECT * FROM invite_codes ORDER BY id DESC LIMIT 200").fetchall()
    conn.close()
    return rows

# ===== Config Functions =====

def get_config(key):
    conn = get_conn()
    row = conn.execute("SELECT value FROM config WHERE key=?", (key,)).fetchone()
    conn.close()
    return row['value'] if row else None

def set_config(key, value):
    conn = get_conn()
    conn.execute("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", (key, str(value)))
    conn.commit()
    conn.close()

def get_all_config():
    conn = get_conn()
    rows = conn.execute("SELECT key, value FROM config").fetchall()
    conn.close()
    return {r['key']: r['value'] for r in rows}

# ===== Private Chat Functions =====

def _get_or_create_private_chat(username, friend_username):
    conn = get_conn()
    try:
        u1, u2 = sorted([username, friend_username])
        existing = conn.execute("SELECT * FROM private_chats WHERE user1=? AND user2=?", (u1, u2)).fetchone()
        if existing:
            return existing['room_id']
        max_room = conn.execute("SELECT MAX(room_id) as m FROM private_chats").fetchone()['m'] or 10000
        new_room_id = max_room + 1
        conn.execute("INSERT INTO private_chats (user1, user2, room_id) VALUES (?, ?, ?)", (u1, u2, new_room_id))
        conn.commit()
        return new_room_id
    finally:
        conn.close()

def get_private_chats(username):
    conn = get_conn()
    msg_conn = get_msg_conn()
    try:
        rows = conn.execute(
            "SELECT * FROM private_chats WHERE user1=? OR user2=?", (username, username)
        ).fetchall()
        online = get_online_users()
        result = []
        for row in rows:
            friend = row['user2'] if row['user1'] == username else row['user1']
            friend_info = conn.execute("SELECT nickname FROM users WHERE username=?", (friend,)).fetchone()
            last_msg = msg_conn.execute(
                "SELECT content, username, msg_type, create_time FROM messages WHERE room_id=? ORDER BY id DESC LIMIT 1",
                (row['room_id'],)
            ).fetchone()
            result.append({
                'friend': friend,
                'nickname': friend_info['nickname'] if friend_info else '',
                'room_id': row['room_id'],
                'is_online': friend in online,
                'last_msg': last_msg['content'] if last_msg else '',
                'last_msg_type': last_msg['msg_type'] if last_msg else 'text',
                'last_msg_user': last_msg['username'] if last_msg else '',
                'last_msg_time': last_msg['create_time'] if last_msg else '',
                'unread': 0,
            })
        return result
    finally:
        conn.close()
        msg_conn.close()

def add_private_chat(username, friend_username):
    if username == friend_username:
        return None, '不能添加自己'
    conn = get_conn()
    try:
        friend = conn.execute("SELECT id FROM users WHERE username=?", (friend_username,)).fetchone()
        if not friend:
            return None, '用户不存在'
        if conn.execute("SELECT id FROM banned_users WHERE username=?", (friend_username,)).fetchone():
            return None, '该用户已被封禁'
        u1, u2 = sorted([username, friend_username])
        existing = conn.execute("SELECT room_id FROM private_chats WHERE user1=? AND user2=?", (u1, u2)).fetchone()
        if existing:
            return existing['room_id'], '已经是好友'
        room_id = _get_or_create_private_chat(username, friend_username)
        return room_id, '添加成功'
    finally:
        conn.close()

def delete_private_chat(username, friend_username):
    conn = get_conn()
    msg_conn = get_msg_conn()
    try:
        u1, u2 = sorted([username, friend_username])
        row = conn.execute("SELECT room_id FROM private_chats WHERE user1=? AND user2=?", (u1, u2)).fetchone()
        if not row:
            return False, '好友关系不存在'
        room_id = row['room_id']
        msg_conn.execute("DELETE FROM messages WHERE room_id=?", (room_id,))
        msg_conn.execute("DELETE FROM read_records WHERE room_id=?", (room_id,))
        msg_conn.commit()
        conn.execute("DELETE FROM private_chats WHERE user1=? AND user2=?", (u1, u2))
        conn.commit()
        return True, '已删除'
    finally:
        msg_conn.close()
        conn.close()

def get_private_chat_room(username, friend_username):
    conn = get_conn()
    try:
        u1, u2 = sorted([username, friend_username])
        row = conn.execute("SELECT room_id FROM private_chats WHERE user1=? AND user2=?", (u1, u2)).fetchone()
        return row['room_id'] if row else None
    finally:
        conn.close()

def get_all_non_banned_users(username):
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT id, username, nickname, is_super FROM users WHERE username != ? ORDER BY id ASC",
            (username,)
        ).fetchall()
        banned = {b['username'] for b in conn.execute("SELECT username FROM banned_users").fetchall()}
        online = get_online_users()
        result = []
        for u in rows:
            if u['username'] not in banned:
                result.append({
                    'username': u['username'],
                    'nickname': u['nickname'] or u['username'],
                    'is_super': u['is_super'],
                    'is_online': u['username'] in online,
                })
        return result
    finally:
        conn.close()

# ===== Admin Room Functions =====

def admin_get_all_rooms():
    conn = get_conn()
    rows = conn.execute("""SELECT r.*,
        (SELECT COUNT(*) FROM room_members WHERE room_id=r.id) as member_count
        FROM rooms r ORDER BY r.sort_order ASC, r.id ASC""").fetchall()
    conn.close()
    return rows

def admin_rename_room(room_id, new_name):
    conn = get_conn()
    room = conn.execute("SELECT * FROM rooms WHERE id=?", (room_id,)).fetchone()
    if not room:
        conn.close()
        return False, '房间不存在'
    conn.execute("UPDATE rooms SET name=? WHERE id=?", (new_name, room_id))
    conn.commit()
    conn.close()
    return True, '重命名成功'

def admin_reorder_rooms(orders):
    conn = get_conn()
    for item in orders:
        conn.execute("UPDATE rooms SET sort_order=? WHERE id=?", (item['sort_order'], item['id']))
    conn.commit()
    conn.close()
    return True, '排序已更新'

def admin_delete_room(room_id):
    conn = get_conn()
    room = conn.execute("SELECT * FROM rooms WHERE id=?", (room_id,)).fetchone()
    if not room:
        conn.close()
        return False, '房间不存在'
    if room_id == 0:
        conn.close()
        return False, '不能删除大厅'
    conn.execute("DELETE FROM room_members WHERE room_id=?", (room_id,))
    conn.execute("DELETE FROM rooms WHERE id=?", (room_id,))
    conn.commit()
    conn.close()
    msg_conn = get_msg_conn()
    msg_conn.execute("DELETE FROM messages WHERE room_id=?", (room_id,))
    msg_conn.execute("DELETE FROM read_records WHERE room_id=?", (room_id,))
    msg_conn.commit()
    msg_conn.close()
    return True, '房间及消息已删除'

init_db()
