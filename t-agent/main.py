#!/usr/bin/env python3
"""
t-agent: 扁平关键词机器人，无多级菜单。

复用 dps-agent 的 qt_client.py 和 utils.py。
群聊 @t/@T 响应，私聊全响应。
用户输入"天气 北京"、"计算 1+2*3"等关键词直接执行，无需选数字进菜单。
"""

import sys
import os
import time
import signal
import re

DPS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "dps-agent")
sys.path.insert(0, os.path.abspath(DPS_DIR))

from qt_client import QuickTalkClient
from utils import load_config, setup_logger

logger = setup_logger("t-agent")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE_DIR)

from skills import load_skills
_skills = load_skills()
logger.info(f"已加载 {len(_skills)} 个技能模块")


def _build_help_text() -> str:
    lines = ["t-agent 可用命令："]
    for skill in _skills:
        for example in skill.get("examples", []):
            lines.append(f"  {example}")
    lines.append("")
    lines.append("直接输入命令即可，无需选择菜单。")
    return "\n".join(list(dict.fromkeys(lines)))


HELP_TEXT = _build_help_text()


def _dispatch(text: str, client=None, room_id=0) -> str:
    """扁平分发：按关键词匹配技能，直接执行"""
    if not text:
        return HELP_TEXT

    text_stripped = text.strip()

    # 帮助类命令
    if text_stripped in ("帮助", "菜单", "?", "h", "help", "命令"):
        return HELP_TEXT

    # 遍历技能，匹配关键词
    for skill in _skills:
        keywords = skill.get("keywords", [])
        for kw in keywords:
            if text_stripped.startswith(kw):
                arg = text_stripped[len(kw):].strip()
                try:
                    # 给 execute 传递上下文（client等），不兼容旧技能的自动回退
                    try:
                        result = skill["execute"](arg, client=client, room_id=room_id)
                    except TypeError:
                        result = skill["execute"](arg)
                    return result
                except Exception as e:
                    logger.error(f"技能执行出错: {e}", exc_info=True)
                    return f"执行失败：{e}"

    # 无匹配时显示帮助
    return f"未知命令。\n\n{HELP_TEXT}"


class TAgent:
    def __init__(self, config_path=None):
        if config_path is None:
            config_path = os.path.join(BASE_DIR, "config.yaml")
        self.config = load_config(config_path)
        self.running = True

        self.client = QuickTalkClient(
            self.config,
            on_message_callback=self._on_message,
        )

        self._room_history = {}
        self._last_reply_time = {}

        signal.signal(signal.SIGINT, self._handle_exit)
        signal.signal(signal.SIGTERM, self._handle_exit)

    def _handle_exit(self, signum, frame):
        logger.info("t-agent 正在退出...")
        self.running = False

    def _on_message(self, msg_data):
        try:
            content = msg_data.get("content", "")
            username = msg_data.get("username", "")
            nickname = msg_data.get("nickname", "")
            room_id = msg_data.get("room_id", 0)
            msg_type = msg_data.get("msg_type", "text")

            # 过滤自己的消息
            if username == self.config["quicktalk"]["username"]:
                return

            # 过滤非文本消息
            if msg_type != "text":
                return

            # 过滤 DSML 乱码和空消息
            if not content or "DSML" in content:
                return

            # 过滤已知 bot 账号，防止交叉循环
            bot_accounts = {"dps", "assistant", "opencodeTM", "opencode209", "opencode6¥", "mimo"}
            if username in bot_accounts:
                return

            # 所有消息都必须带 @t/@T 才回复，无论私聊还是群聊
            if not re.match(r'^@[tT](?:\s|$)', content):
                return
            content = re.sub(r'^@[tT]\s*', '', content).strip()

            # 循环检测：同一房间同一用户连续发相同短消息则忽略
            hist_key = (room_id, username)
            now = time.time()
            hist = self._room_history.setdefault(hist_key, [])
            hist.append({"time": now, "content": content})
            # 只保留最近 3 条
            if len(hist) > 3:
                hist.pop(0)
            if len(hist) >= 3:
                contents = [m["content"] for m in hist[-3:]]
                if len(set(contents)) == 1 and len(contents[0]) <= 20:
                    logger.info(f"[{room_id}] 检测到 {username} 重复消息，跳过")
                    return

            # 限速：同一房间每秒最多回复 1 次
            last_time = self._last_reply_time.get(room_id, 0)
            if now - last_time < 1.0:
                logger.info(f"[{room_id}] 回复太快，跳过")
                return

            display_name = nickname or username
            logger.info(f"[{room_id}] {display_name}: {content[:80]}")

            reply = _dispatch(content, client=self.client, room_id=room_id)

            self.client.send_typing(room_id)
            time.sleep(0.3)
            self.client.send_message(room_id, reply)
            self._last_reply_time[room_id] = time.time()
            logger.info(f"[{room_id}] -> {reply[:80]}")

        except Exception as e:
            logger.error(f"消息处理出错: {e}", exc_info=True)

    def run(self):
        logger.info("=" * 40)
        logger.info(" t-agent (扁平关键词机器人) 启动")
        logger.info(f"  服务器: {self.config['quicktalk']['server']}")
        logger.info(f"  技能数: {len(_skills)}")
        for s in _skills:
            logger.info(f"    - {s['name']}: {s['desc']}")
        logger.info("=" * 40)

        for i, delay in enumerate([10, 60]):
            if self.client.login():
                break
            if i < 1:
                logger.info(f"登录失败，{delay}秒后重试...")
                time.sleep(delay)
        else:
            logger.error("登录失败，退出")
            return

        self.client.connect_ws()
        logger.info("t-agent 已上线")

        try:
            while self.running:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
        finally:
            self.client.close()
            logger.info("t-agent 已退出")


if __name__ == "__main__":
    config_path = sys.argv[1] if len(sys.argv) > 1 else None
    agent = TAgent(config_path)
    agent.run()
