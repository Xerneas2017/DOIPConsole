/**
 * 静态托管测试（§1.2）：证明后端能单端口提供前端界面，且不吞 API、不越界。
 *
 * 这里刻意起**真实 http server**（而不是 mock req/res）——因为要验证的是
 * 「路径解析 + 回退规则 + 安全边界」在真实请求下的行为。
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaticHandler } from '../bridge/staticFiles';

let root: string;
let server: ReturnType<typeof createServer>;
let base: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'doip-static-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>DoIP Console</title>');
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'assets', 'index-abc.js'), 'console.log(1);');

  const handler = createStaticHandler(root);
  server = createServer((req, res) => {
    if (req.url === '/api/health') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (handler(req, res)) return;
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'not-found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

const get = async (path: string): Promise<{ status: number; type: string; body: string; cache: string }> => {
  const res = await fetch(`${base}${path}`);
  return {
    status: res.status,
    type: res.headers.get('content-type') ?? '',
    cache: res.headers.get('cache-control') ?? '',
    body: await res.text(),
  };
};

describe('TC-S01 静态托管：单端口提供前端界面', () => {
  it('根路径返回 index.html（HTML + 不缓存）', async () => {
    const r = await get('/');
    expect(r.status).toBe(200);
    expect(r.type).toContain('text/html');
    expect(r.body).toContain('DoIP Console');
    // 入口 HTML 必须 no-cache，否则升级后前端拿到旧壳
    expect(r.cache).toBe('no-cache');
  });

  it('assets 下的构建产物可长缓存', async () => {
    const r = await get('/assets/index-abc.js');
    expect(r.status).toBe(200);
    expect(r.type).toContain('text/javascript');
    expect(r.cache).toContain('immutable');
    expect(r.body).toContain('console.log');
  });

  it('★SPA 回退：无扩展名的未知路径回 index.html（前端路由）', async () => {
    const r = await get('/some/deep/route');
    expect(r.status).toBe(200);
    expect(r.body).toContain('DoIP Console');
  });

  it('★有扩展名的缺失文件必须是 404，不能回成 HTML', async () => {
    const r = await get('/assets/missing.png');
    expect(r.status).toBe(404);
    expect(r.body).not.toContain('DoIP Console');
  });
});

describe('TC-S02 静态托管：不能破坏 API', () => {
  it('★/api/health 仍由 API 处理，未被静态托管吞掉', async () => {
    const r = await get('/api/health');
    expect(r.status).toBe(200);
    expect(r.body).toContain('"ok":true');
  });

  it('★未匹配的 /api/* 返回 JSON 404，而不是 SPA 的 HTML', async () => {
    const r = await get('/api/download/exp-nope');
    expect(r.status).toBe(404);
    expect(r.body).not.toContain('DoIP Console');
  });
});

describe('TC-S03 静态托管：安全边界', () => {
  it('★路径穿越被拒（编码与非编码两种写法）', async () => {
    const plain = await get('/../../../../etc/passwd');
    expect(plain.body).not.toContain('root:');
    const encoded = await get('/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd');
    expect(encoded.body).not.toContain('root:');
    expect([403, 404]).toContain(encoded.status);
  });

  it('DOIP_WEB_DIST 未指向真实目录时不报错，放行给上层 404', async () => {
    const missing = createStaticHandler(join(tmpdir(), 'doip-static-does-not-exist-xyz'));
    const fakeRes = {
      statusCode: 0,
      headersSent: false,
      setHeader: () => undefined,
      end: () => undefined,
    } as unknown as Parameters<typeof missing>[1];
    const handled = missing({ method: 'GET', url: '/' } as never, fakeRes);
    expect(handled).toBe(false);
  });
});
