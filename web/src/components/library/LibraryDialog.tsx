import { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import DownloadIcon from '@mui/icons-material/Download';
import UploadIcon from '@mui/icons-material/Upload';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import SaveIcon from '@mui/icons-material/Save';
import type { UdsLibrary } from '@doip/shared';
import {
  useLibraryStore,
  type LibraryEditorTab,
  type LibraryValidationIssue,
} from '../../store/useLibraryStore';
import { sendCommand } from '../../ws/useWsConnection';

/**
 * F 区服务库编辑器（T12）。
 *
 * 六个页签：服务 / 子功能 / DID / NRC / 别名 / Key 算法。
 * ★保存走 `library.update`，被拒时把后端的 issues（含行号）原样展示，绝不静默。
 */

type Row = Record<string, string | boolean>;

interface ColumnDef {
  key: string;
  label: string;
  type: 'text' | 'hex' | 'bool' | 'select';
  width: number;
  options?: string[];
}

const TABS: Array<{ id: LibraryEditorTab; label: string }> = [
  { id: 'services', label: '服务' },
  { id: 'subFunctions', label: '子功能' },
  { id: 'dids', label: 'DID' },
  { id: 'nrc', label: 'NRC' },
  { id: 'aliases', label: '地址别名' },
  { id: 'keyAlgorithms', label: 'Key 算法' },
];

export function LibraryDialog(): JSX.Element {
  const open = useLibraryStore((s) => s.editorOpen);
  const library = useLibraryStore((s) => s.library);
  const draft = useLibraryStore((s) => s.draft);
  const tab = useLibraryStore((s) => s.editorTab);
  const issues = useLibraryStore((s) => s.issues);
  const setEditorTab = useLibraryStore((s) => s.setEditorTab);
  const setDraft = useLibraryStore((s) => s.setDraft);
  const setIssues = useLibraryStore((s) => s.setIssues);
  const closeEditor = useLibraryStore((s) => s.closeEditor);

  const working: UdsLibrary | null = draft ?? library;

  const mutate = useCallback(
    (fn: (lib: UdsLibrary) => void): void => {
      if (working === null) return;
      const next: UdsLibrary = JSON.parse(JSON.stringify(working)) as UdsLibrary;
      fn(next);
      setDraft(next);
    },
    [setDraft, working],
  );

  const onSave = useCallback((): void => {
    if (working === null) return;
    setIssues([]);
    sendCommand('library.update', { library: working });
  }, [setIssues, working]);

  const onExport = useCallback((): void => {
    if (working === null) return;
    const blob = new Blob([JSON.stringify(working, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'uds-library.json';
    a.click();
    URL.revokeObjectURL(url);
  }, [working]);

  const onImport = useCallback((): void => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file === undefined) return;
      void file.text().then((text) => {
        try {
          const parsed = JSON.parse(text) as UdsLibrary;
          setIssues([]);
          sendCommand('library.update', { library: parsed });
        } catch {
          setIssues([
            { path: '', line: 0, column: 0, messageZh: '导入的文件不是合法 JSON', severity: 'error' },
          ]);
        }
      });
    };
    input.click();
  }, [setIssues]);

  const onReset = useCallback((): void => {
    setIssues([]);
    sendCommand('library.reset', { scope: 'builtin' });
  }, [setIssues]);

  return (
    <Dialog open={open} onClose={closeEditor} maxWidth="lg" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        服务库编辑器
        <Chip size="small" label="改动后下一次解码立即生效，并 repatch 最近 2000 条" />
        <Box sx={{ ml: 'auto', display: 'flex', gap: 0.5 }}>
          <Tooltip title="导出 JSON">
            <IconButton size="small" onClick={onExport}>
              <DownloadIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="导入 JSON">
            <IconButton size="small" onClick={onImport}>
              <UploadIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="重置为内置基线">
            <IconButton size="small" onClick={onReset}>
              <RestartAltIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
      </DialogTitle>

      <Tabs
        value={tab}
        onChange={(_e, next: LibraryEditorTab) => setEditorTab(next)}
        variant="scrollable"
        sx={{ px: 2, borderBottom: 1, borderColor: 'divider' }}
      >
        {TABS.map((t) => (
          <Tab key={t.id} value={t.id} label={t.label} />
        ))}
      </Tabs>

      <DialogContent dividers sx={{ minHeight: 320 }}>
        {issues.length > 0 ? <IssueList issues={issues} /> : null}
        {working === null ? (
          <Alert severity="info">服务库尚未加载</Alert>
        ) : tab === 'services' ? (
          <ServicesTab lib={working} mutate={mutate} />
        ) : tab === 'subFunctions' ? (
          <SubFunctionsTab lib={working} mutate={mutate} />
        ) : tab === 'dids' ? (
          <TableTab
            rows={working.didTable as unknown as Row[]}
            columns={[
              { key: 'id', label: 'DID', type: 'hex', width: 110 },
              { key: 'name', label: '英文名', type: 'text', width: 260 },
              { key: 'nameZh', label: '中文名', type: 'text', width: 240 },
              { key: 'codec', label: '编码', type: 'select', width: 120, options: ['ascii', 'hex', 'uint8', 'uint16', 'uint32', 'bcd', 'raw'] },
              { key: 'builtin', label: '内置', type: 'bool', width: 70 },
            ]}
            mutate={(rows) =>
              mutate((lib) => {
                lib.didTable = rows as unknown as UdsLibrary['didTable'];
              })
            }
          />
        ) : tab === 'nrc' ? (
          <TableTab
            rows={working.nrcTable as unknown as Row[]}
            columns={[
              { key: 'code', label: '码值', type: 'hex', width: 100 },
              { key: 'name', label: '英文名', type: 'text', width: 320 },
              { key: 'nameZh', label: '中文名', type: 'text', width: 200 },
              { key: 'hint', label: '处置建议', type: 'text', width: 260 },
              { key: 'severity', label: '级别', type: 'select', width: 110, options: ['error', 'warn', 'info'] },
              { key: 'builtin', label: '内置', type: 'bool', width: 70 },
            ]}
            mutate={(rows) =>
              mutate((lib) => {
                lib.nrcTable = rows as unknown as UdsLibrary['nrcTable'];
              })
            }
          />
        ) : tab === 'aliases' ? (
          <TableTab
            rows={working.addressing.aliases as unknown as Row[]}
            columns={[
              { key: 'address', label: '逻辑地址', type: 'hex', width: 130 },
              { key: 'alias', label: '别名', type: 'text', width: 260 },
              { key: 'builtin', label: '内置', type: 'bool', width: 70 },
            ]}
            mutate={(rows) =>
              mutate((lib) => {
                lib.addressing.aliases = rows as unknown as UdsLibrary['addressing']['aliases'];
              })
            }
          />
        ) : (
          <KeyAlgorithmsTab lib={working} mutate={mutate} />
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={closeEditor}>关闭</Button>
        <Button
          variant="contained"
          startIcon={<SaveIcon fontSize="small" />}
          onClick={onSave}
          disabled={working === null}
        >
          保存（校验后入库）
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function IssueList({ issues }: { issues: LibraryValidationIssue[] }): JSX.Element {
  return (
    <Alert severity="error" sx={{ mb: 1 }}>
      <Typography variant="subtitle2">服务库被拒绝，已保留原库（{issues.length} 处问题）</Typography>
      <Box component="ul" sx={{ m: 0, pl: 2, maxHeight: 120, overflow: 'auto' }}>
        {issues.slice(0, 20).map((issue, i) => (
          <li key={`${issue.path}-${String(i)}`}>
            <Typography variant="caption" className="mono">
              {issue.line > 0 ? `第 ${issue.line} 行第 ${issue.column} 列 · ` : ''}
              {issue.path} · {issue.messageZh}
            </Typography>
          </li>
        ))}
      </Box>
    </Alert>
  );
}

/* ─────────────── 通用可编辑表 ─────────────── */

function TableTab({
  rows,
  columns,
  mutate,
}: {
  rows: Row[];
  columns: ColumnDef[];
  mutate: (rows: Row[]) => void;
}): JSX.Element {
  const update = (index: number, key: string, value: string | boolean): void => {
    const next = rows.map((row, i) => (i === index ? { ...row, [key]: value } : row));
    mutate(next);
  };
  const remove = (index: number): void => {
    mutate(rows.filter((_, i) => i !== index));
  };
  const add = (): void => {
    const blank: Row = {};
    for (const col of columns) blank[col.key] = col.type === 'bool' ? false : '';
    mutate([...rows, blank]);
  };

  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
        <Button size="small" startIcon={<AddIcon fontSize="small" />} onClick={add}>
          新增
        </Button>
        <Typography variant="caption" sx={{ color: 'text.secondary', alignSelf: 'center' }}>
          共 {rows.length} 条
        </Typography>
      </Stack>
      <Box sx={{ maxHeight: 340, overflow: 'auto' }}>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: `32px ${columns.map((c) => `${String(c.width)}px`).join(' ')}`,
            gap: 0.5,
            alignItems: 'center',
          }}
        >
          <Box />
          {columns.map((c) => (
            <Typography key={c.key} variant="caption" sx={{ fontWeight: 700, color: 'text.secondary' }}>
              {c.label}
            </Typography>
          ))}
          {rows.map((row, i) => (
            <RowCells
              key={`row-${String(i)}`}
              row={row}
              columns={columns}
              index={i}
              onChange={update}
              onRemove={remove}
            />
          ))}
        </Box>
      </Box>
    </Box>
  );
}

function RowCells({
  row,
  columns,
  index,
  onChange,
  onRemove,
}: {
  row: Row;
  columns: ColumnDef[];
  index: number;
  onChange: (index: number, key: string, value: string | boolean) => void;
  onRemove: (index: number) => void;
}): JSX.Element {
  return (
    <>
      <IconButton size="small" onClick={() => onRemove(index)}>
        <DeleteIcon fontSize="small" />
      </IconButton>
      {columns.map((col) => {
        const value = row[col.key];
        if (col.type === 'bool') {
          return (
            <Chip
              key={col.key}
              size="small"
              variant={value === true ? 'filled' : 'outlined'}
              label={value === true ? '内置' : '自定义'}
              onClick={() => onChange(index, col.key, !(value === true))}
            />
          );
        }
        return (
          <TextField
            key={col.key}
            size="small"
            select={col.type === 'select'}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(index, col.key, e.target.value)}
            inputProps={{ className: col.type === 'hex' ? 'mono' : undefined, spellCheck: false }}
          >
            {(col.options ?? []).map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </TextField>
        );
      })}
    </>
  );
}

/* ─────────────── 服务（含短名） ─────────────── */

function ServicesTab({
  lib,
  mutate,
}: {
  lib: UdsLibrary;
  mutate: (fn: (lib: UdsLibrary) => void) => void;
}): JSX.Element {
  const columns: ColumnDef[] = [
    { key: 'id', label: 'SID', type: 'hex', width: 90 },
    { key: 'shortEn', label: 'shortEn(≤5)', type: 'text', width: 110 },
    { key: 'shortZh', label: 'shortZh(≤6)', type: 'text', width: 120 },
    { key: 'nameZh', label: '中文全名', type: 'text', width: 200 },
    { key: 'builtin', label: '内置', type: 'bool', width: 70 },
  ];
  return (
    <TableTab
      rows={lib.services as unknown as Row[]}
      columns={columns}
      mutate={(rows) =>
        mutate((next) => {
          next.services = rows as unknown as UdsLibrary['services'];
        })
      }
    />
  );
}

/* ─────────────── 子功能 ─────────────── */

function SubFunctionsTab({
  lib,
  mutate,
}: {
  lib: UdsLibrary;
  mutate: (fn: (lib: UdsLibrary) => void) => void;
}): JSX.Element {
  const [sid, setSid] = useState(lib.services[0]?.id ?? '');
  const svc = useMemo(
    () => lib.services.find((s) => s.id.toUpperCase() === sid.toUpperCase()) ?? lib.services[0] ?? null,
    [lib.services, sid],
  );
  const field = svc?.form.find((f) => f.role === 'subFunction') ?? null;
  const rows = useMemo<Row[]>(
    () => (field?.values ?? []) as unknown as Row[],
    [field],
  );

  const setRows = (next: Row[]): void => {
    mutate((nextLib) => {
      const target = nextLib.services.find((s) => s.id.toUpperCase() === sid.toUpperCase());
      if (target === undefined) return;
      const f = target.form.find((x) => x.role === 'subFunction');
      if (f === undefined) return;
      f.values = next as unknown as NonNullable<typeof f.values>;
    });
  };

  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
        <TextField
          select
          size="small"
          label="所属服务"
          value={svc?.id ?? ''}
          onChange={(e) => setSid(e.target.value)}
          sx={{ minWidth: 280 }}
        >
          {lib.services.map((s) => (
            <option key={s.id} value={s.id}>
              {`${s.shortEn}(${s.id.toUpperCase()}) ${s.nameZh}`}
            </option>
          ))}
        </TextField>
      </Stack>
      {field === null ? (
        <Alert severity="info">该服务没有子功能字段</Alert>
      ) : (
        <TableTab
          rows={rows}
          columns={[
            { key: 'value', label: '值', type: 'hex', width: 100 },
            { key: 'name', label: '英文名', type: 'text', width: 280 },
            { key: 'nameZh', label: '中文名', type: 'text', width: 240 },
          ]}
          mutate={setRows}
        />
      )}
    </Box>
  );
}

/* ─────────────── Key 算法 ─────────────── */

function KeyAlgorithmsTab({
  lib,
  mutate,
}: {
  lib: UdsLibrary;
  mutate: (fn: (lib: UdsLibrary) => void) => void;
}): JSX.Element {
  return (
    <Box>
      <Alert severity="info" sx={{ mb: 1 }}>
        `ported` 类算法是注册表里的具名移植算法（源码在服务端，JSON 里只读展示 + 选择）；
        可编辑的是 <b>constant / expression / javascript</b> 三类兜底。
      </Alert>
      <Box sx={{ maxHeight: 300, overflow: 'auto' }}>
        {lib.keyAlgorithms.map((algo, i) => (
          <Box key={algo.id} sx={{ mb: 1 }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Chip size="small" label={algo.type} />
              <Typography variant="body2">{algo.name}</Typography>
              <Typography variant="caption" className="mono" sx={{ color: 'text.secondary' }}>
                {algo.id}
              </Typography>
              {algo.type === 'ported' ? (
                <Chip size="small" variant="outlined" label={`引用 ${algo.algorithmId}`} />
              ) : null}
              <Box sx={{ ml: 'auto' }}>
                <IconButton
                  size="small"
                  onClick={() =>
                    mutate((next) => {
                      next.keyAlgorithms = next.keyAlgorithms.filter((_, k) => k !== i);
                    })
                  }
                >
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Box>
            </Stack>
            {algo.type === 'javascript' ? (
              <TextField
                fullWidth
                multiline
                minRows={3}
                size="small"
                className="mono"
                value={algo.source}
                onChange={(e) =>
                  mutate((next) => {
                    const target = next.keyAlgorithms[i];
                    if (target !== undefined && target.type === 'javascript') target.source = e.target.value;
                  })
                }
              />
            ) : null}
            <Divider sx={{ mt: 1 }} />
          </Box>
        ))}
      </Box>
      <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
        <Button
          size="small"
          startIcon={<AddIcon fontSize="small" />}
          onClick={() =>
            mutate((next) => {
              next.keyAlgorithms.push({
                id: `lib.javascript.custom-${Date.now().toString(36)}`,
                name: '自定义 JS 算法',
                type: 'javascript',
                source: 'var out=new Uint8Array(seed.length);for(var i=0;i<seed.length;i++){out[i]=helpers.toU8(seed[i]);}return out;',
              });
            })
          }
        >
          新增 JS 算法
        </Button>
        <Button
          size="small"
          onClick={() =>
            mutate((next) => {
              next.keyAlgorithms.push({
                id: `lib.constant.custom-${Date.now().toString(36)}`,
                name: '自定义常量密钥',
                type: 'constant',
                params: { keyHex: '00 00 00 00' },
              });
            })
          }
        >
          新增常量密钥
        </Button>
      </Stack>
    </Box>
  );
}
