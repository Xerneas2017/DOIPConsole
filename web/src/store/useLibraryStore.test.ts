import { describe, expect, it, beforeEach } from 'vitest';
import type { KeyAlgorithmDescriptor, ServiceDef, UdsLibrary } from '@doip/shared';
import {
  algorithmsForLevel,
  codeLabel,
  serviceLabel,
  sidOf,
  selectAlgorithm,
  sortedServices,
  useLibraryStore,
} from './useLibraryStore';
import { useTraceStore } from './useTraceStore';

function svc(id: string, shortEn: string, nameZh: string, builtin = true): ServiceDef {
  return {
    id,
    name: 'X',
    nameZh,
    shortEn,
    shortZh: '短名',
    positiveResponseId: `0x${(sidOf(id) + 0x40).toString(16).toUpperCase()}`,
    supportsFunctional: true,
    builtin,
    form: [],
    positiveResponseForm: [],
  };
}

function algo(id: string, origin: 'placeholder' | 'customer-c', verified: boolean, levels: number[]): KeyAlgorithmDescriptor {
  return {
    id,
    nameZh: id,
    appliesToLevels: levels,
    seedLengthBytes: 4,
    keyLengthBytes: 4,
    origin,
    verified,
    provider: 'ported',
    specId: null,
  };
}

const LIB: UdsLibrary = {
  schemaVersion: '1.0',
  meta: { name: 't', description: '', updatedAt: '2026-01-01' },
  doipTables: {
    routingActivationCodes: [],
    genericHeaderNackCodes: [],
    diagnosticMessageNackCodes: [],
    ackCodes: [],
  },
  nrcTable: [],
  services: [svc('0x22', 'RDBI', '读 DID'), svc('0x10', 'DSC', '诊断会话控制'), svc('0x2f', 'IOCBI', 'IO 控制', false)],
  didTable: [],
  dtcTable: [],
  keyAlgorithms: [],
  addressing: { testerLogicalAddress: '0x0E00', functionalAddress: '0x1FFF', aliases: [] },
};

beforeEach(() => {
  useLibraryStore.setState({
    library: null,
    editorOpen: false,
    editorTab: 'services',
    issues: [],
    draft: null,
    algorithms: [],
    vectors: [],
    trial: null,
    unlock: null,
  });
});

describe('useLibraryStore（T12）', () => {
  it('setLibrary 同时清空草稿与 issues', () => {
    useLibraryStore.getState().setIssues([{ path: '/x', line: 1, column: 1, messageZh: 'e', severity: 'error' }]);
    useLibraryStore.getState().setDraft(LIB);
    useLibraryStore.getState().setLibrary(LIB);
    expect(useLibraryStore.getState().draft).toBeNull();
    expect(useLibraryStore.getState().issues.length).toBe(0);
  });

  it('openEditor / closeEditor 切换', () => {
    useLibraryStore.getState().openEditor('nrc');
    expect(useLibraryStore.getState().editorOpen).toBe(true);
    expect(useLibraryStore.getState().editorTab).toBe('nrc');
    useLibraryStore.getState().closeEditor();
    expect(useLibraryStore.getState().editorOpen).toBe(false);
  });

  it('sortedServices：内置在前、按 SID 升序', () => {
    const list = sortedServices(LIB);
    expect(list.map((s) => s.id)).toEqual(['0x10', '0x22', '0x2f']);
    expect(sortedServices(null)).toEqual([]);
  });

  it('★Q13：serviceLabel 形如 DSC(0x10) 诊断会话控制', () => {
    expect(serviceLabel(svc('0x10', 'DSC', '诊断会话控制'))).toBe('DSC(0x10) 诊断会话控制');
    expect(codeLabel('0x2f')).toBe('0x2F');
  });

  it('sidOf 解析 hex id', () => {
    expect(sidOf('0x10')).toBe(0x10);
    expect(sidOf('2F')).toBe(0x2f);
    expect(sidOf('zz')).toBe(-1);
  });
});

describe('Key 算法下拉（T14）', () => {
  it('placeholder 排最后、verified 排最前', () => {
    const list = algorithmsForLevel(
      [algo('a.placeholder', 'placeholder', false, [1]), algo('b.customer', 'customer-c', true, [1])],
      1,
    );
    expect(list[0]?.id).toBe('b.customer');
    expect(list[list.length - 1]?.id).toBe('a.placeholder');
  });

  it('按等级过滤；等级无命中时退回全量', () => {
    const all = [algo('l1', 'customer-c', true, [1]), algo('l3', 'customer-c', true, [3])];
    expect(algorithmsForLevel(all, 3).map((a) => a.id)).toEqual(['l3']);
    expect(algorithmsForLevel(all, 9).length).toBe(2);
  });

  it('appliesToLevels 为空的算法视为通用（不因等级被过滤掉）', () => {
    const all = [algo('any', 'placeholder', false, []), algo('l1', 'customer-c', true, [1])];
    expect(algorithmsForLevel(all, 1).map((a) => a.id)).toEqual(['l1', 'any']);
  });

  it('setAlgorithms / setTrial / setUnlock', () => {
    useLibraryStore.getState().setAlgorithms([algo('x', 'placeholder', false, [1])], []);
    expect(useLibraryStore.getState().algorithms.length).toBe(1);
    useLibraryStore.getState().setTrial({ ok: true, algorithmId: 'x', level: 1, seedHex: '00', keyHex: '5A', expectedKeyHex: null, matched: null, verified: false, errorCode: null, messageZh: null });
    expect(useLibraryStore.getState().trial?.keyHex).toBe('5A');
    useLibraryStore.getState().setUnlock({ ok: false, level: 1, algorithmId: 'x', seedHex: null, keyHex: null, nrc: 0x35, nrcNameZh: '密钥错误', errorCode: 'E_SEC_INVALID_KEY', note: '解锁失败' });
    expect(useLibraryStore.getState().unlock?.nrc).toBe(0x35);
  });
});

describe('★T12 repatch：前端按 seq 就地替换（库改名后 Trace 表刷新）', () => {
  function entry(seq: number, didNameZh: string) {
    return {
      seq,
      transactionId: null,
      ts: '2026-01-01T00:00:00.000000Z',
      tsRelMs: 0,
      transport: 'TCP' as const,
      direction: 'TX' as const,
      peer: '127.0.0.1:1',
      sessionId: 'default',
      doip: {
        protocolVersion: 2, inverseVersionValid: true, payloadType: 0x8001,
        payloadTypeName: 'DiagnosticMessage', payloadTypeNameZh: '诊断报文', payloadLength: 7,
        sourceAddress: 0x0e00, targetAddress: 0x1000, sourceAddressName: null, targetAddressName: null,
        ackCode: null, ackNameZh: null, nackCode: null, nackNameZh: null,
        activationResponseCode: null, activationResponseCodeZh: null,
        vin: null, eid: null, gid: null, headerHex: '',
      },
      uds: {
        decoded: true, serviceId: 0x22, serviceName: 'ReadDataByIdentifier', shortEn: 'RDBI', shortZh: '读DID',
        isPositive: false, messageKind: 'request' as const, subFunction: null, subFunctionName: null,
        subFunctionNameZh: null, suppressPositiveResponse: false,
        did: 0xf190, didName: 'VIN', didNameZh, nrc: null, nrcName: null, nrcNameZh: null, nrcHint: null,
        params: [], tree: null,
      },
      linkedSeq: null, txnRole: null, latencyMs: null, gatewayForwardLatencyMs: null,
      timeout: false, errorCode: null, errorNameZh: null, tags: [],
      rawHex: '02 FD 80 01 00 00 00 07 0E 00 10 00 22 F1 90',
    };
  }

  beforeEach(() => {
    useTraceStore.getState().clear();
  });

  it('applyRepatch 只替换同 seq 条目，不改变条数', () => {
    useTraceStore.getState().ingest([entry(1, '车辆识别代号'), entry(2, '车辆识别代号')]);
    expect(useTraceStore.getState().entries.length).toBe(2);
    useTraceStore.getState().applyRepatch([entry(1, '车架号（已改名）')]);
    const rows = useTraceStore.getState().entries;
    expect(rows.length).toBe(2);
    expect(rows[0]?.uds.didNameZh).toBe('车架号（已改名）');
    expect(rows[1]?.uds.didNameZh).toBe('车辆识别代号');
  });

  it('applyRepatch 对不存在的 seq 无副作用', () => {
    useTraceStore.getState().ingest([entry(1, '车辆识别代号')]);
    useTraceStore.getState().applyRepatch([entry(99, 'x')]);
    expect(useTraceStore.getState().entries.length).toBe(1);
    expect(useTraceStore.getState().entries[0]?.uds.didNameZh).toBe('车辆识别代号');
  });

  it('★ingest 会对已存在的 seq 去重，故 repatch 必须走 applyRepatch', () => {
    useTraceStore.getState().ingest([entry(1, '车辆识别代号')]);
    useTraceStore.getState().ingest([entry(1, '车架号（已改名）')]);
    // ingest 因去重跳过 → 名字不变，证明必须用 applyRepatch
    expect(useTraceStore.getState().entries[0]?.uds.didNameZh).toBe('车辆识别代号');
  });
});

describe('★默认算法选择 selectAlgorithm（QA 终验缺陷 3 + 边界）', () => {
  const list = [
    algo('lib.constant.debug', 'placeholder', false, [1]),
    algo('lib.expression.xor5a', 'placeholder', false, [1]),
    algo('ported.customer.seedkey', 'customer-c', true, [1]),
  ];

  it('无推荐、无手动选择 → 退到第一个非占位算法（不是 placeholder 的 list[0]）', () => {
    const hit = selectAlgorithm(list, {});
    // 三条里两条是 placeholder：第一个非占位的是 customer（已验证）
    expect(hit?.id).toBe('ported.customer.seedkey');
  });

  it('有后端推荐 → 跟随推荐（仿真在跑 = 逐字节异或 0x5A）', () => {
    expect(selectAlgorithm(list, { recommendedId: 'lib.expression.xor5a' })?.id).toBe('lib.expression.xor5a');
  });

  it('★推荐 id 换了（仿真启停触发重拉清单）不覆盖用户手动选择', () => {
    const before = selectAlgorithm(list, { pickedId: 'lib.constant.debug', recommendedId: null });
    const after = selectAlgorithm(list, { pickedId: 'lib.constant.debug', recommendedId: 'lib.expression.xor5a' });
    expect(before?.id).toBe('lib.constant.debug');
    expect(after?.id).toBe('lib.constant.debug');
  });

  it('交还推荐（pickedId=null）后重新跟随后端', () => {
    expect(selectAlgorithm(list, { pickedId: null, recommendedId: 'lib.expression.xor5a' })?.id).toBe(
      'lib.expression.xor5a',
    );
  });

  it('推荐 id 不在本等级列表里 → 保持当前值，不跳变', () => {
    expect(selectAlgorithm(list, { currentId: 'lib.constant.debug', recommendedId: 'nope' })?.id).toBe(
      'lib.constant.debug',
    );
  });

  it('列表只有占位算法时兜底 list[0]（不返回 null 让按钮失效）', () => {
    const only = [algo('only.placeholder', 'placeholder', false, [1])];
    expect(selectAlgorithm(only, {})?.id).toBe('only.placeholder');
    expect(selectAlgorithm([], {})).toBeNull();
  });

  it('store 的 pickedAlgorithmId 往返：pick → 手动 → 交还', () => {
    useLibraryStore.getState().pickAlgorithm('lib.constant.debug');
    expect(useLibraryStore.getState().pickedAlgorithmId).toBe('lib.constant.debug');
    useLibraryStore.getState().pickAlgorithm(null);
    expect(useLibraryStore.getState().pickedAlgorithmId).toBeNull();
  });
});
