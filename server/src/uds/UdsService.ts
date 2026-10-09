/**
 * UDS 服务（§3.6 / T13）—— ★P0-06 唯一入口。
 *
 * 无论是 B 区表单、原始 hex、周期发送还是 0x27 解锁，
 * 都必须走 `sendUdsRequest()`；P1 的脚本层直接复用本 API，不需要重写协议逻辑。
 */

import { formatHex } from '@doip/shared';
import type { SendUdsRequest, SendUdsResult } from '@doip/shared';
import { AppError } from '../errors/AppError';
import { getLogger } from '../logging/logger';
import type { ConnectionManager } from '../session/ConnectionManager';
import { buildUdsRequestBytes } from '../txn/TransactionManager';
import { UdsEncoder } from './UdsEncoder';

/**
 * ★Phase 0 #4：破坏性 SID 白名单（与 前端 前端 Dialog 同口径）。
 * 0x11 ECU复位 / 0x14 清DTC / 0x2E 写DID / 0x31 例程控制；
 * 0x27 不在这里整服务拦，只拦**偶数子功能（发送密钥）**——取种子（奇数）无破坏性。
 */
const DESTRUCTIVE_SIDS: ReadonlyMap<number, string> = new Map([
  [0x11, '0x11 ECU 复位'],
  [0x14, '0x14 清除诊断信息'],
  [0x2e, '0x2E 写 DID'],
  [0x31, '0x31 例程控制'],
]);

/** 返回危险描述（zh）；非危险返回 null。字节 = buildUdsRequestBytes 的最终事实，原始 hex 无法绕过 */
function describeDestructive(bytes: Uint8Array): string | null {
  const sid = bytes[0];
  if (sid === undefined) return null;
  const named = DESTRUCTIVE_SIDS.get(sid);
  if (named !== undefined) return named;
  if (sid === 0x27) {
    const sub = bytes[1];
    if (sub !== undefined && sub % 2 === 0) return `0x27 安全访问（发送密钥，子功能 0x${sub.toString(16).padStart(2, '0')}）`;
  }
  return null;
}

export class UdsService {
  private readonly log = getLogger('uds.service');

  constructor(private readonly connections: ConnectionManager) {}

  /**
   * 发送一条 UDS 请求。
   *
   * - `rawHex` 优先（原始模式）；非法 hex 立即抛 `E_TXN_REQUEST_INVALID`，绝不静默补零。
   * - 否则按 `sid` 发送（表单模式由前端把字段拼进 `dataHex`，后端不重复造轮子）。
   */
  async sendUdsRequest(req: SendUdsRequest): Promise<SendUdsResult> {
    const normalized: SendUdsRequest = { ...req };
    if (req.rawHex !== undefined && req.rawHex.trim().length > 0) {
      const bytes = UdsEncoder.tryParseRawHex(req.rawHex);
      if (bytes === null) {
        throw new AppError('E_TXN_REQUEST_INVALID', `原始 hex 非法："${req.rawHex}"`, {
          hintZh: 'hex 必须为偶数位十六进制字符，允许空格/0x 前缀',
        });
      }
      normalized.rawHex = formatHex(bytes);
    } else if (req.sid !== undefined && req.sid.trim().length > 0) {
      const sidBytes = UdsEncoder.tryParseRawHex(req.sid);
      if (sidBytes === null || sidBytes.length !== 1) {
        throw new AppError('E_TXN_REQUEST_INVALID', `SID 非法："${req.sid}"`);
      }
    }
    /**
     * ★Phase 0 #4 后端门禁：在**唯一入口**拦，而不是在前端拦完就信任。
     * 用最终要上线的字节判定危险度——原始 hex 与表单模式在这一步完全同权，绕不过去。
     */
    const requestBytes = buildUdsRequestBytes(normalized);
    const danger = describeDestructive(requestBytes);
    if (danger !== null && normalized.confirmed !== true) {
      throw new AppError('E_UDS_CONFIRM_REQUIRED', `危险操作「${danger}」未确认，已拒绝发送`, {
        detail: { danger },
      });
    }
    const result = await this.connections.sendUds(normalized);
    this.log.info('UDS 请求已发送', {
      sid: req.sid ?? null,
      raw: req.rawHex ?? null,
      ok: result.ok,
      state: result.state,
    });
    return result;
  }
}
