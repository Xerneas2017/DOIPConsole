/**
 * ★suppressPosRsp 判定回归。
 *
 * 起因（真实事故）：用户在原始 hex 模式发 `14 FF FF FF`（清除 DTC 组 0xFFFFFF），
 * 工具把它判成"抑制正响应"——因为 `UDS_SERVICES_WITH_SUBFUNCTION` 里**错误地包含了
 * 0x14**，于是第 2 字节 `FF` 的 bit7 被当成抑制位。结果：
 *   - ECU 明明回了 `54 FF FF FF`（正响应）
 *   - 事务却被标成 `SUPPRESSED`，响应不配对、结果不显示
 *   - 用户看到的就是"发了没反应"，以为工具坏了
 *
 * ISO 14229-1 请求格式核对：
 *   0x14 清DTC：`14 | DTCGroup(3)` —— **没有子功能字节**，`FF FF FF` 是 DTC 组
 *   0x36 传输数据：`36 | blockSequenceCounter(1) | data` —— bit7 不是抑制位
 *   0x34/0x35：`xx | dataFormatIdentifier(1) | ...` —— 同上
 *
 * 规则：**只有 ISO 明确"子功能字节最高位为抑制位"的服务才允许看 bit7**；
 * 其余服务（尤其原始 hex 模式下任意字节）一律不得猜测。
 */

import { describe, expect, it } from 'vitest';
import {
  expectPositiveSid,
  hasSubFunction,
  suppressPositiveResponseOf,
} from '../txn/TxnMatchPolicy';
import { parseHex } from '@doip/shared';

describe('TC-MP01 哪些服务有子功能字节（ISO 14229-1 请求格式）', () => {
  it('有子功能：10/11/19/27/31/3E/85', () => {
    for (const sid of [0x10, 0x11, 0x19, 0x27, 0x31, 0x3e, 0x85]) {
      expect(hasSubFunction(sid), `0x${sid.toString(16)} 应有子功能`).toBe(true);
    }
  });

  it('★没有子功能：14/22/2E/34/35/36/37 —— 第 2 字节起是数据', () => {
    for (const sid of [0x14, 0x22, 0x2e, 0x34, 0x35, 0x36, 0x37]) {
      expect(hasSubFunction(sid), `0x${sid.toString(16)} 不应有子功能`).toBe(false);
    }
  });
});

describe('TC-MP02 suppressPosRsp 只对真子功能生效', () => {
  it('★14 FF FF FF（清除 DTC 组 0xFFFFFF）绝不能被判成抑制', () => {
    expect(suppressPositiveResponseOf(parseHex('14FFFFFF'))).toBe(false);
  });

  it('36 01 + 数据（块序号 0x01）不能被判成抑制', () => {
    expect(suppressPositiveResponseOf(parseHex('3601020304'))).toBe(false);
  });

  it('22 F1 90（读 DID）没有子功能，FF 不影响判定', () => {
    expect(suppressPositiveResponseOf(parseHex('22F190'))).toBe(false);
    expect(suppressPositiveResponseOf(parseHex('22FFFF'))).toBe(false);
  });

  it('真正的抑制位要能识别：10 83 / 3E 80 / 27 81', () => {
    expect(suppressPositiveResponseOf(parseHex('1083'))).toBe(true);
    expect(suppressPositiveResponseOf(parseHex('3E80'))).toBe(true);
    expect(suppressPositiveResponseOf(parseHex('2781'))).toBe(true);
  });

  it('不置抑制位时为 false：10 03 / 3E 00 / 27 01', () => {
    expect(suppressPositiveResponseOf(parseHex('1003'))).toBe(false);
    expect(suppressPositiveResponseOf(parseHex('3E00'))).toBe(false);
    expect(suppressPositiveResponseOf(parseHex('2701'))).toBe(false);
  });

  it('长度不足 2 或空 payload 不抛异常', () => {
    expect(suppressPositiveResponseOf(new Uint8Array([]))).toBe(false);
    expect(suppressPositiveResponseOf(parseHex('14'))).toBe(false);
  });

  it('正响应 SID：14 → 54', () => {
    expect(expectPositiveSid(0x14)).toBe(0x54);
    expect(expectPositiveSid(0x22)).toBe(0x62);
  });
});
