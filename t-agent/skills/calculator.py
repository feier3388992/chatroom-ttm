"""计算器技能 - 一步返回，扁平调用"""

import ast
import operator
from typing import Any

_OPERATORS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Pow: operator.pow,
    ast.Mod: operator.mod,
    ast.USub: operator.neg,
    ast.UAdd: operator.pos,
}


def skill_name() -> str:
    return "计算器"


def skill_desc() -> str:
    return "数学运算，格式：计算 表达式"


def skill_keywords() -> list[str]:
    return ["计算", "calc", "算"]


def skill_examples() -> list[str]:
    return ["  计算 1+2*3", "  计算 (10+5)/3", "  计算 2**10"]


def execute(arg: str) -> str:
    expr = arg.strip()

    if not expr:
        return "请输入数学表达式，例如：计算 1+2*3"

    try:
        result = _safe_eval(expr)
        return f"{expr} = {result}"
    except SyntaxError:
        return "表达式语法错误，请检查输入。"
    except ZeroDivisionError:
        return "除数不能为零。"
    except (ValueError, TypeError) as exc:
        return f"计算错误：{exc}"
    except Exception:
        return "不支持的表达式，请使用基本的四则运算（+ - * / ** % //）。"


def _safe_eval(expr: str) -> float | int:
    tree = ast.parse(expr.strip(), mode="eval")

    def _eval_node(node: ast.AST) -> float | int:
        if isinstance(node, ast.Constant):
            if isinstance(node.value, (int, float)):
                return node.value
            raise ValueError(f"不支持的常量类型：{type(node.value).__name__}")
        elif isinstance(node, ast.BinOp):
            op_type = type(node.op)
            if op_type not in _OPERATORS:
                raise ValueError(f"不支持的操作符：{op_type.__name__}")
            left = _eval_node(node.left)
            right = _eval_node(node.right)
            return _OPERATORS[op_type](left, right)
        elif isinstance(node, ast.UnaryOp):
            op_type = type(node.op)
            if op_type not in _OPERATORS:
                raise ValueError(f"不支持的操作符：{op_type.__name__}")
            operand = _eval_node(node.operand)
            return _OPERATORS[op_type](operand)
        else:
            raise ValueError(f"不支持的表达式节点：{type(node).__name__}")

    return _eval_node(tree.body)
