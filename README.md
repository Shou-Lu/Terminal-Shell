<div align="center">

<img src="https://raw.githubusercontent.com/Shou-Lu/Terminal-Shell/main/logo.png" width="112" height="112" alt="Terminal Shell logo" />

# Terminal Shell终端

**在 AstrBot WebUI 里打开一个真正属于你的 Shell。**

多标签终端 · 文件管理 · 设备状态图表 · 自定义模糊背景 · ECDH + AES-256-GCM 双向加密

[![AstrBot](https://img.shields.io/badge/AstrBot-%3E%3D4.17-6ee7ff)](https://astrbot.app)
[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB)](https://www.python.org/)
[![License](https://img.shields.io/badge/License-AGPL--3.0-a78bfa)](./LICENSE)

[功能](#功能) · [安装](#安装) · [配置](#配置) · [加密设计](#加密设计) · [安全须知](#安全须知)

</div>

---

## 简介

Terminal Shell终端是 AstrBot 的插件可视化视图：在 WebUI 里以浏览器标签页的方式管理多条真实 Shell 进程。
它不依赖第三方终端服务，直接由 AstrBot 后端创建 PTY / ConPTY，把输入输出通过加密通道实时回传。

所有功能都集中在**同一个插件页面**里：标题栏左侧的「终端 / 文件 / 状态」切换三个工作区，
共用同一条加密通道，不需要在多个插件视图之间来回跳转。

整体界面使用与 SaveBili 相同的深色毛玻璃 + 网格背景。你可以上传自己的图片作为背景，
并通过模糊度和遮罩滑杆控制可读性；图片、终端列表、输入、输出、文件内容和设备状态全部走应用层加密，
即使 AstrBot 部署在普通 HTTP 局域网地址上也能保持端到端密文传输。

> 背景配色和深色网格风格参考 [SaveBili](https://github.com/SATA-F5/SaveBili)（AGPL-3.0）。
>
> 这是一个拥有 Shell 执行权限的高权限工具，请务必阅读[安全须知](#安全须知)后再部署。

## 功能

- **浏览器式多标签**：新建、拖动排序、双击重命名、中键关闭，每个标签一条独立 Shell。
- **真实终端**：Linux / macOS 使用原生 PTY；Windows 使用 ConPTY（`pywinpty`），支持颜色、光标与交互式程序。
- **自定义模糊背景**：上传任意图片，前端压缩后加密上传；支持模糊度、遮罩和字号实时调整。
- **加密终端**：ECDH P-256 握手 → HKDF-SHA256 派生 → AES-256-GCM；请求、响应、SSE 每一帧都加密。
- **聊天 / LLM 调用**：管理员可用 `/终端 <命令>` 或 `terminal_shell_exec` 工具调用持久化 Shell，输出加密落盘。
- **HTTP 环境可用**：HTTPS / localhost 使用浏览器原生 WebCrypto；普通 HTTP 自动切换到内置的 Noble 纯 JS 实现。
- **会话恢复**：刷新页面或从其他 AstrBot 页面切回插件页时，自动恢复终端和最近输出。
- **文件管理**：Material 风格文件工作区，彩色类型图标、面包屑路径、浮动新建按钮与单行操作菜单，支持浏览、上传、下载、预览、编辑文本、重命名、新建文件夹和删除文件。
- **设备状态**：每 0.5 秒更新系统运行时长、CPU、内存、磁盘与负载，仪表盘与函数图实时展示趋势。
- **移动端适配**：响应式布局，触屏设备提供 Esc、Tab、Ctrl+C、方向键等快捷按键。
- **可调外观**：背景模糊、界面遮罩、终端字号均可实时调节并持久化。
- **访问控制**：WebUI 视图默认允许所有已登录用户；`/终端` 与 LLM 工具默认仅管理员可用，并受 AstrBot 指令权限管理约束。

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
页面顶部的「终端 / 文件 / 状态」标签可以切换到文件管理或设备状态，全部功能都在这一页完成。

> 视图运行在受限 iframe 中，必须从 AstrBot 插件详情页打开，不能直接访问 HTML 文件。
> WebUI 视图默认允许所有已登录的 AstrBot 用户访问；请务必为 WebUI 设置强密码。

## 配置

配置文件位于 `data/config/<插件目录名>_config.json`（推荐目录名为 `astrbot_plugin_terminal_shell`），也可以在 WebUI 插件配置页修改。

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | bool | `true` | 关闭后前端无法建立加密会话或创建终端。 |
| `shell` | string | `""` | 自定义 Shell 路径。留空自动选择。 |
| `cwd` | string | `""` | 终端启动目录，留空为用户主目录。 |
| `file_manager_root` | string | `""` | 文件管理工作区的根目录，留空为用户主目录。 |
| `file_manager_max_mb` | int | `8` | 文件管理单文件大小上限。 |
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

### 聊天指令 / LLM 工具

插件注册了管理员指令：

```text
/终端 <命令>
```

- 默认**仅 AstrBot 管理员（超管）**可用
- 在持久化 Shell 中执行命令，回复内容就是终端输出
- 不带参数时返回该会话最近一次持久化的终端输出
- 每个聊天用户拥有独立的持久化 Shell；执行 `cd` 等状态会在进程存活期间保持
- 每次执行后，当前 Shell 的最近输出会加密保存，插件重载或进程被回收后下次执行会自动重建 Shell 并恢复历史
- 单条命令默认等待 25 秒；超时会返回已捕获输出并重置该 Shell，交互式命令请使用 WebUI 终端

同时注册 LLM 工具 `terminal_shell_exec`，模型可在管理员会话中调用同一持久化 Shell：

> `/终端` 与 `terminal_shell_exec` 都只对管理员开放。非管理员调用 LLM 工具会直接返回权限不足，不会执行任何命令。
> LLM 工具会把终端输出标记为不可信数据，避免命令输出中的内容被当作指令执行。

### 背景

点击标题栏「背景」：

1. 选择或拖入图片。
2. 前端将图片缩放到最长边 1600px，并编码为 JPEG（约几十 KB 到几百 KB）。
3. 点击「应用背景」，图片经 AES-256-GCM 加密后上传。
4. 后端校验文件头并保存到插件数据目录，随后作为 CSS 背景图回传渲染。

你可以实时调整：

- **背景模糊**：0–40px
- **界面遮罩**：控制深色遮罩强度，保证终端文字可读
- **终端字号**：11–20px

背景按 WebUI 用户名隔离，保存在：

```text
data/plugin_data/<插件目录名>/backgrounds/
```

> 传输过程加密，但背景图片静态文件本身以原始字节保存在磁盘上。若需要静态加密，请自行使用全盘加密。

### 文件管理

在页面顶部切换到「文件」工作区，可以：

- Material 风格列表：文件夹与图片、代码、压缩包、音视频、PDF 等类型使用不同颜色的图标
- 顶部面包屑路径与返回按钮，右下角浮动按钮集中提供「上传文件 / 新建文件夹」
- 每行右侧「⋮」菜单提供预览、下载、重命名和删除，操作结果以底部提示条反馈
- 浏览目录、面包屑跳转、返回上级
- 上传文件（加密后写入）
- 下载文件（加密回传后由浏览器保存）
- 预览图片、查看和编辑文本文件
- 新建文件夹、重命名、删除文件和目录
- 单文件大小受 `file_manager_max_mb` 限制
- 只能访问 `file_manager_root` 配置的根目录，无法通过 `..` 或符号链接逃逸

默认根目录是运行 AstrBot 的用户主目录。文件管理与其他工作区一样，对所有已登录 WebUI 用户开放；如果 WebUI 不是只对可信用户开放，请谨慎使用或把根目录设置为专用目录。

### 设备状态

切换到「状态」工作区可以查看设备的实时运行情况：

- **系统运行时长**：后端 `SystemMonitor` 定时采样系统启动时长，前端实时递增显示
- **设备信息**：主机名、操作系统、内核、架构、CPU 型号与核心数、Python / AstrBot 版本
- **资源仪表盘**：CPU、内存、磁盘占用、系统负载与进程信息
- **函数图**：最近 180 个采样点（约 90 秒）的 CPU / 内存折线图，以及各指标的小型趋势图

采样由后端异步任务完成（默认 0.5 秒一次），数据通过同一条加密通道回传，不会写入磁盘。
若安装了 `psutil` 会优先使用；没有时自动回退到各平台的标准库实现（`/proc`、Windows API、`vm_stat` 等）。

### 持久化数据

所有可持久化的运行时数据都位于 AstrBot 的插件数据目录，不会写入插件源码目录，更新/重装插件不会覆盖。若 AstrBot 无法提供插件数据目录（或返回空/相对路径），插件会拒绝启动，而不会回退到系统临时目录或当前工作目录：

```text
data/plugin_data/<插件目录名>/
├─ backgrounds/          # 自定义背景图片与元数据（按用户哈希隔离）
├─ preferences/          # 每个 WebUI 用户的界面设置（模糊、遮罩、字号等）
└─ sessions/             # 聊天/LLM 持久化 Shell 的加密输出快照
```

会话快照使用 AES-256-GCM 加密，密钥保存在同目录的 `.session.key`（权限 0600）；该密钥与密文位于同一插件数据目录，主要用于避免明文输出被直接读取/备份，不能替代全盘加密或操作系统账户隔离。

> 推荐把插件目录命名为 `astrbot_plugin_terminal_shell`。插件使用实际安装目录名作为
> `plugin_data` 子目录，因此 AstrBot 删除插件时勾选“同时删除插件持久化数据”可以正确清理。

界面设置会在调整后自动加密保存到服务端，并同步到 `localStorage` 作为离线回退。删除插件时勾选“同时删除插件持久化数据”即可一并清理。

### 会话保持

- 刷新页面，或从其他 AstrBot 页面切回插件页（iframe 被销毁后重建）时，会恢复该用户仍然存活的终端和最近 512 KB 输出。
- AstrBot 插件视图运行在无同源权限的沙箱 iframe 中，可能没有 `sessionStorage`；此时会用 `window.name` 保存 owner ID，终端列表则按 WebUI 用户恢复仍然存活的会话。
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
- WebUI 终端视图默认允许所有已登录用户访问；`/终端` 与 `terminal_shell_exec` 默认仅管理员可用。
- 文件管理与设备状态工作区同样对所有已登录 WebUI 用户开放，且默认根目录是运行 AstrBot 的用户主目录；如不需要请将 `file_manager_root` 指向专用目录，或通过反向代理限制访问。
- 终端进程继承 AstrBot 进程的系统权限；不要以 root / Administrator 运行 AstrBot，除非你明确知道后果。
- 终端会继承 AstrBot 进程的环境变量。若你的部署方式把 API Key、Token 等放在环境变量中，它们可能对终端用户可见；请使用专用低权限账户运行，或改用配置文件/密钥管理。
- 不要把 AstrBot 直接暴露在公网；如需公网访问，请在反向代理层增加 HTTPS、认证、访问控制和速率限制。
- 背景图片会保存在插件数据目录中，请自行做好磁盘与备份权限管理。
- 文件管理工作区可以读取/修改 `file_manager_root` 下的文件，请合理设置该目录并做好备份。
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
| `preferences/get` | POST | 读取界面设置 |
| `preferences/save` | POST | 保存界面设置 |
| `files/list` | POST | 列出文件 |
| `files/read` | POST | 加密读取文件 |
| `files/write` | POST | 加密写入文件 |
| `files/mkdir` | POST | 新建目录 |
| `files/delete` | POST | 删除文件/目录 |
| `files/rename` | POST | 重命名 |
| `system/status` | POST | 系统状态、设备信息与指标历史 |

## 目录结构

```text
astrbot_plugin_terminal_shell/
├─ main.py                     # AstrBot 入口、Web API、访问控制
├─ core/
│  ├─ crypto.py                # ECDH / HKDF / AES-GCM 会话与信封
│  ├─ terminal.py              # PTY / ConPTY、输出 Hub、生命周期
│  ├─ chat_shell.py            # /终端 与 LLM 使用的持久化 Shell
│  ├─ files.py                 # 文件管理安全根目录与读写操作
│  ├─ system.py                # 系统状态采样与设备信息
│  └─ storage.py               # 背景、界面设置、加密会话快照
├─ views/terminal/
│  ├─ index.html               # 单页三工作区（终端 / 文件 / 状态）
│  ├─ style.css                # SaveBili 风深色网格 + 毛玻璃
│  ├─ app.js                   # 多标签、输入输出、背景、工作区切换
│  ├─ files.js / files.css     # 文件管理面板
│  ├─ status.js / status.css   # 设备状态仪表盘与 Canvas 函数图
│  ├─ crypto.js                # WebCrypto + Noble 双后端
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
