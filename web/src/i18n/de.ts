/**
 * Deutsche Übersetzung. Schlüssel müssen exakt mit der chinesischen Basis
 * übereinstimmen (fehlende Schlüssel brechen den Build via `satisfies Dict`).
 */

import type { Dict } from './types';

export const de = {
  /* ── App-Grundgerüst ── */
  'DoIP 诊断控制台': 'DoIP-Diagnosekonsole',
  '服务请求': 'Dienstanfrage',
  '安全解锁 0x27': 'Sicherheitszugriff 0x27',
  'A 连接': 'A · Verbindung',
  '展开连接面板': 'Verbindungsbereich ausklappen',
  '折叠': 'Einklappen',
  '展开': 'Ausklappen',
  'D 详情 / 响应解码树': 'D · Details / Dekodierte Antwort',
  'A 区连接面板': 'Bereich A · Verbindung',
  'B 区服务请求': 'Bereich B · Dienstanfrage',
  'C 区 Trace': 'Bereich C · Trace',
  'D 区详情': 'Bereich D · Details',
  'E 区状态栏': 'Bereich E · Statusleiste',

  /* ── Symbolleiste ── */
  '真实 ECU': 'Echtes Steuergerät',
  '仿真 ECU': 'Simuliertes Steuergerät',
  '目标': 'Ziel',
  '连接': 'Verbinden',
  '连接中…': 'Verbinden…',
  '断开': 'Trennen',
  '车辆发现': 'Fahrzeugerkennung',
  '扫描中…': 'Suche läuft…',
  '服务库': 'Dienstbibliothek',
  'WebSocket：{label}（{status}）': 'WebSocket: {label} ({status})',
  '未连接': 'Nicht verbunden',
  '连接中': 'Verbinden',
  '已连接': 'Verbunden',
  '自动重连中': 'Automatische Wiederverbindung',
  '已断开': 'Getrennt',
  '简体中文': 'Vereinfachtes Chinesisch',
  '英文': 'Englisch',
  '德语': 'Deutsch',

  /* ── Statusleiste ── */
  '未知': 'Unbekannt',
  '路由': 'Routing',
  '会话': 'Sitzung',
  '解锁': 'Entsperrt',
  '错误': 'Fehler',
  '条': 'Einträge',
  '缺口 {count}': 'Lücken {count}',
  '后端连接已断开 · 状态未知': 'Backend getrennt · Status unbekannt',
  '后端已断开，路由激活状态未知':
    'Backend getrennt; Status der Routing-Aktivierung unbekannt',
  '会话保持剩余时间（< 1 s 变橙预警）':
    'Restzeit der Sitzungserhaltung (< 1 s wird orange)',
  '点击切换自动 TesterPresent': 'Klicken, um periodisches TesterPresent umzuschalten',
  '清除': 'Leeren',
  '导出…': 'Exportieren…',
  '查看后端运行日志（自我排查：连接失败、超时、写盘异常等都有记录）':
    'Backend-Protokolle anzeigen (Verbindungsfehler, Timeouts, Schreibfehler werden protokolliert)',
  '日志': 'Protokolle',
  '⏸ 跟随中': '⏸ Folgt',
  '▶ 已脱离': '▶ Abgekoppelt',
  '● 录制 {entries} 条 / {mb} MB': '● Aufzeichnung {entries} Einträge / {mb} MB',

  /* ── Verbindungsbereich ── */
  '仿真 ECU 控制': 'Steuerung des simulierten Steuergeräts',
  '已发现实体': 'Erkannte Entitäten',
  'SA / TA': 'SA / TA',
  '路由激活': 'Routing-Aktivierung',
  '传输层诊断': 'Transportschicht-Diagnose',
  '会话与解锁': 'Sitzung & Sicherheit',
  'SA（ tester 逻辑地址）': 'SA (logische Tester-Adresse)',
  'TA（目标逻辑地址）': 'TA (logische Zieladresse)',
  '应用': 'Anwenden',
  'TA 切换走 target.set，不重建连接（Q4）':
    'TA-Wechsel über target.set, ohne Neuaufbau der Verbindung (Q4)',
  '正在扫描…': 'Suche läuft…',
  '暂无发现结果': 'Keine Entitäten gefunden',
  '点击顶部「车辆发现」发起 UDP 车辆识别请求（0x0001 → 0x0004）':
    'Oben auf „Fahrzeugerkennung“ klicken, um eine UDP-Fahrzeugidentifikationsanfrage zu senden (0x0001 → 0x0004)',
  '仿真': 'Sim',
  '带入 {endpoint}': '{endpoint} übernehmen',
  '连': 'Übernehmen',

  /* ── Routing-Aktivierung ── */
  '激活类型': 'Aktivierungstyp',
  '协议版本': 'Protokollversion',
  '最近响应码': 'Letzter Antwortcode',
  '同一 socket 上重发 0x0005（最小间隔 {ms} ms）':
    '0x0005 auf demselben Socket erneut senden (Mindestabstand {ms} ms)',
  '仅在已建立 TCP 连接后可用': 'Nur nach aufgebauter TCP-Verbindung verfügbar',
  '重激活': 'Reaktivieren',

  /* ── Transportschicht-Diagnose ── */
  'Alive Check 走当前 TCP 连接；实体状态与电源模式走 UDP（缺省问当前连接目标）':
    'Alive Check nutzt die aktuelle TCP-Verbindung; Entitätsstatus und Energiemodus laufen über UDP (Standard: aktueller Peer)',
  '发送 0x0007 并等待 0x0008（超时 {ms} ms，不自动重试）':
    '0x0007 senden und auf 0x0008 warten (Timeout {ms} ms, kein automatischer Wiederholversuch)',
  '需先连接并激活路由': 'Zuerst verbinden und Routing aktivieren',
  'UDP 询问实体状态（0x4001 → 0x4002）：节点类型 / 并发容量 / 当前连接数':
    'Entitätsstatus über UDP abfragen (0x4001 → 0x4002): Knotentyp / parallele Kapazität / offene Sockets',
  'UDP 询问电源模式（0x4003 → 0x4004）：ECU 是否就绪':
    'Energiemodus über UDP abfragen (0x4003 → 0x4004): Ist das Steuergerät bereit?',
  'Alive Check': 'Alive Check',
  '实体状态': 'Entitätsstatus',
  '电源模式': 'Energiemodus',
  '存活 SA=0x{sa}（{ms} ms）': 'Lebendig, SA=0x{sa} ({ms} ms)',
  '{nodeType} 当前 {open}/{max} 连接': '{nodeType}, {open}/{max} Sockets belegt',

  /* ── Sitzung & Sicherheit ── */
  '当前会话': 'Aktuelle Sitzung',
  '解锁等级': 'Sicherheitsstufe',
  'S3 倒计时': 'S3-Countdown',
  '3E 心跳': '3E-Heartbeat',
  '▶ {seconds} s': '▶ {seconds} s',
  '⏸ 已停': '⏸ Gestoppt',
  '自动 TesterPresent': 'Periodisches TesterPresent',
  '范围 {min}–{max} ms': 'Bereich {min}–{max} ms',
  '周期 (ms)': 'Periode (ms)',

  /* ── Simulation & Fehlerinjektion ── */
  '启动': 'Starten',
  '停止': 'Stoppen',
  '故障注入…': 'Fehlerinjektion…',
  '仿真运行中，端口 {port}，实体 {count} 个{isolated}':
    'Simulation läuft auf Port {port}, {count} Entitäten{isolated}',
  '（独立子进程）': ' (eigener Prozess)',
  '仿真未启动': 'Simulation nicht gestartet',
  '故障注入（仿真 ECU）': 'Fehlerinjektion (simuliertes Steuergerät)',
  '启用该规则': 'Regel aktivieren',
  '匹配 SID（可空=全部）': 'Passende SID (leer = alle)',
  '生效次数（空=无限）': 'Anzahl (leer = unbegrenzt)',
  '注入动作': 'Injizierte Aktion',
  '路由激活响应码': 'Antwortcode der Routing-Aktivierung',
  'NRC / NACK 码': 'NRC-/NACK-Code',
  '延迟（ms）': 'Verzögerung (ms)',
  '自定义响应 hex': 'Benutzerdefinierte Antwort (Hex)',
  '返回指定 NRC': 'Bestimmten NRC zurückgeben',
  '返回 NACK（网关未转发）': 'NACK zurückgeben (Gateway hat nicht weitergeleitet)',
  '不响应（触发 P2 超时）': 'Keine Antwort (löst P2-Timeout aus)',
  '延迟响应（先 7F xx 78）': 'Verzögerte Antwort (zuerst 7F xx 78)',
  '原样返回自定义 hex': 'Benutzerdefiniertes Hex unverändert zurückgeben',
  '路由激活强制返回码': 'Antwortcode der Routing-Aktivierung erzwingen',
  '0x11 服务不支持': '0x11 Dienst nicht unterstützt',
  '0x22 条件不满足': '0x22 Bedingungen nicht erfüllt',
  '0x31 请求越界': '0x31 Anfrage außerhalb des Bereichs',
  '0x33 安全访问拒绝': '0x33 Sicherheitszugriff verweigert',
  '0x78 待响应': '0x78 Antwort ausstehend',
  '故障注入规则已下发（下一次匹配的请求生效）':
    'Fehlerinjektionsregel aktiv (wirkt bei der nächsten passenden Anfrage)',
  '已清除全部故障注入规则': 'Alle Fehlerinjektionsregeln gelöscht',
  '清除规则': 'Regeln löschen',
  '下发': 'Anwenden',

  /* ── Anfragebereich ── */
  '表单': 'Formular',
  '原始 hex': 'Roh-Hex',
  '服务': 'Dienst',
  '物理寻址': 'Physische Adressierung',
  '功能寻址 0x1FFF': 'Funktionale Adressierung 0x1FFF',
  '取消收藏': 'Aus Favoriten entfernen',
  '加入收藏夹': 'Zu Favoriten hinzufügen',
  '发送': 'Senden',
  '停止周期': 'Periodik stoppen',
  '周期发送': 'Periodisch senden',
  '周期(ms)': 'Periode (ms)',
  '原始 hex — 可发任意报文，不限于服务库里的条目':
    'Roh-Hex — beliebige Nachrichten senden, nicht nur Bibliothekseinträge',
  '例如：14 FF FF FF（清除全部 DTC）　22 F1 90（读 VIN）':
    'z. B. 14 FF FF FF (alle DTC löschen)  22 F1 90 (VIN lesen)',
  '非法 hex：必须为偶数位十六进制字符（空格与 0x 前缀会被忽略）':
    'Ungültiges Hex: gerade Anzahl Hex-Ziffern erforderlich (Leerzeichen und 0x-Präfixe werden ignoriert)',
  '按字节原样发送；服务库里有该服务时会自动带上解码与破坏性确认':
    'Wird bytegenau gesendet; bekannte Dienste erhalten Dekodierung und Bestätigung für destruktive Aktionen',
  '收藏夹：': 'Favoriten:',
  '预览 hex（与实际发出字节逐字节一致）':
    'Hex-Vorschau (identisch mit den tatsächlich gesendeten Bytes)',
  '破坏性服务': 'Destruktiver Dienst',
  '⚠ 破坏性操作二次确认': '⚠ Destruktive Operation — erneut bestätigen',
  '即将发送': 'Wird gesendet',
  '原始报文': 'Rohnachricht',
  '已按字节原样发送，不做任何补位或改写。请确认目标 ECU 支持该请求。':
    'Wird unverändert gesendet, ohne Auffüllen oder Umschreiben. Bitte sicherstellen, dass das Ziel-Steuergerät diese Anfrage unterstützt.',
  '该服务会改变 ECU 状态或数据，且不可撤销。':
    'Dieser Dienst ändert Zustand oder Daten des Steuergeräts und kann nicht rückgängig gemacht werden.',
  '我确认已评估影响（此确认不替代鉴权）':
    'Ich habe die Auswirkungen bewertet (diese Bestätigung ersetzt keine Authentifizierung)',
  '取消': 'Abbrechen',
  '确认发送': 'Bestätigen & senden',
  '{name}（可选）': '{name} (optional)',
  '{name}（hex）{optional}': '{name} (Hex) {optional}',
  '（可选）': ' (optional)',
  '（hex）': ' (Hex)',
  '非法 hex': 'Ungültiges Hex',
  '报文为空': 'Nachricht ist leer',
  'hex 位数必须为偶数': 'Hex-Länge muss gerade sein',
  '0x11': '0x11',
  'ECU 会复位，正在进行的诊断会话与其它 tester 连接会被打断':
    'Das Steuergerät wird zurückgesetzt; laufende Diagnosesitzungen und andere Tester-Verbindungen werden unterbrochen',
  'ECU 内已存储的 DTC 与快照数据会被永久清除，不可恢复':
    'Gespeicherte DTCs und Freeze-Frame-Daten werden dauerhaft gelöscht und können nicht wiederhergestellt werden',
  '会写入 ECU 的非易失存储，写错值可能导致 ECU 功能异常':
    'Schreibt in den nichtflüchtigen Speicher des Steuergeräts; ein falscher Wert kann Fehlfunktionen verursachen',
  '会启动/停止 ECU 内部例程，可能影响执行机构动作':
    'Startet/stoppt eine interne Routine und kann Aktoren betätigen',
  '发送密钥错误会计入 ECU 解锁尝试计数，连续失败可能触发延迟惩罚甚至临时封禁（NRC 0x35/0x36）':
    'Ein falscher Schlüssel zählt gegen die Entsperrversuche; wiederholte Fehler können Verzögerungen oder eine temporäre Sperre auslösen (NRC 0x35/0x36)',

  /* ── Sicherheitszugriff ── */
  '安全等级': 'Sicherheitsstufe',
  'Key 算法': 'Schlüsselalgorithmus',
  '待替换': 'Zu ersetzen',
  '已手动指定，点此交还给后端推荐（仿真/已验证算法）':
    'Manuell gewählt; klicken, um die Backend-Empfehlung wiederherzustellen (Simulation / verifizierter Algorithmus)',
  '一键解锁': 'Entsperren',
  '解锁成功（Level {level}，Seed {seed} → Key {key}）':
    'Entsperrt (Stufe {level}, Seed {seed} → Key {key})',
  '解锁失败：{reason}': 'Entsperren fehlgeschlagen: {reason}',
  '未知原因': 'unbekannter Grund',
  '适用等级 {levels}': 'Gilt für Stufen {levels}',
  '不限': 'beliebig',
  'Seed {bytes} 字节': 'Seed {bytes} Byte',
  'Key {bytes}': 'Key {bytes}',
  '与 Seed 等长': 'gleiche Länge wie Seed',
  '占位实现': 'Platzhalter',
  '移植算法': 'Portierter Algorithmus',
  '库定义 {provider}': 'Bibliotheksdefinition {provider}',
  '该算法未通过测试向量校验，解锁可能失败（NRC 0x35）':
    'Dieser Algorithmus hat die Testvektorprüfung nicht bestanden; das Entsperren kann fehlschlagen (NRC 0x35)',
  '试算': 'Probeberechnung',
  '算出 Key': 'Berechneter Key',
  '向量期望值': 'Erwarteter Vektorwert',
  '（无对照向量）': '(kein Referenzvektor)',
  '与期望值一致': 'Stimmt mit dem Erwartungswert überein',
  '与期望值不一致': 'Weicht vom Erwartungswert ab',
  '测试向量（{count} 条）': 'Testvektoren ({count})',
  '危险操作确认 · 0x27 SecurityAccess 解锁':
    'Gefährliche Operation · 0x27 SecurityAccess entsperren',
  '当前算法「{name}」': 'Aktueller Algorithmus „{name}“',
  '（占位实现，待替换）': ' (Platzhalter, zu ersetzen)',
  '未经测试向量校验，解锁大概率失败（NRC 0x35 incorrectKey）。':
    'wurde nicht mit Testvektoren geprüft; das Entsperren schlägt höchstwahrscheinlich fehl (NRC 0x35 incorrectKey).',
  '错误的 Key 会计入 ECU 的解锁尝试次数：连续失败可能触发延迟惩罚，次数耗尽后该安全等级会被 ECU 临时封禁（需重新上电或等待延时），影响后续诊断窗口。':
    'Ein falscher Key zählt gegen die Entsperrversuche des Steuergeräts: Wiederholte Fehler können eine Verzögerung auslösen; nach Ausschöpfen der Versuche wird diese Sicherheitsstufe vorübergehend gesperrt (Neustart oder Warten erforderlich), was die weitere Diagnose blockiert.',
  '建议先用下方「试算」对照向量验证算法，或改用已验证（绿勾）/后端推荐算法。':
    'Bitte den Algorithmus zuerst mit der Probeberechnung unten gegen den Vektor prüfen oder einen verifizierten (grüner Haken) / empfohlenen Algorithmus verwenden.',
  '我已知悉上述风险：本次解锁由我人工发起，系统不会自动重试。':
    'Ich kenne die Risiken: Dieses Entsperren wird manuell ausgelöst, das System wiederholt nicht automatisch.',
  '确认发起解锁': 'Entsperren bestätigen',

  /* ── Trace-Bereich ── */
  '暂无报文': 'Noch keine Nachrichten',
  '启动仿真 ECU → 车辆发现 → 连接 → 路由激活后，Trace 会实时显示（含 UDP 发现与 TCP 诊断报文）':
    'Simuliertes Steuergerät starten → Fahrzeugerkennung → Verbinden → Routing aktivieren; danach zeigt Trace live alle Nachrichten (UDP-Erkennung und TCP-Diagnose)',
  '过滤表达式无法解析，当前按未过滤显示（不会静默丢行）':
    'Filterausdruck konnte nicht verarbeitet werden; Anzeige ohne Filter (keine Zeilen werden still verworfen)',
  '⋯ 缺口：seq {seq} 起缺失 {count} 条（{reason}）':
    '⋯ Lücke: {count} Einträge ab seq {seq} fehlen ({reason})',
  '会自动按 seq 顺序向后端请求补齐；若后端环形缓冲已回绕覆盖该段，则不可恢复。':
    'Fehlende Einträge werden in Seq-Reihenfolge vom Backend angefordert; wurden sie im Ringpuffer bereits überschrieben, sind sie nicht wiederherstellbar.',
  '复制行（JSON）': 'Zeile kopieren (JSON)',
  '复制 hex': 'Hex kopieren',
  '复制解码串': 'Dekodierte Zeichenfolge kopieren',
  '在 D 区详情中查看': 'In Bereich D anzeigen',
  '以此为模板新建请求（T13）': 'Anfrage aus dieser Zeile erstellen (T13)',
  '显示 {shown} / {total} 条': 'Zeige {shown} / {total}',
  '缺口 {count} 段': 'Lücken: {count}',
  '存在 seq 缺口（背压或缓冲溢出），seq 链条仍连续可审计':
    'Seq-Lücken vorhanden (Backpressure oder Pufferüberlauf); die Seq-Kette bleibt prüfbar',
  '已复制{what}': '{what} kopiert',
  '复制失败（浏览器剪贴板不可用）': 'Kopieren fehlgeschlagen (Zwischenablage nicht verfügbar)',
  '第 {seq} 行 JSON': 'Zeile {seq} JSON',
  '第 {seq} 行 hex': 'Zeile {seq} Hex',
  '第 {seq} 行解码串': 'Zeile {seq} dekodierte Zeichenfolge',
  '继续摄入（Space）': 'Aufzeichnung fortsetzen (Leertaste)',
  '暂停摄入（Space）': 'Aufzeichnung pausieren (Leertaste)',
  '继续': 'Fortsetzen',
  '暂停': 'Pausieren',
  '自动滚动到最新行（上滚会临时脱离）':
    'Automatisch zur neuesten Zeile scrollen (Hochscrollen koppelt vorübergehend ab)',
  '跟随': 'Folgen',
  '清空前端缓冲（后端 trace.clear 同步执行）':
    'Frontend-Puffer leeren (Backend trace.clear wird synchron ausgeführt)',
  '点击停止录制\n会话目录：{dir}\n当前分片：{file}\n分片数：{files}':
    'Klicken, um die Aufzeichnung zu stoppen\nSitzungsverzeichnis: {dir}\nAktuelles Segment: {file}\nSegmente: {files}',
  '点击开始录制（后端 RollingFileSink，WS 背压不影响落盘完整性）':
    'Klicken, um die Aufzeichnung zu starten (Backend RollingFileSink; WS-Backpressure beeinträchtigt die Persistenz nicht)',
  '尚无落盘目录': 'Noch kein Aufzeichnungsverzeichnis',
  '尚无落盘目录（先开始录制）':
    'Noch kein Aufzeichnungsverzeichnis (zuerst Aufzeichnung starten)',
  '打开目录': 'Ordner öffnen',
  '导出 CSV / JSON / JSONL / HEX（可按过滤或 seq 区间）':
    'CSV / JSON / JSONL / HEX exportieren (nach Filter oder Seq-Bereich)',
  '录制': 'Aufzeichnung',
  '落盘丢弃 {count}': 'Beim Schreiben verworfen {count}',
  '暂停期间丢弃 {count} 条': 'Während der Pause verworfen: {count}',
  '○ 未录制（未知）': '○ Keine Aufzeichnung (unbekannt)',
  '● 录制中 {entries} 条 / {mb} MB / {files} 片':
    '● Aufzeichnung läuft: {entries} Einträge / {mb} MB / {files} Segmente',
  '■ 已停止 {entries} 条 / {mb} MB / {files} 片':
    '■ Gestoppt: {entries} Einträge / {mb} MB / {files} Segmente',
  '⚠ 录制异常 {code}（已写 {entries} 条）':
    '⚠ Aufzeichnungsfehler {code} ({entries} Einträge geschrieben)',
  '○ 未录制': '○ Keine Aufzeichnung',
  '过滤：doip.type == 0x8001 && uds.sid == 0x22':
    'Filter: doip.type == 0x8001 && uds.sid == 0x22',
  '表达式无法解析（按未过滤显示）':
    'Ausdruck konnte nicht verarbeitet werden (Anzeige ohne Filter)',
  '隐藏周期 3E': 'Periodisches 3E ausblenden',
  '复制当前过滤表达式': 'Aktuellen Filterausdruck kopieren',
  '已复制过滤表达式': 'Filterausdruck kopiert',
  '列设置': 'Spalten',
  '缓冲 {total}': 'Gepuffert {total}',
  'WS 背压降级': 'WS-Backpressure-Degradierung',
  '缓冲溢出淘汰': 'Pufferüberlauf-Verwerfung',
  '本地断号': 'Lokale Seq-Lücke',
  '仅错误': 'Nur Fehler',
  '仅 NRC': 'Nur NRC',
  '仅诊断报文': 'Nur Diagnosenachrichten',
  '仅读 DID(0x22)': 'Nur DID lesen (0x22)',
  '正响应': 'Positive Antwort',
  'NRC 否定响应': 'NRC-Negativantwort',
  '0x8002 ACK（传输层确认）': '0x8002 ACK (Transportbestätigung)',
  '0x8003 NACK（网关未转发）': '0x8003 NACK (nicht vom Gateway weitergeleitet)',
  '周期 3E（可隐藏）': 'Periodisches 3E (ausblendbar)',

  /* ── Detailbereich ── */
  '请求': 'Anfrage',
  '响应': 'Antwort',
  '网关确认': 'Gateway-ACK',
  '网关拒绝': 'Gateway-NACK',
  '主动上报': 'Unaufgefordert',
  '事务': 'Transaktion',
  '角色': 'Rolle',
  '耗时(ms)': 'Dauer (ms)',
  '网关转发(ms)': 'Gateway-Weiterleitung (ms)',
  '跳转到配对行': 'Zur zugehörigen Zeile springen',
  '配对行 → seq {seq}': 'Zugehörige Zeile → seq {seq}',
  '超时': 'Timeout',
  '未选择报文': 'Keine Nachricht ausgewählt',
  '在 C 区点击任意一行，这里显示三层解码、原始 hex 与错误解释':
    'In Bereich C eine Zeile anklicken; hier erscheinen dreistufige Dekodierung, Roh-Hex und Fehlererklärung',
  '解码树': 'Dekodierbaum',
  '错误解释': 'Fehlererklärung',
  '点击任意字节可反向定位到字段': 'Beliebiges Byte anklicken, um das Feld zu lokalisieren',
  '偏移 {offset} → {field}（{hex}）{name}': 'Offset {offset} → {field} ({hex}) {name}',
  'DoIP 通用头（8 字节）': 'DoIP-Generic-Header (8 Byte)',
  '反码版本': 'Invertierte Version',
  '校验通过（异或 = 0xFF）': 'Gültig (XOR = 0xFF)',
  '★反码校验失败': '★Prüfung der invertierten Version fehlgeschlagen',
  '负载长度': 'Payload-Länge',
  '★网关未转发，不是 UDS 层错误':
    '★Vom Gateway nicht weitergeleitet — kein UDS-Fehler',
  '抑制正响应位已置起': 'Bit „positive Antwort unterdrücken“ ist gesetzt',
  '当前为兜底字段，T12 服务库接入后自动补齐':
    'Fallback-Feld; wird nach Anbindung der Dienstbibliothek ergänzt',
  '在 C 区选择一行报文查看三层解码':
    'In Bereich C eine Nachricht auswählen, um die Dekodierung zu sehen',
  '偏移 {offset}（0x{hex}）': 'Offset {offset} (0x{hex})',
  '无数据': 'Keine Daten',
  '请求超时{code}': 'Anfrage-Timeout{code}',
  '网关已收下并转发（收到 0x8002 ACK），但 ECU 未在 P2 时限内响应':
    'Das Gateway hat die Anfrage angenommen und weitergeleitet (0x8002 ACK), aber das Steuergerät hat nicht innerhalb von P2 geantwortet',
  '网关未在时限内返回 ACK/NACK，请求可能未进入网关':
    'Das Gateway hat nicht rechtzeitig ACK/NACK zurückgegeben; die Anfrage hat es möglicherweise nicht erreicht',
  '建议：确认目标地址在线、ECU 未处于繁忙/锁定状态；必要时放大 P2 超时或检查故障注入规则。':
    'Hinweis: Zieladresse und Erreichbarkeit prüfen, sicherstellen, dass das Steuergerät nicht belegt/gesperrt ist; ggf. P2-Timeout erhöhen oder Fehlerinjektionsregeln prüfen.',
  '★这是传输层错误：网关未把报文转发给 ECU，UDS 层还没有被执行（与 NRC 不同，不要按服务问题排查）。':
    '★Dies ist ein Transportschichtfehler: Das Gateway hat die Nachricht nicht an das Steuergerät weitergeleitet, die UDS-Schicht wurde nie ausgeführt (anders als bei einem NRC — nicht als Dienstproblem behandeln).',
  '建议：检查目标逻辑地址 TA 是否存在、路由激活是否成功、报文长度是否超限。':
    'Hinweis: prüfen, ob die logische Zieladresse (TA) existiert, die Routing-Aktivierung erfolgreich war und die Nachrichtenlänge im Limit liegt.',
  '是什么：{text}': 'Was: {text}',
  '常见原因：{text}': 'Häufige Ursachen: {text}',
  '建议动作：{text}': 'Empfohlene Maßnahme: {text}',
  'ECU 返回了否定响应。': 'Das Steuergerät hat eine negative Antwort zurückgegeben.',
  '否定响应': 'Negativantwort',
  '无事务': 'keine Transaktion',

  /* ── Exportdialog ── */
  'Excel 友好（UTF-8 BOM，26 列）': 'Excel-freundlich (UTF-8 BOM, 26 Spalten)',
  '数组，逐字保留全部字段': 'Array, alle Felder unverändert',
  '与落盘分片同格式，可流式处理': 'Gleiches Format wie Aufzeichnungssegmente, streamingfähig',
  '偏移 + ASCII 侧栏，肉眼比对用': 'Offset + ASCII-Seitenleiste für den Sichtvergleich',
  'seq 区间非法（需要整数且 from ≤ to）':
    'Ungültiger Seq-Bereich (ganze Zahlen, from ≤ to erforderlich)',
  '已请求导出 {format}（{scope}）': 'Export angefordert: {format} ({scope})',
  '导出 Trace（{count} 条在缓冲）': 'Trace exportieren ({count} Einträge im Puffer)',
  '格式': 'Format',
  '范围': 'Bereich',
  '全部': 'Alle',
  '当前过滤': 'Aktueller Filter',
  'seq 区间': 'Seq-Bereich',
  '表达式：{expr}': 'Ausdruck: {expr}',
  '（过滤栏为空 = 全部）': '(leerer Filter = alle)',
  '起始 seq': 'Von seq',
  '结束 seq': 'Bis seq',
  '导出结果中剔除周期 TesterPresent（0x3E 0x80），减少噪音':
    'Periodisches TesterPresent (0x3E 0x80) aus dem Export entfernen, um Rauschen zu reduzieren',
  '隐藏周期 TesterPresent（0x3E 0x80）': 'Periodisches TesterPresent ausblenden (0x3E 0x80)',
  '导出中…': 'Exportiere…',
  '导出并下载': 'Exportieren & herunterladen',

  /* ── Dienstbibliothek ── */
  '服务库编辑器': 'Dienstbibliothek-Editor',
  '子功能': 'Unterfunktionen',
  '改动后下一次解码立即生效，并 repatch 最近 2000 条':
    'Änderungen gelten ab der nächsten Dekodierung und aktualisieren die letzten 2000 Einträge',
  '导出 JSON': 'JSON exportieren',
  '导入 JSON': 'JSON importieren',
  '重置为内置基线': 'Auf integrierte Basis zurücksetzen',
  '服务库尚未加载': 'Dienstbibliothek nicht geladen',
  '英文名': 'Englischer Name',
  '中文名': 'Chinesischer Name',
  '编码': 'Codec',
  '内置': 'Integriert',
  '码值': 'Code',
  '处置建议': 'Empfehlung',
  '级别': 'Stufe',
  '逻辑地址': 'Logische Adresse',
  '别名': 'Alias',
  '关闭': 'Schließen',
  '保存（校验后入库）': 'Speichern (prüfen, dann übernehmen)',
  '服务库被拒绝，已保留原库（{count} 处问题）':
    'Dienstbibliothek abgelehnt; vorherige Bibliothek beibehalten ({count} Probleme)',
  '第 {line} 行第 {column} 列 · ': 'Zeile {line}, Spalte {column} · ',
  '新增': 'Hinzufügen',
  '共 {count} 条': '{count} Einträge',
  '自定义': 'Benutzerdefiniert',
  '中文全名': 'Vollständiger chinesischer Name',
  '所属服务': 'Übergeordneter Dienst',
  '该服务没有子功能字段': 'Dieser Dienst hat keine Unterfunktionsfelder',
  '值': 'Wert',
  '新增 JS 算法': 'JS-Algorithmus hinzufügen',
  '新增常量密钥': 'Konstanten Schlüssel hinzufügen',
  '自定义 JS 算法': 'Benutzerdefinierter JS-Algorithmus',
  '自定义常量密钥': 'Benutzerdefinierter konstanter Schlüssel',
  '导入的文件不是合法 JSON': 'Die importierte Datei ist kein gültiges JSON',

  /* ── Protokollbereich ── */
  '后端运行日志': 'Backend-Laufzeitprotokolle',
  '加载中…': 'Lädt…',
  '已记录 {lines} 行 · 当前文件 {bytes} B · 保留 {files} 个文件':
    '{lines} Zeilen aufgezeichnet · aktuelle Datei {bytes} B · {files} Dateien behalten',
  '日志有 {count} 行因写入失败被丢弃（磁盘或权限问题），排查时请留意日志不完整。':
    '{count} Protokollzeilen wurden wegen Schreibfehlern verworfen (Datenträger oder Berechtigungen); die Protokolle sind möglicherweise unvollständig.',
  '与后端的连接当前不是打开状态，显示的是上一次拉取的内容。':
    'Die Backend-Verbindung ist nicht offen; angezeigt wird der zuletzt geladene Inhalt.',
  '只看警告/错误': 'Nur Warnungen/Fehler',
  '自动刷新': 'Automatisch aktualisieren',
  '仅显示最近若干行': 'Nur die letzten Zeilen werden angezeigt',
  '已含全部现有日志': 'Enthält alle vorhandenen Protokollzeilen',
  '（暂无日志）': '(keine Protokolle)',
  '（当前过滤条件下没有匹配行）': '(keine Zeilen entsprechen dem aktuellen Filter)',
  '目录：{dir}': 'Verzeichnis: {dir}',
  '在文件管理器里打开日志目录': 'Protokollverzeichnis im Dateimanager öffnen',
  '刷新': 'Aktualisieren',

  /* ── Allgemein ── */
  '重试': 'Wiederholen',
  '渲染失败：{message}': 'Rendering fehlgeschlagen: {message}',
  '非法 hex：只允许 0-9 / A-F': 'Ungültiges Hex: nur 0-9 / A-F erlaubt',
  '长度应为 {expected} 字节，当前 {actual} 字节':
    '{expected} Byte erwartet, aktuell {actual} Byte',
  '非法 hex 输入': 'Ungültige Hex-Eingabe',
  '跳转': 'Springen',
  '跳转到对应 Trace 行': 'Zur entsprechenden Trace-Zeile springen',
  '暂无数据': 'Keine Daten',
} satisfies Dict;
