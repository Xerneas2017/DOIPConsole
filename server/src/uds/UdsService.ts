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
import { UdsEncoder } from './UdsEncoder';

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
