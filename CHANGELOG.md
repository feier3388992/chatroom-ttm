# 更新日记 (CHANGELOG)

## v3.2.0 — 2026-10-16

### 变更

- **版本**：统一为 v3.2.0（`main.py` 的 `VERSION`、README 标题）。
- **默认账户**：超级管理员统一为 `admin` / `admin`，可用环境变量 `QUICKTALK_SUPER_PASSWORD` 覆盖密码。
- **权限判断**：后端与前端（`pages/admin.html`、`static/app.js`）中硬编码的超级管理员用户名统一为 `admin`（后端改为读取常量 `SUPER_ADMIN`）。
- **凭据脱敏**：
  - `t-agent/config.yaml` 中的服务器地址、机器人账号密码、DeepSeek/硅基流动 API Key 全部替换为占位符。
  - `utils/auth_util.py` 的机器人令牌改为环境变量 `QUICKTALK_BOT_TOKEN`（默认占位符）。
  - `deploy.bat` 中真实服务器/密码改为示例参数。
- **随包数据库**：`users.db` 与 `messages.db` 均已清空，仅保留超级管理员 `admin`、大厅房间及表结构；邀请码表清空，首次启动自动重新生成。
- **文档修订**：修正 `INSTALL.md` 端口说明（11555 → 18675）与实际不符的问题；更新文件结构说明。
- **仓库瘦身**：不再随包分发 `uploads/`、`wallpapers/`、`transcodes/`、`database/` 中的真实数据以及离线依赖目录 `pip_packages*` 和旧打包文件。

### 说明

本版本为面向公开仓库的脱敏版本，不含任何真实用户数据、聊天记录、密钥或服务器信息。

## v3.1.0 — 2026-07（历史）

- 新增：高级管理面板 - 房间排序、重命名、删除（回收关联消息）。
- 新增：文件类型配置系统（YAML），统一管理上传/预览/转码格式。
- 新增：视频/音频自动转码（ffmpeg），不支持的格式自动转码为 mp4/mp3。
- 新增：转码进度条、文件下载按钮、预览窗口下载。
- 优化：转码后台线程执行、大文件 Range 分片播放、转码缓存复用。
