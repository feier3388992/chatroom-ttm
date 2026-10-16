# QuickTalk 聊天室 — 完全指南

## 📋 近期改造内容

### 1. dps-agent 改造
**文件**: `dps-agent/main.py`

- **dps 只响应私聊**：群聊中即使 @dps 也不再回复，只有私聊（room_id>=10000）才处理
- **移除 @t 菜单处理**：`_handle_menu_command` 调用已移除，不再拦截 @t 指令
- **巡查修复**：catchup 扫描也加了私聊过滤，防止启动时误回复群聊消息

### 2. t-agent 独立智能机器人（新建）
**文件**: `t-agent/main.py`（新建 190 行）

- 独立账号 `t` 连接 QuickTalk，完全独立于 dps
- 用 DeepSeek-V4-Flash 驱动，保持 20 轮对话上下文
- **私聊**：任何消息都响应
- **群聊**：需要 `@t` 开头才响应
- 回复**不加 @dps/@用户**，避免互相触发
- **systemd 服务**：`t-agent.service`，开机自启，崩溃自动重启

### 3. 聊天室 UI 改造
**文件**: `static/style.css`

- **全宽块状布局**：消息气泡 display:block，占满整行，无 max-width 限制
- **统一左对齐**：自己和他人消息都靠左，不再区分左右
- **左侧蓝色竖线**：每条消息左侧 3px 蓝色竖线（border-left: 3px solid var(--accent)）
- **每行分割线**：所有消息之间有分割线，最后一条也有
- **统一背景色**：自己和他人消息使用相同背景色
- **CSS 版本 v=16**：浏览器硬刷新后生效

### 4. 启动架构改造
**文件**: `main.py`

- `dps_boot.start()` 从 `__main__` 块移到模块级，支持 systemd uvicorn 启动
- 但最终改用独立 systemd 服务更可靠（dps-agent.service + t-agent.service）

---

## 🚀 如何使用

### 登录
```
服务器: <你的服务器地址>:18675
```

### 普通聊天
- 在房间直接发消息，所有人可见
- 私聊：点击用户列表中的好友，进入私聊

### 使用 dps（AI 助手）
**只支持私聊**！给 dps 发私聊即可：
```
帮我查天气 北京
帮我搜 今日新闻
帮我查股票 茅台
```

### 使用 t（独立聊天机器人）
**群聊**：发送 `@t xxx`，t 会回复
**私聊**：直接发消息，t 自动回复

t 是独立的智能聊天机器人，和 dps 互不干扰。用 DeepSeek-V4 驱动，闲聊、问答都可以。

### @t 菜单系统
旧版 @t 菜单（数字菜单）已移除。t 现在直接用大模型回复，不需要数字菜单。

---

## 📝 配置文件

| 项目 | 配置路径 | 说明 |
|------|---------|------|
| dps | `dps-agent/config.yaml` | 账号: dps/****, 触发词: @dps |
| t | `t-agent/config.yaml` | 账号: t/****（在 config.yaml 中填写） |
| 聊天室 | `main.py` SERVER_PORT | 端口 18675 |

---

## 🔧 系统管理

```
# 查看服务状态
systemctl status quicktalk.service    # 聊天室服务
systemctl status dps-agent.service    # dps 机器人
systemctl status t-agent.service      # t 机器人

# 重启服务
systemctl restart quicktalk.service
systemctl restart dps-agent.service
systemctl restart t-agent.service
```
