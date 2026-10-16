# QuickTalk V3 Mobile v3.2.0

基于 FastAPI + WebSocket 的即时通讯平台，移动端导向。

## 技术栈

- **后端**: Python FastAPI + SQLite + WebSocket
- **前端**: 原生 HTML/CSS/JS
- **端口**: 18675 (默认)

## 功能

- 私信/群聊/公告频道
- 文件上传分享（图片、视频、音频、文档、代码等）
- 视频/音频自动转码（ffmpeg，支持 avi/mkv/wmv/rmvb 等 → mp4/mp3）
- 文件类型可配置（YAML）
- 消息引用
- 代码语法高亮
- 实时输入状态
- 深色/浅色主题切换
- 管理员面板（房间管理、用户管理、邀请码管理等）
- 房间排序/重命名/删除
- 文件直接下载（不预览）

## v3.2.0 更新内容

- 新增：更新日记（`CHANGELOG.md`）与版本号统一为 v3.2.0
- 优化：默认超级管理员与前端权限判断统一为 `admin`
- 优化：机器人令牌/密钥改为环境变量/占位配置，不再内置真实凭据
- 优化：随包数据库为空库，仅内置超级管理员 `admin`
- 修复：`INSTALL.md` 端口说明与实际默认端口（18675）不一致

## v3.1.0 更新内容

- 新增：高级管理面板 - 房间排序（上/下箭头）、重命名、删除（回收关联消息）
- 新增：文件类型配置系统（YAML）—— 统一管理支持的上传/预览/转码格式
- 新增：视频/音频自动转码（ffmpeg）—— 浏览器不原生支持的格式（wmv, avi, mkv, rmvb, wma, ape 等）自动转码为 mp4/mp3
- 新增：转码进度条——前端轮询展示实时进度百分比
- 新增：文件消息右下角“下载”按钮——直接下载原文件，无需预览
- 新增：预览窗口下载按钮——下载转码后的文件
- 优化：转码在线程中后台执行，不阻塞正常聊天
- 优化：大文件支持 Range 分片播放（拖拽秒跳）
- 优化：转码后缓存重复使用

## 目录结构

```
talktome/
├── main.py                # 服务端主程序（FastAPI + WebSocket）
├── utils/                 # 工具模块（认证 auth_util、文件类型 file_config）
├── pages/                 # HTML 页面（login/chat/admin/admin_files）
├── static/                # CSS / JS / 字体 / 音效等静态资源
├── t-agent/               # 独立聊天机器人（config.yaml + skills/）
├── dps-agent/             # 机器人客户端库（qt_client、utils）
├── database/              # SQLite 数据库（首次运行自动生成，空库）
├── uploads/               # 用户上传文件（运行期生成，不随仓库分发）
├── wallpapers/            # 聊天背景图（运行期生成）
├── transcodes/            # 视频/音频转码缓存（运行期生成）
├── file_types.yaml        # 可配置的文件类型
├── requirements.txt       # 依赖清单（在线安装）
├── requirements-full.txt  # 完整依赖清单（含全部可选模块）
├── deploy.bat             # Windows 远程部署脚本（示例，需填自己的参数）
├── CHANGELOG.md           # 更新日记
├── CHANGELOG_USAGE.md     # 使用指南
├── INSTALL.md             # 安装说明
├── README.md              # 本文件
└── EXPERIENCE_LOG.md      # 开发记录
```

## 安装

```bash
pip install -r requirements.txt
python main.py
```

## 默认账户

- 超级管理员: `admin` / `admin`
- 邀请码：首次启动时自动生成到 `invite_codes.txt`
