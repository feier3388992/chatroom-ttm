"""动态技能加载模块 - 自动发现并导入技能"""

import importlib
import pkgutil
from pathlib import Path

__all__ = ["load_skills"]


def load_skills() -> list[dict]:
    skills = []
    package_dir = Path(__file__).parent

    for entry in sorted(package_dir.iterdir()):
        if not entry.is_file() or entry.suffix != ".py":
            continue
        if entry.stem == "__init__":
            continue

        module_name = f".{entry.stem}"

        try:
            module = importlib.import_module(module_name, package=__package__)
        except Exception as exc:
            import sys as _sys
            print(f"⚠ 跳过技能模块 '{entry.stem}': {exc}", file=_sys.stderr)
            continue

        if not hasattr(module, "skill_name") or not callable(module.skill_name):
            continue
        if not hasattr(module, "skill_desc") or not callable(module.skill_desc):
            continue

        execute_fn = getattr(module, "execute", None)
        if not callable(execute_fn):
            continue

        keywords = getattr(module, "skill_keywords", None)
        if keywords is None or not callable(keywords):
            continue

        examples = getattr(module, "skill_examples", None)
        if examples is None or not callable(examples):
            continue

        skills.append({
            "name": module.skill_name(),
            "desc": module.skill_desc(),
            "keywords": module.skill_keywords(),
            "examples": module.skill_examples(),
            "module": entry.stem,
            "execute": execute_fn,
        })

    return skills
