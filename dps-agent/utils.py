import os
import re
import yaml
import logging
import threading
import time


def load_config(path="config.yaml"):
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def setup_logger(name="dps-agent", level=logging.INFO):
    logger = logging.getLogger(name)
    logger.setLevel(level)
    if not logger.handlers:
        handler = logging.StreamHandler()
        fmt = logging.Formatter("[%(asctime)s] [%(levelname)s] %(message)s", datefmt="%H:%M:%S")
        handler.setFormatter(fmt)
        logger.addHandler(handler)
    return logger


def detect_mentions(text, bot_name):
    pattern = re.compile(rf'@{re.escape(bot_name)}\b')
    return pattern.findall(text)


def sanitize_filename(name):
    return re.sub(r'[\\/*?:"<>|]', "_", name)


class AutoDeleteManager:
    """临时消息自动删除管理器"""

    def __init__(self, client=None, default_ttl=3):
        self.client = client
        self.default_ttl = default_ttl
        self._temp_msgs = {}  # {room_id: {msg_id: expire_ts}}
        self._lock = threading.Lock()
        self._logger = setup_logger("autodel")
        self._sweep_thread = None
        self._sweep_stop = threading.Event()
        self._start_sweeper()

    def set_client(self, client):
        self.client = client

    def _start_sweeper(self):
        """后台扫描线程,定期清理过期的临时消息"""
        def _sweep():
            while not self._sweep_stop.is_set():
                try:
                    now = time.time()
                    to_delete = []  # [(room_id, msg_id)]
                    with self._lock:
                        for room_id, msgs in list(self._temp_msgs.items()):
                            for mid, expire_ts in list(msgs.items()):
                                if now >= expire_ts:
                                    to_delete.append((room_id, mid))
                                    del msgs[mid]
                            if not msgs:
                                del self._temp_msgs[room_id]
                    for room_id, mid in to_delete:
                        try:
                            self._logger.info(f"自动删除消息 #{mid} (房间 {room_id})")
                            self.client.delete_message(room_id, mid)
                        except Exception as e:
                            self._logger.warning(f"自动删除失败 #{mid}: {e}")
                except Exception as e:
                    self._logger.warning(f"扫描线程出错: {e}")
                time.sleep(1)

        self._sweep_thread = threading.Thread(target=_sweep, daemon=True)
        self._sweep_thread.start()

    def send_temporary(self, room_id, content, ttl=None):
        """发送一条临时消息,ttl 秒后自动删除"""
        if not self.client:
            return None
        if ttl is None:
            ttl = self.default_ttl

        sent = self.client.send_message(room_id, content)
        if not sent:
            return None

        expire_ts = time.time() + ttl
        with self._lock:
            if room_id not in self._temp_msgs:
                self._temp_msgs[room_id] = {}
            self._temp_msgs[room_id]["__pending__" + str(time.time())] = expire_ts

        self._logger.info(f"发送临时消息到房间 {room_id},TTL={ttl}s")
        return True

    def on_self_message(self, msg_data):
        """收到自己发的消息时调用,如果这条消息属于临时消息则登记"""
        msg_id = msg_data.get("id")
        room_id = msg_data.get("room_id")
        if not msg_id or not room_id:
            return

        with self._lock:
            msgs = self._temp_msgs.get(room_id)
            if not msgs:
                return
            pending_keys = [k for k in msgs if k.startswith("__pending__")]
            if not pending_keys:
                return
            pending_keys.sort()
            oldest = pending_keys[0]
            expire_ts = msgs.pop(oldest)
            msgs[msg_id] = expire_ts
            self._logger.info(f"临时消息已登记: #{msg_id} (房间 {room_id}, 过期={int(expire_ts - time.time())}s)")

    def clear_temporary(self, room_id):
        """立即清除该房间的所有临时消息(发最终回复前调用)"""
        with self._lock:
            msgs = self._temp_msgs.pop(room_id, {})
            msg_ids = [mid for mid in msgs if not str(mid).startswith("__pending__")]

        count = 0
        for mid in msg_ids:
            try:
                self._logger.info(f"立即清理临时消息 #{mid} (房间 {room_id})")
                self.client.delete_message(room_id, mid)
                count += 1
            except Exception as e:
                self._logger.warning(f"清理临时消息失败 #{mid}: {e}")
        return count
