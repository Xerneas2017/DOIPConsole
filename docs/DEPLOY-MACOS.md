# macOS 使用指南

DoIP 诊断控制台 · macOS 部署与日常使用（面向使用者的完整步骤）

---

## 一、环境要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | macOS 12 Monterey 或更高（Intel / Apple Silicon 均可） |
| Node.js | **20 或更高版本**（推荐 22 LTS） |
| 浏览器 | Safari / Chrome / Edge 任意现代浏览器 |
| 网络 | 连真实 ECU 时需与目标车辆同一网段；连内置仿真则无需外网 |

**不需要**安装 Python、Homebrew 依赖或任何驱动。

### 1. 安装 Node.js

任选其一：

- **官网安装器**（最简单）：<https://nodejs.org/> 下载 LTS 的 macOS 安装包（按芯片选 Apple Silicon 或 Intel 版），双击安装
- **Homebrew**：`brew install node@22`

安装后在「终端」执行：

```bash
node -v
```

显示 `v20.x.x` 或更高即成功。

---

## 二、启动（推荐：一键脚本）

在终端进入项目目录，执行：

```bash
bash scripts/start.sh
```

脚本会自动完成：安装依赖（仅首次）→ 构建前端 → 启动后端，并在约 3 秒后**自动打开浏览器**。

> 已构建过、只想快速启动时：
> ```bash
> bash scripts/start.sh --no-build
> ```

启动成功的标志——终端会打印：

```
后端已启动：http://127.0.0.1:8787  （WS: ws://127.0.0.1:8787）
界面地址：http://127.0.0.1:8787
```

**保持这个终端窗口开着**（它就是后端进程），用完按 `Ctrl-C` 退出。

### 端口被占用怎么办

8787 被占用时，工具会自动顺延到 8788-8797。**以终端打印的实际地址为准**；若自动打开的浏览器页面打不开，手动改成终端里的地址。

---

## 三、启动（手动方式）

等价命令：

```bash
npm install
npm start
```

（`npm start` 自带构建步骤。）macOS 下 `npm start` 不会自动开浏览器，需手动访问 <http://127.0.0.1:8787>——想自动打开就用 start.sh。

---

## 四、日常使用

1. **连内置仿真 ECU**（无需硬件）：左上模式选「仿真 ECU」→ 点「连接」。仿真未启动时工具会自动拉起，正常只点一次。
2. **连真实 ECU / 网关**：模式选「真实 ECU」→ 填目标 IP 与端口（DoIP 标准 13400）→ 可先「车辆发现」扫描 → 「连接」。
3. 诊断报文、Trace 查看、导出等详见界面与 `README.md`。

### 数据都存在哪

| 内容 | 位置 |
| --- | --- |
| 报文落盘（trace-logs） | `~/.doip-console/trace-logs/` |
| 运行日志 | `~/.doip-console/logs/` |

界面底部状态栏的「日志」/「录盘」打开目录按钮会直接在访达中打开对应文件夹。

### Wireshark 抓包（macOS 特色用法）

仿真 ECU 跑在真 socket 上，可以抓 `lo0` 看完整 DoIP 报文——调试协议栈的最强手段：

```bash
sudo tcpdump -i lo0 port 13401   # 或用 Wireshark 选 Loopback 网卡
```

---

## 五、命令行工具（可选）

不想开浏览器时，可以直接用命令行发诊断请求（复用同一套协议栈）：

```bash
npm run cli -- scan --port 13401          # 车辆发现
npm run cli -- send 22F190 -p 13401       # 读 VIN
npm run cli -- alive -p 13401             # 存活检查
npm run cli -- entity-status -p 13401     # 实体状态
npm run cli -- power-mode -p 13401        # 电源模式
```

> npm 传参的 `--` 分隔符不能省略。

想直接敲 `doip` 命令：

```bash
npm link
doip send 22 F1 90 -p 13401 --json
```

- 连内置仿真：端口用 `13401`（先 `npm run sim:up`，或在界面点「启动仿真 ECU」）
- 连真实 ECU：端口用默认 `13400`，加 `-H <ECU的IP>`
- `--json` 输出机器可读结果，适合 shell 管道与 CI
- 危险操作（`0x11` 复位等）需加 `--yes`

完整命令、选项与退出码见 [CLI 文档](./CLI.md)。

---

## 六、macOS 网络说明

- 工具只监听 127.0.0.1，macOS 防火墙默认不会拦截，**无弹窗、无需授权**。
- 「车辆发现」的 UDP 广播在多网卡（Wi-Fi + 有线 + 虚拟网卡如 VMWare/Parallels 的 vment）下可能选错出口网卡：若扫不到真实 ECU，先确认活动网卡正确（系统设置 → 网络），或直接在发现框里填目标 IP 单播探测。
- 抓包场景需要 `sudo` 权限（tcpdump/Wireshark 都要）。

---

## 七、常见问题

| 现象 | 原因与解法 |
| --- | --- |
| `node: command not found` | Node 未装或未进 PATH。官网安装器默认写 /usr/local/bin（Intel）或 /opt/homebrew（brew）；装完重开终端 |
| `npm install` 慢/超时 | 换镜像：`npm config set registry https://registry.npmmirror.com` |
| 权限报错 EACCES | 不要用 sudo 跑 npm。把项目放在用户目录（如 ~/work）下；全局包问题参考 npm 官方 fix 权限文档 |
| Apple Silicon 装 Node 报架构不符 | 下载安装包时选 Apple Silicon 版本；或 `brew install node@22` |
| 浏览器没自动打开 | start.sh 才会自动开；手动访问终端里打印的地址 |
| 端口被占用 | 工具自动顺延，按终端实际地址访问；`lsof -i :8787` 可查占用进程 |

---

## 八、开发模式（可选）

改前端代码需要热更新时，开**两个**终端分别运行：

```bash
node --import tsx server/src/index.ts   # 终端1：后端（8787）
npm run dev                             # 终端2：Vite 开发（5273，已代理 /api 与 /ws）
```

界面地址变为 <http://127.0.0.1:5273>。日常使用不需要开发模式。

---

*Windows 用户请查阅 [DEPLOY-WINDOWS.md](./DEPLOY-WINDOWS.md)*
