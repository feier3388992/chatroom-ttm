import json
import os
import time
import threading
import requests
import websocket

from utils import setup_logger

logger = setup_logger("qt_client")


class QuickTalkClient:
    def __init__(self, config, on_message_callback=None, on_self_message_callback=None):
        self.config = config
        self.server = config["quicktalk"]["server"]
        self.username = config["quicktalk"]["username"]
        self.password = config["quicktalk"]["password"]
        self.use_https = config["quicktalk"].get("use_https", False)

        self.http_proto = "https" if self.use_https else "http"
        self.ws_proto = "wss" if self.use_https else "ws"
        self.base_url = f"{self.http_proto}://{self.server}"
        self.ws_url_base = f"{self.ws_proto}://{self.server}"

        self.token = None
        self.ws = None
        self.running = False
        self.current_rooms = {}
        self.on_message = on_message_callback
        self.on_self_message = on_self_message_callback
        self._ws_thread = None
        self._ping_thread = None
        self._retry_count = 0

    # ─── REST API ─────────────────────────────────────────

    def login(self):
        url = f"{self.base_url}/api/auth/login"
        try:
            resp = requests.post(url, json={
                "username": self.username,
                "password": self.password
            }, timeout=10)
            data = resp.json()
            if data.get("code") == 200:
                self.token = data["token"]
                logger.info(f"登录成功: {self.username}")
                return True
            else:
                logger.error(f"登录失败: {data.get('msg')}")
                return False
        except requests.exceptions.RequestException as e:
            logger.error(f"登录请求失败: {e}")
            return False

    def get_rooms(self):
        url = f"{self.base_url}/api/rooms"
        resp = requests.get(url, headers=self._headers())
        data = resp.json()
        if data.get("code") == 200:
            return data["data"]
        return []

    def get_messages(self, room_id, after_id=0):
        url = f"{self.base_url}/api/chat/messages"
        resp = requests.get(url, headers=self._headers(), params={
            "room_id": room_id, "after_id": after_id
        })
        data = resp.json()
        if data.get("code") == 200:
            return data["data"]
        return []

    def upload_file(self, room_id, file_path):
        url = f"{self.base_url}/api/chat/upload"
        with open(file_path, "rb") as f:
            files = {"file": f}
            data = {"room_id": room_id}
            resp = requests.post(url, headers={"X-Auth-Token": self.token},
                                 files=files, data=data, timeout=30)
        result = resp.json()
        if result.get("code") == 200:
            logger.info(f"文件上传成功: {file_path}")
        else:
            logger.error(f"文件上传失败: {result.get('msg')}")
        return result

    def download_file(self, file_path):
        # 如果只是文件名（无路径前缀），尝试 /uploads/ 和 /api/chat/download/
        path = file_path.strip()
        if not path.startswith("/"):
            for prefix in ("/uploads/", "/api/chat/download/"):
                url = f"{self.base_url}{prefix}{path}"
                try:
                    resp = requests.get(url, headers=self._headers(), timeout=15)
                    if resp.status_code == 200:
                        return resp.content
                except Exception:
                    continue
            raise Exception(f"无法下载文件: {path}")
        url = f"{self.base_url}{path}"
        resp = requests.get(url, headers=self._headers(), timeout=15)
        if resp.status_code != 200:
            raise Exception(f"下载失败 (HTTP {resp.status_code})")
        return resp.content

    def delete_message(self, room_id, message_id):
        """删除单条消息。
        正确的 QuickTalk 端点: DELETE /api/chat/messages/{msg_id}
        普通用户只能删自己发的,超管可删任意。
        """
        url = f"{self.base_url}/api/chat/messages/{message_id}"
        try:
            resp = requests.delete(url, headers=self._headers(), timeout=10)
            return resp.json()
        except Exception as e:
            logger.error(f"删除消息失败: {e}")
            return {"code": -1, "msg": str(e)}

    def api_request(self, method, endpoint, json_data=None, params=None):
        url = f"{self.base_url}{endpoint}"
        try:
            resp = requests.request(
                method=method.upper(),
                url=url,
                headers={"X-Auth-Token": self.token},
                json=json_data,
                params=params,
                timeout=15,
            )
            return resp.json()
        except Exception as e:
            logger.error(f"API 请求失败 {method} {endpoint}: {e}")
            return {"code": -1, "msg": str(e)}

    def _headers(self):
        return {"Content-Type": "application/json", "X-Auth-Token": self.token}

    # ─── WebSocket ────────────────────────────────────────

    def connect_ws(self):
        if not self.token:
            logger.error("未登录，无法连接 WebSocket")
            return False

        ws_url = f"{self.ws_url_base}/ws?token={self.token}"

        self.ws = websocket.WebSocketApp(
            ws_url,
            on_open=self._on_ws_open,
            on_message=self._on_ws_message,
            on_error=self._on_ws_error,
            on_close=self._on_ws_close,
        )

        self.running = True
        self._ws_thread = threading.Thread(
            target=lambda: self.ws.run_forever(
                ping_interval=10,
                ping_timeout=5,
                ping_payload="",
            ),
            daemon=True,
        )
        self._ws_thread.start()
        time.sleep(1)
        return True

    def _on_ws_open(self, ws):
        logger.info("WebSocket 已连接")
        self._retry_count = 0
        self._start_ping()

    def _on_ws_message(self, ws, raw):
        try:
            data = json.loads(raw)
            self._handle_ws_data(data)
        except json.JSONDecodeError:
            pass

    def _on_ws_error(self, ws, error):
        logger.error(f"WebSocket 错误: {error}")

    def _on_ws_close(self, ws, close_status_code, close_msg):
        logger.info(f"WebSocket 已关闭 ({close_status_code})")
        if self._ping_thread:
            self._ping_thread = None
        if self.running:
            self._start_reconnect()

    def _start_reconnect(self):
        delays = [10, 600, 1200]
        if self._retry_count >= len(delays):
            logger.error("重连失败次数过多，程序退出")
            os._exit(1)

        delay = delays[self._retry_count]
        self._retry_count += 1
        logger.info(f"等待 {delay} 秒后重连 (第 {self._retry_count} 次)...")

        for _ in range(delay):
            if not self.running:
                return
            time.sleep(1)

        if not self.running:
            return

        if not self.login():
            logger.warning("登录失败，进入下一次重试")
            self._start_reconnect()
            return

        self.connect_ws()

    def _handle_ws_data(self, data):
        msg_type = data.get("type")

        if msg_type == "pong":
            pass
        elif msg_type == "message":
            msg_data = data.get("data", {})
            room_id = msg_data.get("room_id")
            msg_username = msg_data.get("username", "")

            if msg_username == self.username and self.on_self_message:
                self.on_self_message(msg_data)

            # 后台线程处理，避免阻塞 WebSocket 调度线程（防止 keepalive 超时断开）
            if self.on_message and msg_username != self.username:
                threading.Thread(
                    target=self.on_message,
                    args=(msg_data,),
                    daemon=True,
                ).start()
        elif msg_type == "online":
            pass
        elif msg_type == "typing":
            pass

    def _start_ping(self):
        def ping_loop():
            while self.running and self.ws and self.ws.sock:
                try:
                    self.ws.send(json.dumps({"type": "ping"}))
                except:
                    break
                time.sleep(15)

        self._ping_thread = threading.Thread(target=ping_loop, daemon=True)
        self._ping_thread.start()

    def send_message(self, room_id, content, msg_type="text"):
        if not self.ws or not self.ws.sock:
            logger.error("WebSocket 未连接，无法发送消息")
            return False
        payload = json.dumps({
            "type": "send",
            "room_id": room_id,
            "content": content,
            "msg_type": msg_type,
        })
        try:
            self.ws.send(payload)
            return True
        except Exception as e:
            logger.error(f"发送消息失败: {e}")
            return False

    def send_typing(self, room_id):
        if self.ws and self.ws.sock:
            try:
                self.ws.send(json.dumps({"type": "typing", "room_id": room_id}))
            except:
                pass

    def close(self):
        self.running = False
        if self.ws:
            self.ws.close()
