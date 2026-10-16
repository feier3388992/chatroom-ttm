import os, yaml

_BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_YAML_PATH = os.path.join(_BASE_DIR, "file_types.yaml")

_config_cache = None

def load_config():
    global _config_cache
    if _config_cache is not None:
        return _config_cache
    with open(_YAML_PATH, "r", encoding="utf-8") as f:
        _config_cache = yaml.safe_load(f)
    return _config_cache

def reload_config():
    global _config_cache
    _config_cache = None
    return load_config()

def get_all_extensions():
    cfg = load_config()
    exts = set()
    for exts_list in cfg.values():
        if isinstance(exts_list, list):
            for e in exts_list:
                exts.add(e.lower())
    return exts

def get_frontend_config():
    cfg = load_config()
    result = {
        "image": cfg.get("image", []),
        "video": cfg.get("video", []),
        "audio": cfg.get("audio", []),
        "document": cfg.get("document", []),
        "code": cfg.get("code", []),
        "text": cfg.get("text", []),
        "special": cfg.get("special", []),
        "archive": cfg.get("archive", []),
    }
    return result
