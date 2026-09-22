/**
 * 服务库热更新后的 repatch（§3.5 / P0-10 验收 ②）。
 *
 * 改一个 DID 名称 → 下一次解码立即生效，且**最近 2000 条已产生的 Trace 被重算**，
 * 前端就地更新（推 `trace.repatched`）。
 *
 * ★repatch 只改"名字/解释"这类派生字段，绝不改 `seq / ts / rawHex` 等事实字段。
 */

import { describeCode, tryParseHex } from '@doip/shared';
import type { CodeEntry, TraceEntry } from '@doip/shared';
import {
  FALLBACK_ACK_CODES,
  FALLBACK_DIAGNOSTIC_MESSAGE_NACK_CODES,
  FALLBACK_GENERIC_HEADER_NACK_CODES,
  FALLBACK_ROUTING_ACTIVATION_CODES,
} from '@doip/shared';
import { getLogger } from '../logging/logger';
import { UdsDecoder } from './UdsDecoder';
import type { UdsLibraryStore } from './UdsLibraryStore';

const DOIP_HEADER_BYTES = 8;
const DIAGNOSTIC_MESSAGE_SA_TA_BYTES = 4;
const PAYLOAD_TYPE_DIAGNOSTIC_MESSAGE = 0x8001;

/** 从 TraceEntry 的原始报文中取出 UDS userData（0x8001 才有） */
export function extractUserData(entry: TraceEntry): Uint8Array | null {
  const bytes = tryParseHex(entry.rawHex);
  if (bytes === null || bytes.length <= DOIP_HEADER_BYTES) return null;
  if (entry.doip.payloadType !== PAYLOAD_TYPE_DIAGNOSTIC_MESSAGE) return null;
  const payload = bytes.subarray(DOIP_HEADER_BYTES);
  if (payload.length <= DIAGNOSTIC_MESSAGE_SA_TA_BYTES) return null;
  return payload.subarray(DIAGNOSTIC_MESSAGE_SA_TA_BYTES);
}

/** 用库码表（空表时回落内置常量）解析一个码的中文名 */
export function describeWithLibrary(
  table: CodeEntry[],
  fallback: readonly CodeEntry[],
  code: number | null,
): string | null {
  if (code === null) return null;
  const effective = table.length > 0 ? table : fallback;
  return describeCode(effective, code).nameZh;
}

export class UdsRepatcher {
  private readonly log = getLogger('uds.repatch');

  constructor(
    private readonly store: UdsLibraryStore,
    private readonly decoder: UdsDecoder,
  ) {}

  /** repatch 一条；返回是否被改写 */
  repatchOne(entry: TraceEntry): boolean {
    const before = JSON.stringify([entry.uds, entry.doip]);

    /* DoIP 层名字（★Q2：NACK 码表走库文件） */
    entry.doip.ackNameZh = describeWithLibrary(
      this.store.doipTable('ackCodes'),
      FALLBACK_ACK_CODES,
      entry.doip.ackCode,
    );
    entry.doip.nackNameZh = describeWithLibrary(
      this.store.doipTable('diagnosticMessageNackCodes'),
      FALLBACK_DIAGNOSTIC_MESSAGE_NACK_CODES,
      entry.doip.nackCode,
    );
    entry.doip.activationResponseCodeZh = describeWithLibrary(
      this.store.doipTable('routingActivationCodes'),
      FALLBACK_ROUTING_ACTIVATION_CODES,
      entry.doip.activationResponseCode,
    );
    if (entry.doip.payloadType === 0x0000 && entry.doip.nackCode !== null) {
      entry.doip.nackNameZh = describeWithLibrary(
        this.store.doipTable('genericHeaderNackCodes'),
        FALLBACK_GENERIC_HEADER_NACK_CODES,
        entry.doip.nackCode,
      );
    }
    entry.doip.sourceAddressName = this.formatAddress(entry.doip.sourceAddress);
    entry.doip.targetAddressName = this.formatAddress(entry.doip.targetAddress);

    /* UDS 层 */
    const userData = extractUserData(entry);
    if (userData !== null) {
      const role = entry.direction === 'TX' ? 'request' : 'response';
      entry.uds = this.decoder.decode(userData, role);
    }

    return JSON.stringify([entry.uds, entry.doip]) !== before;
  }

  /** 批量 repatch；只返回**真正被改写**的条目（避免无谓推送） */
  repatch(entries: TraceEntry[], limit = this.store.repatchWindow): TraceEntry[] {
    const window = entries.length > limit ? entries.slice(entries.length - limit) : entries;
    const changed: TraceEntry[] = [];
    for (const entry of window) {
      if (this.repatchOne(entry)) changed.push(entry);
    }
    this.log.info('服务库热更新 repatch 完成', {
      scanned: window.length,
      changed: changed.length,
    });
    return changed;
  }

  private formatAddress(address: number | null): string | null {
    if (address === null) return null;
    const alias = this.store.aliasOf(address);
    const hex = `0x${(address & 0xffff).toString(16).toUpperCase().padStart(4, '0')}`;
    return alias === null ? hex : `${hex} ${alias}`;
  }
}
