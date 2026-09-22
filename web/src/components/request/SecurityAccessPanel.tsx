import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import LockOpenIcon from '@mui/icons-material/LockOpen';
import CalculateIcon from '@mui/icons-material/Calculate';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { formatHex, tryParseHex } from '@doip/shared';
import type { KeyAlgorithmDescriptor } from '@doip/shared';
import { algorithmsForLevel, selectAlgorithm, useLibraryStore } from '../../store/useLibraryStore';
import { sendCommand } from '../../ws/useWsConnection';

/**
 * 0x27 解锁面板 + 算法试算（T14）。
 *
 * - 算法下拉：`ported` 在前、`placeholder` 排最后并打灰标「待替换」；`verified` 打绿勾。
 * - 试算：输入 Seed → 显示 Key，并与向量期望值**同屏对照**。
 * - `verified=false` 时橙色提示"解锁可能失败（NRC 0x35）"。
 */

export function SecurityAccessPanel(): JSX.Element {
  const algorithms = useLibraryStore((s) => s.algorithms);
  const vectors = useLibraryStore((s) => s.vectors);
  const recommendedId = useLibraryStore((s) => s.recommendedId);
  const trial = useLibraryStore((s) => s.trial);
  const unlock = useLibraryStore((s) => s.unlock);

  /**
   * ★QA 终验边界：把"用户是否手动选过"放进 store（而不是组件局部 state）。
   *   ① 后端重拉清单（仿真启停会触发）时不会悄悄覆盖用户的选择；
   *   ② 切走页签再回来，用户的选择不会丢。
   */
  const pickedAlgorithmId = useLibraryStore((s) => s.pickedAlgorithmId);
  const pickAlgorithm = useLibraryStore((s) => s.pickAlgorithm);
  const picked = pickedAlgorithmId !== null;

  const [level, setLevel] = useState(1);
  const [algorithmId, setAlgorithmId] = useState('');
  const [seedHex, setSeedHex] = useState('A1 B2 C3 D4');

  const list = useMemo(() => algorithmsForLevel(algorithms, level), [algorithms, level]);
  /**
   * ★QA 终验缺陷 3：默认算法的选择口径。
   * 原来是 `list[0]`（= 占位算法），一键解锁开箱必吃 NRC 0x35。
   * 现在按：后端推荐 → 第一个非占位 → list[0]（兜底，列表里只有占位时）。
   */
  const selected: KeyAlgorithmDescriptor | null = useMemo(
    () =>
      selectAlgorithm(list, {
        currentId: algorithmId,
        recommendedId,
        pickedId: pickedAlgorithmId,
      }),
    [list, algorithmId, recommendedId, pickedAlgorithmId],
  );

  useEffect(() => {
    if (selected !== null && (!picked && selected.id !== algorithmId)) {
      setAlgorithmId(selected.id);
    }
  }, [algorithmId, selected, picked]);

  const seedInvalid = tryParseHex(seedHex) === null;

  const onTrial = useCallback((): void => {
    if (selected === null) return;
    sendCommand('keyAlgo.trial', { algorithmId: selected.id, level, seedHex });
  }, [level, seedHex, selected]);

  const onUnlock = useCallback((): void => {
    if (selected === null) return;
    sendCommand('security.unlock', { level, keyAlgorithmId: selected.id });
  }, [level, selected]);

  return (
    <Box
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        gap: 0.5,
        py: 0.5,
        // ★安全网：内容超过可用高度时必须可滚动。
        //   曾因没有这条，"解锁成功"Alert 被外层 overflow:hidden 裁掉，用户看不到结果。
        overflowY: 'auto',
      }}
    >
      <Stack direction="row" spacing={1} alignItems="center" sx={{ px: 1, flexWrap: 'wrap' }}>
        <TextField
          select
          size="small"
          label="安全等级"
          value={String(level)}
          onChange={(e) => setLevel(Number(e.target.value))}
          sx={{ minWidth: 120 }}
        >
          {[1, 2, 3, 4, 5].map((l) => (
            <MenuItem key={l} value={String(l)}>
              {`Level ${l}`}
            </MenuItem>
          ))}
        </TextField>

        <TextField
          select
          size="small"
          label="Key 算法"
          value={selected?.id ?? ''}
          onChange={(e) => {
            setAlgorithmId(e.target.value);
            pickAlgorithm(e.target.value);
          }}
          sx={{ minWidth: 300 }}
        >
          {list.map((a) => (
            <MenuItem key={a.id} value={a.id} sx={{ opacity: a.origin === 'placeholder' ? 0.75 : 1 }}>
              <Stack direction="row" spacing={0.5} alignItems="center">
                <span>{a.nameZh}</span>
                {isPlaceholder(a) ? (
                  <Chip size="small" label="待替换" sx={{ height: 18, fontSize: 10 }} />
                ) : a.provider !== 'ported' ? (
                  <Chip size="small" variant="outlined" label={a.provider} sx={{ height: 18, fontSize: 10 }} />
                ) : null}
                {a.verified ? <CheckCircleIcon fontSize="small" color="success" /> : null}
              </Stack>
            </MenuItem>
          ))}
        </TextField>

        {picked ? (
          <Tooltip title="已手动指定，点此交还给后端推荐（仿真/已验证算法）">
            <IconButton
              size="small"
              onClick={() => {
                pickAlgorithm(null);
              }}
            >
              <RestartAltIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        ) : null}

        <Button
          size="small"
          variant="contained"
          startIcon={<LockOpenIcon fontSize="small" />}
          onClick={onUnlock}
          disabled={selected === null}
        >
          一键解锁
        </Button>
      </Stack>

      {/**
       * ★解锁结果紧跟在按钮下方，并且 `flexShrink: 0`。
       *
       * 这是用户最关心的反馈，必须**不用滚动就能看到**。曾经排在面板最末尾，
       * 而根节点又没有 overflow:auto，内容一多就被外层裁掉 —— 用户报的就是这个。
       */}
      {unlock !== null ? (
        <Box sx={{ px: 1, flexShrink: 0 }}>
          <Alert
            severity={unlock.ok ? 'success' : 'error'}
            sx={{ py: 0.25, '& .MuiAlert-message': { py: 0.25 } }}
          >
            {unlock.ok
              ? `解锁成功（Level ${unlock.level}，Seed ${unlock.seedHex ?? '—'} → Key ${unlock.keyHex ?? '—'}）`
              : `解锁失败：${unlock.note ?? unlock.errorCode ?? '未知原因'}`}
          </Alert>
        </Box>
      ) : null}

      {selected !== null ? (
        <Box sx={{ px: 1 }}>
          <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
            <Chip size="small" label={`适用等级 ${selected.appliesToLevels.join('/') || '不限'}`} />
            <Chip size="small" label={`Seed ${selected.seedLengthBytes ?? '不限'} 字节`} />
            <Chip size="small" label={`Key ${selected.keyLengthBytes ?? '与 Seed 等长'}`} />
            <Chip
              size="small"
              color={isPlaceholder(selected) ? 'default' : 'success'}
              label={isPlaceholder(selected) ? '占位实现' : selected.provider === 'ported' ? '移植算法' : `库定义 ${selected.provider}`}
            />
          </Stack>
          {selected.notes !== undefined ? (
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5 }}>
              {selected.notes}
            </Typography>
          ) : null}
          {isPlaceholder(selected) && !selected.verified ? (
            <Alert severity="warning" sx={{ mt: 0.5, py: 0 }}>
              该算法未通过测试向量校验，解锁可能失败（NRC 0x35）
            </Alert>
          ) : null}
        </Box>
      ) : null}

      <Divider />

      {/* 试算 */}
      <Stack direction="row" spacing={1} alignItems="center" sx={{ px: 1 }}>
        <TextField
          size="small"
          label="Seed（hex）"
          value={seedHex}
          error={seedInvalid}
          helperText={seedInvalid ? '非法 hex' : ' '}
          onChange={(e) => setSeedHex(e.target.value)}
          inputProps={{ className: 'mono', spellCheck: false }}
          sx={{ minWidth: 220 }}
        />
        <Button
          size="small"
          variant="outlined"
          startIcon={<CalculateIcon fontSize="small" />}
          onClick={onTrial}
          disabled={selected === null || seedInvalid}
        >
          试算
        </Button>
      </Stack>

      {trial !== null ? (
        <Box sx={{ px: 1 }}>
          <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap' }}>
            <Field label="算出 Key" value={trial.keyHex ?? '—'} mono />
            <Field
              label="向量期望值"
              value={trial.expectedKeyHex ?? '（无对照向量）'}
              mono
              muted={trial.expectedKeyHex === null}
            />
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              {trial.matched === null ? null : trial.matched ? (
                <>
                  <CheckCircleIcon fontSize="small" color="success" />
                  <Typography variant="caption" color="success.main">
                    与期望值一致
                  </Typography>
                </>
              ) : (
                <>
                  <CancelIcon fontSize="small" color="error" />
                  <Typography variant="caption" color="error">
                    与期望值不一致
                  </Typography>
                </>
              )}
            </Box>
          </Stack>
          {trial.messageZh !== null ? (
            <Tooltip title={trial.messageZh}>
              <Typography variant="caption" sx={{ color: 'warning.main', display: 'block', mt: 0.5 }}>
                {trial.messageZh}
              </Typography>
            </Tooltip>
          ) : null}
          {trial.errorCode !== null ? (
            <Typography variant="caption" color="error" sx={{ display: 'block' }}>
              {`${trial.errorCode}：${trial.messageZh ?? ''}`}
            </Typography>
          ) : null}
        </Box>
      ) : null}

      {vectors.length > 0 ? (
        <Box sx={{ px: 1, overflow: 'auto', minHeight: 0 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            测试向量（{vectors.length} 条）
          </Typography>
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', mt: 0.25 }}>
            {vectors.slice(0, 8).map((v) => (
              <Chip
                key={v.id}
                size="small"
                variant="outlined"
                className="mono"
                label={`${v.seedHex} → ${v.expectedKeyHex}`}
                onClick={() => setSeedHex(v.seedHex)}
              />
            ))}
          </Stack>
        </Box>
      ) : null}
    </Box>
  );
}

function Field({
  label,
  value,
  mono,
  muted,
}: {
  label: string;
  value: string;
  /** exactOptionalPropertyTypes：显式声明可传 undefined */
  mono?: boolean | undefined;
  muted?: boolean | undefined;
}): JSX.Element {
  return (
    <Box>
      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
        {label}
      </Typography>
      <Typography
        variant="body2"
        className={mono === true ? 'mono' : ''}
        sx={{ color: muted === true ? 'text.disabled' : 'text.primary' }}
      >
        {value}
      </Typography>
    </Box>
  );
}

/** ★只有注册表里的具名移植算法才有"占位/已校验"语义；库定义的兜底算法按 provider 展示 */
function isPlaceholder(a: KeyAlgorithmDescriptor): boolean {
  return a.provider === 'ported' && a.origin === 'placeholder';
}

/** 供库编辑器复用：把字节数组显示为大写空格分隔 */
export function showKey(bytes: Uint8Array | null): string {
  return bytes === null ? '—' : formatHex(bytes);
}
