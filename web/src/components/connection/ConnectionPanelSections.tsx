import type { ReactNode } from 'react';
import { Box, Typography } from '@mui/material';

/** A 区小节容器：带标题；`plain` 时标题不带下划线（内容自带标题） */
export function ConnectionPanelSections({
  title,
  children,
  plain = false,
}: {
  title: string;
  children: ReactNode;
  plain?: boolean;
}): JSX.Element {
  return (
    <Box>
      <Typography
        variant="caption"
        sx={{
          fontWeight: 700,
          color: 'text.secondary',
          display: 'block',
          mb: plain ? 0.25 : 0.5,
          borderBottom: plain ? undefined : '1px solid',
          borderColor: 'divider',
          pb: plain ? 0 : 0.25,
        }}
      >
        {title}
      </Typography>
      {children}
    </Box>
  );
}
