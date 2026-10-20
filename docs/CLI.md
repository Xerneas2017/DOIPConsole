# 命令行工具（doip CLI）

DoIP 诊断控制台除浏览器界面外，还提供一个命令行工具 `doip`——**复用同一套协议栈**
（`ConnectionManager` / `UdsService` / `DoipUdpDiscovery`），适合脚本化、批量操作与 CI。

> CLI 直接跑协议栈，**不启动 HTTP/WS 服务**，也不需要浏览器。仿真 ECU 需另行启动
> （界面里点「启动仿真 ECU」，或 `npm run sim:up`）。

---

## 一、三种调用方式

| 方式 | 命令 | 适用场景 |
| --- | --- | --- |
| 免安装（推荐先试） | `npm run cli -- <参数>` | 不想动全局环境 |
| 全局命令 | `npm link` 后直接用 `doip <命令>` | 日常高频使用 |
| 直接执行 | `node bin/doip.mjs <命令>` | 排查 CLI 本身的问题 |

> `npm run cli -- send 22F190` 里的 `--` 是 npm 的传参分隔符，不可省略。
> `npm link` 会在**当前用户**下注册全局命令（Windows 为 `doip.cmd`），卸载用 `npm unlink -g doip-console`。

---

## 二、命令总览

| 命令 | 作用 | 传输层 |
| --- | --- | --- |
| `doip scan` | UDP 车辆发现（0x0001 → 0x0004） | UDP |
| `doip send <hex>` | 连接 + 路由激活 + 发送一条 UDS（0x8001），打印响应 | TCP |
| `doip alive` | 主动存活检查（0x0007 → 0x0008） | TCP |
| `doip entity-status` | 实体状态（0x4001 → 0x4002） | UDP |
| `doip power-mode` | 电源模式（0x4003 → 0x4004） | UDP |

---

## 三、通用选项

| 选项 | 说明 | 默认 |
| --- | --- | --- |
| `-H, --host <ip>` | 目标地址（scan 缺省为广播 + 回环） | `127.0.0.1` |
| `-p, --port <n>` | 目标端口 | `13400`（内置仿真用 `13401`） |
| `--sa <0xXXXX>` | tester 逻辑地址 | `0x0E00` |
| `--ta <0xXXXX>` | 目标逻辑地址 | `0x1000` |
| `--protocol <ver>` | DoIP 协议版本 `0x02` / `0x03` | `0x02` |
| `--activation-type <0xNN>` | 路由激活类型 | `0x00` |
| `--timeout <ms>` | send 的 P2 超时；UDP 命令的等待超时 | 协议默认 |
| `--addressing <mode>` | send 的寻址方式 `physical` / `functional` | `physical` |
| `--passive` | scan 时同时被动监听 0x0004 公告 | 关 |
| `--json` | 机器可读输出（自动关闭颜色） | 关 |
| `--yes` | 危险操作确认（见下） | 关 |
| `--no-color` | 关闭彩色输出 | 自动（非 TTY 自动关） |
| `-h, --help` / `-v, --version` | 帮助 / 版本 | — |

---

## 四、命令详解

### 4.1 `doip scan` — 车辆发现

```bash
doip scan --port 13401            # 发现内置仿真 ECU
doip scan -H 192.168.1.10         # 单播探测指定 IP
doip scan --passive --timeout 5000
doip scan --json                  # 输出 { ok, partial, entities: [...] }
```

```text
正在发现车辆（UDP 255.255.255.255 + 127.0.0.1:13401）...
发现 3 个实体：
  [1] 0x1000  127.0.0.1:13401  VIN LSVAM1234N2000001  EID 010203040506  GID 111213141516  request / sim
```

> `partial: true` 表示结果可能不全（广播被系统拦截后降级为回环探测，或开了被动监听）。

### 4.2 `doip send` — 发送一条 UDS

```bash
doip send 22 F1 90 --port 13401          # 读 VIN（hex 可分空格/连写/带 0x）
doip send 22F190 -p 13401 --json         # JSON 输出，适合管道
doip send 10 03 -p 13401                 # 切扩展会话
doip send 19 02 -p 13401                 # 读 DTC
doip send 22 F1 90 -H 192.168.1.10       # 连真实 ECU
```

```text
连接 127.0.0.1:13401（SA 0x0E00 → TA 0x1000，协议 0x02）...
路由已激活（0x10）
→ 22 F1 90
← 62 F1 90 4C 53 56 41 4D 31 32 33 34 4E 32 30 30 30 30 30 31
[OK] COMPLETED  耗时 1 ms，网关转发 0 ms
VIN = LSVAM1234N2000001
```

负响应会解释成中文并给出建议：

```text
← 7F 22 31
[NRC] 请求越界（0x31）
  建议：DID/参数在该 ECU 上不存在
```

**危险操作门禁**（与界面同一口径，原始 hex 也无法绕过）：

`0x11` 复位 / `0x14` 清 DTC / `0x2E` 写 DID / `0x31` 例程 / `0x27` 发送密钥，必须显式加 `--yes`：

```bash
doip send 11 01 -p 13401          # → [FAIL] 危险操作「0x11 ECU 复位」未确认，exit 1
doip send 11 01 -p 13401 --yes    # → 正常执行
```

### 4.3 `doip alive` — 主动存活检查

```bash
doip alive -p 13401
# [OK] 存活检查通过：实体 SA=0x1000，往返 0 ms
```

### 4.4 `doip entity-status` — 实体状态

```bash
doip entity-status -p 13401
# [OK] 实体状态  来自 127.0.0.1:13401，2 ms
#   节点类型      DoIP 网关（0x01）
#   并发 socket   1 / 5
#   最大数据长度  4.0 MiB
```

### 4.5 `doip power-mode` — 电源模式

```bash
doip power-mode -p 13401
# [OK] 电源模式：准备就绪（0x02）  来自 127.0.0.1:13401，2 ms
```

---

## 五、退出码与 CI 用法

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功（UDS 收到正响应**或负响应 NRC** 都算通信成功） |
| `1` | 通信失败：连接失败 / 路由被拒 / ACK 超时 / UDS 超时 / NACK / UDP 无响应 / 未发现实体 |
| `2` | 参数错误（未知命令、非法 hex、非法端口等） |

> NRC 是 ECU 的正常回答（通信已完成），因此退出码为 0；需要按 NRC 判定业务结果时读 `--json` 的 `nrc` 字段。

**脚本示例（读取 VIN，失败即退出）：**

```bash
#!/usr/bin/env bash
set -euo pipefail
VIN=$(doip send 22F190 -p 13401 --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);const hex=(r.responseHex||'').replace(/ /g,'');console.log(Buffer.from(hex.slice(6),'hex').toString('ascii'))})")
echo "VIN=$VIN"
```

**批量读 DID：**

```bash
for did in F190 F18C F191; do
  doip send "22 $did" -p 13401 --json | node -e "...按需解析..."
done
```

> CLI 每次调用是**独立连接**（连接→激活→发送→断开），不做连接复用；需要连续多请求时
> 用界面或编写脚本复用 `ConnectionManager`。

---

## 六、与界面的关系

- 同一套协议栈、同一套错误码与中文解释；
- CLI 不做 Trace 落盘、不启动 WebSocket，也不会自动重连/重发（Q1）；
- 界面里的「传输层诊断」三个按钮与 `alive` / `entity-status` / `power-mode` 一一对应。

---

*返回：[README](../README.md) · [Windows 指南](./DEPLOY-WINDOWS.md) · [macOS 指南](./DEPLOY-MACOS.md)*
