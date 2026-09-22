/**
 * DoipFrame → TraceEntry（§3.11）。
 *
 * 只做"报文事实"的搬运与命名解析：
 *  - DoIP 层：版本/逆版本、payload type 中英名、SA/TA、ACK/NACK/路由激活码及其中文名、VIN/EID/GID
 *  - UDS 层：M2 尚未接入服务库解码器（T12），统一填 `emptyUdsDecodeResult()`，
 *    保证 Trace 结构稳定、导出不缺列；接入后只需替换本文件的 `decodeUds()`。
 *
 * ★本文件不做任何 seq 分配（seq 由 EventBus 统一分配，见 §3.12）。
 */

import {
  FALLBACK_ACK_CODES,
  FALLBACK_DIAGNOSTIC_MESSAGE_NACK_CODES,
  FALLBACK_GENERIC_HEADER_NACK_CODES,
  FALLBACK_NRC_TABLE,
  FALLBACK_ROUTING_ACTIVATION_CODES,
  describeCode,
  emptyUdsDecodeResult,
  formatHex,
  formatHexCompact,
  isoMicroNow,
  payloadTypeMeta,
} from '@doip/shared';
import type { CodeEntry, DoipFrame, TraceEntry, UdsDecodeResult } from '@doip/shared';
import { getLogger } from '../logging/logger';
import type { DoipSessionFrameContext } from '../session/DoipSession';
import { DoipPayloadCodec } from '../doip/DoipPayloadCodec';
import type { UdsDecoder } from '../uds/UdsDecoder';
import type { UdsLibraryStore } from '../uds/UdsLibraryStore';
import { describeWithLibrary } from '../uds/UdsRepatcher';

export interface TraceEntryBuilderDeps {
  /** T12 接入：有库才有真正的服务名/子功能名/NRC 中文解释 */
  decoder?: UdsDecoder;
  store?: UdsLibraryStore;
}

export interface TraceEntryExtras {
  transactionId?: string | null;
  linkedSeq?: number | null;
  txnRole?: TraceEntry['txnRole'];
  latencyMs?: number | null;
  gatewayForwardLatencyMs?: number | null;
  timeout?: boolean;
  errorCode?: string | null;
  errorNameZh?: string | null;
  tags?: string[];
}

export class TraceEntryBuilder {
  private readonly sessionStartMs: number;
  private readonly decoder: UdsDecoder | null;
  private readonly store: UdsLibraryStore | null;

  /**
   * @param sessionStartMs 会话起点兜底值（epoch ms），仅当 ctx 未带 `sessionStartMs` 时使用
   * @param deps T12 起的解码器与库（缺省时保持 M2 的"最基础事实"口径）
   */
  constructor(sessionStartMs: number = Date.now(), deps: TraceEntryBuilderDeps = {}) {
    this.sessionStartMs = sessionStartMs;
    this.decoder = deps.decoder ?? null;
    this.store = deps.store ?? null;
  }

  build(frame: DoipFrame, ctx: DoipSessionFrameContext, extras: TraceEntryExtras = {}): TraceEntry {
    const header = frame.header;
    const meta = payloadTypeMeta(header.payloadType);
    const decoded = DoipPayloadCodec.decode(header.payloadType, frame.payload);

    const entry: TraceEntry = {
      // ★占位：真实 seq 由 EventBus.publishTrace() 统一分配（§3.12，全局单调不断号）
      seq: 0,
      transactionId: extras.transactionId ?? null,
      ts: isoMicroNow(),
      // ★D-05：基准优先取"本次连接建立时刻"（会话层给），没有才回落到构造时的兜底值
      tsRelMs: Math.max(0, Date.now() - (ctx.sessionStartMs ?? this.sessionStartMs)),
      transport: ctx.transport,
      direction: ctx.direction,
      peer: ctx.peer,
      sessionId: ctx.sessionId,
      doip: {
        protocolVersion: header.protocolVersion,
        inverseVersionValid: header.inverseVersionValid,
        payloadType: header.payloadType,
        payloadTypeName: meta.name,
        payloadTypeNameZh: meta.nameZh,
        payloadLength: header.payloadLength,
        sourceAddress: null,
        targetAddress: null,
        sourceAddressName: null,
        targetAddressName: null,
        ackCode: null,
        ackNameZh: null,
        nackCode: null,
        nackNameZh: null,
        activationResponseCode: null,
        activationResponseCodeZh: null,
        vin: null,
        eid: null,
        gid: null,
        headerHex: formatHexCompact(frame.raw.subarray(0, 8)),
      },
      uds: this.decodeUds(
        decoded.kind === 'diagnosticMessage' ? decoded.value.userData : null,
        ctx.direction === 'TX' ? 'request' : 'response',
      ),
      linkedSeq: extras.linkedSeq ?? null,
      txnRole: extras.txnRole ?? null,
      latencyMs: extras.latencyMs ?? null,
      gatewayForwardLatencyMs: extras.gatewayForwardLatencyMs ?? null,
      timeout: extras.timeout ?? false,
      errorCode: extras.errorCode ?? null,
      errorNameZh: extras.errorNameZh ?? null,
      tags: extras.tags ?? [],
      rawHex: formatHex(frame.raw),
    };

    switch (decoded.kind) {
      case 'diagnosticMessage': {
        entry.doip.sourceAddress = decoded.value.sourceAddress;
        entry.doip.targetAddress = decoded.value.targetAddress;
        entry.doip.sourceAddressName = this.addressName(decoded.value.sourceAddress);
        entry.doip.targetAddressName = this.addressName(decoded.value.targetAddress);
        break;
      }
      case 'diagnosticMessageAck': {
        entry.doip.sourceAddress = decoded.value.sourceAddress;
        entry.doip.targetAddress = decoded.value.targetAddress;
        entry.doip.sourceAddressName = this.addressName(decoded.value.sourceAddress);
        entry.doip.targetAddressName = this.addressName(decoded.value.targetAddress);
        entry.doip.ackCode = decoded.value.ackCode;
        entry.doip.ackNameZh = this.codeNameZh('ackCodes', decoded.value.ackCode);
        entry.txnRole = 'ack';
        break;
      }
      case 'diagnosticMessageNack': {
        entry.doip.sourceAddress = decoded.value.sourceAddress;
        entry.doip.targetAddress = decoded.value.targetAddress;
        entry.doip.sourceAddressName = this.addressName(decoded.value.sourceAddress);
        entry.doip.targetAddressName = this.addressName(decoded.value.targetAddress);
        entry.doip.nackCode = decoded.value.nackCode;
        entry.doip.nackNameZh = this.codeNameZh('diagnosticMessageNackCodes', decoded.value.nackCode);
        entry.txnRole = 'nack';
        break;
      }
      case 'routingActivationResponse': {
        entry.doip.sourceAddress = decoded.value.testerLogicalAddress;
        entry.doip.targetAddress = decoded.value.doipEntityLogicalAddress;
        entry.doip.sourceAddressName = this.addressName(decoded.value.testerLogicalAddress);
        entry.doip.targetAddressName = this.addressName(decoded.value.doipEntityLogicalAddress);
        entry.doip.activationResponseCode = decoded.value.routingActivationResponseCode;
        entry.doip.activationResponseCodeZh = this.codeNameZh(
          'routingActivationCodes',
          decoded.value.routingActivationResponseCode,
        );
        break;
      }
      case 'routingActivationRequest': {
        entry.doip.sourceAddress = decoded.value.sourceAddress;
        entry.doip.sourceAddressName = this.addressName(decoded.value.sourceAddress);
        break;
      }
      case 'aliveCheckResponse': {
        entry.doip.sourceAddress = decoded.value.sourceAddress;
        entry.doip.sourceAddressName = this.addressName(decoded.value.sourceAddress);
        break;
      }
      case 'vehicleAnnouncement': {
        entry.doip.vin = decoded.value.vin;
        entry.doip.eid = formatHex(decoded.value.eid);
        entry.doip.gid = formatHex(decoded.value.gid);
        entry.doip.sourceAddress = decoded.value.logicalAddress;
        entry.doip.sourceAddressName = this.addressName(decoded.value.logicalAddress);
        break;
      }
      case 'genericHeaderNack': {
        entry.doip.nackCode = decoded.value.nackCode;
        entry.doip.nackNameZh = this.codeNameZh('genericHeaderNackCodes', decoded.value.nackCode);
        break;
      }
      default:
        break;
    }

    return entry;
  }

  /**
   * UDS 解码（T12 起走 `UdsDecoder` + 服务库）。
   * 没有库时退化为只填最基础事实（SID / 是否负响应 / NRC），绝不"假装解码"。
   */
  private decodeUds(userData: Uint8Array | null, role: 'request' | 'response'): UdsDecodeResult {
    if (this.decoder !== null) {
      try {
        return this.decoder.decode(userData, role);
      } catch (err) {
        // ★解码器永不抛异常；万一抛了也必须保住流水线
        this.logDecodeError(err);
      }
    }
    const result = emptyUdsDecodeResult();
    if (userData === null || userData.length === 0) return result;
    const first = userData[0] ?? 0;
    if (first === 0x7f) {
      result.decoded = true;
      result.messageKind = 'negative';
      result.serviceId = userData[1] ?? null;
      result.nrc = userData[2] ?? null;
      return result;
    }
    result.decoded = true;
    result.serviceId = first;
    result.isPositive = first > 0x40;
    result.messageKind = first > 0x40 ? 'positive' : 'request';
    result.subFunction = userData.length > 1 ? (userData[1] ?? null) : null;
    this.fillNrcFallback(result);
    return result;
  }

  private fillNrcFallback(result: UdsDecodeResult): void {
    if (result.nrc === null) return;
    const table = this.store?.nrcTable() ?? [];
    const desc = describeCode(table.length > 0 ? table : FALLBACK_NRC_TABLE, result.nrc);
    result.nrcName = desc.name;
    result.nrcNameZh = desc.nameZh;
    result.nrcHint = desc.hint;
  }

  private logDecodeError(err: unknown): void {
    getLogger('trace.builder').error('UDS 解码器异常，已回退基础解码', {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  /** ★Q2：码表优先取库文件，库为空才回落内置常量 */
  private codeNameZh(table: 'ackCodes' | 'diagnosticMessageNackCodes' | 'genericHeaderNackCodes' | 'routingActivationCodes', code: number): string {
    const fromLibrary = this.store === null ? [] : this.store.doipTable(table);
    const fallback = TraceEntryBuilder.fallbackOf(table);
    return describeWithLibrary(fromLibrary, fallback, code) ?? `未知码(0x${code.toString(16).toUpperCase()})`;
  }

  private static fallbackOf(table: string): readonly CodeEntry[] {
    switch (table) {
      case 'ackCodes':
        return FALLBACK_ACK_CODES;
      case 'diagnosticMessageNackCodes':
        return FALLBACK_DIAGNOSTIC_MESSAGE_NACK_CODES;
      case 'genericHeaderNackCodes':
        return FALLBACK_GENERIC_HEADER_NACK_CODES;
      default:
        return FALLBACK_ROUTING_ACTIVATION_CODES;
    }
  }

  /** 逻辑地址显示：优先别名（库可配置） */
  private addressName(address: number): string {
    const hex = `0x${(address & 0xffff).toString(16).toUpperCase().padStart(4, '0')}`;
    const alias = this.store?.aliasOf(address) ?? null;
    return alias === null ? hex : `${hex} ${alias}`;
  }
}
