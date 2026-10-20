import { useCallback } from 'react';
import { Alert, IconButton, Snackbar, Stack } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { useConnectionStore } from '../../store/useConnectionStore';
import { useTraceStore } from '../../store/useTraceStore';
import { useT } from '../../i18n';

/**
 * 通知宿主（T11，P0-14）：展示最近一条错误，点击"跳转"可定位到 Trace 行。
 */
export function SnackHost(): JSX.Element {
  const errors = useConnectionStore((s) => s.errors);
  const select = useTraceStore((s) => s.select);
  const t = useT();

  const last = errors.at(-1) ?? null;

  const handleClose = useCallback((): void => {
    useConnectionStore.getState().clearErrors();
  }, []);

  const handleJump = useCallback((): void => {
    if (last?.linkedSeq !== undefined) {
      select(last.linkedSeq);
    }
    handleClose();
  }, [handleClose, last, select]);

  const severity = last?.severity === 'error' ? 'error' : last?.severity === 'warn' ? 'warning' : 'info';

  return (
    <Snackbar
      open={last !== null}
      autoHideDuration={last?.severity === 'error' ? null : 4000}
      onClose={handleClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      sx={{ bottom: 56 }}
    >
      {last === null ? (
        <span />
      ) : (
        <Alert
          severity={severity}
          onClose={handleClose}
          action={
            <Stack direction="row" spacing={0.5} alignItems="center">
              {last.linkedSeq === undefined ? null : (
                <IconButton size="small" color="inherit" onClick={handleJump} title={t('跳转到对应 Trace 行')}>
                  <span style={{ fontSize: 12 }}>{t('跳转')}</span>
                </IconButton>
              )}
              <IconButton size="small" color="inherit" onClick={handleClose}>
                <CloseIcon fontSize="small" />
              </IconButton>
            </Stack>
          }
        >
          {last.messageZh}
          {last.hintZh === undefined ? '' : ` — ${last.hintZh}`}
        </Alert>
      )}
    </Snackbar>
  );
}

/** 供外部（如故障注入成功后）主动提示 */
export function notify(message: string, severity: 'info' | 'warn' | 'error' = 'info'): void {
  useConnectionStore.getState().pushError({ code: 'E_UI_NOTICE', messageZh: message, severity });
}
