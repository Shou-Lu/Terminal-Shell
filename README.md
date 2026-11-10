<div align="center">

<img src="./logo.png" width="112" height="112" alt="Terminal Shell logo" />

# Terminal Shell终端

**在 AstrBot WebUI 里打开一个真正属于你的 Shell。**

多标签终端 · 自定义高斯泼溅背景 · ECDH + AES-256-GCM 双向加密

[![AstrBot](https://img.shields.io/badge/AstrBot-%3E%3D4.17-6ee7ff)](https://astrbot.app)
[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB)](https://www.python.org/)
[![License](https://img.shields.io/badge/License-AGPL--3.0-a78bfa)](./LICENSE)

[功能](#功能) · [安装](#安装) · [配置](#配置) · [加密设计](#加密设计) · [安全须知](#安全须知)

</div>

---

## 简介

Terminal Shell终端是 AstrBot 的插件可视化视图：在 WebUI 里以浏览器标签页的方式管理多条真实 Shell 进程。
它不依赖第三方终端服务，直接由 AstrBot 后端创建 PTY / ConPTY，把输入输出通过加密通道实时回传。

整体界面使用**高斯泼溅（Gaussian Splatting）**风格：用户上传的图片会被采样成数千个柔和的高斯光点，
在终端玻璃面板背后缓慢漂移，并随鼠标产生轻微视差。图片、终端列表、输入、输出全部走应用层加密，
即使 AstrBot 部署在普通 HTTP 局域网地址上也能保持端到端密文传输。

> 这是一个拥有 Shell 执行权限的高权限工具，请务必阅读[安全须知](#安全须知)后再部署。

## 功能

- **浏览器式多标签**：新建、拖动排序、双击重命名、中键关闭，每个标签一条独立 Shell。
- **真实终端**：Linux / macOS 使用原生 PTY；Windows 使用 ConPTY（`pywinpty`），支持颜色、光标与交互式程序。
- **自定义高斯泼溅背景**：上传任意图片，前端自动压缩并采样成高斯光点；内置默认星云背景。
- **双向加密**：ECDH P-256 握手 → HKDF-SHA256 派生 → AES-256-GCM；请求、响应、SSE 每一帧都加密。
- **HTTP 环境可用**：HTTPS / localhost 使用浏览器原生 WebCrypto；普通 HTTP 自动切换到内置的 Noble 纯 JS 实现。
- **会话恢复**：刷新页面后自动恢复同一浏览器标签页创建的终端和最近输出。
- **移动端适配**：响应式布局，触屏设备提供 Esc、Tab、Ctrl+C、方向键等快捷按键。
- **可调外观**：泼溅尺寸、光晕强度、漂移速度、界面遮罩、终端字号均可实时调节并本地记忆。
- **访问控制**：可通过 `allowed_users` 限制允许使用的 WebUI 用户名，限制并发终端数与空闲回收时间。
- **智能对比度**：根据背景图平均亮度自动加深玻璃面板，保证终端文字可读。

## 安装

### 通过插件市场

在 AstrBot WebUI 的「插件」页面搜索 **Terminal Shell终端**，安装后重载插件。

### 手动安装

```bash
cd AstrBot/data/plugins
git clone https://github.com/Shou-Lu/Terminal-Shell.git astrbot_plugin_terminal_shell
```

然后在 WebUI 的插件页点击插件卡片的「重载插件」。首次加载会自动安装 `requirements.txt` 中的依赖：

```text
cryptography>=41.0.0
pywinpty>=2.0.13; sys_platform == "win32"
```

### 打开终端

插件页 → **Terminal Shell终端** → 可视化视图 **Terminal Shell终端**。

> **首次使用前必须先配置权限。** 出于安全考虑，`allowed_users` 为空且
> `allow_all_users` 为 `false` 时，插件会拒绝所有终端访问。请在插件配置中填写
> AstrBot WebUI 用户名，或明确开启 `allow_all_users`。

> 视图运行在受限 iframe 中，必须从 AstrBot 插件详情页打开，不能直接访问 HTML 文件。

## 配置

配置文件位于 `data/config/<插件目录名>_config.json`（推荐目录名为 `astrbot_plugin_terminal_shell`），也可以在 WebUI 插件配置页修改。

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | bool | `true` | 关闭后前端无法建立加密会话或创建终端。 |
| `allowed_users` | list | `[]` | 允许使用的 WebUI 用户名。留空时需要开启 `allow_all_users`，否则拒绝所有访问。 |
| `allow_all_users` | bool | `false` | 在 `allowed_users` 为空时允许所有 WebUI 用户。终端权限较高，默认关闭。 |
| `shell` | string | `""` | 自定义 Shell 路径。留空自动选择。 |
| `cwd` | string | `""` | 终端启动目录，留空为用户主目录。 |
| `max_sessions` | int | `8` | 每个用户同时存活的终端上限。 |
| `idle_timeout` | int | `1800` | 无输入输出的空闲回收时间（秒）。 |
| `allow_background_upload` | bool | `true` | 是否允许上传自定义背景。 |
| `max_upload_mb` | int | `8` | 背景图片大小上限（前端会先压缩）。 |
| `session_ttl` | int | `3600` | 加密会话空闲有效期（秒），过期自动重新协商。 |

### Shell 自动选择

- **Windows**：优先 `pwsh.exe`，其次 `powershell.exe`，最后 `cmd.exe`。
- **Linux / macOS**：使用 `$SHELL`，回退到 `/bin/bash`、`/bin/zsh`、`/bin/sh`。
- 也可以显式指定，例如 `C:\Program Files\PowerShell\7\pwsh.exe` 或 `/bin/fish`。

## 使用

### 快捷键

| 快捷键 | 功能 |
| --- | --- |
| `Ctrl` / `Cmd` + `Shift` + `T` | 新建终端 |
| `Ctrl` / `Cmd` + `Shift` + `W` | 关闭当前终端 |
| `Ctrl` / `Cmd` + `Tab` | 切换到下一个终端 |
| `Ctrl` + `Shift` + `Tab` | 切换到上一个终端 |
| `Ctrl` + `Shift` + `C` | 复制选中文本 |
| `Ctrl` + `Shift` + `V` | 粘贴 |
| `Ctrl` + `V` | 普通粘贴（浏览器允许时） |

右键终端区域可以复制选中、复制全部、粘贴、清空屏幕、关闭终端。

### 背景

点击标题栏「背景」：

1. 选择或拖入图片。
2. 前端将图片缩放到最长边 1600px，并编码为 JPEG（约几十 KB 到几百 KB）。
3. 点击「应用背景」，图片经 AES-256-GCM 加密后上传。
4. 后端校验文件头并保存到插件数据目录，随后回传渲染。

背景按 WebUI 用户名隔离，保存在：

```text
data/plugin_data/<插件目录名>/backgrounds/
```

> 传输过程加密，但静态文件本身以原始字节保存在磁盘上。若需要静态加密，请自行使用全盘加密。

### 持久化数据

所有可持久化的运行时数据都位于 AstrBot 的插件数据目录，不会写入插件源码目录，更新/重装插件不会覆盖：

```text
data/plugin_data/<插件目录名>/
├─ backgrounds/          # 自定义背景图片与元数据（按用户哈希隔离）
└─ preferences/          # 每个 WebUI 用户的界面设置（泼溅、遮罩、字号等）
```

> 推荐把插件目录命名为 `astrbot_plugin_terminal_shell`。插件使用实际安装目录名作为
> `plugin_data` 子目录，因此 AstrBot 删除插件时勾选“同时删除插件持久化数据”可以正确清理。

界面设置会在调整后自动加密保存到服务端，并同步到 `localStorage` 作为离线回退。删除插件时勾选“同时删除插件持久化数据”即可一并清理。

### 会话保持

- 刷新页面会通过 `sessionStorage`（沙箱不可用时回退到 `window.name`）中的 owner ID 恢复终端和最近 48 KB 输出。
- 关闭标签页**不会**立即杀死 Shell；超过 `idle_timeout` 后由后端回收。
- 关闭终端标签、插件停用或 AstrBot 退出时会主动结束对应进程。

## 加密设计

### 握手

```text
Browser                                      AstrBot Plugin
   |                                                |
   |  POST handshake { pub: base64(P-256) }          |
   |----------------------------------------------->|
   |                                                |  生成临时 P-256 密钥对
   |                                                |  ECDH → HKDF-SHA256
   |  { sid, pub, salt, ttl }                        |
   |<-----------------------------------------------|
   |  ECDH → HKDF-SHA256 → AES-256-GCM key           |
```

- 双方各自生成**临时** ECDH P-256 密钥对，不持久化。
- 共享密钥经 `HKDF-SHA256(salt=server_random, info="astrbot-terminal-shell/v1")` 派生 256 位 AES 密钥。
- 会话 ID、AES 密钥只保存在进程内存中，有 TTL 和用户名绑定。

### 数据帧

每个请求 / 响应 / SSE 帧都是：

```json
{
  "sid": "会话 ID",
  "a": "input",
  "iv": "base64(12 字节随机 IV)",
  "ct": "base64(AES-256-GCM 密文 + 16 字节 tag)"
}
```

AES-GCM 的附加认证数据（AAD）为：

```text
<sid>|<action>
```

因此同一段密文不能重放到另一个接口；篡改任意字节都会导致校验失败。

### 普通 HTTP 兼容

浏览器只在安全上下文（HTTPS / localhost）提供 `crypto.subtle`。为了让局域网 HTTP 部署也能加密，
插件在检测不到 WebCrypto 时动态加载内置的 [@noble/curves](https://github.com/paulmillr/noble-curves)、
[@noble/hashes](https://github.com/paulmillr/noble-hashes)、[@noble/ciphers](https://github.com/paulmillr/noble-ciphers)，
执行完全相同的 P-256 / HKDF-SHA256 / AES-256-GCM 协议。状态栏会显示当前使用 `WebCrypto` 还是 `Noble`。

> 应用层加密不能替代 HTTPS。它防止的是「AstrBot 前面有反向代理 / 抓包工具看到明文」以及
> 普通 HTTP 局域网中的明文传输；如果要抵御主动中间人攻击，仍然应该启用 HTTPS。

## 安全须知

**这个插件等同于把服务器 Shell 交给能够访问 AstrBot WebUI 的人。**

- 务必为 AstrBot WebUI 设置强密码，并尽量只在内网或 VPN 中开放。
- 强烈建议配置 `allowed_users`，只允许可信的 WebUI 用户名。
- 终端进程继承 AstrBot 进程的系统权限；不要以 root / Administrator 运行 AstrBot，除非你明确知道后果。
- 终端会继承 AstrBot 进程的环境变量。若你的部署方式把 API Key、Token 等放在环境变量中，它们可能对终端用户可见；请使用专用低权限账户运行，或改用配置文件/密钥管理。
- 不要把 AstrBot 直接暴露在公网；如需公网访问，请在反向代理层增加 HTTPS、认证、访问控制和速率限制。
- 背景图片会保存在插件数据目录中，请自行做好磁盘与备份权限管理。
- 发现异常加密状态（标题栏显示「加密异常」）时，请刷新页面；不要忽略持续的解密失败。
- 本插件不会记录终端输入输出到日志；但终端中运行的命令可能自行写入日志或历史文件。

## 跨平台说明

| 平台 | 实现 | 说明 |
| --- | --- | --- |
| Linux / macOS | 原生 PTY (`pty` + `os.fork` 风格) | 完整交互体验，支持 `vim`、`htop` 等。 |
| Windows | ConPTY (`pywinpty`) | 需要安装 `pywinpty`，支持颜色与大多数交互程序。 |
| Windows（无 pywinpty） | 管道回退 | 可以执行命令，但没有 PTY 行编辑、全屏程序和完整提示符。 |

如果 Windows 上看到 `无法加载 PSReadline 模块`，这是系统 PowerShell 的用户模块兼容性问题，
与插件无关。可在配置中把 `shell` 改成 `cmd.exe`，或安装 PowerShell 7 后使用 `pwsh.exe`。

## API 一览

所有接口都挂在插件路由前缀下，并经过加密信封（除握手外）：

| 接口 | 方法 | 说明 |
| --- | --- | --- |
| `handshake` | POST | ECDH 握手 |
| `session` | POST | 创建终端 |
| `list` | POST | 列出当前 owner 的终端 |
| `input` | POST | 写入终端输入 |
| `resize` | POST | 调整终端尺寸 |
| `close` | POST | 关闭终端 |
| `poll` | POST | 加密轮询（SSE 不可用时） |
| `stream` | GET | 加密 SSE 输出流 |
| `background/get` | POST | 读取背景 |
| `background/upload` | POST | 上传背景（密文内为 Base64 图片） |
| `background/reset` | POST | 恢复默认背景 |

## 目录结构

```text
astrbot_plugin_terminal_shell/
├─ main.py                     # AstrBot 入口、Web API、访问控制
├─ core/
│  ├─ crypto.py                # ECDH / HKDF / AES-GCM 会话与信封
│  ├─ terminal.py              # PTY / ConPTY、输出 Hub、生命周期
│  └─ storage.py               # 背景图片、界面设置的校验与持久化
├─ views/terminal/
│  ├─ index.html               # 插件可视化视图
│  ├─ style.css                # 玻璃拟态 + 响应式 UI
│  ├─ app.js                   # 多标签、输入输出、背景、快捷键
│  ├─ crypto.js                # WebCrypto + Noble 双后端
│  ├─ splat.js                 # WebGL2 高斯泼溅渲染器
│  └─ vendor/                  # xterm.js、Noble（含许可证）
├─ .astrbot-plugin/i18n/       # 插件 / 配置 / 视图国际化
├─ _conf_schema.json
├─ metadata.yaml
├─ logo.png
└─ requirements.txt
```

## 开发说明

插件遵循 AstrBot 插件存储规范：配置位于 `data/config/`，可变数据位于
`data/plugin_data/<插件目录名>/`，不会写入插件源码目录；卸载时勾选“同时删除插件持久化数据”即可清理。

### 第三方资源

- [xterm.js](https://github.com/xtermjs/xterm.js) — MIT，终端渲染。
- [@noble/curves](https://github.com/paulmillr/noble-curves)、[@noble/hashes](https://github.com/paulmillr/noble-hashes)、[@noble/ciphers](https://github.com/paulmillr/noble-ciphers) — MIT，HTTP 回退加密。

对应的许可证文本保存在 `views/terminal/vendor/` 下。

## License

[GNU Affero General Public License v3.0](./LICENSE) © 2026 Shou-Lu

本项目整体以 AGPL-3.0 授权。`views/terminal/vendor/` 下的 xterm.js 与 Noble 组件仍按其各自的 MIT
许可证授权，相关许可证文本已一并保留。

<div align="center">

**如果这个插件对你有帮助，欢迎点一个 Star ⭐**

</div>
