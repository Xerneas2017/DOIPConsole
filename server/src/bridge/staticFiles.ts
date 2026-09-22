/**
 * 静态文件服务（§1.2「HTTP 静态托管」）——让后端单端口同时提供 API 与前端界面。
 *
 * 目的：`npm run build` 产出的 `web/dist` 由后端直接托管，用户只需启动一个进程、
 * 打开一个地址（http://127.0.0.1:8787），不必再并行起 Vite、也不会有
 * 「Vite 代理指向了另一支后端」这类端口漂移问题。
 *
 * 约束：
 * - ★Q11：只在 127.0.0.1 上监听（由 WsServer 保证），这里不涉及绑定。
 * - **必须让位于 `/api/*`**：任何 API 请求都不能被静态处理吞掉（否则下载/健康检查会 404 或返回 HTML）。
 * - **路径穿越防护**：解析后的绝对路径必须仍在 root 内，`../` 与编码绕过一律 403。
 * - `dist` 不存在时**不报错退出**，只 warn 一次并放行给上层 404 —— 便于后端在纯 API 模式下独立运行。
 * - SPA 回退：无扩展名的未知路径回 `index.html`（前端路由），有扩展名的直接 404（避免把图片缺失也回成 HTML）。
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getLogger } from '../logging/logger';

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};

export type StaticHandler = (req: IncomingMessage, res: ServerResponse) => boolean;

/**
 * 创建静态文件处理器。返回 `true` 表示已响应（调用方不要再处理），
 * `false` 表示"这不是静态资源"，交由调用方继续（例如回 404 JSON）。
 */
export function createStaticHandler(rootDir: string): StaticHandler {
  const log = getLogger('bridge.static');
  const rootAbs = resolve(rootDir);
  let distMissingLogged = false;

  const indexPath = resolve(rootAbs, 'index.html');

  return function serveStatic(req: IncomingMessage, res: ServerResponse): boolean {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;

    const rawUrl = req.url ?? '/';
    // ★API 优先：绝不吞掉 /api/*
    if (rawUrl === '/api' || rawUrl.startsWith('/api/')) return false;

    if (!existsSync(rootAbs)) {
      if (!distMissingLogged) {
        distMissingLogged = true;
        log.warn('前端产物不存在，静态托管已跳过（请先执行 npm run build）', { root: rootAbs });
      }
      return false;
    }

    const pathOnly = rawUrl.split('?')[0] ?? '/';
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathOnly);
    } catch {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'bad-uri' }));
      return true;
    }

    // 去掉前导分隔符，禁止绝对路径逃逸
    const rel = decoded.replace(/^[/\\]+/, '');
    const target = resolve(rootAbs, rel);

    // ★路径穿越防护：必须仍在 root 内
    if (target !== rootAbs && !target.startsWith(rootAbs + sep)) {
      log.warn('静态请求越界，已拒绝', { url: pathOnly });
      res.statusCode = 403;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'forbidden' }));
      return true;
    }

    let filePath = target;
    if (rel === '' || rel.endsWith('/')) filePath = resolve(target, 'index.html');

    if (existsSync(filePath) && statSync(filePath).isFile()) {
      sendFile(filePath, res);
      return true;
    }

    // 未命中：有扩展名 → 确实不存在；无扩展名 → SPA 回退到 index.html
    if (extname(rel) !== '') {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'not-found' }));
      return true;
    }

    if (existsSync(indexPath)) {
      sendFile(indexPath, res);
      return true;
    }
    return false;
  };
}

function sendFile(filePath: string, res: ServerResponse): void {
  const ext = extname(filePath).toLowerCase();
  const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
  res.setHeader('content-type', mime);

  // 带内容哈希的构建产物（assets/）可长缓存；入口 HTML 必须不缓存，否则升级后拿到旧壳
  if (filePath.includes(`${sep}assets${sep}`)) {
    res.setHeader('cache-control', 'public, max-age=31536000, immutable');
  } else {
    res.setHeader('cache-control', 'no-cache');
  }

  if (res.req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'read-failed' }));
    } else {
      res.end();
    }
  });
  stream.pipe(res);
}
