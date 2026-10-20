# DoIP 诊断控制台

> 界面支持 **简体中文 / English / Deutsch**（工具栏右上角切换，选择会记住）
> 文档：[简体中文](README.md) · [English](docs/GUIDE.en.md) · [Deutsch](docs/GUIDE.de.md)

ISO 13400-2（DoIP）/ ISO 14229-1（UDS）诊断控制台。monorepo：`shared` / `server` / `web`。

## 快速开始

```bash
npm install
npm start        # 构建前端 + 启动后端，浏览器打开 http://127.0.0.1:8787
```

或使用启动脚本（自动打开浏览器）：

```bash
bash scripts/start.sh              # 构建 + 启动
bash scripts/start.sh --no-build   # 跳过构建，使用已有 web/dist
```

Windows：

```bat
scripts\start.bat              &rem 构建 + 启动
scripts\start.bat --no-build   &rem 跳过构建
```

单进程、单地址 `http://127.0.0.1:8787`。端口被占用时自动顺延，以终端输出的实际地址为准。

分平台说明：[Windows](docs/DEPLOY-WINDOWS.md) · [macOS](docs/DEPLOY-MACOS.md)

## 命令行工具（CLI）

`doip` 命令复用同一套协议栈，不启动 HTTP 服务、不需要浏览器（仿真 ECU 需先启动：`npm run sim:up`）：

```bash
npm run cli -- scan --port 13401          # UDP 车辆发现（0x0001 → 0x0004）
npm run cli -- send 22F190 -p 13401       # 连接 + 路由激活 + 发 UDS（0x8001）
npm run cli -- alive -p 13401             # 主动存活检查（0x0007 → 0x0008）
npm run cli -- entity-status -p 13401     # 实体状态（0x4001 → 0x4002）
npm run cli -- power-mode -p 13401        # 电源模式（0x4003 → 0x4004）

npm link                                  # 可选：注册全局命令
doip send 22 F1 90 -p 13401 --json        # 机器可读输出
```

危险操作（`0x11` 复位 / `0x14` 清 DTC / `0x2E` 写 DID / `0x31` 例程 / `0x27` 发送密钥）需显式加 `--yes`，
与界面使用同一套门禁。完整说明见 [CLI 文档](docs/CLI.md)。

## 开发模式

```bash
node --import tsx server/src/index.ts   # 终端 1：后端（8787）
npm run dev                             # 终端 2：Vite dev（5273，代理 /api 与 /ws）
```

界面地址为 `http://127.0.0.1:5273`。两条命令需分别在两个终端运行。

## 门禁

| 命令 | 作用 |
| --- | --- |
| `npm run typecheck` | 全工作区 `tsc --noEmit`，要求 0 错误 |
| `npm run check:timeouts` | 超时/上限硬编码守卫：所有超时集中在 `shared/src/protocol/constants.ts`，命中即退出码 1 |
| `npm test` | server + web 全量单测 |
| `npm run smoke` | `scripts/smoke.mjs` 端到端冒烟（真实 TCP/UDP socket），任一 FAIL 即退出码 1 |
| `npm run verify` | 依次执行以上四步 |

守卫自检钩子：

```bash
DOIP_SMOKE_FORCE_FAIL=1 npm run smoke   # 注入一条 FAIL，验证退出码传递
DOIP_SMOKE_LEAK_PROBE=1 npm run smoke   # 注入 timer 泄漏，验证句柄守卫
```

`check:timeouts` 可在任意 `.tsx` 中写入 `setTimeout(..., 9999)` 验证：应报出文件名与行号并以退出码 1 结束。

句柄守卫采用基线比对：启动时采集句柄类型计数，收尾静默后只允许新增为 0。

## 目录

- `shared/` 协议常量、码表、类型、WS 契约（前后端唯一真源）
- `server/` DoIP 客户端、事务管理、会话状态机、TraceStore、滚动落盘、WS 桥接、UDS 服务库与 Key 算法
- `web/` React + MUI 前端，五分区（A 连接 / B 请求 / C Trace / D 详情 / E 状态栏）
- `data/` `uds-library.json`（内置服务库，带 `builtin` 标记）、`key-algo-vectors.json`（算法校准向量）

## 设计约束

- 禁止自动重连/自动重发：失败只返回 NRC 与处置建议，由用户决定。
- 所有超时/上限集中在 `shared/src/protocol/constants.ts`。
- 后端 HTTP/WS 只绑定 `127.0.0.1`（硬编码，不可配置）。
- `seq` 由 `EventBus` 单点分配且全局单调；任何丢弃区间必须发 `trace.gap`，error/status 类事件永不丢弃。
- `RollingFileSink` 是 `EventBus` 的平级订阅者，不消费 `BatchFlusher` 输出，WS 背压降级不影响落盘。

## 互操作性验证

除自身端到端测试外，使用按 ISO 13400 标准实现的第三方库 python-doipclient 对仿真实体做字节级验证：

```bash
npm start          # 另开终端
npm run sim:up     # 启动仿真 ECU
npm run interop    # 运行 11 项互操作检查
```

依赖：`pip install doipclient`。

当前结果：11/11 通过 —— TCP + 路由激活、UDP 车辆识别、`10/22/19/3E/27/11` 六类 UDS 服务（含 VIN 明文比对）、
NRC `0x31` 负例、Alive Check `0x0007→0x0008`、实体状态 `0x4001→0x4002`。

验证过程中定位并修复的问题：

| # | 问题 | 归属 | 修法 |
|---|---|---|---|
| 1 | 路由激活请求长度被硬校验为 `>= 11`，而 ISO 中 OEM 保留字段可选，标准客户端只发 7 字节，导致帧被丢弃、激活超时 | 本项目 | `DoipPayloadCodec` 接受 7 或 11 字节；补 TC-C09 回归 |
| 2 | 仿真 UDP 未处理 `0x4001` 实体状态；TCP 收到 `0x0007` 无分支，导致对方超时 | 本项目 | 补两个处理分支；补 TC-S07 回归 |
| 3 | `python-doipclient` 的 `send_diagnostic_to_address()` 收到 `0x8002` ACK 即返回，不等待随后的 UDS 响应（`client.py:769-774`） | 第三方库 | 不修改（发送 ACK 符合 ISO）；互操作脚本用 `receive_diagnostic()` 补读 |

仿真侧原先对"收到帧但无法处理"使用 `debug` 级日志，默认 `info` 级别下不可见；现已改为 `warn` 并附带原始字节。

## 0x27 Key 算法

`server/src/uds/algorithms/ported/CustomerSeedKey.ts` 当前为占位实现：`origin: 'placeholder'`、`verified: false`，
UI 中标记「待替换」并排在列表末尾，试算面板会提示待替换。

- 仿真侧另有 `SIM_SEED_KEY_MASK = 0x5A`（`server/src/sim/simPresets.ts`），仅仿真使用，与客户端算法独立；
  连接仿真时 UI 自动选中与之匹配的「逐字节异或 0x5A」。
- 下拉排序：已验证移植算法 → 未验证 → `placeholder` 最后；实现见 `KeyAlgorithmRegistry.sortKey()` 与
  `useLibraryStore.rank()`，两处口径一致。
- 接入真实算法：
  1. 在 `server/src/uds/algorithms/ported/` 新增 `PortedAlgorithmImpl`（`id` / `nameZh` / `appliesToLevels` /
     seed 与 key 长度约束 / 纯函数 `compute(level, seed)` / `origin: 'customer-c'`），并在 `KeyAlgorithmRegistry` 注册；
  2. 将已知测试向量填入 `data/key-algo-vectors.json` 并运行 `npm test`，`origin: 'customer-c'` 的算法向量须 100% 通过
     才标记 `verified: true`（空集不计为通过）。
- C→JS 移植注意 `server/src/__tests__/keyAlgo.test.ts` 的 TC-K11 用例：有符号 `>>` 与无符号 `>>>`、char 符号扩展、
  未自动截断到 uint8/uint32。

## 运行日志与排查

后端日志同时写入终端与文件：`~/.doip-console/logs/backend-YYYYMMDD.log`（单文件 16 MiB，保号续写，保留最近 14 个）。
界面底部状态栏「日志」可查看尾部、只看警告/错误、自动刷新，并可打开日志目录。关闭文件日志：`DOIP_LOG_FILE=0`。

### 连接仿真 ECU 报「目标主动拒绝 TCP 连接」

`ECONNREFUSED` 表示目标端口无监听。仿真模式下点「连接」会自动启动仿真并取得实际端口后连接，通常只需点击一次。
若仍失败，日志会给出结论：

| 日志中的 diagnosis | 含义 / 处理 |
| --- | --- |
| `仿真 ECU 尚未启动：请先在左侧点【启动仿真 ECU】，再点【连接】` | 自动启动失败时出现；手动点击面板顶部的「启动」 |
| `端口不一致：界面目标端口 13401，但仿真 ECU 实际监听 13402` | 上一次仿真仍占用 13401，本次顺延；将目标端口改为日志给出的端口 |
| `目标未在该地址/端口监听：请确认 ECU 的 DoIP 服务已启动、IP 与端口正确` | 真实 ECU：检查 IP/端口、ECU 上电状态与 DoIP 服务 |
| `连接超时：目标可能不在同一网段、被防火墙拦截` | 网络层问题，与 DoIP 无关 |

## 许可

- **代码**：[Apache License 2.0](LICENSE)
- **版权**：Copyright 2026 Xerneas2017
- **商标**：Apache-2.0 不授予商标许可。项目名称与 Logo 归作者所有，衍生项目不得使用其名称或 Logo 暗示官方背书。
- **第三方依赖**：各自遵循原许可（React、MUI、zod、ws、pino、Vite 等均为 MIT / Apache-2.0）。
- **贡献**：提交 Pull Request 即表示同意按 Apache-2.0 授权该贡献（inbound = outbound）。
