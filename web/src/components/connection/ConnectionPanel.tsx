import { useState } from 'react';
import { Box, Button, Divider, Paper, Stack, Typography } from '@mui/material';
import { sendCommand } from '../../ws/useWsConnection';
import { useUiStore } from '../../store/useUiStore';
import { HexInput } from '../common/HexInput';
import { ConnectionPanelSections } from './ConnectionPanelSections';
import { EntityDiscoveryList } from './EntityDiscoveryList';
import { RoutingActivationCard } from './RoutingActivationCard';
import { SessionSecurityCard } from './SessionSecurityCard';
import { SimEcuControl } from './FaultInjectDialog';

/**
 * A 区容器（T11，PRD §6.2）：仿真控制 + 发现列表 + SA/TA + 路由激活卡片 + 会话/解锁卡片。
 * 宽度与折叠状态由 AppShell 控制（左栏固定 ~320 px，可折叠）。
 *
 * ★布局顺序是有意为之：「仿真 ECU 控制」放在**最上面**。
 *   实测（577px 高视口）：面板内容 781px 装进 505px 的可滚动容器，
 *   原本放在末尾的「启动」按钮被压在可视区外——用户看不到它，直接点顶部工具栏的
 *   「连接」，就会拿到 `ECONNREFUSED`（目标主动拒绝 TCP 连接），还以为是工具坏了。
 *   仿真控制必须先被看到。
 */
export function ConnectionPanel(): JSX.Element {
  return (
    <Paper
      square
      elevation={0}
      sx={{
        height: '100%',
        overflowY: 'auto',
        bgcolor: 'background.paper',
        borderRight: '1px solid',
        borderColor: 'divider',
      }}
    >
      <Stack spacing={1} sx={{ p: 1 }}>
        <ConnectionPanelSections title="仿真 ECU 控制" plain>
          <SimEcuControl />
        </ConnectionPanelSections>

        <Divider />

        <ConnectionPanelSections title="已发现实体">
          <EntityDiscoveryList />
        </ConnectionPanelSections>

        <Divider />

        <ConnectionPanelSections title="SA / TA">
          <TargetAddressField />
        </ConnectionPanelSections>

        <Divider />

        <ConnectionPanelSections title="路由激活" plain>
          <RoutingActivationCard />
        </ConnectionPanelSections>

        <Divider />

        <ConnectionPanelSections title="会话与解锁" plain>
          <SessionSecurityCard />
        </ConnectionPanelSections>
      </Stack>
    </Paper>
  );
}

/** SA / TA：TA 切换走 `target.set`，★Q4 —— 不重建 socket */
function TargetAddressField(): JSX.Element {
  const sa = useUiStore((s) => s.sa);
  const ta = useUiStore((s) => s.ta);
  const setTarget = useUiStore((s) => s.setTarget);
  const [draft, setDraft] = useState(ta);

  return (
    <Box>
      <HexInput label="SA（ tester 逻辑地址）" value={sa} onChange={(v) => setTarget({ sa: v })} expectedBytes={2} />
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', mt: 0.5 }}>
        <HexInput label="TA（目标逻辑地址）" value={draft} onChange={setDraft} expectedBytes={2} />
        <Button
          size="small"
          variant="outlined"
          sx={{ mt: 0.25, whiteSpace: 'nowrap' }}
          onClick={() => {
            setTarget({ ta: draft });
            sendCommand('target.set', { ta: draft });
          }}
        >
          应用
        </Button>
      </Box>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        TA 切换走 target.set，不重建连接（Q4）
      </Typography>
    </Box>
  );
}
