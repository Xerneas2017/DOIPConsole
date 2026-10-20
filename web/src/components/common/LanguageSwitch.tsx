import { ToggleButton, ToggleButtonGroup, Tooltip } from '@mui/material';
import { LANG_OPTIONS, useI18nStore, useT } from '../../i18n';
import type { Lang } from '../../i18n';

/**
 * 语言切换（中文 / English / Deutsch）。
 *
 * ★放在工具栏最右侧（WS 状态灯之前）：这是"全局设置"类控件，
 *   不参与任何诊断操作，不打断从左到右的操作流。
 * ★选择持久化到 localStorage（key: doip.lang），刷新/重启后保持。
 */
export function LanguageSwitch(): JSX.Element {
  const lang = useI18nStore((s) => s.lang);
  const setLang = useI18nStore((s) => s.setLang);
  const t = useT();

  return (
    <ToggleButtonGroup
      size="small"
      exclusive
      value={lang}
      onChange={(_e, next: Lang | null) => {
        if (next !== null) setLang(next);
      }}
      aria-label={t('简体中文')}
      sx={{ flexShrink: 0 }}
    >
      {LANG_OPTIONS.map((option) => (
        <Tooltip key={option.value} title={t(option.labelKey)}>
          <ToggleButton
            value={option.value}
            sx={{ px: 1, py: 0.15, fontSize: 11, minWidth: 30, lineHeight: 1.6 }}
          >
            {option.short}
          </ToggleButton>
        </Tooltip>
      ))}
    </ToggleButtonGroup>
  );
}
