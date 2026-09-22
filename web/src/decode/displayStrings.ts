import type { TraceEntry } from '@doip/shared';
import { formatHex, tryParseHex } from '@doip/shared';

/**
 * Trace 显示串（T10，★Q13：短名拼装规则）。
 *
 * 口径（与 PRD §6.1 线框一致）：
 *   - 请求      `DSC(10) extended(03)`
 *   - 正响应    `✓ DSC-PR(50) 03`
 *   - 否定响应  `✗ NRC 0x35 invalidKey`
 *   - ACK       `✓ ACK 0x8002`
 *   - NACK      `✗ NACK 0x03 目标地址未知`
 *   - 纯 DoIP   `DoIP: RoutingActivationRequest`
 */

/** 0x10 → '10'（大写两位） */
export function hex2(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '--';
  return (value & 0xff).toString(16).toUpperCase().padStart(2, '0');
}

/** 0x8001 → '0x8001' */
export function hex4(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '--';
  return `0x${(value & 0xffff).toString(16).toUpperCase().padStart(4, '0')}`;
}

/** 服务短名：优先服务库的 shortEn，缺省回落到 `SID(0xXX)` */
export function serviceShort(entry: TraceEntry): string {
  const { uds } = entry;
  if (uds.shortEn !== null && uds.shortEn !== '') return uds.shortEn;
  if (uds.serviceName !== null && uds.serviceName !== '') return uds.serviceName;
  if (uds.serviceId !== null) return `SID(${hex2(uds.serviceId)})`;
  return '';
}

/** 子功能名（含中文，tooltip 用） */
export function subFunctionText(entry: TraceEntry): string {
  const { uds } = entry;
  if (uds.subFunction === null) return '';
  const name = uds.subFunctionName ?? uds.subFunctionNameZh ?? '';
  return name === '' ? hex2(uds.subFunction) : `${name}(${hex2(uds.subFunction)})`;
}

/** C 区「UDS 解码」列的主串 */
export function decodeSummary(entry: TraceEntry): string {
  const { uds, doip } = entry;

  // ① UDS 层：NRC > 正响应 > 请求
  if (uds.nrc !== null) {
    const nrcName = uds.nrcName ?? uds.nrcNameZh ?? '';
    return `✗ NRC ${hex2(uds.nrc)}${nrcName === '' ? '' : ` ${nrcName}`}`;
  }
  if (uds.serviceId !== null) {
    const svc = serviceShort(entry);
    const sub = subFunctionText(entry);
    if (uds.isPositive) {
      const did =
        uds.did !== null ? ` ${hex4(uds.did)}` : entry.doip.payloadType === 0x8001 ? '' : '';
      return `✓ ${svc}${sub === '' ? '' : ` ${sub}`}${did}`;
    }
    const spr = uds.suppressPositiveResponse ? ' ☐抑制' : '';
    return `${svc}${sub === '' ? '' : ` ${sub}`}${spr}`;
  }

  // ② DoIP 层
  if (doip.nackCode !== null) {
    return `✗ NACK ${hex2(doip.nackCode)}${doip.nackNameZh === null ? '' : ` ${doip.nackNameZh}`}`;
  }
  if (doip.ackCode !== null) {
    return `✓ ACK ${hex4(0x8002)}${doip.ackNameZh === null ? '' : ` ${doip.ackNameZh}`}`;
  }
  if (doip.activationResponseCode !== null) {
    const ok = doip.activationResponseCode === 0x10;
    return `${ok ? '✓' : '✗'} RoutingActivated ${hex2(doip.activationResponseCode)}`;
  }
  return `DoIP: ${doip.payloadTypeName}${doip.payloadTypeNameZh === null ? '' : ` ${doip.payloadTypeNameZh}`}`;
}

/** 时间戳：本地时间 `HH:MM:SS.mmmmmm`（列设置可切 UTC） */
export function formatTs(iso: string, useUtc: boolean): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number, len = 2): string => String(n).padStart(len, '0');
  const hh = useUtc ? d.getUTCHours() : d.getHours();
  const mm = useUtc ? d.getUTCMinutes() : d.getMinutes();
  const ss = useUtc ? d.getUTCSeconds() : d.getSeconds();
  const ms = d.getMilliseconds();
  // μs 位：ISO 串末 3 位（后端给 6 位小数）
  const micro = /\.(\d{6})Z?$/.exec(iso)?.[1]?.slice(3) ?? '000';
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}.${pad(ms, 3)}${micro}`;
}

/** 相对时间：`+12.345 s` */
export function formatRel(ms: number): string {
  if (!Number.isFinite(ms)) return '-';
  return `${(ms / 1000).toFixed(3)} s`;
}

/** SA→TA 展示（含别名） */
export function addressPair(entry: TraceEntry): string {
  const { doip } = entry;
  const sa =
    doip.sourceAddress === null
      ? '----'
      : (doip.sourceAddressName ?? hex4(doip.sourceAddress).slice(2));
  const ta =
    doip.targetAddress === null
      ? '----'
      : (doip.targetAddressName ?? hex4(doip.targetAddress).slice(2));
  return `${sa}→${ta}`;
}

/** 原始 hex 展示串（大写、单空格分隔） */
export function rawHexDisplay(entry: TraceEntry): string {
  const bytes = tryParseHex(entry.rawHex);
  if (bytes === null) return entry.rawHex;
  return formatHex(bytes);
}

/** 标签串（周期3E / unsolicited / 自定义） */
export function tagText(entry: TraceEntry): string {
  return entry.tags.join(' ');
}

/** 连接状态灯颜色 */
export function stateColor(state: string): string {
  switch (state) {
    case 'ROUTING_ACTIVE':
      return '#3ddc97';
    case 'TCP_CONNECTING':
    case 'TCP_CONNECTED':
    case 'ROUTING_ACTIVATING':
    case 'SCANNING':
      return '#f7b955';
    case 'ERROR':
      return '#e06c75';
    case 'DISCONNECTED':
    case 'CLOSED':
      return '#6b7280';
    default:
      return '#9aa4b2';
  }
}
