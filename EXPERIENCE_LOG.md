# QuickTalk 改造全记录

## 🎯 需求

用户要求改 QuickTalk 聊天室：

1. **dps** 只响应私聊，不响应群聊 @dps
2. **t** 是独立的智能机器人账号，不是和 dps 搞到一起
3. **聊天室 UI** 改风格：全宽左对齐块状消息、分割线、统一向左

---

## 🛠 改造过程（踩坑实录）

### 第一轮：MiMoCode 自动化

用 MiMoCode 执行了三个任务：
- dps-agent 改为只响应私聊 ✅
- 创建独立 t-agent（复用 qt_client + DeepSeek） ✅
- CSS 全宽+左对齐+分割线 ✅

### 🔥 然后开始连环踩坑

**坑1：t-agent 启动不起来**
发现 `dps_boot.py` 用 `importlib` 加载模块时路径冲突，`sys.path` 里 dps-agent 排在 t-agent 前面，导致 `import main` 找错文件。

**坑2：dps 和 t 互相聊天**
t-agent 回复带 `@dps`，dps catchup 看到 `@dps` 就去回复，t 又回 @t，形成死循环。dps 在群里狂回几十条消息。

**坑3：两个 dps 实例在跑**
`dps-agent.service` + `dps_boot.py` 嵌入式线程，两个实例同时处理消息，每条消息回两次。

**坑4：dps_boot.start() 从来没执行过**
代码写在 `if __name__ == "__main__":` 里，但 systemd 用 uvicorn main:app 启动时不会执行这个块！试了 `@app.on_event("startup")` 和模块级导入都不行。

**坑5：两个 uvicorn 在跑**
旧的 port 8611（go-platform）一直自启，用户可能连错端口。

**坑6：僵尸 bash 进程**
15:19 和 15:23 启动的两个 bash wrapper 一直没死，带着旧代码继续跑，改了文件也没用。

### ✅ 最终方案

1. **抛弃嵌入式启动**，dps 和 t 都改成独立 systemd 服务
2. **清除 pycache + 杀僵尸进程**，保证新代码生效
3. **t-agent 回复不加 @dps**，避免互相触发
4. **dps catchup 巡查也加私聊过滤**

---

## 📂 改动文件清单

| 文件 | 改动 |
|------|------|
| `dps-agent/main.py` | _on_message + catchup 都加 is_private 过滤；移除 _handle_menu_command 调用 |
| `t-agent/main.py` | **新建**：独立智能机器人，私聊全响应/群聊@t，回复不加@mention |
| `t-agent/config.yaml` | **新建**：t/**** |
| `static/style.css` | 全宽 display:block、左对齐、分割线、统一背景色、左侧蓝线 |
| `pages/chat.html` | CSS 版本号 v=16 |
| `main.py` | 移除嵌入启动代码（改用独立 systemd 服务） |
| `dps_boot.py` | 更新为双 bot 启动（已弃用） |

---

## 🚀 最终架构

```
quicktalk.service (port 18675)
├── FastAPI 聊天室服务
├── dps-agent.service (独立进程)
│   └── 只在私聊响应
└── t-agent.service (独立进程)
    ├── 群聊 @t 响应
    └── 私聊全响应
```

## 🎨 新 UI 特点

- 所有消息靠左，全宽块状
- 每条消息之间有分割线
- 左侧蓝色竖线区分消息块
- 自己和他人消息风格统一
- 刷新可见（Ctrl+F5）
