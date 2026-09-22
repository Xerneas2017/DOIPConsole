import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Alert, Box, Button } from '@mui/material';

/**
 * 局部错误边界（T11）：某一区崩溃时不带崩整个界面。
 */

interface Props {
  children: ReactNode;
  /** 出错区域的名称，便于定位 */
  zone: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error(`[${this.props.zone}] 组件崩溃`, error, info.componentStack);
  }

  private handleReset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <Box sx={{ p: 2 }}>
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={this.handleReset}>
              重试
            </Button>
          }
        >
          {this.props.zone} 渲染失败：{error.message}
        </Alert>
      </Box>
    );
  }
}
