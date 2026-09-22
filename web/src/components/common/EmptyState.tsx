import { Box, Typography } from '@mui/material';

/** 空状态占位（T08/T11） */
export function EmptyState({
  title,
  hint,
  height,
}: {
  title: string;
  hint?: string;
  height?: number | string;
}): JSX.Element {
  return (
    <Box
      sx={{
        height: height ?? '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'text.secondary',
        gap: 0.5,
        p: 2,
        textAlign: 'center',
      }}
    >
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {title}
      </Typography>
      {hint === undefined ? null : (
        <Typography variant="caption" sx={{ opacity: 0.8, maxWidth: 420 }}>
          {hint}
        </Typography>
      )}
    </Box>
  );
}
