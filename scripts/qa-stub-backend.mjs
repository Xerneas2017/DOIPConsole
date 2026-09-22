/**
 * QA 桩后端（仅用于浏览器验证，不写入仓库）。
 *
 * 目的：工作树当前后端无法启动（server/src/uds/algorithms/KeyAlgorithmRegistry.ts
 * 的相对 import 路径错误，见 QA 报告），为验证「前端断连后自动重连 + 补齐」这一
 * 前端行为，用桩替代后端的 WS 契约：
 *   - 收到 session.hello → 回 hello + trace.batch（3 条真实形状的 TraceEntry）
 *   - 其它指令回 cmd.ack
 * 只实现前端 M3 需要的契约，不代表后端实现。
 */
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = 8787;
const EMPTY_UDS = { decoded: false, serviceId: null, serviceName: null, shortEn: null, shortZh: null, isPositive: false, messageKind: 'unknown', subFunction: null, subFunctionName: null, subFunctionNameZh: null, suppressPositiveResponse: false, did: null, didName: null, didNameZh: null, nrc: null, nrcName: null, nrcNameZh: null, nrcHint: null, params: [], tree: null };

function entry(seq, direction, doip, rawHex, udsExtra = {}) {
  return {
    seq, transactionId: null, ts: new Date().toISOString(), tsRelMs: seq * 3,
    transport: 'TCP', direction, peer: '127.0.0.1:13401', sessionId: 'stub',
    doip: {
      protocolVersion: 2, inverseVersionValid: true, payloadType: doip.payloadType,
      payloadTypeName: doip.payloadTypeName, payloadTypeNameZh: doip.payloadTypeNameZh,
      payloadLength: doip.payloadLength, sourceAddress: doip.sourceAddress,
      targetAddress: doip.targetAddress, sourceAddressName: '', targetAddressName: '',
      ackCode: doip.ackCode ?? null, ackNameZh: doip.ackNameZh ?? null,
      nackCode: null, nackNameZh: null, activationResponseCode: doip.activationResponseCode ?? null,
      activationResponseCodeZh: doip.activationResponseCodeZh ?? null,
      vin: null, eid: null, gid: null, headerHex: '02FD',
    },
    uds: { ...EMPTY_UDS, ...udsExtra },
    linkedSeq: null, txnRole: null, latencyMs: null, gatewayForwardLatencyMs: null,
    timeout: false, errorCode: null, errorNameZh: null, tags: [], rawHex,
  };
}

const ENTRIES = [
  entry(1, 'TX', { payloadType: 0x0005, payloadTypeName: 'RoutingActivationRequest', payloadTypeNameZh: '路由激活请求', payloadLength: 11, sourceAddress: 0x0e00, targetAddress: 0x0000 }, '02 FD 00 05 00 00 00 0B 0E 00 00 00 00 00 00 00 00 00 00'),
  entry(2, 'RX', { payloadType: 0x0006, payloadTypeName: 'RoutingActivationResponse', payloadTypeNameZh: '路由激活响应', payloadLength: 13, sourceAddress: 0x0e00, targetAddress: 0x1000, activationResponseCode: 0x10, activationResponseCodeZh: '路由激活成功' }, '02 FD 00 06 00 00 00 0D 0E 00 10 00 10 00 00 00 00 00 00 00 00'.replace(/\s/g, '')),
  entry(3, 'TX', { payloadType: 0x8001, payloadTypeName: 'DiagnosticMessage', payloadTypeNameZh: '诊断报文', payloadLength: 6, sourceAddress: 0x0e00, targetAddress: 0x1000 }, '02 FD 80 01 00 00 00 06 0E 00 10 00 10 03', { decoded: true, serviceId: 0x10, serviceName: 'DiagnosticSessionControl', shortZh: '会话控制', isPositive: true, messageKind: 'request', subFunction: 0x03 }),
];

const http = createServer((req, res) => {
  if ((req.url ?? '') === '/api/health') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, version: 'stub', bindHost: '127.0.0.1' }));
    return;
  }
  res.statusCode = 404;
  res.end('{}');
});
const wss = new WebSocketServer({ noServer: true });
http.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

let connSeq = 0;
wss.on('connection', (ws) => {
  connSeq += 1;
  console.log(`[stub] ws connect #${connSeq}`);
  const send = (type, payload) => ws.send(JSON.stringify({ v: 1, type, ts: Date.now(), payload }));
  send('connected', undefined);
  ws.on('message', (raw) => {
    let msg = {};
    try { msg = JSON.parse(String(raw)); } catch { /* ignore */ }
    if (msg.type === 'session.hello') {
      console.log(`[stub] hello lastSeq=${msg.payload?.lastSeq}`);
      send('hello', { serverVersion: 'stub', seqNow: ENTRIES.length, traceMinSeq: 1, traceMaxSeq: ENTRIES.length });
      send('trace.batch', { events: ENTRIES.map((e) => ({ kind: 'trace.entry', entry: e })) });
      return;
    }
    if (msg.type === 'ping') return;
    if (typeof msg.id === 'string') ws.send(JSON.stringify({ v: 1, type: 'cmd.ack', ts: Date.now(), payload: { id: msg.id, ok: true } }));
  });
  ws.on('close', () => console.log(`[stub] ws close #${connSeq}`));
});

http.listen(PORT, '127.0.0.1', () => console.log(`[stub] listening on 127.0.0.1:${PORT}`));
