/**
 * ★难点 1：TCP 流式分帧状态机（§3.3）。
 *
 * 单块可增长 Buffer + 读游标的实现（O(1) 摊还，避免 O(n^2) 拼接）。
 * 不变量：0 <= off <= len <= buf.length
 *
 * 三层守卫：
 *   ① payloadLength 上界（单帧）
 *   ② 缓冲区增长上界（累积）
 *   ③ 分帧超时（半包卡死）
 * ★每帧 raw 必须深拷贝 —— Buffer 是内存视图，不拷贝就会被后续压实/覆写串数据。
 */

import { LIMITS, isInverseVersionValid, nowMonoMs, dumpHex } from '@doip/shared';
import type { DoipFrame } from '@doip/shared';
import { DOIP_HEADER_LENGTH } from '@doip/shared';
import { isKnownPayloadType } from '@doip/shared';
import { getLogger } from '../logging/logger';

export type FrameReaderErrorCode =
  | 'E_DOIP_INVERSE_VERSION_INVALID'
  | 'E_DOIP_PAYLOAD_TOO_LARGE'
  | 'E_DOIP_BUFFER_OVERFLOW'
  | 'E_DOIP_INCOMPLETE_FRAME_TIMEOUT';

export interface FrameReaderError {
  code: FrameReaderErrorCode;
  messageZh: string;
  /** false = 字节流已失同步，必须断开连接（上层负责 close） */
  recoverable: boolean;
  /** 出错时缓冲区前 256 字节的 hex，便于定位 */
  dumpHex: string;
}

export interface FrameReaderOptions {
  /** LIMITS.MAX_PAYLOAD_BYTES */
  maxPayloadBytes: number;
  /** LIMITS.MAX_FRAME_READER_BUFFER_BYTES */
  maxBufferBytes: number;
  /** TIMING.FRAME_ASSEMBLY_TIMEOUT_MS */
  incompleteFrameTimeoutMs: number;
  /** strict: inverse 校验失败即判失同步；lenient: 仅标记并继续（默认） */
  versionPolicy: 'strict' | 'lenient';
  /** 失同步后是否尝试字节级重同步扫描（默认 false = 直接报错由上层关连接） */
  resyncOnDesync: boolean;
  onFrame: (frame: DoipFrame) => void;
  onError: (e: FrameReaderError) => void;
}

type ParseResult =
  | { kind: 'needMore' }
  | { kind: 'frame'; frame: DoipFrame }
  | { kind: 'error'; code: FrameReaderErrorCode; messageZh: string; recoverable: boolean };

export class DoipFrameReader {
  private buf: Buffer;
  private len = 0;
  private off = 0;
  private firstByteAtMs = 0;
  /** 不可恢复错误后停止解析，等待上层 reset / 关连接 */
  private halted = false;

  constructor(private readonly opts: FrameReaderOptions) {
    const initial = Math.min(LIMITS.FRAME_READER_INITIAL_BUFFER_BYTES, Math.max(opts.maxBufferBytes, 64));
    this.buf = Buffer.allocUnsafe(initial);
  }

  /** socket 'data' 回调直接转发；同步产出 frame / error */
  push(chunk: Buffer): void {
    if (this.halted || chunk.length === 0) return;
    if (this.len - this.off === 0) {
      this.firstByteAtMs = nowMonoMs();
    }
    if (!this.ensureCapacity(chunk.length)) return; // 已上报 BUFFER_OVERFLOW
    chunk.copy(this.buf, this.len);
    this.len += chunk.length;
    this.drain();
  }

  /** 由外层定时器（TIMING.FRAME_READER_TICK_MS）调用，处理"半包卡死" */
  tick(): void {
    if (this.halted) return;
    const pending = this.len - this.off;
    if (pending <= 0) return;
    if (nowMonoMs() - this.firstByteAtMs > this.opts.incompleteFrameTimeoutMs) {
      this.fail(
        'E_DOIP_INCOMPLETE_FRAME_TIMEOUT',
        `TCP 字节流中出现不完整 DoIP 帧且 ${this.opts.incompleteFrameTimeoutMs}ms 内未完成（已收 ${pending} 字节）`,
        false,
      );
    }
  }

  /** 复位（连接复用 / 重同步成功后调用） */
  reset(): void {
    this.len = 0;
    this.off = 0;
    this.firstByteAtMs = 0;
    this.halted = false;
  }

  /** 当前未消费字节数（诊断与测试用） */
  pendingBytes(): number {
    return this.len - this.off;
  }

  /** 是否已因不可恢复错误停止 */
  isHalted(): boolean {
    return this.halted;
  }

  /* ─────────────── 内部实现 ─────────────── */

  private drain(): void {
    for (;;) {
      if (this.halted) return;
      const r = this.tryParseOne();
      if (r.kind === 'needMore') return;
      if (r.kind === 'error') {
        if (this.opts.resyncOnDesync && this.tryResync()) continue;
        this.fail(r.code, r.messageZh, r.recoverable);
        return;
      }
      this.opts.onFrame(r.frame);
      // 刚好消费完 → 复位，避免残留空区间影响 firstByteAtMs 判定
      if (this.off >= this.len) {
        this.reset();
        return;
      }
    }
  }

  private tryParseOne(): ParseResult {
    const avail = this.len - this.off;
    if (avail < DOIP_HEADER_LENGTH) return { kind: 'needMore' }; // ① 半包：头都不全

    const pv = this.buf.readUInt8(this.off);
    const ipv = this.buf.readUInt8(this.off + 1);
    const payloadType = this.buf.readUInt16BE(this.off + 2);
    const payloadLength = this.buf.readUInt32BE(this.off + 4);

    // ② inverse 校验：lenient 下仅打标，不阻断解析（★B12）
    const inverseVersionValid = isInverseVersionValid(pv, ipv);
    if (!inverseVersionValid && this.opts.versionPolicy === 'strict') {
      return {
        kind: 'error',
        code: 'E_DOIP_INVERSE_VERSION_INVALID',
        messageZh: `协议版本校验失败(0x${pv.toString(16)}/0x${ipv.toString(16)})，字节流可能已失同步`,
        recoverable: false,
      };
    }

    // ③ payloadLength 合法性：先判上界再谈内存（readUInt32BE 为无符号，不会溢出为负）
    if (payloadLength > this.opts.maxPayloadBytes) {
      return {
        kind: 'error',
        code: 'E_DOIP_PAYLOAD_TOO_LARGE',
        messageZh: `payloadLength=${payloadLength} 超过上限 ${this.opts.maxPayloadBytes}，疑似失同步`,
        recoverable: false,
      };
    }

    const total = DOIP_HEADER_LENGTH + payloadLength;
    if (avail < total) {
      // 半包：等更多字节，但缓冲区不得无限增长
      if (this.len > this.opts.maxBufferBytes) {
        return {
          kind: 'error',
          code: 'E_DOIP_BUFFER_OVERFLOW',
          messageZh: `分帧缓冲已 ${this.len} 字节，超过上界 ${this.opts.maxBufferBytes} 仍未凑齐一帧`,
          recoverable: false,
        };
      }
      return { kind: 'needMore' };
    }

    // ④ 完整帧：★raw 必须深拷贝（reader 缓冲会被后续压实/覆写）
    const raw = Buffer.allocUnsafe(total);
    this.buf.copy(raw, 0, this.off, this.off + total);
    const payload = raw.subarray(DOIP_HEADER_LENGTH);
    const firstByteAtMs = this.firstByteAtMs;
    this.off += total;

    // ⑤ 压实：已消费超过阈值或浪费过半 → 整体前移
    if (this.off > LIMITS.FRAME_COMPACT_THRESHOLD_BYTES || this.off * 2 > this.len) {
      this.compact();
    }

    return {
      kind: 'frame',
      frame: {
        header: {
          protocolVersion: pv,
          inverseProtocolVersion: ipv,
          payloadType,
          payloadLength,
          inverseVersionValid,
        },
        payload,
        raw,
        firstByteAtMs,
      },
    };
  }

  /** 压实：把 [off,len) 前移到 0（Buffer.copy 内部为 memmove，重叠安全） */
  private compact(): void {
    if (this.off === 0 || this.len === this.off) {
      if (this.len === this.off) {
        this.len = 0;
        this.off = 0;
      }
      return;
    }
    const pending = this.len - this.off;
    this.buf.copy(this.buf, 0, this.off, this.len);
    this.len = pending;
    this.off = 0;
  }

  /** 增长缓冲；返回 false 表示已上报 BUFFER_OVERFLOW 且本帧应丢弃 */
  private ensureCapacity(additional: number): boolean {
    if (this.len + additional <= this.buf.length) return true;

    // 先尝试压实腾出尾部空间
    this.compact();
    if (this.len + additional <= this.buf.length) return true;

    const needed = this.len + additional;
    if (needed > this.opts.maxBufferBytes) {
      this.fail(
        'E_DOIP_BUFFER_OVERFLOW',
        `分帧缓冲需要 ${needed} 字节，超过上界 ${this.opts.maxBufferBytes}`,
        false,
      );
      return false;
    }
    let cap = this.buf.length > 0 ? this.buf.length : 64;
    while (cap < needed) cap *= 2;
    if (cap > this.opts.maxBufferBytes) cap = this.opts.maxBufferBytes;
    const next = Buffer.allocUnsafe(cap);
    this.buf.copy(next, 0, this.off, this.len);
    this.len = this.len - this.off;
    this.off = 0;
    this.buf = next;
    return true;
  }

  /**
   * 字节级重同步扫描（仅在 resyncOnDesync=true 时启用；默认关闭，
   * 因为它有可能把垃圾字节误判成"看似正常的帧"）。
   */
  private tryResync(): boolean {
    const end = this.len - DOIP_HEADER_LENGTH;
    for (let i = this.off + 1; i <= end; i += 1) {
      const pv = this.buf.readUInt8(i);
      const ipv = this.buf.readUInt8(i + 1);
      if (!isInverseVersionValid(pv, ipv)) continue;
      const payloadType = this.buf.readUInt16BE(i + 2);
      if (!isKnownPayloadType(payloadType)) continue;
      const payloadLength = this.buf.readUInt32BE(i + 4);
      if (payloadLength > this.opts.maxPayloadBytes) continue;
      const total = DOIP_HEADER_LENGTH + payloadLength;
      if (i + total > this.len) continue;
      // 命中：丢弃 [off, i) 的垃圾字节
      getLogger('doip.frame').warn('分帧重同步：丢弃疑似垃圾字节', {
        droppedBytes: i - this.off,
        payloadType: `0x${payloadType.toString(16)}`,
      });
      this.off = i;
      this.firstByteAtMs = nowMonoMs();
      return true;
    }
    return false;
  }

  private fail(code: FrameReaderErrorCode, messageZh: string, recoverable: boolean): void {
    const start = this.off;
    const stop = Math.min(this.len, start + LIMITS.FRAME_ERROR_DUMP_BYTES);
    const dump = dumpHex(this.buf.subarray(start, stop));
    getLogger('doip.frame').warn('DoIP 分帧失败', { code, messageZh, recoverable, pending: this.len - this.off });
    if (!recoverable) {
      this.reset();
      this.halted = true;
    }
    this.opts.onError({ code, messageZh, recoverable, dumpHex: dump });
  }
}
