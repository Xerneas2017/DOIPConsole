/**
 * 临时助手：通过 WS 启动仿真 ECU（供命令行互操作测试用，不依赖浏览器）。
 * 用法：node .sim-up.mjs [后端端口，默认 8787]
 */
import WebSocket from 'ws';

const PORT = Number(process.argv[2] ?? 8787);
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);

const done = (code, msg) => {
  console.log(msg);
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  process.exit(code);
};

const timer = setTimeout(() => done(1, '[FAIL] 超时：仿真未在 12s 内就绪'), 12000);

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'sim.start', id: 'sim-up', payload: {} }));
});

ws.on('message', (d) => {
  const env = JSON.parse(d.toString());
  if (env.type === 'sim.status' && env.payload?.running === true) {
    clearTimeout(timer);
    done(0, `[OK] 仿真 ECU 已启动，端口 ${env.payload.port}，实体 ${env.payload.entities?.length ?? '?'} 个`);
  }
  if (env.type === 'error') {
    clearTimeout(timer);
    done(1, `[FAIL] 后端返回错误：${JSON.stringify(env.payload).slice(0, 200)}`);
  }
});

ws.on('error', (err) => {
  clearTimeout(timer);
  done(1, `[FAIL] WS 连接失败：${err.message}`);
});
