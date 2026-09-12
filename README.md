<div align="center">
  <img src="public/logo.svg" width="96" alt="Witchcat Ops Logo" />

  # Witchcat Ops

  **AI Agent 驱动的服务器运维桌面工具**

  Tauri 2 · React 19 · Rust(russh / sqlx / ring)· xterm.js

  灵感来自 [Solsynth/MaidKit](https://github.com/Solsynth/MaidKit),从零自研的定制化实现
</div>

---

## 这是什么

Witchcat Ops 把"AI Agent 运维"和"人工运维"统一到一台桌面应用里：Agent 的写操作必须先生成提案并由用户审批；Agent、快捷指令、服务控制与 SFTP 写操作汇入同一份结构化审计日志，审计证据再沉淀为运维文档和可复用技能。

## 核心能力

### 经验飞轮(项目灵魂)

| 环节 | 说明 |
|---|---|
| **操作审计** | 统一执行出口 `execute_and_audit()`:谁、何时、哪台服务器、什么命令、结果、耗时、审批人,全部落库可查 |
| **Skills 技能** | 双形态:SOP 知识包(Markdown,注入 Agent 上下文)+ 快捷指令(人类一键执行多步操作) |
| **产出沉淀** | 会话与审计证据生成复盘草稿；文档经审核后才能转为默认停用的技能草稿，再由用户发布使用 |

### 基础运维

- **服务器管理** —— SSH 密码/私钥连接,首次连接主机密钥指纹确认(TOFU),连接状态实时可见
- **PTY 交互式终端** —— russh PTY + xterm.js,30s keep-alive 保活;输出缓冲时序设计保证初始输出零丢失;断线有明确提示。PTY 记录会话结束事件，默认不保存可能包含密码的输入内容
- **SFTP 文件管理** —— 目录浏览(面包屑/上一级)、在线编辑文本文件(1MB 保护 + UTF-8 校验)、删除(两步确认)、新建目录、八进制权限显示、符号链接跟随
- **监控仪表盘** —— CPU / 内存 / Load / Swap / 磁盘挂载点,实时轮询
- **容器管理** —— Docker 容器列表与启停控制
- **Systemd 服务** —— 服务列表与 start/stop/restart

### AI Agent

- **Agent Copilot** —— LLM 配置(多 Provider)存在后端 Vault,请求由 Rust 后端代理并以事件流回传（支持 reasoning 回显）
- **提案/执行解耦** —— Agent 只产出写操作提案，批准、执行与结果状态都由服务端状态机处理

### 安全

- **Vault 凭证库** —— 主密码 → PBKDF2(310,000 次)→ 解包数据密钥 → AES-GCM-256 加密所有敏感数据;数据密钥存于 OS 钥匙串(keyring)并在库内留包装备份(忘记主密码可用钥匙串恢复);Vault 未启用时敏感值以 `plain:` 前缀明文存储(本地单机权衡,建议启用 Vault)
- 结构化操作在执行前先登记审计，完成后写入 succeeded/failed/unknown；应用异常退出时不会把在途操作误报成功或自动重试

## 界面

苹果风设计:无边框窗口(macOS 三键接管窗口控制,悬停浮现符号)、玻璃拟态卡片、5 套主题(macOS 黑夜/白天、Bilibili 粉、赛博暗黑、Monokai 极客)、全矢量 lucide 图标。

## 快速开始

### 环境要求

- Node.js 18+ / pnpm
- Rust 工具链(rustup)
- Windows:WebView2 Runtime(Win11 自带)

### 开发

```bash
pnpm install
pnpm tauri dev
```

### 构建

```bash
pnpm tauri build
```

### 重新生成图标

Logo 源稿是 `public/logo.svg`(终端光标 `>_` 标)。全套 PNG/ICO 由脚本程序化绘制:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/gen-icon.ps1
```

### Windows 特殊说明(WDAC)

本机 WDAC 策略若拦截项目目录中的 cargo 构建脚本（os error 4551），可在 PowerShell 中先设置：

```powershell
$env:CARGO_TARGET_DIR = Join-Path $env:USERPROFILE 'Documents\witchcat-ops-target'
```

应用数据库位于操作系统应用数据目录（SQLite，WAL 模式，启动自动执行版本化迁移）。
旧版项目根目录 `data` 会在首次升级时完整复制，并保留原副本；目标目录原有数据还会保存为相邻的 `.pre-legacy-import` 备份；
也可用环境变量 `WITCHCAT_DATA_DIR` 指定便携数据目录。

## 项目结构

```
witchcat-ops/
├── src/                        # 前端(React 19 + TS)
│   ├── components/             #   17 个视图组件(终端/SFTP/监控/Agent/审计...)
│   ├── context/AppContext.tsx  #   全局状态 + IPC 编排
│   ├── lib/ipc.ts              #   类型安全的 invoke 封装 + 终端输出缓冲
│   ├── lib/agent.ts            #   Agent 会话(流式对话/提案执行)
│   └── types/backend.ts        #   前后端共享类型
├── src-tauri/                  # 后端(Rust)
│   ├── src/ssh.rs              #   russh 连接/执行/PTY/SFTP(含 keep-alive)
│   ├── src/terminal.rs         #   终端 actor(事件流 ↔ 指令流)
│   ├── src/executor.rs         #   结构化命令的执行与审计状态机
│   ├── src/vault.rs            #   PBKDF2 + AES-GCM 凭证库
│   ├── src/commands/           #   按域划分的 Tauri IPC 命令
│   └── migrations/             #   SQLite 版本化迁移
├── scripts/gen-icon.ps1        # 图标程序化生成器
└── docs/                       # 设计文档
    ├── PROJECT_DESIGN.md           # 总体设计
    ├── BACKEND_API.md              # 前后端 IPC 契约
    └── MAIDKIT_LESSONS_AND_PLAN.md # MaidKit 源码研读笔记
```

## 路线图

- [x] SSH / PTY / SFTP / 监控 / 容器 / 服务
- [x] Vault 加密凭证库 + 审计日志
- [x] Skills / 快捷指令 / 文档飞轮
- [x] Agent Copilot(提案-审批-执行)
- [ ] MCP Server(对外暴露运维能力,loopback HTTP+SSE)
- [x] SFTP 二进制上传/下载
- [ ] 多标签终端分屏

## 文档

- [总体设计](docs/PROJECT_DESIGN.md)
- [后端 IPC 契约](docs/BACKEND_API.md)
- [MaidKit 研读与规划](docs/MAIDKIT_LESSONS_AND_PLAN.md)
