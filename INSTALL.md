# QuickTalk 安装说明

## 环境要求

- Python 3.10+
- pip
- **Linux额外依赖**: `libgdiplus`, `libc6-dev`（spire文档解析所需）

## 安装依赖

### 在线安装（推荐）

```bash
# Linux 先装系统依赖
sudo apt-get install -y libgdiplus libc6-dev

# 安装 Python 包
pip install -r requirements.txt
```

> 本仓库不含离线依赖包（`pip_packages/`、`pip_packages_linux/`）。
> 如需离线部署，可自行在有网机器上执行
> `pip download -r requirements.txt -d pip_packages` 生成离线包后再拷贝安装。
> 首次启动时，服务器会自动检测并尝试安装缺失的 Python 包；
> Linux 下还会自动尝试 `apt-get install libgdiplus libc6-dev`。

## 启动

```bash
python main.py
```

默认监听 `http://0.0.0.0:18675`

## 默认账户

- 超级管理员: `admin` / `admin`（可用环境变量 `QUICKTALK_SUPER_PASSWORD` 覆盖密码）
- 邀请码：首次启动时自动生成到 `invite_codes.txt`

## 文件说明

| 文件/目录 | 说明 |
|-----------|------|
| `main.py` | 服务端主程序 |
| `utils/` | 工具模块（认证等） |
| `pages/` | HTML 页面 |
| `static/` | CSS / JS / 静态资源 |
| `t-agent/` | 独立聊天机器人（含 skills） |
| `dps-agent/` | 机器人客户端库 |
| `uploads/` | 用户上传文件（运行期生成，不随仓库分发） |
| `database/` | SQLite 数据库（首次运行生成，不随仓库分发） |
| `wallpapers/` | 聊天背景图（运行期生成） |
| `transcodes/` | 音视频转码缓存（运行期生成） |
| `file_types.yaml` | 可配置的文件类型 |
| `requirements.txt` | 依赖清单 |
| `deploy.bat` | Windows 远程部署脚本（示例） |
| `invite_codes.txt` | 邀请码列表（首次运行生成） |

## 功能特性

- **多房间聊天**: 支持公开/私密房间，密码保护
- **私聊**: 一对一私密聊天
- **文件上传**: 支持图片、视频、音频、PDF等20+格式
- **文件预览**: 拖拽/可调大小的预览窗口
  - Word(.docx/.doc): 使用 spire.doc 保留完整格式、样式、表格
  - Excel(.xlsx/.xls): 使用 spire.xls 保留完整格式、样式、表格
  - PPT(.pptx/.ppt): 使用 python-pptx 解析
  - Markdown(.md): 自定义渲染
  - 代码文件: 语法高亮显示
  - PDF/图片/视频/音频: 浏览器原生预览
- **消息气泡颜色**: 用户可自定义消息背景和文字颜色
- **暗色模式**: 纯黑白灰色调主题
- **@提及**: @在线用户获取通知
- **引用回复**: 引用历史消息
- **表情选择器**: 内置表情面板
- **管理员面板**: 用户管理、消息管理、邀请码管理
- **Bot API**: 支持机器人接入
- **实时通信**: WebSocket 实时消息推送

## API 接口

### 认证

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/login` | 登录 |
| POST | `/api/auth/register` | 注册 |
| POST | `/api/auth/logout` | 登出 |
| GET | `/api/auth/me` | 获取当前用户信息 |

### 聊天

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/chat/messages` | 获取消息列表 |
| POST | `/api/chat/send` | 发送消息 |
| POST | `/api/chat/upload` | 上传文件 |
| DELETE | `/api/chat/messages/{id}` | 删除消息 |
| GET | `/api/file/parse/{id}` | 解析预览文件 |

### 房间

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/rooms` | 房间列表 |
| POST | `/api/rooms` | 创建房间 |
| POST | `/api/rooms/{id}/join` | 加入房间 |
| POST | `/api/rooms/{id}/leave` | 离开房间 |
| DELETE | `/api/rooms/{id}` | 删除房间 |

### 私聊

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/chat/private-chats` | 私聊列表 |
| POST | `/api/chat/private-chats` | 添加好友 |
| DELETE | `/api/chat/private-chats/{friend}` | 删除好友 |

### 用户

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/users` | 用户列表 |
| GET | `/api/user/color` | 获取消息气泡颜色 |
| POST | `/api/user/color` | 设置消息气泡颜色 |

### 管理员

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/admin/users` | 用户管理 |
| POST | `/api/admin/kick/{username}` | 踢出用户 |
| POST | `/api/admin/ban/{username}` | 封禁用户 |
| POST | `/api/admin/unban/{username}` | 解封用户 |
| GET | `/api/admin/codes` | 邀请码管理 |
| POST | `/api/admin/codes/generate` | 生成邀请码 |
| GET | `/api/admin/messages` | 消息管理 |
| POST | `/api/admin/messages/batch-delete` | 批量删除消息 |
| GET | `/api/admin/files` | 文件管理 |
| POST | `/api/admin/files/cleanup` | 清理孤立文件 |
| GET | `/api/admin/code-files` | 代码编辑器文件列表 |
| GET | `/api/admin/code-file` | 读取代码文件 |
| POST | `/api/admin/code-file` | 保存代码文件 |
| POST | `/api/admin/restart` | 重启服务器 |

### Bot

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/bot/send` | Bot发送消息 |
| GET | `/api/bot/messages` | Bot获取消息 |
| POST | `/api/bot/typing` | Bot输入状态 |
