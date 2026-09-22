/**
 * DoIP 头 / payload 编解码单测（§9.1 TC-C01 ~ TC-C08）：
 * 各 payload type 编解码往返全等、未知 type 不抛异常、大端字节序。
 */

import { describe, expect, it } from 'vitest';
import { DoipHeaderCodec } from '../doip/DoipHeaderCodec';
import { DoipPayloadCodec } from '../doip/DoipPayloadCodec';
import { PayloadType, isInverseVersionValid, parseHex } from '@doip/shared';

describe('TC-C01 通用头编解码往返', () => {
  it('encodeHeader → decodeHeader 全等', () => {
    const buf = DoipHeaderCodec.encodeHeader(0x02, PayloadType.DIAGNOSTIC_MESSAGE, 7);
    expect(buf.length).toBe(8);
    const h = DoipHeaderCodec.decodeHeader(buf, 0);
    expect(h.protocolVersion).toBe(0x02);
    expect(h.inverseProtocolVersion).toBe(0xfd);
    expect(h.payloadType).toBe(0x8001);
    expect(h.payloadLength).toBe(7);
    expect(h.inverseVersionValid).toBe(true);
  });

  it('大端字节序：payloadLength=0x00000007 的第 4..7 字节为 00 00 00 07', () => {
    const buf = DoipHeaderCodec.encodeHeader(0x02, 0x8001, 7);
    expect(Array.from(buf.subarray(4, 8))).toEqual([0x00, 0x00, 0x00, 0x07]);
  });

  it('0x03 协议的 inverse = 0xFC', () => {
    const buf = DoipHeaderCodec.encodeHeader(0x03, 0x8001, 0);
    expect(buf.readUInt8(1)).toBe(0xfc);
    expect(isInverseVersionValid(0x03, 0xfc)).toBe(true);
  });
});

describe('TC-C02 路由激活请求/响应往返', () => {
  it('0x0005 encode → decode 全等（11 字节）', () => {
    const payload = DoipPayloadCodec.encode({
      kind: 'routingActivationRequest',
      payloadType: PayloadType.ROUTING_ACTIVATION_REQ,
      value: { sourceAddress: 0x0e00, activationType: 0x00, reservedIso: 0, reservedOem: new Uint8Array([1, 2, 3, 4]) },
    });
    expect(payload.length).toBe(11);
    const decoded = DoipPayloadCodec.decode(PayloadType.ROUTING_ACTIVATION_REQ, payload);
    expect(decoded.kind).toBe('routingActivationRequest');
    if (decoded.kind !== 'routingActivationRequest') return;
    expect(decoded.value.sourceAddress).toBe(0x0e00);
    expect(decoded.value.activationType).toBe(0x00);
    expect(decoded.value.reservedIso).toBe(0);
    expect(Array.from(decoded.value.reservedOem)).toEqual([1, 2, 3, 4]);
  });

  it('0x0006 encode → decode 全等（13 字节）', () => {
    const payload = DoipPayloadCodec.encode({
      kind: 'routingActivationResponse',
      payloadType: PayloadType.ROUTING_ACTIVATION_RES,
      value: {
        testerLogicalAddress: 0x0e00,
        doipEntityLogicalAddress: 0x1000,
        routingActivationResponseCode: 0x10,
        reservedIso: 0,
        reservedOem: new Uint8Array(4),
      },
    });
    expect(payload.length).toBe(13);
    const decoded = DoipPayloadCodec.decode(PayloadType.ROUTING_ACTIVATION_RES, payload);
    expect(decoded.kind).toBe('routingActivationResponse');
    if (decoded.kind !== 'routingActivationResponse') return;
    expect(decoded.value.testerLogicalAddress).toBe(0x0e00);
    expect(decoded.value.doipEntityLogicalAddress).toBe(0x1000);
    expect(decoded.value.routingActivationResponseCode).toBe(0x10);
  });
});

describe('TC-C03 诊断报文 / ACK / NACK 往返', () => {
  it('0x8001 userData 完整保留', () => {
    const userData = parseHex('22F190');
    const payload = DoipPayloadCodec.encode({
      kind: 'diagnosticMessage',
      payloadType: PayloadType.DIAGNOSTIC_MESSAGE,
      value: { sourceAddress: 0x0e00, targetAddress: 0x1000, userData },
    });
    const decoded = DoipPayloadCodec.decode(PayloadType.DIAGNOSTIC_MESSAGE, payload);
    expect(decoded.kind).toBe('diagnosticMessage');
    if (decoded.kind !== 'diagnosticMessage') return;
    expect(decoded.value.sourceAddress).toBe(0x0e00);
    expect(decoded.value.targetAddress).toBe(0x1000);
    expect(Array.from(decoded.value.userData)).toEqual([0x22, 0xf1, 0x90]);
  });

  it('0x8002 ACK 含 previousMessage 回显', () => {
    const prev = parseHex('22F190');
    const payload = DoipPayloadCodec.encode({
      kind: 'diagnosticMessageAck',
      payloadType: PayloadType.DIAGNOSTIC_MESSAGE_ACK,
      value: { sourceAddress: 0x1000, targetAddress: 0x0e00, ackCode: 0x00, previousMessage: prev },
    });
    expect(payload.length).toBe(5 + 3);
    const decoded = DoipPayloadCodec.decode(PayloadType.DIAGNOSTIC_MESSAGE_ACK, payload);
    expect(decoded.kind).toBe('diagnosticMessageAck');
    if (decoded.kind !== 'diagnosticMessageAck') return;
    expect(decoded.value.ackCode).toBe(0x00);
    expect(Array.from(decoded.value.previousMessage)).toEqual([0x22, 0xf1, 0x90]);
  });

  it('0x8003 NACK 码正确', () => {
    const payload = DoipPayloadCodec.encode({
      kind: 'diagnosticMessageNack',
      payloadType: PayloadType.DIAGNOSTIC_MESSAGE_NACK,
      value: { sourceAddress: 0x1000, targetAddress: 0x0e00, nackCode: 0x01, previousMessage: parseHex('22F190') },
    });
    const decoded = DoipPayloadCodec.decode(PayloadType.DIAGNOSTIC_MESSAGE_NACK, payload);
    expect(decoded.kind).toBe('diagnosticMessageNack');
    if (decoded.kind !== 'diagnosticMessageNack') return;
    expect(decoded.value.nackCode).toBe(0x01);
  });
});

describe('TC-C04 车辆公告（0x0004）33 字节', () => {
  it('VIN / LA / EID / GID 往返', () => {
    const payload = DoipPayloadCodec.encode({
      kind: 'vehicleAnnouncement',
      payloadType: PayloadType.VEHICLE_ANNOUNCEMENT,
      value: {
        vin: 'LSVAM1234N2000001',
        logicalAddress: 0x1000,
        eid: parseHex('010203040506'),
        gid: parseHex('111213141516'),
        furtherActionRequired: 0,
        vinGidSyncStatus: 0,
      },
    });
    expect(payload.length).toBe(33);
    const decoded = DoipPayloadCodec.decode(PayloadType.VEHICLE_ANNOUNCEMENT, payload);
    expect(decoded.kind).toBe('vehicleAnnouncement');
    if (decoded.kind !== 'vehicleAnnouncement') return;
    expect(decoded.value.vin).toBe('LSVAM1234N2000001');
    expect(decoded.value.logicalAddress).toBe(0x1000);
    expect(Array.from(decoded.value.eid)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(Array.from(decoded.value.gid)).toEqual([0x11, 0x12, 0x13, 0x14, 0x15, 0x16]);
  });
});

describe('TC-C05 零长度与短 payload', () => {
  it('0x0001 / 0x0007 编解码', () => {
    const empty = DoipPayloadCodec.encode({
      kind: 'vehicleIdentificationRequest',
      payloadType: PayloadType.VEHICLE_IDENTIFICATION_REQ,
      value: {},
    });
    expect(empty.length).toBe(0);
    expect(DoipPayloadCodec.decode(PayloadType.VEHICLE_IDENTIFICATION_REQ, empty).kind).toBe(
      'vehicleIdentificationRequest',
    );

    const alive = DoipPayloadCodec.encode({
      kind: 'aliveCheckRequest',
      payloadType: PayloadType.ALIVE_CHECK_REQ,
      value: {},
    });
    expect(alive.length).toBe(0);
    expect(DoipPayloadCodec.decode(PayloadType.ALIVE_CHECK_REQ, alive).kind).toBe('aliveCheckRequest');
  });

  it('0x0008 AliveCheckResponse（2 字节 SA）', () => {
    const payload = DoipPayloadCodec.encode({
      kind: 'aliveCheckResponse',
      payloadType: PayloadType.ALIVE_CHECK_RES,
      value: { sourceAddress: 0x0e00 },
    });
    expect(payload.length).toBe(2);
    const decoded = DoipPayloadCodec.decode(PayloadType.ALIVE_CHECK_RES, payload);
    expect(decoded.kind).toBe('aliveCheckResponse');
    if (decoded.kind !== 'aliveCheckResponse') return;
    expect(decoded.value.sourceAddress).toBe(0x0e00);
  });
});

describe('TC-C06 未知 payloadType 不抛异常', () => {
  it('未知 type → {kind:"unknown", hex}', () => {
    const decoded = DoipPayloadCodec.decode(0x9001, parseHex('DEADBEEF'));
    expect(decoded.kind).toBe('unknown');
    if (decoded.kind !== 'unknown') return;
    expect(decoded.value.hex).toBe('DEADBEEF');
    expect(decoded.value.payloadType).toBe(0x9001);
  });

  it('已知 type 但长度不足（对端违规）→ 退化为 unknown 而非抛异常', () => {
    const decoded = DoipPayloadCodec.decode(PayloadType.DIAGNOSTIC_MESSAGE, new Uint8Array([0x0e, 0x00]));
    expect(decoded.kind).toBe('unknown');
  });
});

describe('TC-C07 payloadType 元信息', () => {
  it('已知 / 未知 type 的中英文名与传输层归属', () => {
    expect(DoipPayloadCodec.meta(0x8001).nameZh).toBe('诊断报文');
    expect(DoipPayloadCodec.meta(0x8001).transport).toBe('TCP');
    expect(DoipPayloadCodec.meta(0x0004).transport).toBe('UDP');
    expect(DoipPayloadCodec.meta(0x1234).name).toBe('Unknown');
  });
});

describe('TC-C08 buildFrame 组装', () => {
  it('头 + payload 长度正确且协议版本字节可校验', () => {
    const payload = parseHex('0E0010002203');
    const frame = DoipHeaderCodec.buildFrame(0x02, PayloadType.DIAGNOSTIC_MESSAGE, payload);
    expect(frame.length).toBe(8 + payload.length);
    const header = DoipHeaderCodec.decodeHeader(frame, 0);
    expect(header.payloadLength).toBe(payload.length);
    expect(isInverseVersionValid(header.protocolVersion, header.inverseProtocolVersion)).toBe(true);
  });
});

/**
 * ★TC-C09 互操作性回归：路由激活请求的 OEM 保留字段是**可选**的。
 *
 * 起因是一次真实事故：用第三方标准库（python-doipclient）连我们的仿真 ECU，
 * 它的 `request_activation(vm_specific=None)` 只发 **7 字节** payload
 * （SA(2) + activationType(1) + reservedIso(4)，不含 reservedOem(4)），
 * 而我们把长度硬校验成 `>= 11` → 解码返回 null → 帧被静默丢弃 →
 * 对方路由激活永远超时，而我们的日志里一片空白（当时该分支是 debug 级）。
 *
 * 教训：标准里"可选"的字段，实现里就必须真的可选；单测只测了自己发的形态，
 * 等于没测互操作性。
 */
describe('TC-C09 路由激活请求长度容忍（OEM 字段可选）', () => {
  it('7 字节形态（标准客户端的默认行为）必须能解码', () => {
    // 02 FD 00 05 | 00 00 00 07 | 0E 00 | 00 | 00 00 00 00
    const payload = parseHex('0E000000000000'); // SA=0x0E00, type=0x00, reservedIso=0x00000000
    expect(payload.length).toBe(7);
    const decoded = DoipPayloadCodec.decode(PayloadType.ROUTING_ACTIVATION_REQ, payload);
    expect(decoded.kind).toBe('routingActivationRequest');
    if (decoded.kind !== 'routingActivationRequest') throw new Error('unreachable');
    expect(decoded.value.sourceAddress).toBe(0x0e00);
    expect(decoded.value.activationType).toBe(0x00);
    expect(decoded.value.reservedIso).toBe(0);
    // 未携带 OEM 字段时给空数组，调用方不必判空
    expect(decoded.value.reservedOem.length).toBe(0);
  });

  it('11 字节形态（带 OEM 字段）仍然解码正确，OEM 字节被保留', () => {
    const payload = parseHex('0E00000000000001020304');
    expect(payload.length).toBe(11);
    const decoded = DoipPayloadCodec.decode(PayloadType.ROUTING_ACTIVATION_REQ, payload);
    expect(decoded.kind).toBe('routingActivationRequest');
    if (decoded.kind !== 'routingActivationRequest') throw new Error('unreachable');
    expect(decoded.value.sourceAddress).toBe(0x0e00);
    expect(Array.from(decoded.value.reservedOem)).toEqual([1, 2, 3, 4]);
  });

  it('短于 7 字节仍然判为非法（不能把截断帧当合法）', () => {
    for (const hex of ['', '0E', '0E00', '0E0000', '0E000000', '0E00000000', '0E0000000000']) {
      const decoded = DoipPayloadCodec.decode(PayloadType.ROUTING_ACTIVATION_REQ, parseHex(hex));
      expect(decoded.kind, `长度 ${hex.length / 2} 字节不应被接受`).not.toBe('routingActivationRequest');
    }
  });

  it('超长（如 15 字节）不崩，且只取前 11 字节语义', () => {
    const decoded = DoipPayloadCodec.decode(
      PayloadType.ROUTING_ACTIVATION_REQ,
      parseHex('0E0000000000000102030405060708'),
    );
    expect(decoded.kind).toBe('routingActivationRequest');
    if (decoded.kind !== 'routingActivationRequest') throw new Error('unreachable');
    expect(decoded.value.sourceAddress).toBe(0x0e00);
    expect(Array.from(decoded.value.reservedOem)).toEqual([1, 2, 3, 4]);
  });
});
