/**
 * UDS 解码器（§3.5 / T12）。
 *
 * 产出 `UdsDecodeResult`：既给 Trace 一行能显示的短文本（Q13），
 * 也给 D 区三层解码树用的结构化树。
 *
 * ★解码永不抛异常：识别不了就 `decoded=false` 并保留原始字节，
 *   绝不让一条报文把整条 Trace 流水线打断。
 */

import {
  emptyUdsDecodeResult,
  formatHex,
  FALLBACK_NRC_TABLE,
  describeCode,
} from '@doip/shared';
import type { DecodeNode, UdsDecodeResult } from '@doip/shared';
import type { UdsLibraryStore } from './UdsLibraryStore';
import type { ServiceDef } from '@doip/shared';

export type DecodeRole = 'request' | 'response';

function bytesToNumber(bytes: Uint8Array, endian: 'big' | 'little'): number {
  let value = 0;
  if (endian === 'big') {
    for (const b of bytes) value = (value << 8) | (b & 0xff);
  } else {
    let shift = 0;
    for (const b of bytes) {
      value |= (b & 0xff) << shift;
      shift += 8;
    }
  }
  return value >>> 0;
}

export class UdsDecoder {
  constructor(private readonly store: UdsLibraryStore) {}

  /** 解码一条 UDS userData；`role` 决定用请求表单还是正响应表单 */
  decode(userData: Uint8Array | null, role: DecodeRole = 'request'): UdsDecodeResult {
    const result = emptyUdsDecodeResult();
    if (userData === null || userData.length === 0) return result;

    const first = userData[0] ?? 0;
    result.decoded = true;

    /* ── 负响应 7F <sid> <nrc> ── */
    if (first === 0x7f) {
      const sid = userData[1] ?? null;
      const nrc = userData[2] ?? null;
      result.messageKind = 'negative';
      result.serviceId = sid;
      result.nrc = nrc;
      const svc = sid === null ? null : this.store.serviceBySid(sid);
      this.fillService(result, svc);
      this.fillNrc(result, nrc);
      result.tree = this.buildNegativeTree(userData, sid, nrc, svc);
      return result;
    }

    const isPositive = (first & 0x40) !== 0;
    const requestSid = isPositive ? (first - 0x40) & 0xff : first;
    result.isPositive = isPositive;
    result.serviceId = isPositive ? requestSid : first;
    result.messageKind = isPositive ? 'positive' : 'request';

    const svc = this.store.serviceBySid(requestSid);
    this.fillService(result, svc);

    const form = svc === null ? [] : isPositive ? svc.positiveResponseForm : svc.form;

    /* 子功能（大多数服务的 form[0] 就是 subFunction） */
    const subField = form.find((f) => f.role === 'subFunction');
    if (subField !== undefined && userData.length > subField.offset) {
      const raw = userData[subField.offset] ?? 0;
      result.subFunction = raw;
      result.suppressPositiveResponse = (raw & 0x80) !== 0;
      const matched = subField.values?.find((v) => UdsDecoder.hexValue(v.value) === (raw & 0x7f));
      if (matched !== undefined) {
        result.subFunctionName = matched.name;
        result.subFunctionNameZh = matched.nameZh;
      }
    }

    /* DID */
    const didField = form.find((f) => f.role === 'did');
    if (didField !== undefined && userData.length >= didField.offset + 2) {
      const did = bytesToNumber(
        userData.subarray(didField.offset, didField.offset + 2),
        'big',
      );
      result.did = did;
      const entry = this.store.didById(did);
      if (entry !== null) {
        result.didName = entry.name;
        result.didNameZh = entry.nameZh;
      }
    }

    /* 其余数据字段 */
    result.params = [];
    for (const field of form) {
      if (field.role === 'subFunction' || field.role === 'did') continue;
      const start = field.offset;
      const end = field.length < 0 ? userData.length : Math.min(userData.length, start + field.length);
      if (start >= end) continue;
      result.params.push({
        name: field.name,
        value: formatHex(userData.subarray(start, end)),
        offset: start,
      });
    }

    result.tree = this.buildPositiveTree(userData, svc, isPositive, role);
    return result;
  }

  /* ─────────────── 内部 ─────────────── */

  private fillService(result: UdsDecodeResult, svc: ServiceDef | null): void {
    if (svc === null) return;
    result.serviceName = svc.name;
    result.shortEn = svc.shortEn;
    result.shortZh = svc.shortZh;
  }

  private fillNrc(result: UdsDecodeResult, nrc: number | null): void {
    if (nrc === null) return;
    const table = this.store.nrcTable();
    const effective = table.length > 0 ? table : FALLBACK_NRC_TABLE;
    const desc = describeCode(effective, nrc);
    result.nrcName = desc.name;
    result.nrcNameZh = desc.nameZh;
    result.nrcHint = desc.hint;
  }

  private buildPositiveTree(
    userData: Uint8Array,
    svc: ServiceDef | null,
    isPositive: boolean,
    role: DecodeRole,
  ): DecodeNode {
    const root: DecodeNode = {
      offset: 0,
      length: userData.length,
      field: 'uds',
      valueHex: formatHex(userData),
      ...(svc === null ? {} : { nameEn: svc.name }),
      nameZh: svc === null ? '未识别的 UDS 报文' : `${svc.nameZh}${isPositive ? '（正响应）' : '（请求）'}`,
      ...(svc === null ? {} : { shortZh: svc.shortZh }),
      meaning: role === 'request' ? '本端发出的诊断请求' : '对端返回的诊断响应',
      children: [],
    };
    const children = root.children ?? [];

    children.push({
      offset: 0,
      length: 1,
      field: 'sid',
      valueHex: formatHex(userData.subarray(0, 1)),
      ...(svc === null ? {} : { nameEn: svc.name }),
      nameZh: svc === null ? '服务标识符' : `${svc.shortEn} 服务标识符`,
      ...(svc === null
        ? { meaning: '服务库中无此 SID，可在服务库 JSON 中补充' }
        : { meaning: svc.nameZh }),
    });

    const form = svc === null ? [] : isPositive ? svc.positiveResponseForm : svc.form;
    for (const field of form) {
      const start = field.offset;
      const end = field.length < 0 ? userData.length : Math.min(userData.length, start + field.length);
      if (start >= end) continue;
      const slice = userData.subarray(start, end);
      const node: DecodeNode = {
        offset: start,
        length: end - start,
        field: field.name,
        valueHex: formatHex(slice),
        nameZh: this.fieldLabel(field.name, field.role),
      };
      if (field.role === 'subFunction') {
        const raw = slice[0] ?? 0;
        const matched = field.values?.find((v) => UdsDecoder.hexValue(v.value) === (raw & 0x7f));
        if (matched !== undefined) {
          node.nameEn = matched.name;
          node.nameZh = `${matched.nameZh}（${matched.name}）`;
        }
        if ((raw & 0x80) !== 0) node.meaning = '抑制正响应位已置起';
      }
      if (field.role === 'did') {
        const did = bytesToNumber(slice, 'big');
        const entry = this.store.didById(did);
        if (entry !== null) {
          node.nameEn = entry.name;
          node.nameZh = `${entry.nameZh}（${entry.name}）`;
          node.meaning = `编码：${entry.codec}`;
        }
      }
      children.push(node);
    }

    const covered = children.reduce((max, c) => Math.max(max, c.offset + c.length), 1);
    if (covered < userData.length) {
      children.push({
        offset: covered,
        length: userData.length - covered,
        field: 'trailingData',
        valueHex: formatHex(userData.subarray(covered)),
        nameZh: '未建模的剩余数据',
        meaning: '服务库未定义该区段的字段，原样保留',
      });
    }
    return root;
  }

  private buildNegativeTree(
    userData: Uint8Array,
    sid: number | null,
    nrc: number | null,
    svc: ServiceDef | null,
  ): DecodeNode {
    const root: DecodeNode = {
      offset: 0,
      length: userData.length,
      field: 'uds',
      valueHex: formatHex(userData),
      nameEn: 'NegativeResponse',
      nameZh: svc === null ? '负响应' : `${svc.shortEn} 负响应`,
      ...(svc === null ? {} : { shortZh: svc.shortZh }),
      meaning: 'ECU 拒绝了本次请求',
      children: [
        {
          offset: 0,
          length: 1,
          field: 'negativeResponseSid',
          valueHex: '7F',
          nameZh: '负响应标识',
          meaning: '固定 0x7F',
        },
        {
          offset: 1,
          length: 1,
          field: 'sid',
          valueHex: formatHex(userData.subarray(1, 2)),
          ...(svc === null ? {} : { nameEn: svc.name }),
          nameZh: svc?.nameZh ?? (sid === null ? '服务标识符' : `SID 0x${sid.toString(16).toUpperCase()}`),
        },
      ],
    };
    const children = root.children ?? [];
    const hint = nrc === null ? null : this.nrcHintOf(nrc);
    const nrcName = this.nrcNameOf(nrc);
    children.push({
      offset: 2,
      length: 1,
      field: 'nrc',
      valueHex: formatHex(userData.subarray(2, 3)),
      ...(nrcName === undefined ? {} : { nameEn: nrcName }),
      nameZh: this.nrcNameZhOf(nrc),
      ...(hint === null ? {} : { meaning: hint }),
    });
    if (userData.length > 3) {
      children.push({
        offset: 3,
        length: userData.length - 3,
        field: 'extraData',
        valueHex: formatHex(userData.subarray(3)),
        nameZh: '附加数据',
        meaning: '非标准负响应，多出的数据原样保留',
      });
    }
    return root;
  }

  private fieldLabel(name: string, role: string): string {
    if (role === 'subFunction') return `${name}（子功能）`;
    if (role === 'did') return `${name}（数据标识符）`;
    return `${name}（数据）`;
  }

  private nrcNameOf(nrc: number | null): string | undefined {
    if (nrc === null) return undefined;
    const table = this.store.nrcTable();
    return describeCode(table.length > 0 ? table : FALLBACK_NRC_TABLE, nrc).name;
  }

  private nrcNameZhOf(nrc: number | null): string {
    if (nrc === null) return '否定响应码';
    const table = this.store.nrcTable();
    return describeCode(table.length > 0 ? table : FALLBACK_NRC_TABLE, nrc).nameZh;
  }

  private nrcHintOf(nrc: number): string | null {
    const table = this.store.nrcTable();
    return describeCode(table.length > 0 ? table : FALLBACK_NRC_TABLE, nrc).hint;
  }

  private static hexValue(text: string): number {
    const cleaned = text.replace(/^0[xX]/, '').trim();
    const value = Number.parseInt(cleaned, 16);
    return Number.isFinite(value) ? value : -1;
  }
}
