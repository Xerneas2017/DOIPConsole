import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  FormControlLabel,
  IconButton,
  MenuItem,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';
import SendIcon from '@mui/icons-material/Send';
import { compactHex, tryParseHex } from '@doip/shared';
import type { FormField, ServiceDef } from '@doip/shared';
import { useLibraryStore, serviceLabel, sortedServices } from '../../store/useLibraryStore';
import { usePersistedState } from '../../hooks/usePersistedState';
import { sendCommand } from '../../ws/useWsConnection';
import { useT } from '../../i18n';
import type { TKey } from '../../i18n';

/**
 * B 区服务请求区（T13）。
 *
 * - 库驱动动态表单 + 原始 hex 双模式；hex 预览与实际发出字节**同一份字符串**。
 * - 寻址切换（物理 / 功能 0x1FFF）。
 * - ★B17：破坏性服务（0x11/0x14/0x2E/0x31…）发送前强制二次确认 + 红色警示。
 * - 周期发送与收藏夹（localStorage）。
 */

type Mode = 'form' | 'raw';

interface Favorite {
  id: string;
  label: string;
  hex: string;
  addressing: 'physical' | 'functional';
}

const DESTRUCTIVE_KEYS: Record<string, TKey> = {
  '0x11': 'ECU 会复位，正在进行的诊断会话与其它 tester 连接会被打断',
  '0x14': 'ECU 内已存储的 DTC 与快照数据会被永久清除，不可恢复',
  '0x2E': '会写入 ECU 的非易失存储，写错值可能导致 ECU 功能异常',
  '0x31': '会启动/停止 ECU 内部例程，可能影响执行机构动作',
  '0x27': '发送密钥错误会计入 ECU 解锁尝试计数，连续失败可能触发延迟惩罚甚至临时封禁（NRC 0x35/0x36）',
};

function normalizeHexInput(text: string): string {
  const bytes = tryParseHex(text);
  return bytes === null ? '' : compactHex(text);
}

function parseCodeValue(text: string): number | null {
  const bytes = tryParseHex(text.replace(/^0[xX]/, ''));
  if (bytes === null || bytes.length === 0) return null;
  let value = 0;
  for (const b of bytes) value = (value << 8) | (b & 0xff);
  return value;
}

/** 表单值 → 字节（与后端 `buildUdsRequestBytes` 口径一致：sid + sub + dids + data） */
function buildRequestHex(svc: ServiceDef, values: Record<string, string>): string {
  const parts: string[] = [compactHex(svc.id.replace(/^0[xX]/, ''))];
  for (const field of svc.form) {
    const raw = values[field.name] ?? '';
    if (raw.trim() === '') {
      if (field.optional === true) continue;
      if (field.role === 'subFunction') continue;
      continue;
    }
    parts.push(compactHex(raw));
  }
  return parts.join('');
}

export function ServiceRequestPanel(): JSX.Element {
  const library = useLibraryStore((s) => s.library);
  const services = useMemo(() => sortedServices(library), [library]);

  const [mode, setMode] = useState<Mode>('form');
  const [sid, setSid] = useState<string>('0x10');
  const [addressing, setAddressing] = useState<'physical' | 'functional'>('physical');
  const [values, setValues] = useState<Record<string, string>>({});
  const [rawHex, setRawHex] = useState<string>('10 03');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [periodMs, setPeriodMs] = useState(1000);
  const [periodicOn, setPeriodicOn] = useState(false);
  const timerRef = useRef<number | null>(null);
  const [favorites, setFavorites] = usePersistedState<Favorite[]>('doip.favorites', []);
  const t = useT();

  const svc = useMemo(
    () => services.find((s) => s.id.toUpperCase() === sid.toUpperCase()) ?? null,
    [services, sid],
  );

  // 切换服务时重建表单默认值
  useEffect(() => {
    if (svc === null) return;
    const next: Record<string, string> = {};
    for (const field of svc.form) {
      next[field.name] = field.values?.[0]?.value ?? '';
    }
    setValues(next);
  }, [svc]);

  const previewHex = useMemo(() => {
    if (mode === 'raw') return normalizeHexInput(rawHex);
    if (svc === null) return '';
    return buildRequestHex(svc, values);
  }, [mode, rawHex, svc, values]);

  const hexError = useMemo(() => {
    if (previewHex === '') return t('报文为空');
    if (previewHex.length % 2 !== 0) return t('hex 位数必须为偶数');
    return null;
  }, [previewHex, t]);

  /**
   * ★#4（交叉评审① + 评审裁定进本批）：危险判定不再限定 raw 模式——
   * 两模式 doSend 发的是同一份 previewHex（最终上线字节），按字节判定即与后端
   * describeDestructive 完全同构；库内置 0x27 表单（未标 destructive 的 SendKey 选项）
   * 也先弹 B17，而不是静默被后端 E_UDS_CONFIRM_REQUIRED 拒发。
   */
  const isDestructive = isDestructiveRequest(svc, previewHex);

  const stopPeriodic = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setPeriodicOn(false);
  }, []);

  useEffect(() => () => stopPeriodic(), [stopPeriodic]);

  const doSend = useCallback((confirmed = false): void => {
    sendCommand('uds.send', {
      addressing,
      rawHex: previewHex,
      expectResponse: true,
      // ★#4：只有用户过了 B17 强确认对话框才置 confirmed:true——
      // 与后端 UdsService 门禁同口径（危险请求缺它一律 E_UDS_CONFIRM_REQUIRED 拒绝）。
      ...(confirmed ? { confirmed: true } : {}),
    });
  }, [addressing, previewHex]);

  const onSendClick = useCallback((): void => {
    if (hexError !== null) return;
    if (isDestructive) {
      setConfirmOpen(true);
      return;
    }
    doSend();
  }, [doSend, hexError, isDestructive]);

  const togglePeriodic = useCallback((): void => {
    if (periodicOn) {
      stopPeriodic();
      return;
    }
    if (hexError !== null) return;
    if (isDestructive) {
      setConfirmOpen(true);
      return;
    }
    const id = window.setInterval(doSend, Math.max(50, periodMs));
    timerRef.current = id;
    setPeriodicOn(true);
  }, [doSend, hexError, isDestructive, periodMs, periodicOn, stopPeriodic]);

  const favorited = favorites.some((f) => f.hex === previewHex);
  const toggleFavorite = useCallback((): void => {
    if (previewHex === '') return;
    if (favorited) {
      setFavorites(favorites.filter((f) => f.hex !== previewHex));
      return;
    }
    setFavorites([
      ...favorites,
      {
        id: `fav-${Date.now().toString(36)}`,
        label: svc === null ? previewHex : svc.shortEn,
        hex: previewHex,
        addressing,
      },
    ]);
  }, [addressing, favorites, favorited, previewHex, setFavorites, svc]);

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ px: 1, py: 0.5, flexWrap: 'wrap' }}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={mode}
          onChange={(_e, next: Mode | null) => {
            if (next !== null) setMode(next);
          }}
        >
          <ToggleButton value="form">{t('表单')}</ToggleButton>
          <ToggleButton value="raw">{t('原始 hex')}</ToggleButton>
        </ToggleButtonGroup>

        {mode === 'form' ? (
          <TextField
            select
            size="small"
            label={t('服务')}
            value={sid}
            onChange={(e) => setSid(e.target.value)}
            sx={{ minWidth: 260 }}
            SelectProps={{ MenuProps: { PaperProps: { sx: { maxHeight: 360 } } } }}
          >
            {services.map((s) => (
              <MenuItem key={s.id} value={s.id}>
                {serviceLabel(s)}
                {s.destructive === true ? '　⚠' : ''}
              </MenuItem>
            ))}
          </TextField>
        ) : null}

        <ToggleButtonGroup
          size="small"
          exclusive
          value={addressing}
          onChange={(_e, next: 'physical' | 'functional' | null) => {
            if (next !== null) setAddressing(next);
          }}
        >
          <ToggleButton value="physical">{t('物理寻址')}</ToggleButton>
          <ToggleButton value="functional">{t('功能寻址 0x1FFF')}</ToggleButton>
        </ToggleButtonGroup>

        <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 1 }}>
          <Tooltip title={favorited ? t('取消收藏') : t('加入收藏夹')}>
            <IconButton size="small" onClick={toggleFavorite}>
              {favorited ? <StarIcon fontSize="small" color="warning" /> : <StarBorderIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
          <Button
            size="small"
            variant="contained"
            color={isDestructive ? 'error' : 'primary'}
            startIcon={<SendIcon fontSize="small" />}
            disabled={hexError !== null}
            onClick={onSendClick}
          >
            {t('发送')}
          </Button>
          <Button size="small" variant={periodicOn ? 'outlined' : 'text'} onClick={togglePeriodic}>
            {periodicOn ? t('停止周期') : t('周期发送')}
          </Button>
          {periodicOn ? (
            <TextField
              size="small"
              type="number"
              label={t('周期(ms)')}
              value={periodMs}
              onChange={(e) => setPeriodMs(Number(e.target.value) || 1000)}
              sx={{ width: 96 }}
            />
          ) : null}
        </Box>
      </Stack>

      <Divider />

      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', px: 1, py: 0.5 }}>
        {mode === 'form' && svc !== null ? (
          <FormFields
            svc={svc}
            values={values}
            onChange={(name, value) => setValues((prev) => ({ ...prev, [name]: value }))}
          />
        ) : null}
        {mode === 'raw' ? (
          <TextField
            fullWidth
            size="small"
            label={t('原始 hex — 可发任意报文，不限于服务库里的条目')}
            placeholder={t('例如：14 FF FF FF（清除全部 DTC）　22 F1 90（读 VIN）')}
            value={rawHex}
            error={tryParseHex(rawHex) === null}
            helperText={
              tryParseHex(rawHex) === null
                ? t('非法 hex：必须为偶数位十六进制字符（空格与 0x 前缀会被忽略）')
                : t('按字节原样发送；服务库里有该服务时会自动带上解码与破坏性确认')
            }
            onChange={(e) => setRawHex(e.target.value)}
            inputProps={{ className: 'mono', spellCheck: false }}
          />
        ) : null}

        {favorites.length > 0 ? (
          <Stack direction="row" spacing={0.5} sx={{ mt: 1, flexWrap: 'wrap', gap: 0.5 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', mr: 0.5 }}>
              {t('收藏夹：')}
            </Typography>
            {favorites.map((f) => (
              <Chip
                key={f.id}
                size="small"
                label={`${f.label} ${f.hex}`}
                onDelete={() => setFavorites(favorites.filter((x) => x.id !== f.id))}
                onClick={() => {
                  setMode('raw');
                  setRawHex(f.hex);
                  setAddressing(f.addressing);
                }}
              />
            ))}
          </Stack>
        ) : null}
      </Box>

      <Box
        sx={{
          px: 1,
          py: 0.5,
          borderTop: '1px solid',
          borderColor: 'divider',
          display: 'flex',
          alignItems: 'center',
          gap: 1,
        }}
      >
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {t('预览 hex（与实际发出字节逐字节一致）')}
        </Typography>
        <Box
          className="mono"
          sx={{
            flex: 1,
            fontSize: 12,
            px: 1,
            py: 0.25,
            borderRadius: 0.5,
            bgcolor: 'action.hover',
            color: hexError === null ? 'text.primary' : 'error.main',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {previewHex === '' ? '—' : formatGrouped(previewHex)}
        </Box>
        {hexError !== null ? (
          <Typography variant="caption" color="error">
            {hexError}
          </Typography>
        ) : null}
        {isDestructive ? (
          <Chip size="small" color="error" label={t('破坏性服务')} />
        ) : null}
      </Box>

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <DialogTitle sx={{ color: 'error.main' }}>{t('⚠ 破坏性操作二次确认')}</DialogTitle>
        <DialogContent>
          <DialogContentText component="div">
            <Typography variant="body2" sx={{ mb: 1 }}>
              {/* ★原始 hex 模式下必须报"原始报文"，不能拿表单模式残留的服务名——
                  否则用户发 14 FF FF FF，确认框却写"即将发送 DSC(0x10)"，会以为发错了 */}
              {t('即将发送')} <b>{mode === 'raw' ? t('原始报文') : svc === null ? previewHex : serviceLabel(svc)}</b>：
            </Typography>
            <Box className="mono" sx={{ fontSize: 12, bgcolor: 'action.hover', p: 1, borderRadius: 0.5 }}>
              {formatGrouped(previewHex)}
            </Box>
            <Typography variant="body2" sx={{ mt: 1, color: 'error.main' }}>
              {mode === 'raw'
                ? t('已按字节原样发送，不做任何补位或改写。请确认目标 ECU 支持该请求。')
                : t(DESTRUCTIVE_KEYS[sid.toUpperCase()] ?? '该服务会改变 ECU 状态或数据，且不可撤销。')}
            </Typography>
            <FormControlLabel
              sx={{ mt: 1 }}
              control={<Switch defaultChecked />}
              label={t('我确认已评估影响（此确认不替代鉴权）')}
            />
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>{t('取消')}</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => {
              setConfirmOpen(false);
              doSend(true);
            }}
          >
            {t('确认发送')}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

function FormFields({
  svc,
  values,
  onChange,
}: {
  svc: ServiceDef;
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
}): JSX.Element {
  const library = useLibraryStore((s) => s.library);
  const didOptions = library?.didTable ?? [];

  return (
    <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
      {svc.form.map((field) => (
        <FieldInput
          key={field.name}
          field={field}
          value={values[field.name] ?? ''}
          didOptions={didOptions.map((d) => ({ value: d.id, name: d.name, nameZh: d.nameZh }))}
          onChange={(v) => onChange(field.name, v)}
        />
      ))}
    </Stack>
  );
}

function FieldInput({
  field,
  value,
  didOptions,
  onChange,
}: {
  field: FormField;
  value: string;
  didOptions: Array<{ value: string; name: string; nameZh: string }>;
  onChange: (value: string) => void;
}): JSX.Element {
  const options = field.widget === 'didSelect' ? didOptions : (field.values ?? []);
  const isHexWidget = field.widget === 'hex';
  const invalid = isHexWidget && value.trim() !== '' && tryParseHex(value) === null;
  const t = useT();
  const optionalSuffix = field.optional === true ? t('（可选）') : '';
  const hexSuffix = field.widget === 'hex' ? t('（hex）') : '';

  if (options.length > 0) {
    return (
      <TextField
        select
        size="small"
        label={`${field.name}${optionalSuffix}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        sx={{ minWidth: 220 }}
      >
        {options.map((o) => (
          <MenuItem key={o.value} value={o.value}>
            {`${o.value} ${o.nameZh}`}
          </MenuItem>
        ))}
      </TextField>
    );
  }

  return (
    <TextField
      size="small"
      label={`${field.name}${hexSuffix}${optionalSuffix}`}
      value={value}
      error={invalid}
      helperText={invalid ? t('非法 hex') : ' '}
      onChange={(e) => onChange(e.target.value)}
      inputProps={{ className: 'mono', spellCheck: false }}
      sx={{ minWidth: isHexWidget ? 200 : 140 }}
    />
  );
}

function formatGrouped(hex: string): string {
  const out: string[] = [];
  for (let i = 0; i < hex.length; i += 2) out.push(hex.slice(i, i + 2));
  return out.join(' ');
}

/**
 * ★#4 与后端 UdsService.describeDestructive **同口径**的危险判定（供单测直接打）：
 * 0x11/0x14/0x2E/0x31 + 0x27 偶数子功能（发送密钥）。
 * 口径不一致时前端会漏弹确认框 → 后端直接拒发（E_UDS_CONFIRM_REQUIRED）。
 */
export function isDestructiveHex(hex: string): boolean {
  const clean = hex.replace(/\s+/g, '');
  const code = parseCodeValue(clean.slice(0, 2));
  if (code === null) return false;
  if ([0x11, 0x14, 0x2e, 0x31].includes(code)) return true;
  if (code === 0x27) {
    const sub = parseCodeValue(clean.slice(2, 4));
    return sub !== null && sub % 2 === 0;
  }
  return false;
}

/**
 * ★#4 组合口径（纯函数，供单测直接打）：库标记 destructive 或**最终字节危险**都算。
 * 与模式无关——表单模式经 buildRequestHex 产出的也是同一份上线字节（交叉评审①的教训：
 * 库内置 0x27 表单可能未标 destructive，必须靠字节判定兜住）。
 */
export function isDestructiveRequest(
  svc: { destructive?: boolean } | null,
  previewHex: string,
): boolean {
  return svc?.destructive === true || isDestructiveHex(previewHex);
}
