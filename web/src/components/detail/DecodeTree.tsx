import { useMemo } from 'react';
import { Box, Typography } from '@mui/material';
import type { DecodeNode, TraceEntry } from '@doip/shared';

/**
 * 三层解码树（T11，PRD §6.2 D 区）：
 *   DoIP Header / DoIP Payload / UDS
 * 叶节点显示「偏移 · 字段名 · 值 · 含义」。
 *
 * ★T12 的 `UdsDecoder` 接入后 `entry.uds.tree` 才有完整节点；
 *   在此之前用 DoIP 层的确定性字段兜底，保证 D 区始终可用（不阻塞 M3 验收）。
 */

export interface TreeRow {
  depth: number;
  offset: number;
  length: number;
  field: string;
  valueHex: string;
  nameZh: string | null;
  meaning: string | null;
}

function flatten(node: DecodeNode, depth: number, base: number, out: TreeRow[]): void {
  out.push({
    depth,
    offset: base + node.offset,
    length: node.length,
    field: node.field,
    valueHex: node.valueHex,
    nameZh: node.nameZh ?? node.shortZh ?? null,
    meaning: node.meaning ?? null,
  });
  for (const child of node.children ?? []) {
    flatten(child, depth + 1, base + node.offset, out);
  }
}

/** 构造三层树（DoIP 头固定 8 字节；UDS 位于 payload 之后） */
export function buildDecodeRows(entry: TraceEntry): { rows: TreeRow[]; udsBase: number } {
  const rows: TreeRow[] = [];
  const d = entry.doip;

  rows.push({ depth: 0, offset: 0, length: 8, field: 'DoIP Header', valueHex: d.headerHex, nameZh: 'DoIP 通用头（8 字节）', meaning: null });
  rows.push({ depth: 1, offset: 0, length: 1, field: 'protocolVersion', valueHex: hex2(d.protocolVersion), nameZh: '协议版本', meaning: d.protocolVersion === 0x02 ? 'ISO 13400-2:2012' : 'ISO 13400-2:2019' });
  rows.push({ depth: 1, offset: 1, length: 1, field: 'inverseProtocolVersion', valueHex: hex2(~d.protocolVersion & 0xff), nameZh: '反码版本', meaning: d.inverseVersionValid ? '校验通过（异或 = 0xFF）' : '★反码校验失败' });
  rows.push({ depth: 1, offset: 2, length: 2, field: 'payloadType', valueHex: hex4be(d.payloadType), nameZh: d.payloadTypeNameZh, meaning: `${d.payloadTypeName}（0x${d.payloadType.toString(16).toUpperCase().padStart(4, '0')}）` });
  rows.push({ depth: 1, offset: 4, length: 4, field: 'payloadLength', valueHex: hex4be(d.payloadLength), nameZh: '负载长度', meaning: `${d.payloadLength} 字节` });

  // DoIP Payload 层（按 payloadType 列出已知字段）
  if (d.sourceAddress !== null || d.targetAddress !== null) {
    rows.push({ depth: 0, offset: 8, length: d.payloadLength, field: 'DoIP Payload', valueHex: '', nameZh: d.payloadTypeNameZh, meaning: null });
    if (d.sourceAddress !== null) {
      rows.push({ depth: 1, offset: 8, length: 2, field: 'sourceAddress', valueHex: hex4be(d.sourceAddress), nameZh: d.sourceAddressName, meaning: null });
    }
    if (d.targetAddress !== null) {
      rows.push({ depth: 1, offset: 10, length: 2, field: 'targetAddress', valueHex: hex4be(d.targetAddress), nameZh: d.targetAddressName, meaning: null });
    }
  }
  if (d.ackCode !== null) {
    rows.push({ depth: 1, offset: 12, length: 1, field: 'ackCode', valueHex: hex2(d.ackCode), nameZh: d.ackNameZh, meaning: null });
  }
  if (d.nackCode !== null) {
    rows.push({ depth: 1, offset: 12, length: 1, field: 'nackCode', valueHex: hex2(d.nackCode), nameZh: d.nackNameZh, meaning: '★网关未转发，不是 UDS 层错误' });
  }
  if (d.activationResponseCode !== null) {
    rows.push({ depth: 1, offset: 12, length: 1, field: 'routingActivationResponseCode', valueHex: hex2(d.activationResponseCode), nameZh: d.activationResponseCodeZh, meaning: null });
  }
  if (d.vin !== null) {
    rows.push({ depth: 1, offset: 12, length: 17, field: 'vin', valueHex: '', nameZh: 'VIN', meaning: d.vin });
  }

  // UDS 层：T12 接入后走 tree；此前用顶层字段兜底
  const udsBase = 8 + (d.sourceAddress !== null ? 4 : 0);
  const uds = entry.uds;
  const hasUds = uds.serviceId !== null || uds.nrc !== null;
  if (hasUds) {
    rows.push({ depth: 0, offset: udsBase, length: Math.max(0, d.payloadLength - (udsBase - 8)), field: 'UDS', valueHex: '', nameZh: uds.serviceName ?? 'UDS', meaning: uds.shortZh ?? null });
    if (uds.tree !== null) {
      flatten(uds.tree, 1, udsBase, rows);
    } else {
      if (uds.serviceId !== null) {
        rows.push({ depth: 1, offset: udsBase, length: 1, field: 'sid', valueHex: hex2(uds.serviceId), nameZh: uds.serviceName, meaning: uds.shortEn });
      }
      if (uds.subFunction !== null) {
        rows.push({ depth: 1, offset: udsBase + 1, length: 1, field: 'subFunction', valueHex: hex2(uds.subFunction), nameZh: uds.subFunctionNameZh ?? uds.subFunctionName, meaning: uds.suppressPositiveResponse ? '抑制正响应位已置起' : null });
      }
      if (uds.did !== null) {
        rows.push({ depth: 1, offset: udsBase + (uds.subFunction === null ? 1 : 2), length: 2, field: 'dataIdentifier', valueHex: hex4be(uds.did), nameZh: uds.didNameZh ?? uds.didName, meaning: null });
      }
      if (uds.nrc !== null) {
        rows.push({ depth: 1, offset: udsBase + 2, length: 1, field: 'nrc', valueHex: hex2(uds.nrc), nameZh: uds.nrcNameZh ?? uds.nrcName, meaning: uds.nrcHint });
      }
      for (const p of uds.params) {
        rows.push({ depth: 1, offset: udsBase + p.offset, length: 1, field: p.name, valueHex: p.value, nameZh: null, meaning: null });
      }
      rows.push({ depth: 1, offset: udsBase, length: 0, field: '（T12 完整解码树待接入）', valueHex: '', nameZh: null, meaning: '当前为兜底字段，T12 服务库接入后自动补齐' });
    }
  }

  return { rows, udsBase };
}

function hex2(v: number): string {
  return (v & 0xff).toString(16).toUpperCase().padStart(2, '0');
}

function hex4be(v: number): string {
  const hi = (v >> 8) & 0xff;
  const lo = v & 0xff;
  return `${hex2(hi)} ${hex2(lo)}`;
}

export function DecodeTree({
  rows,
  highlight,
  onHoverRange,
}: {
  rows: TreeRow[];
  highlight: [number, number] | null;
  onHoverRange: (range: [number, number] | null, offset: number | null) => void;
}): JSX.Element {
  const rowsOut = useMemo(() => rows, [rows]);
  return (
    <Box sx={{ overflowY: 'auto', fontFamily: 'monospace', fontSize: 11 }}>
      {rowsOut.map((r, index) => {
        const inRange =
          highlight !== null && r.offset < highlight[1] && r.offset + Math.max(1, r.length) > highlight[0];
        return (
          <Box
            key={`${r.field}-${r.offset}-${index}`}
            onMouseEnter={() => onHoverRange([r.offset, r.offset + Math.max(1, r.length)], r.offset)}
            onMouseLeave={() => onHoverRange(null, null)}
            sx={{
              display: 'flex',
              gap: 1,
              whiteSpace: 'nowrap',
              py: 0.1,
              pl: r.depth * 12,
              bgcolor: inRange ? '#263349' : undefined,
              borderLeft: inRange ? '2px solid #4f9cf9' : '2px solid transparent',
            }}
          >
            <Box component="span" sx={{ color: 'text.secondary', width: 58 }}>
              [{r.offset}]
            </Box>
            <Box component="span" sx={{ width: 190, color: r.depth === 0 ? 'primary.main' : 'text.primary' }}>
              {r.field}
            </Box>
            <Box component="span" sx={{ width: 96, color: 'warning.main' }}>
              {r.valueHex}
            </Box>
            <Box component="span" sx={{ color: 'text.secondary' }}>
              {r.nameZh ?? ''}
              {r.meaning === null || r.meaning === '' ? '' : ` — ${r.meaning}`}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

export function DecodeTreeEmpty(): JSX.Element {
  return (
    <Typography variant="caption" sx={{ color: 'text.secondary' }}>
      在 C 区选择一行报文查看三层解码
    </Typography>
  );
}
