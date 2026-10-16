"""时间日期技能 - 返回当前时间、日期、时区"""

from datetime import datetime
import time


def skill_name() -> str:
    return "时间日期"


def skill_desc() -> str:
    return "查询当前时间或日期，格式：时间 / 日期 / 北京时间"


def skill_keywords() -> list[str]:
    return ["时间", "日期", "time", "date", "几号", "几点"]


def skill_examples() -> list[str]:
    return ["  时间", "  日期", "  几号"]


def execute(arg: str) -> str:
    now = datetime.now()
    tz = time.tzname
    weekday_cn = ["一", "二", "三", "四", "五", "六", "日"]

    arg_lower = arg.strip().lower()

    if arg_lower in ("日期", "date", "几号"):
        return f"📅 {now.year}年{now.month}月{now.day}日 星期{weekday_cn[now.weekday()]}"

    if arg_lower in ("时间", "time", "几点"):
        return f"🕐 {now.hour:02d}:{now.minute:02d}:{now.second:02d} {tz[0]}"

    return (
        f"📅 {now.year}年{now.month}月{now.day}日 星期{weekday_cn[now.weekday()]}\n"
        f"🕐 {now.hour:02d}:{now.minute:02d}:{now.second:02d} {tz[0]}"
    )


if __name__ == "__main__":
    print(execute(""))
    print(execute("时间"))
    print(execute("日期"))
