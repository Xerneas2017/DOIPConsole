# DoIP 诊断控制台

ISO 13400-2（DoIP）/ ISO 14229-1（UDS）诊断控制台。monorepo：`shared` / `server` / `web`。

## 快速开始

**方式一：一条命令（推荐）—— 后端单端口同时提供界面与 API**

```bash
npm install
npm start        # = 构建前端 + 启动后端，然后浏览器打开 http://127.0.0.1:8787
```

或用脚本（会自动帮你打开浏览器）：

```bash
bash scripts/start.sh              # 构建 + 启动
bash scripts/start.sh --no-build   # 跳过构建，直接用已有 web/dist
```

只需要**一个进程、一个地址** `http://127.0.0.1:8787`。端口被占用会自动顺延，以终端输出的实际地址为准。

**方式二：开发模式（改前端代码时用）**

```bash
node --import tsx server/src/index.ts   # 终端 1：后端（8787）
npm run dev                             # 终端 2：Vite dev（5273，已代理 /api 与 /ws）
```

两个命令**必须在两个终端里分别运行**——`node ...` 是前台常驻进程，写在同一行会导致后面那条永远不执行。界面地址是 `http://127.0.0.1:5273`。

## 门禁（CI / 本地同一套）

| 命令 | 作用 |
| --- | --- |
| `npm run typecheck` | 全工作区 `tsc --noEmit`，必须 0 错误 |
| `npm run check:timeouts` | **超时/上限硬编码守卫**（Q3）：所有超时集中在 `shared/src/protocol/constants.ts`，扫描 `.ts` / `.tsx`，命中即退出码 1 |
| `npm test` | server + web 全量单测 |
| `npm run smoke` | `scripts/smoke.mjs` 端到端冒烟（真实 TCP/UDP socket），任一条 FAIL 即退出码 1 |
| `npm run verify` | 以上四步串起来跑 |

### 门禁自检钩子（证明守卫"能失败"）

一个永远不会失败的守卫等于没有守卫。冒烟脚本内置两个自检钩子：

```bash
DOIP_SMOKE_FORCE_FAIL=1 npm run smoke   # 人为注入一条 FAIL → 必须 exit 1（验证 FAIL→非 0 的传递链）
DOIP_SMOKE_LEAK_PROBE=1 npm run smoke   # 故意泄漏一个 timer → 句柄守卫必须抓到并 exit 1
```

`check:timeouts` 同样可自检：在任意 `.tsx` 里写 `setTimeout(..., 9999)` 再跑，应报出文件名+行号并 exit 1。

### 句柄守卫用"基线比对"，不是"必须为空"

进程固有持有 stdin/stdout/stderr（表现为 2 个 `PipeWrap`），所以收尾时断言"活动资源为空"必然误报。
脚本在**启动时**采集一次句柄类型计数作为基线，收尾静默后只允许"新增"，新增必须为 0。

## 目录

- `shared/` 协议常量、码表、类型、WS 契约（前后端唯一真源）
- `server/` DoIP 客户端、事务管理、会话状态机、TraceStore、滚动落盘、WS 桥接、UDS 服务库与 Key 算法
- `web/` React + MUI 前端，五分区（A 连接 / B 请求 / C Trace / D 详情 / E 状态栏）
- `data/` `uds-library.json`（内置服务库，带 `builtin` 标记）、`key-algo-vectors.json`（算法校准向量）

## 硬约束

- **Q1** 禁止自动重连/自动重发：失败只回 NRC 与处置建议，由用户决定。
- **Q3** 所有超时/上限集中在 `shared/src/protocol/constants.ts`。
- **Q11** 后端 HTTP/WS 只绑 `127.0.0.1`（硬编码，不可配置）。
- `seq` 由 `EventBus` 单点分配且全局单调；任何丢弃区间必须发 `trace.gap`，error/status 类事件永不丢弃。
- `RollingFileSink` 是 `EventBus` 的**平级订阅者**，不消费 `BatchFlusher` 输出 —— WS 背压降级不影响落盘。

## 互操作性验证（第三方标准库）

自证的测试（smoke、以及自己写的客户端）只能证明"自己跟自己聊得来"。用**照 ISO 13400 标准实现的第三方库**再验一遍，才能证明仿真 ECU 在字节级和流程上真的合规。

```bash
npm start          # 另开终端
npm run sim:up     # 启动仿真 ECU（不用开浏览器）
npm run interop    # 用 python-doipclient 跑 11 项互操作检查
```

依赖：`pip install doipclient`（已装在受管 venv：`~/.workbuddy/binaries/python/envs/default`）。

**当前结果：11/11 通过** —— TCP+路由激活、UDP 车辆识别、`10/22/19/3E/27/11` 六类 UDS 服务（含 VIN 明文比对）、NRC `0x31` 负例、Alive Check `0x0007→0x0008`、实体状态 `0x4001→0x4002`。

### 这个过程抓到的三个真问题（两个是我们的，一个是库的）

| # | 问题 | 归属 | 修法 |
|---|---|---|---|
| 1 | 路由激活请求长度被硬校验成 `>= 11`，而 ISO 里 **OEM 保留字段是可选的**，标准客户端只发 7 字节 → 帧被静默丢弃、激活永远超时、日志一片空白 | **我们** | `DoipPayloadCodec` 接受 7 或 11 字节；补 TC-C09 回归 |
| 2 | 仿真 UDP 只处理 `0x0001~0x0003`，**没有 `0x4001` 实体状态**；TCP 收到 `0x0007` 也没有分支 → 对方超时 | **我们** | 补两个处理分支；补 TC-S07 回归 |
| 3 | `python-doipclient` 的 `send_diagnostic_to_address()` 读到 `0x8002` 正 ACK 就 `return`，**不等随后那条真正的 UDS 响应**（源码 `client.py:769-774`） | **对方** | 不修（发 ACK 符合 ISO）；互操作脚本用 `receive_diagnostic()` 补读绕开 |

**顺带修的诊断性问题**：仿真侧"收到帧但处理不了"原本是 `debug` 级日志，默认 `info` 下完全不可见——这正是问题 1 只能靠抓包才定位到的原因。现在改为 `warn` 并带上原始字节。**同时给这类 warn 加了排除名单**：实体自身方向的报文（公告 `0x0004`、状态响应等）会回环到自己 socket，属于正常现象，不能刷屏。

## 排查：运行日志（自我排查）

后端日志会**同时**写入终端与文件：`~/.doip-console/logs/backend-YYYYMMDD.log`（单文件 16 MiB 上限，保号续写，保留最近 14 个）。

在界面底部状态栏点 **「日志」** 即可直接查看尾部，支持「只看警告/错误」「自动刷新」，也可一键在文件管理器里打开日志目录。关闭文件日志用 `DOIP_LOG_FILE=0`。

### 常见问题：连仿真 ECU 报「目标主动拒绝 TCP 连接」

这是 `ECONNREFUSED`（目标端口上没有东西在监听）。

**现在点「连接」会自动处理**：若处于「仿真 ECU」模式且仿真还没启动，工具会**先自动启动仿真、拿到实际端口后再发起连接**（界面上会有两行 info 提示）。所以正常情况下**只需要点一次「连接」**。

如果仍然失败，日志里会给出**具体结论**而不只是一句错误码：

| 日志里的 diagnosis | 含义 / 该怎么办 |
| --- | --- |
| `仿真 ECU 尚未启动：请先在左侧点【启动仿真 ECU】，再点【连接】` | 极少见（自动启动失败时）。手动点左侧面板的「启动」，它现在在面板**最上方**，不用滚动 |
| `端口不一致：界面目标端口 13401，但仿真 ECU 实际监听 13402` | 上一次的仿真还占着 13401，本次顺延了。把目标端口改成日志里给出的那个 |
| `目标未在该地址/端口监听：请确认 ECU 的 DoIP 服务已启动、IP 与端口正确` | 真实 ECU 模式：检查 IP/端口、ECU 是否已上电并提供 DoIP 服务 |
| `连接超时：目标可能不在同一网段、被防火墙拦截` | 网络层问题，与 DoIP 无关 |

日志的每条连接尝试都会同时记下 `mode / host / port / simRunning / simPort` —— **"界面填了什么"与"仿真实际状态"必须能对上**，这样才不用猜。

> 历史坑：A 区面板内容高 781px 而可视区只有 505px，早期「仿真 ECU 控制」排在面板末尾，
> 「启动」按钮被挤出可视区（按钮 y≈762），用户看不到就直接点工具栏的「连接」，
> 于是拿到 `ECONNREFUSED` 并误以为工具坏了。现已把该块移到面板顶部 + 增加自动启动。

## ★交付说明：0x27 Key 算法当前为占位实现（待客户 源码）

**客户 源码尚未提供，当前 0x27 Seed→Key 不是客户真实算法。**

- `server/src/uds/algorithms/ported/CustomerSeedKey.ts` 是**占位 scaffold**：`origin: 'placeholder'`、`verified: false`，UI 下拉里打灰标「待替换」并**排在最后**，试算面板会提示"待替换为真实算法"。
- 仿真侧另有 `SIM_SEED_KEY_MASK = 0x5A`（`server/src/sim/simPresets.ts`），**仅仿真专用**，与客户端算法互不相干；连仿真时 UI 会自动默认选中与之匹配的「逐字节异或 0x5A」。
- 下拉排序规则：`verified` 已验证移植算法 → 未验证 → **`placeholder` 最后**；实现见 `server/src/uds/algorithms/KeyAlgorithmRegistry.ts` 的 `sortKey()`（后端下发）与 `web/src/store/useLibraryStore.ts` 的 `rank()`（前端渲染），两处口径一致。
- **接入真实算法只需两步**：
  1. 在 `server/src/uds/algorithms/ported/` 下新增一个 `PortedAlgorithmImpl`（`id` / `nameZh` / `appliesToLevels` / seed 与 key 长度约束 / 纯函数 `compute(level, seed)` / `origin: 'customer-c'`），并在 `KeyAlgorithmRegistry` 注册；
  2. 把客户已知向量填进 `data/key-algo-vectors.json`，跑 `npm test` —— `origin: 'customer-c'` 的算法**向量必须 100% 通过才算 `verified: true`**（空集不算通过）。
- 移植 C→JS 时务必对照 `server/src/__tests__/keyAlgo.test.ts` 的 TC-K11 三坑用例：**有符号 `>>` vs 无符号 `>>>`、char 符号扩展、无自动截断到 uint8/uint32**。
