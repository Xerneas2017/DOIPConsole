/**
 * ★难点 2 单测：TransactionManager 六个分支 A~F（§9.1 TC-T01 ~ TC-T09）。
 *
 * 断言的都是**协议行为**：两种超时必须严格区分、NRC 0x78 转 P2*、
 * 功能寻址聚合、抑制正响应不误报超时、断开后无悬挂 timer。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransactionManager } from '../txn/TransactionManager';
import type { TxnEvent, TxnSender } from '../txn/TransactionManager';
import {
  FALLBACK_DIAGNOSTIC_MESSAGE_NACK_CODES,
  describeCode,
  parseHex,
} from '@doip/shared';
import type {
  DiagnosticMessageAckPayload,
  DiagnosticMessageNackPayload,
  DiagnosticMessagePayload,
  SendUdsRequest,
  SendUdsResult,
} from '@doip/shared';
import { TIMING } from '@doip/shared';

const SA = 0x0e00;
const TA = 0x1000;

class FakeSender implements TxnSender {
  readonly sent: Array<{ sa: number; ta: number; userData: Uint8Array }> = [];

  sendDiagnosticMessage(sa: number, ta: number, userData: Uint8Array): void {
    this.sent.push({ sa, ta, userData: Uint8Array.from(userData) });
  }

  last(): { sa: number; ta: number; userData: Uint8Array } {
    const last = this.sent[this.sent.length - 1];
    if (last === undefined) throw new Error('没有发出任何报文');
    return last;
  }
}

function ack(sa = TA, ta = SA, previous = parseHex('1003'), ackCode = 0x00): DiagnosticMessageAckPayload {
  return { sourceAddress: sa, targetAddress: ta, ackCode, previousMessage: previous };
}

function nack(sa = TA, ta = SA, code = 0x01, previous = parseHex('1003')): DiagnosticMessageNackPayload {
  return { sourceAddress: sa, targetAddress: ta, nackCode: code, previousMessage: previous };
}

function diag(sa: number, ta: number, hex: string): DiagnosticMessagePayload {
  return { sourceAddress: sa, targetAddress: ta, userData: parseHex(hex) };
}

interface Ctx {
  sender: FakeSender;
  txns: TransactionManager;
  events: TxnEvent[];
}

function setup(addressing: 'physical' | 'functional' = 'physical'): Ctx {
  const sender = new FakeSender();
  const events: TxnEvent[] = [];
  const txns = new TransactionManager({
    sender,
    sa: SA,
    ta: TA,
    now: () => Date.now(),
    onEvent: (e) => events.push(e),
  });
  void addressing;
  return { sender, txns, events };
}

function req(overrides: Partial<SendUdsRequest> = {}): SendUdsRequest {
  return { addressing: 'physical', sid: '0x10', subFunction: '0x03', ...overrides };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('TC-T01 分支 A：正常三方完成', () => {
  it('0x8001 → 0x8002 → 0x8001 正响应，COMPLETED 且记录两种延迟', async () => {
    const { sender, txns } = setup();
    const p = txns.send(req());
    await Promise.resolve();

    expect(Array.from(sender.last().userData)).toEqual([0x10, 0x03]);
    expect(sender.last().sa).toBe(SA);
    expect(sender.last().ta).toBe(TA);

    txns.onDiagnosticMessageAck(ack(), 2);
    const mid = txns.getTransaction('tx-0001');
    expect(mid?.state).toBe('WAITING_UDS_RESPONSE');
    expect(mid?.gatewayForwardLatencyMs).not.toBeNull();

    txns.onDiagnosticMessage(diag(TA, SA, '5003003201F4'), 3);
    const r: SendUdsResult = await p;

    expect(r.ok).toBe(true);
    expect(r.state).toBe('COMPLETED');
    expect(r.responseHex).toBe('50 03 00 32 01 F4');
    expect(r.latencyMs).not.toBeNull();
    expect(r.gatewayForwardLatencyMs).not.toBeNull();
    expect(txns.pendingTransactions()).toHaveLength(0);
  });
});

describe('TC-T02 分支 B：网关拒绝转发（0x8003 NACK）', () => {
  it('FAILED_NACK，note 含"网关未转发（非 UDS 层错误）"，且不查 NRC 表', async () => {
    const { txns } = setup();
    const p = txns.send(req());
    await Promise.resolve();

    txns.onDiagnosticMessageNack(nack(TA, SA, 0x01), 2);
    const r = await p;

    expect(r.ok).toBe(false);
    expect(r.state).toBe('FAILED_NACK');
    expect(r.errorCode).toBe('E_TXN_NACK');
    expect(r.nackCode).toBe(0x01);
    expect(r.note).toContain('网关未转发（非 UDS 层错误）');
    const desc = describeCode(FALLBACK_DIAGNOSTIC_MESSAGE_NACK_CODES, 0x01);
    expect(r.note).toContain(desc.nameZh);
    expect(r.nrc).toBeUndefined(); // ★不查 NRC 表
  });
});

describe('TC-T03 分支 C：ACK 超时（网关没收下）', () => {
  it('FAILED_ACK_TIMEOUT，文案与 UDS 超时不同', async () => {
    const { txns } = setup();
    const p = txns.send(req());
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(TIMING.ACK_WAIT_TIMEOUT_MS + 10);
    const r = await p;

    expect(r.ok).toBe(false);
    expect(r.state).toBe('FAILED_ACK_TIMEOUT');
    expect(r.errorCode).toBe('E_TXN_ACK_TIMEOUT');
    expect(r.note).toContain('网关未在');
    expect(r.note).toContain('请求可能未进入网关');
    expect(r.note).not.toContain('已收下并转发'); // ★严格区分
    expect(r.gatewayForwardLatencyMs).toBeUndefined();
  });
});

describe('TC-T04 分支 D：已 ACK 但 UDS 响应超时', () => {
  it('FAILED_UDS_TIMEOUT，文案明确"网关已收下并转发"', async () => {
    const { txns } = setup();
    const p = txns.send(req());
    await Promise.resolve();

    txns.onDiagnosticMessageAck(ack(), 2);
    await vi.advanceTimersByTimeAsync(TIMING.P2_CLIENT_MS + 10);
    const r = await p;

    expect(r.ok).toBe(false);
    expect(r.state).toBe('FAILED_UDS_TIMEOUT');
    expect(r.errorCode).toBe('E_TXN_UDS_TIMEOUT');
    expect(r.note).toContain('网关已收下并转发');
    expect(r.note).toContain('ECU 在');
    expect(r.gatewayForwardLatencyMs).not.toBeNull(); // ★网关确实收下了
    expect(r.note).not.toContain('请求可能未进入网关');
  });
});

describe('TC-T05 分支 E：NRC 0x78 pending → P2* 续等', () => {
  it('P2* 内收到最终响应 → COMPLETED', async () => {
    const { txns } = setup();
    const p = txns.send(req());
    await Promise.resolve();

    txns.onDiagnosticMessageAck(ack(), 2);
    txns.onDiagnosticMessage(diag(TA, SA, '7F1078'), 3);
    expect(txns.getTransaction('tx-0001')?.state).toBe('WAITING_PENDING');

    await vi.advanceTimersByTimeAsync(1000);
    txns.onDiagnosticMessage(diag(TA, SA, '5003003201F4'), 4);
    const r = await p;

    expect(r.state).toBe('COMPLETED');
    expect(r.ok).toBe(true);
  });

  it('P2* 超时 → FAILED_UDS_TIMEOUT（提示延长 P2*）', async () => {
    const { txns } = setup();
    const p = txns.send(req());
    await Promise.resolve();

    txns.onDiagnosticMessageAck(ack(), 2);
    txns.onDiagnosticMessage(diag(TA, SA, '7F1078'), 3);
    await vi.advanceTimersByTimeAsync(TIMING.P2_STAR_CLIENT_MS + 10);
    const r = await p;

    expect(r.state).toBe('FAILED_UDS_TIMEOUT');
    expect(r.note).toContain('P2*');
  });

  it('非 0x78 的 NRC 直接终结事务（COMPLETED + nrc）', async () => {
    const { txns } = setup();
    const p = txns.send(req());
    await Promise.resolve();

    txns.onDiagnosticMessageAck(ack(), 2);
    txns.onDiagnosticMessage(diag(TA, SA, '7F1022'), 3);
    const r = await p;

    expect(r.state).toBe('COMPLETED');
    expect(r.ok).toBe(false);
    expect(r.nrc).toBe(0x22);
    expect(r.nrcNameZh).toBeTruthy();
  });
});

describe('TC-T06 分支 F：抑制正响应（3E 80）', () => {
  it('收到 ACK 后进入 SUPPRESSED，观察窗结束静默完成，不报超时', async () => {
    const { sender, txns } = setup();
    const p = txns.send({ addressing: 'physical', rawHex: '3E80' });
    await Promise.resolve();
    expect(Array.from(sender.last().userData)).toEqual([0x3e, 0x80]);

    txns.onDiagnosticMessageAck(ack(TA, SA, parseHex('3E80')), 2);
    expect(txns.getTransaction('tx-0001')?.state).toBe('SUPPRESSED');

    await vi.advanceTimersByTimeAsync(TIMING.SUPPRESSED_NRC_WINDOW_MS + 10);
    const r = await p;

    expect(r.state).toBe('SUPPRESSED');
    expect(r.ok).toBe(true);
    expect(r.errorCode).toBeUndefined(); // ★不误报超时
  });

  it('观察窗内收到 NRC 会被记录', async () => {
    const { txns } = setup();
    const p = txns.send({ addressing: 'physical', rawHex: '3E80' });
    await Promise.resolve();
    txns.onDiagnosticMessageAck(ack(TA, SA, parseHex('3E80')), 2);
    txns.onDiagnosticMessage(diag(TA, SA, '7F3E13'), 3);
    const r = await p;
    expect(r.nrc).toBe(0x13);
  });
});

describe('TC-T07 功能寻址聚合', () => {
  it('窗口内多响应按 SA 分组，窗口结束汇总', async () => {
    const { txns } = setup('functional');
    const p = txns.send({ addressing: 'functional', sid: '0x22', dids: ['0xF190'] });
    await Promise.resolve();

    txns.onDiagnosticMessageAck(ack(TA, SA, parseHex('22F190')), 2);
    txns.onDiagnosticMessage(diag(0x1000, SA, '62F1904C53'), 3);
    txns.onDiagnosticMessage(diag(0x1010, SA, '62F1904D54'), 4);
    txns.onDiagnosticMessage(diag(0x1020, SA, '7F2231'), 5);

    // 窗口未结束时不应终态
    expect(txns.getTransaction('tx-0001')?.state).toBe('WAITING_UDS_RESPONSE');

    await vi.advanceTimersByTimeAsync(TIMING.FUNCTIONAL_AGGREGATION_WINDOW_MS + 10);
    const r = await p;

    expect(r.state).toBe('COMPLETED');
    expect(r.functionalResponses).toHaveLength(3);
    expect(r.functionalResponses?.map((x) => x.sa)).toEqual([0x1000, 0x1010, 0x1020]);
    expect(r.functionalResponses?.[2]?.nrc).toBe(0x31);
    expect(r.note).toContain('功能寻址聚合完成');
  });

  it('窗口内 0 条响应 → FAILED_UDS_TIMEOUT（而非 ACK 超时）', async () => {
    const { txns } = setup('functional');
    const p = txns.send({ addressing: 'functional', sid: '0x22', dids: ['0xF190'] });
    await Promise.resolve();
    txns.onDiagnosticMessageAck(ack(TA, SA, parseHex('22F190')), 2);

    await vi.advanceTimersByTimeAsync(TIMING.FUNCTIONAL_AGGREGATION_WINDOW_MS + 10);
    const r = await p;
    expect(r.state).toBe('FAILED_UDS_TIMEOUT');
  });

  /**
   * ★QA 终验缺陷 1 的回归闸门。
   *
   * 单测里 `new TransactionManager({ ta: TA })` 的 TA 恰好是物理地址（0x1000），
   * 而旧实现"发帧固定用 `this.ta`"，于是历史上"functional 却发了 0x1000"也没被抓到 ——
   * 因为更早的用例根本没断言实际发出的 TA。真实链路里 `ta` 由 `connect()` 覆盖成物理地址，
   * 功能寻址就永远发不出去（仿真侧只回一条，没有多 ECU 聚合）。
   * 这里直接断言 `sender.sent[0].ta === 0x1FFF`，且物理寻址仍用 0x1000。
   */
  it('★功能寻址必须真的发到 0x1FFF（ta 为物理地址时亦然）', async () => {
    const { sender, txns } = setup();
    void txns.send({ addressing: 'functional', sid: '0x3e', subFunction: '0x00' });
    await Promise.resolve();
    expect(sender.sent).toHaveLength(1);
    expect(sender.last().ta).toBe(0x1fff);
    expect(sender.last().sa).toBe(SA);
    // 事务记录里的 TA 也要是实际发出的那个，否则 Trace 对不上
    expect(txns.getTransaction('tx-0001')?.ta).toBe(0x1fff);
    vi.clearAllTimers();
  });

  it('★物理寻址仍发配置的物理 TA（不被功能寻址逻辑污染）', async () => {
    const { sender, txns } = setup();
    void txns.send({ addressing: 'physical', sid: '0x10', subFunction: '0x03' });
    await Promise.resolve();
    expect(sender.last().ta).toBe(TA);
    expect(txns.getTransaction('tx-0001')?.ta).toBe(TA);
    vi.clearAllTimers();
  });
});

describe('TC-T08 配对健壮性', () => {
  it('previousMessage 截断时仍按 FIFO 配对，但记 warn', async () => {
    const { txns } = setup();
    const events: TxnEvent[] = [];
    const p = txns.send(req());
    await Promise.resolve();
    void events;

    // 网关回显被截断成 2 字节且与请求不符
    txns.onDiagnosticMessageAck(ack(TA, SA, parseHex('FFFF')), 2);
    const txn = txns.getTransaction('tx-0001');
    expect(txn?.warnCodes).toContain('E_TXN_ACK_PREVIOUS_MISMATCH');
    expect(txn?.state).toBe('WAITING_UDS_RESPONSE');

    txns.onDiagnosticMessage(diag(TA, SA, '5003'), 3);
    const r = await p;
    expect(r.state).toBe('COMPLETED');
  });

  it('无主响应 → 记为 unsolicited 事件', () => {
    const { txns, events } = setup();
    txns.onDiagnosticMessage(diag(TA, SA, '62F19001'), 9);
    const unsolicited = events.find((e) => e.kind === 'unsolicited');
    expect(unsolicited).toBeDefined();
  });

  it('非法迁移被拦截：终态后不得再迁移', async () => {
    const { txns } = setup();
    const p = txns.send(req());
    await Promise.resolve();
    txns.onDiagnosticMessageAck(ack(), 2);
    txns.onDiagnosticMessage(diag(TA, SA, '5003'), 3);
    const r = await p;
    expect(r.state).toBe('COMPLETED');

    // 再喂一条响应，状态不得回到等待态
    txns.onDiagnosticMessage(diag(TA, SA, '5003'), 4);
    expect(txns.getTransaction('tx-0001')?.state).toBe('COMPLETED');
  });
});

describe('TC-T09 连接断开与资源释放', () => {
  it('onSessionClosed 把所有非终态事务置 CANCELLED，且无悬挂 timer', async () => {
    const { txns } = setup();
    const p1 = txns.send(req());
    await Promise.resolve();
    const p2 = txns.send(req({ sid: '0x22', subFunction: undefined, dids: ['0xF190'] }));
    await Promise.resolve();

    txns.onSessionClosed('test');
    const r1 = await p1;
    const r2 = await p2;

    expect(r1.state).toBe('CANCELLED');
    expect(r2.state).toBe('CANCELLED');
    expect(r1.errorCode).toBe('E_TXN_CANCELLED');
    expect(r2.note).toContain('连接断开');
    expect(vi.getTimerCount()).toBe(0); // ★无悬挂 timer
    expect(txns.pendingTransactions()).toHaveLength(0);
  });

  it('dispose 后不残留 timer', async () => {
    const { txns } = setup();
    const p = txns.send(req());
    await Promise.resolve();
    txns.dispose();
    await p;
    expect(vi.getTimerCount()).toBe(0);
  });
});
