#!/usr/bin/env python3
"""
互操作性交叉验证：用第三方成熟库 python-doipclient 连我们内置的仿真 ECU。

为什么要有这个脚本
------------------
我们自己的 smoke.mjs 用的是自己写的 DoipClient，属于"自证"；QA 当时用的也是手写的
原生 net/dgram 客户端。用**照 ISO 13400 标准实现的第三方库**再验一遍，才能证明我们的
仿真 ECU 在字节级和流程上真的符合标准，而不是"只跟自己的客户端聊得来"。

这个脚本第一次跑就抓到了两处问题（一处在我们的代码里，一处在库里）
------------------------------------------------------------------
**① 我们的真缺陷（已修）**：python-doipclient 的路由激活请求只发 **7 字节** payload
（`02 FD 00 05 | 00 00 00 07 | SA(2) | activationType(1) | reservedIso(4)`），
而我们把 0x0005 的长度硬校验成了 `>= 11`（多了可选的 reservedOem(4)）。
结果：对方连上 TCP 后路由激活永远超时，而我们的日志里**一片空白**
（解码返回 null → 落到 "未处理 payload" 分支 → 当时是 debug 级，info 下不可见）。

ISO 13400-2 里 OEM 保留字段是**可选**的，两种长度都必须接受。
已修：`DoipPayloadCodec` 接受 7 或 11 字节；未处理 payload 的日志改为 warn 并带原始字节。

**② python-doipclient 自身的 bug（不是我们的问题）**：它的
`send_diagnostic_to_address()` 在读到 0x8002 正 ACK 时直接 `return`，
**不再等待随后那条真正的 0x8001 UDS 响应**（源码 client.py:769-774）。
而按 ISO 13400-2，DoIP 实体**允许**先回 ACK 再回响应 —— 我们的仿真就是这么做的，
所以用这个库直连我们的仿真时，`send_diagnostic()` 会返回 None。

本脚本因此用 `receive_diagnostic()` 补读那条响应（见 `diag()` 的注释），
这样仍然把我们的 UDS 层端到端验完，而不是被库的 bug 挡住。
**结论：我们的仿真发 ACK 是符合标准的；这个库对 ACK 的处理不完整。**

用法
----
1. 起后端：`npm start`
2. 在界面点一次「连接」（仿真模式会自动拉起仿真 ECU），或先点「启动」
3. 跑本脚本：
       python3 \
         scripts/interop-python-doipclient.py [仿真端口，默认 13401]

依赖：pip install doipclient
"""

from __future__ import annotations

import sys
import traceback

from doipclient import DoIPClient

ECU_IP = "127.0.0.1"
ECU_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 13401
ECU_LOGICAL_ADDRESS = 0x1000  # 预置的第一个虚拟 ECU
CLIENT_LOGICAL_ADDRESS = 0x0E00  # Tester

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""), flush=True)


def hexs(data) -> str:
    if data is None:
        return "(无响应)"
    if isinstance(data, (bytes, bytearray)):
        return " ".join(f"{b:02X}" for b in data) if len(data) else "(空)"
    return repr(data)


def main() -> int:
    print(f"目标 {ECU_IP}:{ECU_PORT}   ECU LA=0x{ECU_LOGICAL_ADDRESS:04X}   Tester LA=0x{CLIENT_LOGICAL_ADDRESS:04X}")
    print("-" * 78)

    client = None
    try:
        client = DoIPClient(
            ECU_IP,
            ECU_LOGICAL_ADDRESS,
            tcp_port=ECU_PORT,
            udp_port=ECU_PORT,
            protocol_version=2,
            client_logical_address=CLIENT_LOGICAL_ADDRESS,
        )
        check("TCP 连接 + 路由激活 0x0005 → 0x0006 (0x10)", True, "构造器返回即激活成功")
    except Exception as exc:  # noqa: BLE001
        check("TCP 连接 + 路由激活 0x0005 → 0x0006 (0x10)", False, f"{type(exc).__name__}: {exc}")
        traceback.print_exc()
        return summarize()

    # ── UDP 车辆识别（0x0001 → 0x0004），走库自己的实现 ────────────────────
    try:
        entity = client.request_vehicle_identification()
        vin = getattr(entity, "vin", None)
        la = getattr(entity, "logical_address", None)
        eid = getattr(entity, "eid", None)
        gid = getattr(entity, "gid", None)
        detail = f"VIN={vin!r} LA={la} EID={eid} GID={gid}"
        check("UDP 车辆识别 0x0001 → 0x0004（库自行解析）", vin is not None and la is not None, detail)
    except Exception as exc:  # noqa: BLE001
        check("UDP 车辆识别 0x0001 → 0x0004（库自行解析）", False, f"{type(exc).__name__}: {exc}")

    print()

    def diag(name: str, payload: bytes, expect_prefix: bytes | None) -> bytes | None:
        """
        发一条 UDS 并取回响应。

        ★为什么要先 empty_rxqueue + 二次补读：
          python-doipclient 的 send_diagnostic_to_address() 读到 0x8002 正 ACK 就 `return`，
          不等随后的 0x8001 响应（库的 bug）。所以：
            1) 每次请求前清空 rxqueue，避免上一条的延迟响应串到下一条；
            2) send_diagnostic 返回 None 时，用 receive_diagnostic() 把真正的 UDS 响应读回来。
        """
        client.empty_rxqueue()
        try:
            resp = client.send_diagnostic(payload, timeout=2)
            if resp is None:
                resp = client.receive_diagnostic(timeout=2)
        except Exception as exc:  # noqa: BLE001
            check(name, False, f"异常 {type(exc).__name__}: {exc}")
            return None
        if resp is None:
            check(name, expect_prefix is None, "超时无响应")
            return None
        ok = True if expect_prefix is None else bytes(resp).startswith(expect_prefix)
        suffix = "" if expect_prefix is None else f"（期望前缀 {hexs(expect_prefix)}）"
        check(name, ok, f"{hexs(resp)} {suffix}".strip())
        return resp

    # ── UDS 服务（正响应）────────────────────────────────────────────────
    diag("10 03 扩展会话          → 50 03", b"\x10\x03", b"\x50\x03")
    diag("22 F190 读 VIN          → 62 F1 90", b"\x22\xF1\x90", b"\x62\xF1\x90")
    diag("19 02 读 DTC            → 59 02", b"\x19\x02", b"\x59\x02")
    diag("3E 00 TesterPresent     → 7E 00", b"\x3E\x00", b"\x7E\x00")
    diag("27 01 请求种子          → 67 01", b"\x27\x01", b"\x67\x01")
    diag("11 01 ECU 复位          → 51 01", b"\x11\x01", b"\x51\x01")

    # ── 负例：不存在的 DID 必须回 NRC 0x31 ──────────────────────────────
    diag("22 FFFF 未知 DID        → 7F 22 31", b"\x22\xFF\xFF", b"\x7F\x22\x31")

    print()

    # ── 传输层保活与实体状态 ────────────────────────────────────────────
    try:
        ok = client.request_alive_check()
        check("Alive Check 0x0007 → 0x0008", bool(ok), f"返回 {ok!r}")
    except Exception as exc:  # noqa: BLE001
        check("Alive Check 0x0007 → 0x0008", False, f"{type(exc).__name__}: {exc}")

    try:
        status = client.request_entity_status()
        check("实体状态 0x4001 → 0x4002", status is not None, f"返回 {status!r}")
    except Exception as exc:  # noqa: BLE001
        check("实体状态 0x4001 → 0x4002", False, f"{type(exc).__name__}: {exc}")

    try:
        client.close()
    except Exception:  # noqa: BLE001
        pass

    print()
    return summarize()


def summarize() -> int:
    print("=" * 78)
    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    print(f"互操作结果：{passed}/{total} 通过")
    for name, ok, detail in results:
        if not ok:
            print(f"  FAIL: {name} — {detail}")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
