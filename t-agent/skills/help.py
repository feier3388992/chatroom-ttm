"""帮助技能 - 显示使用说明"""


def skill_name() -> str:
    return "帮助"


def skill_desc() -> str:
    return "显示帮助信息"


def skill_keywords() -> list[str]:
    return ["帮助", "菜单", "?", "h", "help", "命令"]


def skill_examples() -> list[str]:
    return ["  帮助"]


def execute(arg: str) -> str:
    return ""  # help 在 main.py 中已特殊处理，此函数仅作注册用
