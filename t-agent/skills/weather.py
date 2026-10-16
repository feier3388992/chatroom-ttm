"""天气查询技能 - 一步返回，扁平调用"""

import requests
from typing import Any


def skill_name() -> str:
    return "天气查询"


def skill_desc() -> str:
    return "查询实时天气，格式：天气 城市名"


def skill_keywords() -> list[str]:
    return ["天气", "weather"]


def skill_examples() -> list[str]:
    return ["  天气 北京", "  weather London"]


def execute(arg: str) -> str:
    if not arg:
        return "请指定城市名，例如：天气 北京"

    city = arg.strip()
    try:
        resp = requests.get(
            f"https://wttr.in/{city}?format=%C+%t+%h+%w",
            timeout=10,
        )
        if resp.status_code == 200:
            raw = resp.text.strip()
            return f"🌤 {city} 当前天气：{raw}"
        else:
            return f"查询失败（HTTP {resp.status_code}），请检查城市名是否正确。"
    except requests.RequestException as exc:
        return f"网络请求失败：{exc}，请稍后重试。"
