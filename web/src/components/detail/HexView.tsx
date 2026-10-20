import { useMemo, useState } from 'react';
import { Box, Stack, Tooltip, Typography } from '@mui/material';
import { tryParseHex } from '@doip/shared';
import { useT } from '../../i18n';

/**
 * Hex 视图（T11）：与解码树**双向高亮**。
 * - 选中树节点 → 高亮该字段字节；
 * - 点击/悬浮 hex 字节 → 反向定位到字段（回调 onPickByte）。
 */

export interface HexViewProps {
  hex: string;
  /** 高亮区间 [start, end)（相对整帧首字节的偏移） */
  highlight: [number, number] | null;
  onPickByte?: (offset: number) => void;
  bytesPerRow?: number;
}

export function HexView({ hex, highlight, onPickByte, bytesPerRow = 16 }: HexViewProps): JSX.Element {
  const bytes = useMemo(() => tryParseHex(hex) ?? new Uint8Array(0), [hex]);
  const [hover, setHover] = useState<number | null>(null);
  const t = useT();

  const rows: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += bytesPerRow) {
    rows.push(bytes.subarray(i, Math.min(i + bytesPerRow, bytes.length)));
  }

  return (
    <Box sx={{ overflowX: 'auto', fontFamily: 'monospace', fontSize: 11, lineHeight: 1.5 }}>
      {rows.map((row, rowIndex) => {
        const base = rowIndex * bytesPerRow;
        return (
          <Stack key={rowIndex} direction="row" spacing={1} sx={{ whiteSpace: 'pre' }}>
            <Box component="span" sx={{ color: 'text.secondary', width: 56 }}>
              {base.toString(16).toUpperCase().padStart(8, '0')}
            </Box>
            <Box component="span">
              {Array.from(row).map((b, i) => {
                const offset = base + i;
                const inHighlight =
                  highlight !== null && offset >= highlight[0] && offset < highlight[1];
                const isHover = hover === offset;
                return (
                  <Tooltip
                    key={offset}
                    title={t('偏移 {offset}（0x{hex}）', {
                      offset,
                      hex: offset.toString(16).toUpperCase(),
                    })}
                  >
                    <Box
                      component="span"
                      onClick={() => onPickByte?.(offset)}
                      onMouseEnter={() => setHover(offset)}
                      onMouseLeave={() => setHover(null)}
                      sx={{
                        px: 0.25,
                        cursor: onPickByte === undefined ? 'default' : 'pointer',
                        bgcolor: inHighlight ? '#2f5d8a' : isHover ? '#263349' : undefined,
                        color: inHighlight ? '#ffffff' : undefined,
                        borderRadius: '2px',
                      }}
                    >
                      {b.toString(16).toUpperCase().padStart(2, '0')}
                    </Box>
                  </Tooltip>
                );
              })}
            </Box>
            <Box component="span" sx={{ color: 'text.secondary' }}>
              {asciiOf(row)}
            </Box>
          </Stack>
        );
      })}
      {bytes.length === 0 ? (
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {t('无数据')}
        </Typography>
      ) : null}
    </Box>
  );
}

function asciiOf(row: Uint8Array): string {
  let out = '';
  for (const b of row) out += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.';
  return out;
}
