import { Alert, Box, Stack, Typography } from '@mui/material';
import type { TraceEntry } from '@doip/shared';

/**
 * 错误解释卡（T11）：NRC / NACK / 超时 三类错误的"是什么 + 常见原因 + 建议动作"。
 * 文案来源优先级：后端 `note`/`nrcHint` > 本地兜底表（保证 M3 还没接服务库时也有解释）。
 */

const NRC_HINTS: Record<number, { what: string; why: string; do: string }> = {
  0x11: {
    what: '服务不支持（ServiceNotSupported）',
    why: '目标 ECU 的服务库里没有该 SID，或当前会话下不允许执行。',
    do: '确认 SID 是否在 ECU 支持列表中；必要时先切到扩展会话。',
  },
  0x12: {
    what: '子功能不支持（SubFunctionNotSupported）',
    why: 'SID 支持，但子功能参数不被支持（含抑制位组合非法）。',
    do: '核对子功能取值与抑制正响应位。',
  },
  0x13: {
    what: '报文长度错误（IncorrectMessageLength）',
    why: '请求字节数与 ECU 期望的不一致。',
    do: '对照服务定义补齐/裁剪参数字节。',
  },
  0x22: {
    what: '条件不满足（ConditionsNotCorrect）',
    why: 'ECU 当前状态不满足执行条件（如车速、电压、会话）。',
    do: '先满足前置条件（例如切会话、停车、上电）再重试。',
  },
  0x31: {
    what: '请求越界（RequestOutOfRange）',
    why: 'DID 不存在或参数值超出允许范围。',
    do: '核对 DID 与参数范围；用 0x22 遍历确认可用 DID。',
  },
  0x33: {
    what: '安全访问被拒绝（SecurityAccessDenied）',
    why: '未通过 0x27 安全解锁，或 Key 错误。',
    do: '先执行 0x27 请求种子并发送正确 Key（T14 接入 Key 算法）。',
  },
  0x35: {
    what: '密钥无效（InvalidKey）',
    why: '发送的 Key 与 ECU 根据 Seed 计算的结果不一致。',
    do: '核对 Seed/Key 算法与字节序（T14 会提供算法注册表与测试向量）。',
  },
  0x36: {
    what: '尝试次数超限（ExceededNumberOfAttempts）',
    why: '连续错误 Key 达到上限，ECU 进入锁定延时。',
    do: '等待锁定时间结束（或断电重启 ECU）后重试。',
  },
  0x37: {
    what: '延时未到（RequiredTimeDelayNotExpired）',
    why: '上次安全访问失败后规定的延时还没走完。',
    do: '等待延时结束后重试。',
  },
  0x78: {
    what: '请求已接收，响应待处理（RequestCorrectlyReceived-ResponsePending）',
    why: 'ECU 处理耗时超过 P2，先回 pending 续命。',
    do: '这是正常中间态：等待最终响应（P2* 上限内）。',
  },
  0x7e: {
    what: '当前会话下子功能不支持',
    why: '该子功能需要切换会话（如编程会话）才可用。',
    do: '先用 0x10 切换会话。',
  },
  0x7f: {
    what: '当前会话下服务不支持',
    why: 'SID 在当前会话被禁用。',
    do: '先用 0x10 切换到允许的会话。',
  },
};

export function ErrorExplainCard({ entry }: { entry: TraceEntry }): JSX.Element | null {
  const { uds, doip, timeout, errorCode, errorNameZh } = entry;

  if (timeout) {
    return (
      <Alert severity="warning" sx={{ fontSize: 12, py: 0.5 }}>
        <Stack spacing={0.25}>
          <Typography variant="body2" sx={{ fontWeight: 700 }}>
            请求超时{errorCode === null ? '' : `（${errorCode}）`}
          </Typography>
          <Typography variant="caption">
            {errorNameZh ??
              (doip.ackCode !== null
                ? '网关已收下并转发（收到 0x8002 ACK），但 ECU 未在 P2 时限内响应'
                : '网关未在时限内返回 ACK/NACK，请求可能未进入网关')}
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            建议：确认目标地址在线、ECU 未处于繁忙/锁定状态；必要时放大 P2 超时或检查故障注入规则。
          </Typography>
        </Stack>
      </Alert>
    );
  }

  if (doip.nackCode !== null) {
    return (
      <Alert severity="error" sx={{ fontSize: 12, py: 0.5 }}>
        <Stack spacing={0.25}>
          <Typography variant="body2" sx={{ fontWeight: 700 }}>
            DoIP NACK {hex2(doip.nackCode)}：{doip.nackNameZh ?? ''}
          </Typography>
          <Typography variant="caption">
            ★这是传输层错误：网关未把报文转发给 ECU，UDS 层还没有被执行（与 NRC 不同，不要按服务问题排查）。
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            建议：检查目标逻辑地址 TA 是否存在、路由激活是否成功、报文长度是否超限。
          </Typography>
        </Stack>
      </Alert>
    );
  }

  if (uds.nrc !== null) {
    const hint = NRC_HINTS[uds.nrc];
    return (
      <Alert severity={uds.nrc === 0x78 ? 'info' : 'error'} sx={{ fontSize: 12, py: 0.5 }}>
        <Stack spacing={0.25}>
          <Typography variant="body2" sx={{ fontWeight: 700 }}>
            NRC {hex2(uds.nrc)}：{uds.nrcNameZh ?? uds.nrcName ?? (hint?.what ?? '否定响应')}
          </Typography>
          {hint === undefined ? (
            <Typography variant="caption">{uds.nrcHint ?? 'ECU 返回了否定响应。'}</Typography>
          ) : (
            <>
              <Typography variant="caption">是什么：{hint.what}</Typography>
              <Typography variant="caption">常见原因：{hint.why}</Typography>
              <Typography variant="caption">建议动作：{hint.do}</Typography>
            </>
          )}
        </Stack>
      </Alert>
    );
  }

  if (errorCode !== null) {
    return (
      <Alert severity="warning" sx={{ fontSize: 12, py: 0.5 }}>
        <Typography variant="caption">
          {errorCode}：{errorNameZh ?? ''}
        </Typography>
      </Alert>
    );
  }

  return (
    <Box>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        该行无错误（正响应或中间确认）
      </Typography>
    </Box>
  );
}

function hex2(v: number): string {
  return `0x${(v & 0xff).toString(16).toUpperCase().padStart(2, '0')}`;
}
