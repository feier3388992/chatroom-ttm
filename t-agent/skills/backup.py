"""备份聊天室文件技能"""

import os
import re
import requests


def skill_name() -> str:
    return "文件备份"


def skill_desc() -> str:
    return "备份聊天室的所有文件到 /root/myapp/chat_files/ 目录，格式：备份 或 备份文件 房间N"


def skill_keywords() -> list[str]:
    return ["备份", "备份文件"]


def skill_examples() -> list[str]:
    return [
        "  备份文件",
        "  备份文件 房间4",
        "  备份文件 大厅",
    ]


ROOM_NAMES = {"大厅": 0, "群公告": 9, "导航群": 13, "天气查询": 6, "股票群": 4,
              "彩票讨论群": 7, "家庭信息群": 11, "代码改进建议": 3, "更新agent专用": 12}

EXT_CATEGORY = {
    ('.jpg','.jpeg','.png','.gif','.bmp','.webp','.svg'): 'images',
    ('.doc','.docx','.xls','.xlsx','.ppt','.pptx','.pdf','.txt','.md','.csv'): 'documents',
    ('.zip','.tar','.gz','.bz2','.7z','.rar'): 'archives',
    ('.py','.js','.ts','.html','.css','.java','.cpp','.c','.go','.rs','.sh','.bat','.yaml','.yml','.json','.xml'): 'code',
}


def _categorize(fname: str) -> str:
    ext = os.path.splitext(fname)[1].lower()
    for exts, cat in EXT_CATEGORY.items():
        if ext in exts:
            return cat
    return 'other'


def execute(arg: str, client=None, room_id=0) -> str:
    # 解析目标房间
    target_room = room_id
    if arg:
        m = re.search(r'(?:房间|room)\s*(\d+)', arg, re.IGNORECASE)
        if m:
            target_room = int(m.group(1))
        elif arg.strip() in ROOM_NAMES:
            target_room = ROOM_NAMES[arg.strip()]
        else:
            try:
                target_room = int(re.search(r'\d+', arg).group())
            except Exception:
                pass

    if client is None:
        return "❌ 无法连接客户端，请稍后再试"

    # 拉消息列表
    try:
        msgs = client.get_messages(target_room)
    except Exception as e:
        return f"❌ 获取消息失败：{e}"

    files = [m for m in msgs if m.get("file_path")]
    if not files:
        return f"房间 {target_room} 没有文件需要备份"

    # 创建备份目录
    backup_dir = f"/root/myapp/chat_files/room_{target_room}"
    os.makedirs(backup_dir, exist_ok=True)
    for sub in ('images', 'documents', 'archives', 'code', 'other'):
        os.makedirs(f"{backup_dir}/{sub}", exist_ok=True)

    downloaded = 0
    errors = 0
    for f in files:
        fpath = f.get("file_path", "")
        if not fpath:
            continue
        try:
            data = client.download_file(fpath)
            if data is None:
                errors += 1
                continue
            fname = os.path.basename(fpath)
            sub = _categorize(fname)
            save_path = f"{backup_dir}/{sub}/{fname}"
            with open(save_path, "wb") as sf:
                sf.write(data)
            downloaded += 1
        except Exception:
            errors += 1

    line = f"✅ 房间 {target_room} 备份完成：{downloaded}/{len(files)} 文件"
    if errors:
        line += f"（{errors} 个失败）"
    return line
