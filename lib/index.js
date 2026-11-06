// ============================================================
// dsh-android-scrcpy —— 安卓 provider（Host 半区）
//
// 它只回答"安卓设备怎么说话"：
//   · 传输：adb
//   · sidecar：scrcpy-server.jar → adb push → app_process
//   · 设备发现、环境检测、自己的连接配置
//   · 底层动作：截图 / 控件树 / 触控 / 按键 / 文本 / 投屏流
//
// **不做**：不注册 UI、不注册 AI 工具、不写 AI 提示词、不关心"聚焦设备是谁"（那些都在 dsh-scrcpy-core）。
//
// 它向 core 登记自己（ctx.scrcpyProviders.register），并按契约实现：
//   actions : listDevices / startStream / stopStream / snapshot / dumpLayout / tap / longpress / key / input
//   handlers: env:detect / cfg:describe / cfg:get / cfg:save
// 投屏流：自己开一个本机 WebSocket 端点，**说 core 定的那套协议**
//   （二进制 = 裸 H.264；文本 = {"msg":"size"|"log"}；浏览器发 {type:'touch'|'key'|'screen'|'size'|'log'}）
//
// 依据：`android/Dev/demo/demo-host.mjs`（404 行，已跑通）+ PLAN-3.0.0 §7 的协议实测记录。
// ⚠️ 标【未实测】的是照协议文档/ demo 写的，还没在真机上验过。
// ============================================================

import { spawn, execFile, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { connect } from 'node:net'
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

// ------------------------------------------------------------
// 与 core 的关系（**自由装**）
//   · 本包**不声明**对 `dsh-scrcpy-core` 的包依赖 —— 装 provider **不会**自动把 core 拉下来；
//   · 没装 core：本插件因 `inject: ['scrcpyProviders']` 不满足而**静默不激活**
//     （不报错，但也用不了 —— 这是设计如此，不是 bug）；
//   · 装了 core 但版本不配套：**判定权在 core** —— 本包只声明下面的 `abi`，
//     core 拿自己的版本比对，不通过就把本 provider 标成停用（设备不进列表、动作不路由）
//     并在菜单显示一句原因。**本包不 throw**（不拖垮别的 provider）。
// ------------------------------------------------------------
// 「匹配 core」的声明：支持 "1.0.0" 精确 / "~1.0.0" 只许最后一位变 / "^1.0.0" 同 major / ">=1.0.0" 下限
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ------------------------------------------------------------
// 常量
// ------------------------------------------------------------
const RES = (p) => join(PKG_ROOT, 'resources', p)
const JAR_LOCAL = RES('scrcpy-server-v4.1')
const JAR_REMOTE = '/data/local/tmp/scrcpy-server.jar'
const SERVER_VERSION = '4.1'              // ⚠️ 必须与 scrcpy-server 完全一致，否则 server 直接失败
const GOP_MAX_BYTES = 16 * 1024 * 1024
const TUNNEL_PORT_BASE = 27183            // adb forward 用的本机端口（每个设备一个）
const CONFIG_DIR = process.env.DSH_HOME || join(os.homedir(), '.dsh')
const CONFIG_FILE = join(CONFIG_DIR, 'dsh-android-scrcpy.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('[android-scrcpy]', ...a)
const warn = (...a) => console.error('[android-scrcpy] ⚠️', ...a)
// 构建戳（格式定成 `YYYY-MM-DD.B<N>` = Build N，每个包各起各的戳）：
//   改动打一次包就 +1；**戳对不上 = 没装上/没重启**。它经 cfg:describe.build 显示在连接设置按钮行左边。
const PROVIDER_BUILD = '2026-11-06.B3'

// 画面四件套的默认值（key 由 core 定，）：
//   有线 1/2 · 60fps，无线 1/4 · 30fps；两端都能到"原画"（'1'）；帧率 120 封顶
const PIC_DEFAULTS = { wiredScale: '1/2', wiredFps: 60, wirelessScale: '1/4', wirelessFps: 30 }
function readConfig() {
  const str = (v, d) => (v === undefined || v === null || v === '' ? d : String(v))
  const num = (v, d) => (Number(v) > 0 ? Number(v) : d)
  try {
    const o = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    return {
      adbPath: String(o.adbPath || ''),
      wiredScale: str(o.wiredScale, PIC_DEFAULTS.wiredScale), wiredFps: num(o.wiredFps, PIC_DEFAULTS.wiredFps),
      wirelessScale: str(o.wirelessScale, PIC_DEFAULTS.wirelessScale), wirelessFps: num(o.wirelessFps, PIC_DEFAULTS.wirelessFps),
    }
  } catch {
    return { adbPath: '', wiredScale: PIC_DEFAULTS.wiredScale, wiredFps: PIC_DEFAULTS.wiredFps, wirelessScale: PIC_DEFAULTS.wirelessScale, wirelessFps: PIC_DEFAULTS.wirelessFps }
  }
}
/** '1/2' → 2（'1' 或无法识别 → 1 = 不缩放） */
function scaleDivisor(s) {
  const m = /^1\/(\d+)$/.exec(String(s || ''))
  return m ? Math.max(1, Number(m[1])) : 1
}
/** 设备长边像素（取 wm size 里较大的那个）；查不到返回 0 → 这一项就不限制 */
async function deviceLongEdge(sn) {
  try {
    const r = await adbExec(sn, ['shell', 'wm', 'size'], { allowFail: true })
    // ⚠️ adbExec 返回的是 { code, out, err }（不是 stdout）—— 2026-09-27 我在这里读错了字段，
    //    结果永远解析不到分辨率 → max_size 从来没被加上去 → "选 1/4 还是 2560x1600"。
    const m = /(\d+)\s*x\s*(\d+)/.exec(String((r && r.out) || ''))
    return m ? Math.max(Number(m[1]), Number(m[2])) : 0
  } catch (e) { return 0 }
}
function writeConfig(cfg) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8')
    return { ok: true }
  } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
}

// ------------------------------------------------------------
// 设备命令层：所有 adb 调用都带 -s <sn>（多设备时不带会报 "more than one device/emulator"）
// ------------------------------------------------------------
function adbCandidates() {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  return [
    process.env.ADB,
    process.platform === 'win32' ? join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe') : '',
    process.platform === 'darwin' ? join(home, 'Library', 'Android', 'sdk', 'platform-tools', 'adb') : '',
    process.platform === 'win32' ? '' : join(home, 'Android', 'Sdk', 'platform-tools', 'adb'),
  ].filter(Boolean)
}
function resolveAdb() {
  const cfg = readConfig()
  if (cfg.adbPath && existsSync(cfg.adbPath)) return { path: cfg.adbPath, source: 'config' }
  for (const c of adbCandidates()) if (existsSync(c)) return { path: c, source: 'candidate' }
  try {
    if (spawnSync('adb', ['version'], { stdio: 'ignore' }).status === 0) return { path: 'adb', source: 'PATH' }
  } catch (e) {}
  return { path: '', source: '' }
}
let ADB = ''

function adbExec(sn, args, opts) {
  const allowFail = !!(opts && opts.allowFail)
  const bin = (opts && opts.bin) || ADB
  return new Promise((resolve, reject) => {
    execFile(bin, sn ? ['-s', sn].concat(args) : args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const out = String(stdout || ''), errText = String(stderr || (err && err.message) || '')
      if (err && !allowFail) return reject(new Error('adb ' + args.join(' ') + ' 失败: ' + (errText.trim() || out.trim())))
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: out, err: errText })
    })
  })
}
const shell = (sn, cmd, opts) => adbExec(sn, ['shell', cmd], opts)

async function adbVersion(bin) {
  if (!bin) return { ok: false, version: '', error: '没找到 adb（可填路径，或设 ADB 环境变量 / 加进 PATH）' }
  const r = await new Promise((resolve) => {
    execFile(bin, ['version'], { windowsHide: true }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }))
  })
  if (r.err) return { ok: false, version: '', error: String(r.stderr || r.err.message || '').split(/\r?\n/)[0] || 'adb 运行失败' }
  const first = String(r.stdout || r.stderr || '').split(/\r?\n/).filter(Boolean)[0] || ''
  return { ok: true, version: first.replace(/^Android Debug Bridge version\s*/i, ''), error: '' }
}

/** `adb devices` → [{sn, online}] */
async function rawDevices() {
  const r = await adbExec('', ['devices'], { allowFail: true })
  const out = []
  for (const line of String(r.out).split(/\r?\n/)) {
    const m = line.match(/^(\S+)\s+(device|offline|unauthorized)\s*$/)
    if (m) out.push({ sn: m[1], state: m[2], online: m[2] === 'device' })
  }
  return out
}
/** 设备上所有 app_process 的 pid（用于"只清自己起的那个"） */
async function appProcessPids(sn) {
  const r = await shell(sn, 'pidof app_process', { allowFail: true })
  return String(r.out).trim().split(/\s+/).filter(Boolean)
}
/** 型号等静态信息（拿不到就算了，不阻塞发现） */
async function deviceModel(sn) {
  const r = await shell(sn, 'getprop ro.product.model', { allowFail: true })
  return String(r.out).trim()
}
async function screenSize(sn) {
  const r = await shell(sn, 'wm size', { allowFail: true })
  const m = String(r.out).match(/Override size:\s*(\d+)x(\d+)/) || String(r.out).match(/Physical size:\s*(\d+)x(\d+)/)
  return m ? { w: parseInt(m[1], 10), h: parseInt(m[2], 10) } : null
}

/**
 * 控件树 / 触摸用的坐标系 = **当前显示方向**的空间。
 * ⚠️ 真机坑（2026-09-26 踩到）：平板横屏显示空间是 2560x1600，里面放了个竖屏应用（1280x1600），
 *   而 `wm size` 报的仍是**自然方向**的顺序（1600x2560）—— 直接拿它当分母，x/y 会整体算歪
 *   （实测表现：点"评论"点到别处；按 2560x1600 重算后一次点中）。
 * 优先级：① **投屏帧尺寸**（权威 —— 它就是当前显示空间）
 *        ② `wm size` + 按 dump 包围盒判断要不要转 90° ③ dump 包围盒兜底
 */
async function layoutSpace(sn, maxX, maxY) {
  const dev = sessions.get(sn)
  if (dev && dev.st.width && dev.st.height) return { w: dev.st.width, h: dev.st.height, source: 'frame' }
  const s = await screenSize(sn)
  if (!s) return { w: maxX || 1, h: maxY || 1, source: 'dump' }
  const dumpLandscape = (maxX || 0) > (maxY || 0)
  const wmLandscape = s.w > s.h
  if (dumpLandscape !== wmLandscape) return { w: s.h, h: s.w, source: 'wm-size-rotated' }
  return { w: s.w, h: s.h, source: 'wm-size' }
}

/** dump 里所有 bounds 右下角的最大值（= 这份 dump 实际使用的坐标系尺寸）*/
function xmlBounds(xml) {
  let maxX = 0, maxY = 0
  const re = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/g
  let m
  while ((m = re.exec(String(xml))) !== null) {
    const x2 = +m[3], y2 = +m[4]
    if (x2 > maxX) maxX = x2
    if (y2 > maxY) maxY = y2
  }
  return { maxX: maxX, maxY: maxY }
}

// ------------------------------------------------------------
// 极简 WebSocket 服务端（RFC 6455 子集：text/binary/close/ping-pong，不支持分片）
//   Node 没有内置 WS 服务端，而 core 的浏览器半区用的是 new WebSocket(...)。
//   参考实现：鸿蒙那边的 Java 版 WsServer（Main.java）。
// ------------------------------------------------------------
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
function wsAccept(key) { return createHash('sha1').update(key + WS_GUID).digest('base64') }

function encodeFrame(opcode, payload) {
  const len = payload.length
  let header
  if (len < 126) { header = Buffer.alloc(2); header[1] = len }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2) }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2) }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, payload])
}

/**
 * 只放行「本机页面」和「不带 Origin 的非浏览器客户端」（【用户备忘录】里记过这条，2026-09-26 补上）。
 * 威胁很具体：**你随便打开的一个网页可以扫本地端口连上这个 WS → 看屏幕 + 注入触摸**。
 * 校验 Origin（浏览器一定会带）+ Host（挡 DNS rebinding —— 那时 Host 会是攻击者的域名）。
 * ⚠️ 不校验「本地进程」：能连 socket 的进程本来就能直接用 adb，加校验也不构成任何边界。
 */
const LOOPBACK_ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/
const LOOPBACK_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/
/**
 * ⚠️ DSH 桌面端渲染进程的 Origin 是 **`dsh-app://app`**（2026-09-26 实测；**不是** http://127.0.0.1:19387）。
 * 放行整个 `dsh-app://` scheme 是安全的：网页**无法伪造 Origin 的 scheme**，只有应用自己的渲染进程发得出来。
 * 教训：这条规则最初只放行 http 回环 → 把自家客户端挡在门外 → 浏览器只报 1006 → 画面/注释/汇报全没了，查了半天。
 */
const DSH_APP_ORIGIN_RE = /^dsh-app:\/\/[A-Za-z0-9._-]+$/i
function wsUpgradeReject(req) {
  const origin = req.headers['origin']
  if (origin && !LOOPBACK_ORIGIN_RE.test(String(origin)) && !DSH_APP_ORIGIN_RE.test(String(origin))) {
    return 'Origin 既不是本机回环也不是 DSH 应用：' + origin
  }
  const host = req.headers['host']
  if (host && !LOOPBACK_HOST_RE.test(String(host))) return 'Host 不是本机回环：' + host
  return ''
}

/**
 * 每一次 WS 握手尝试都记到 %TEMP%/dsh-scrcpy-ws.log。
 * 为什么需要：浏览器 WS 失败**只报 1006，看不到 HTTP 状态**，所以必须让服务端把真实请求头记下来，
 * 否则永远只能猜（2026-09-26 就是被这个坑住的）。
 */
function logWsAttempt(req, verdict) {
  try {
    const line = new Date().toISOString() + ' ' + verdict
      + ' origin=' + JSON.stringify(String(req.headers['origin'] || ''))
      + ' host=' + JSON.stringify(String(req.headers['host'] || ''))
      + ' ua=' + JSON.stringify(String(req.headers['user-agent'] || '').slice(0, 70))
      + '\n'
    appendFileSync(join(os.tmpdir(), 'dsh-scrcpy-ws.log'), line)
  } catch (e) {}
}

function createWsServer() {
  const clients = new Set()
  let onText = null
  let onOpen = null
  let onClose = null

  const server = createServer((req, res) => { res.writeHead(426, { 'content-type': 'text/plain' }); res.end('websocket only') })

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key']
    if (!key) { logWsAttempt(req, 'NO-KEY'); try { socket.destroy() } catch (e) {} return }
    const bad = wsUpgradeReject(req)
    logWsAttempt(req, bad ? ('REJECT: ' + bad) : 'ACCEPT')
    if (bad) {
      warn('拒绝 WS 连接：' + bad)
      try { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy() } catch (e) {}
      return
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n')

    const client = {
      socket: socket,
      alive: true,
      sendText(s) { if (this.alive) { try { socket.write(encodeFrame(0x1, Buffer.from(String(s), 'utf8'))) } catch (e) {} } },
      sendBinary(buf) { if (this.alive) { try { socket.write(encodeFrame(0x2, buf)) } catch (e) {} } },
      close() { this.alive = false; try { socket.destroy() } catch (e) {} },
    }
    clients.add(client)
    if (onOpen) { try { onOpen(client) } catch (e) { warn('onOpen 出错: ' + String((e && e.message) || e)) } }

    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
      for (;;) {
        if (buf.length < 2) return
        const fin = (buf[0] & 0x80) !== 0
        const opcode = buf[0] & 0x0f
        const masked = (buf[1] & 0x80) !== 0
        let len = buf[1] & 0x7f
        let off = 2
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4 }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10 }
        let mask = null
        if (masked) { if (buf.length < off + 4) return; mask = buf.subarray(off, off + 4); off += 4 }
        if (buf.length < off + len) return
        const payload = Buffer.from(buf.subarray(off, off + len))
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
        buf = buf.subarray(off + len)
        if (!fin) continue                      // 不支持分片
        if (opcode === 0x1) { if (onText) { try { onText(client, payload.toString('utf8')) } catch (e) { warn('onText 出错: ' + String((e && e.message) || e)) } } }
        else if (opcode === 0x8) { client.close() }
        else if (opcode === 0x9) { try { socket.write(encodeFrame(0xA, payload)) } catch (e) {} }
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => { client.alive = false; clients.delete(client); if (onClose) { try { onClose(client) } catch (e) {} } })
  })

  return {
    server: server,
    clients: clients,
    set onText(fn) { onText = fn },
    set onOpen(fn) { onOpen = fn },
    set onClose(fn) { onClose = fn },
    listen() {
      return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
    },
    close() {
      for (const c of clients) c.close()
      clients.clear()
      try { server.close() } catch (e) {}
    },
  }
}

// ------------------------------------------------------------
// 每台设备的会话状态
// ------------------------------------------------------------
const sessions = new Map()   // sn -> dev
const modelCache = new Map() // sn -> 型号（型号不会变，缓存起来省掉每 3 秒一次的 getprop）

function newSession(sn, tunnelPort) {
  return {
    sn: sn,
    tunnelPort: tunnelPort,
    serverProc: null,
    serverPids: [],            // 我们自己起的那个进程的 pid（用"起之前/之后差集"认出来）
    videoSock: null,
    controlSock: null,
    ws: null,
    wsPort: 0,
    ready: false,
    broadcasting: true,
    st: { codecId: null, width: 0, height: 0, buf: Buffer.alloc(0), frames: 0, idrs: 0, bytes: 0, lastPts: 0 },
    gop: { config: null, frames: [], bytes: 0, overflow: false },
    lastClientSeen: Date.now(),
  }
}

// scrcpy 包头标记（PLAN §7 实测）
const F_CONFIG = 1, F_KEY = 2

function pushGop(gop, flags, payload) {
  if (flags & F_CONFIG) { gop.config = { flags: flags, payload: Buffer.from(payload) }; gop.frames = []; gop.bytes = 0; gop.overflow = false; return }
  if (flags & F_KEY) { gop.frames = [{ flags: flags, payload: Buffer.from(payload) }]; gop.bytes = payload.length; gop.overflow = false; return }
  if (!gop.config || gop.overflow) return
  gop.frames.push({ flags: flags, payload: Buffer.from(payload) })
  gop.bytes += payload.length
  if (gop.bytes > GOP_MAX_BYTES) { warn('GOP 缓存超上限，整段丢弃、等下一个关键帧'); gop.frames = []; gop.bytes = 0; gop.overflow = true }
}

/** 新观众接入：把 config(SPS/PPS) + 最近一个 GOP 补发出去，让它立刻能解码 */
function replayGop(dev, client) {
  let n = 0
  if (dev.gop.config) { client.sendBinary(dev.gop.config.payload); n++ }
  for (const f of dev.gop.frames) { client.sendBinary(f.payload); n++ }
  if (n) log(dev.sn + ': 给新观众补发 ' + n + ' 帧')
}

/** 解析 scrcpy 视频流：session 包（尺寸）/ config 包（SPS/PPS）/ 媒体包 */
function onVideoData(dev, chunk) {
  const st = dev.st, gop = dev.gop
  st.buf = st.buf.length ? Buffer.concat([st.buf, chunk]) : chunk
  for (;;) {
    if (st.codecId === null) {
      if (st.buf.length < 4) return
      st.codecId = st.buf.readUInt32BE(0)
      log(dev.sn + ': codec id = 0x' + st.codecId.toString(16) + " = '" + st.buf.subarray(0, 4).toString('latin1') + "'")
      st.buf = st.buf.subarray(4)
      continue
    }
    if (st.buf.length < 12) return
    const b0 = st.buf[0]

    if (b0 & 0x80) {                                     // session 包：宽高变了
      const w = st.buf.readUInt32BE(4), h = st.buf.readUInt32BE(8)
      const changed = st.width > 0 && st.height > 0 && (st.width !== w || st.height !== h)
      st.width = w; st.height = h
      st.buf = st.buf.subarray(12)
      log(dev.sn + ': 帧尺寸 ' + w + 'x' + h + (changed ? '（变了）' : ''))
      // 尺寸变了**不主动推**（原来这里会广播 {"msg":"size"}）：
      //   契约里这一问一答是 {type:'size'}（浏览器问）→ {"msg":"size"}（这边答），两端一致（鸿蒙的 sidecar 也是被问才答）。
      //   主动推会让 core 不得不"响应平台独有的推送"，平台差异就漏进 core 了。
      //   答问句的代码在下面 `if (o.type === 'size')` 那处。
      continue
    }

    const size = st.buf.readUInt32BE(8)
    if (st.buf.length < 12 + size) return
    const flags = (b0 & 0x40 ? F_CONFIG : 0) | (b0 & 0x20 ? F_KEY : 0)
    const ptsUs = Number(st.buf.readBigUInt64BE(0) & 0x1fffffffffffffffn)
    const payload = Buffer.from(st.buf.subarray(12, 12 + size))
    st.buf = st.buf.subarray(12 + size)

    st.frames++; st.bytes += size; st.lastPts = ptsUs
    if (flags & F_KEY) st.idrs++
    if (st.frames === 1) note2ui(dev, '设备首帧到达 ' + st.width + 'x' + st.height)
    pushGop(gop, flags, payload)

    if (dev.broadcasting && dev.ws) for (const c of dev.ws.clients) c.sendBinary(payload)
  }
}

// ------------------------------------------------------------
// 注入原语（control socket）—— AI 工具与浏览器 WS 命令共用这一份
// ------------------------------------------------------------
/** INJECT_TOUCH_EVENT：32 字节定长，x/y 用【帧坐标】（demo 实测） */
function injectTouch(dev, action, x, y) {
  if (!dev || !dev.controlSock) return { ok: false, error: 'control socket 不在（先投屏连接）' }
  const { width, height } = dev.st
  if (!width || !height) return { ok: false, error: '还没收到帧尺寸，稍后再试' }
  const m = Buffer.alloc(32)
  m[0] = 2; m[1] = action
  m.writeBigUInt64BE(0xfffffffffffffffen, 2)
  m.writeInt32BE(Math.round(x), 10)
  m.writeInt32BE(Math.round(y), 14)
  m.writeUInt16BE(width, 18)
  m.writeUInt16BE(height, 20)
  m.writeUInt16BE(0xffff, 22)
  dev.controlSock.write(m)
  return { ok: true }
}
/** INJECT_TEXT：type=1 + 长度(uint32) + UTF-8（支持中文；比 adb shell input text 强）【未实测】 */
function injectTextViaControl(dev, text) {
  if (!dev || !dev.controlSock) return { ok: false, error: 'control socket 不在（先投屏连接）' }
  const body = Buffer.from(String(text), 'utf8')
  const m = Buffer.alloc(5 + body.length)
  m[0] = 1
  m.writeUInt32BE(body.length, 1)
  body.copy(m, 5)
  dev.controlSock.write(m)
  return { ok: true }
}
// ------------------------------------------------------------
// UHID 虚拟外接键盘：鼠标点进投屏窗口后，PC 键盘直接变成设备的键盘
//   （设备侧是**真 HID 键盘** → 系统输入法按物理键盘处理 → 拼音候选词能出来）
// 协议照抄官方 scrcpy 4.1 源码（app/src/control_msg.c:157-180 + app/src/hid/hid_keyboard.c）：
//   12 UHID_CREATE  [12][id u16][vendor u16][product u16][名字长 u8][名字][描述符长 u16][描述符]
//   13 UHID_INPUT   [13][id u16][size u16][data...]
//   14 UHID_DESTROY [14][id u16]
// 键盘报告固定 8 字节：[0]修饰键 [1]保留(0) [2..7]最多 6 个按下的 usage
// ⚠️ 不需要改 server 启动参数：服务端是**收到 UHID_CREATE 才按需建** UhidManager
//    （server/.../control/Controller.java:183-212），UHID 全走 control 通道。
// ------------------------------------------------------------
const UHID_ID_KEYBOARD = 1
const UHID_MAX_KEYS = 6
/** 官方 hid_keyboard.c:54-126 的键盘报告描述符（**63 字节，照抄勿改**） */
const UHID_KEYBOARD_DESC = Buffer.from([
  0x05, 0x01, 0x09, 0x06, 0xA1, 0x01, 0x05, 0x07, 0x19, 0xE0, 0x29, 0xE7, 0x15, 0x00, 0x25, 0x01,
  0x75, 0x01, 0x95, 0x08, 0x81, 0x02, 0x75, 0x08, 0x95, 0x01, 0x81, 0x01, 0x05, 0x08, 0x19, 0x01,
  0x29, 0x05, 0x75, 0x01, 0x95, 0x05, 0x91, 0x02, 0x75, 0x03, 0x95, 0x01, 0x91, 0x01, 0x05, 0x07,
  0x19, 0x00, 0x29, 0x65, 0x15, 0x00, 0x25, 0x65, 0x75, 0x08, 0x95, 0x06, 0x81, 0x00, 0xC0,
])
/** 建虚拟键盘（连上 control 后发一次）*/
function uhidKeyboardCreate(dev) {
  if (!dev || !dev.controlSock) return { ok: false, error: 'control socket 不在（先投屏连接）' }
  const name = Buffer.from('dsh-scrcpy', 'utf8')
  const head = Buffer.alloc(8)
  head[0] = 12
  head.writeUInt16BE(UHID_ID_KEYBOARD, 1)
  head.writeUInt16BE(0, 3)      // vendor_id
  head.writeUInt16BE(0, 5)      // product_id
  head[7] = name.length         // 名字长度（1 字节）
  const tail = Buffer.alloc(2)
  tail.writeUInt16BE(UHID_KEYBOARD_DESC.length, 0)
  dev.controlSock.write(Buffer.concat([head, name, tail, UHID_KEYBOARD_DESC]))
  dev.hidKeys = []
  dev.hidMods = 0
  dev.uhid = true
  log(dev.sn + ': UHID 虚拟键盘已创建（PC 键盘可直输）')
  return { ok: true }
}
/** 发一个键盘报告（按下/松开都由它刷新）*/
function uhidKeyboardReport(dev) {
  if (!dev || !dev.controlSock) return { ok: false, error: 'control socket 不在' }
  const keys = (dev.hidKeys || []).slice(0, UHID_MAX_KEYS)
  const data = Buffer.alloc(8)
  data[0] = (dev.hidMods || 0) & 0xff
  for (let i = 0; i < keys.length; i++) data[2 + i] = keys[i] & 0xff
  const m = Buffer.alloc(5 + data.length)
  m[0] = 13
  m.writeUInt16BE(UHID_ID_KEYBOARD, 1)
  m.writeUInt16BE(data.length, 3)
  data.copy(m, 5)
  dev.controlSock.write(m)
  return { ok: true }
}
function uhidKeyboardDestroy(dev) {
  if (!dev || !dev.controlSock || !dev.uhid) return
  const m = Buffer.alloc(3)
  m[0] = 14
  m.writeUInt16BE(UHID_ID_KEYBOARD, 1)
  try { dev.controlSock.write(m) } catch (e) {}
  dev.uhid = false
}
/** 比例坐标 → 帧像素 */
function clamp01(v) { v = Number(v); return v < 0 ? 0 : v > 1 ? 1 : v }
function fxToPx(dev, fx) { return Math.max(0, Math.min(dev.st.width - 1, Math.round(Number(fx) * (dev.st.width - 1)))) }
function fyToPx(dev, fy) { return Math.max(0, Math.min(dev.st.height - 1, Math.round(Number(fy) * (dev.st.height - 1)))) }

const KEYCODES = { back: 4, home: 3, volumeUp: 24, volumeDown: 25, power: 26, enter: 66, menu: 82 }
    // 手动输入用的编辑键：逻辑名由 core 给（首字母大写），走 input keyevent，毫秒级
    const EDIT_KEYCODES = {
      Backspace: 67, Delete: 112, Enter: 66, Tab: 61,
      ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22,
      Home: 122, End: 123,
    }

// ------------------------------------------------------------
// 起流 / 停流
// ------------------------------------------------------------
function connectSocket(port) {
  return new Promise((resolve, reject) => {
    const s = connect({ host: '127.0.0.1', port: port }, () => resolve(s))
    s.on('error', reject)
  })
}
/** 二进制输出（execFile 默认按 utf8 解码，会毁掉 PNG！所以单独一个 helper） */
function adbExecOut(sn, args) {
  return new Promise((resolve, reject) => {
    execFile(ADB, ['-s', sn].concat(args), { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error('adb ' + args.join(' ') + ' 失败: ' + String(stderr || err.message || '')))
      resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || ''))
    })
  })
}
function tunnelPortFor() {
  const used = new Set(Array.from(sessions.values()).map((d) => d.tunnelPort))
  let p = TUNNEL_PORT_BASE
  while (used.has(p)) p++
  return p
}

/** 浏览器经 WS 发来的命令（契约里的那套） */
function handleWsCommand(dev, client, text) {
  let o = null
  try { o = JSON.parse(text) } catch (e) { return }
  if (!o || !o.type) return
  if (o.type === 'size') {
    if (dev.st.width && dev.st.height) client.sendText(JSON.stringify({ msg: 'size', data: dev.st.width + 'x' + dev.st.height }))
    return
  }
  if (o.type === 'screen') {
    const mode = String(o.mode || '')
    if (mode === 'pause') { dev.broadcasting = false; log(dev.sn + ': 广播暂停'); return }
    if (mode === 'resume' || mode === 'video') {
      dev.broadcasting = true
      // ⚠️ 暂停期间是**成片丢帧**的。恢复时若不补一个"可解码起点"，客户端拿到的是中间段的增量帧，
      //    它们参考的帧已经在暂停时被丢掉了 → 解不出来 → 画面冻在暂停前那一帧（而二进制帧照到、计数照涨）。
      //    【实测 2026-09-28】两台设备来回切标签页就复现；旋转屏幕能救，因为那会逼出一个新 IDR。
      //    这里把缓存的 GOP（SPS/PPS + 最近一个关键帧起的帧）补发给这个观众，等价于"重放一次起点"。
      replayGop(dev, client)
      log(dev.sn + ': 广播恢复 · 已补发 GOP')
      return
    }
    return
  }
  if (o.type === 'touch') {
    // 浏览器传来的 x/y 已经是【帧坐标】（它用我们下发的 size 换算过）
    const action = o.event === 'down' ? 0 : o.event === 'up' ? 1 : 2
    const r = injectTouch(dev, action, Number(o.x), Number(o.y))
    if (!r.ok) warn(dev.sn + ': ' + r.error)
    return
  }
  if (o.type === 'key') {
    const code = KEYCODES[String(o.name || '')]
    if (code) shell(dev.sn, 'input keyevent ' + code, { allowFail: true })
    else warn(dev.sn + ': 不支持的按键 ' + o.name)
    return
  }
  if (o.type === 'hid') {
    // 投屏窗口里按下的 PC 键：usage 是 USB HID usage（客户端查表），mods 是修饰键位图
    if (!dev.uhid) {
      if (!dev.uhidWarned) {
        dev.uhidWarned = true
        warn(dev.sn + ': UHID 键盘未就绪，忽略按键')
        sendToClients(dev, { ok: false, error: 'UHID 虚拟键盘没建起来（provider 侧），按键被丢弃' })
        sendToClients(dev, { msg: 'hid', ok: false })
      }
      return
    }
    const usage = Number(o.usage) | 0
    const down = o.down === true
    dev.hidMods = Number(o.mods) | 0
    const list = dev.hidKeys || (dev.hidKeys = [])
    const i = list.indexOf(usage)
    if (usage) {
      if (down && i < 0) { if (list.length >= UHID_MAX_KEYS) list.shift(); list.push(usage) }
      else if (!down && i >= 0) list.splice(i, 1)
    }
    const r = uhidKeyboardReport(dev)
    if (!r.ok) warn(dev.sn + ': ' + r.error)
    return
  }
  if (o.type === 'log') {
    // 面板的「日志」现在是【插件日志】（2026-09-26决定）：不再有"设备日志流"这个概念，
    // 所以这里什么都不用回 —— 面板显示的是客户端诊断 + 本 provider 推的 {"msg":"log"} 行。
    return
  }
}

/** 把一条消息推给本会话所有网页客户端（core 的 status 行会显示 ok:false 的 error）*/
function sendToClients(dev, obj) {
  try { if (dev && dev.ws) for (const c of dev.ws.clients) c.sendText(JSON.stringify(obj)) } catch (e) {}
}
/**
 * 固定的一条诊断日志（"那就固定一个日志"）：
 *   同时写控制台**和插件日志面板**。面板那条要等网页客户端连上才送得出去 ——
 *   而起流时客户端还没连上，所以先存在会话上，连上那一刻由 flushLogPanel 补发。
 */
function logPanel(dev, text) {
  const line = String(text)
  try { log((dev && dev.sn ? dev.sn + ': ' : '') + line) } catch (e) {}
  if (!dev) return
  if (dev.ws && dev.ws.clients && dev.ws.clients.size) { sendToClients(dev, { msg: 'log', data: line }); return }
  if (!Array.isArray(dev.logPending)) dev.logPending = []
  dev.logPending.push(line)
  if (dev.logPending.length > 40) dev.logPending.shift()
}
function flushLogPanel(dev) {
  if (!dev || !Array.isArray(dev.logPending) || !dev.logPending.length) return
  const lines = dev.logPending
  dev.logPending = []
  for (const l of lines) sendToClients(dev, { msg: 'log', data: l })
}
/** 往【插件日志】里写一行（面板「日志」按钮可见）—— 不是"设备日志流" */
function note2ui(dev, text) { sendToClients(dev, { msg: 'log', data: String(text) }) }

async function startStream(sn) {
  // 先把"这次要用哪组画面参数"算出来 —— 复用会话前要比一比（
  // 有线选了 1/4，首帧却仍是 2560x1600 → 因为当时直接复用了旧流，参数只在起流那一刻读）
  const cfg = readConfig()
  const picWireless = /:\d+$/.test(String(sn))   // adb 目标带 :port = TCP（无线调试）
  const picKeyNow = (picWireless ? 'w' : 'u') + '|' + (picWireless ? cfg.wirelessScale : cfg.wiredScale) + '|' + (picWireless ? cfg.wirelessFps : cfg.wiredFps)
  const existing = sessions.get(sn)
  if (existing && existing.ready) {
    if (existing.picKey === picKeyNow) {
      // 同一台设备已在跑、画面参数也没变：复用（不断开重连，避免打断正在看的画面）
      const p = existing.pic || {}
      return { ok: true, sn: sn, port: existing.wsPort, reused: true, wireless: !!p.wireless, scale: p.scale || 1, frameRate: p.fps || 0 }
    }
    log(sn + ': 画面参数变了（' + (existing.picKey || '?') + ' → ' + picKeyNow + '），按新参数重建投屏')
    await stopStream(sn)
  }
  const adbInfo = resolveAdb()
  if (!adbInfo.path) return { ok: false, error: '没找到 adb：请在「连接设置」里填路径，或设 ADB 环境变量' }
  ADB = adbInfo.path
  if (!existsSync(JAR_LOCAL)) return { ok: false, error: '包内资源缺失：' + JAR_LOCAL }

  const list = await rawDevices()
  const target = list.find((d) => d.sn === sn)
  if (!target) return { ok: false, error: '设备 ' + sn + ' 不在 adb 列表里（检查数据线 / 无线调试）' }
  if (!target.online) return { ok: false, error: '设备 ' + sn + ' 的状态是 ' + target.state + '（需要在设备上允许 USB 调试）' }

  const dev = newSession(sn, tunnelPortFor())
  sessions.set(sn, dev)

  try {
    // ① 先记下"别人已经存在的 app_process"，我们只清自己起的那个（CONTRACT §5 的硬要求）
    const before = await appProcessPids(sn)

    // ② push jar + 建隧道
    log(sn + ': push ' + JAR_LOCAL + ' → ' + JAR_REMOTE)
    await adbExec(sn, ['push', JAR_LOCAL, JAR_REMOTE])
    await adbExec(sn, ['forward', '--remove', 'tcp:' + dev.tunnelPort], { allowFail: true })
    await adbExec(sn, ['forward', 'tcp:' + dev.tunnelPort, 'localabstract:scrcpy'])

    // ③ 起 server（关掉不需要的两样，保留 frame_meta / stream_meta）
    const opts = ['tunnel_forward=true', 'audio=false', 'control=true', 'cleanup=false', 'send_device_meta=false', 'send_dummy_byte=false']
    // 画面四件套（core 定的 key）：按**当前是无线还是有线**选一组；缩放折算成 max_size 像素，帧率走 max_fps
    const picScale = picWireless ? cfg.wirelessScale : cfg.wiredScale
    const picFps = picWireless ? cfg.wirelessFps : cfg.wiredFps
    if (picFps > 0) opts.push('max_fps=' + Math.min(120, Number(picFps)))   // 120 封顶（
    const picDivisor = scaleDivisor(picScale)
    let picMaxSize = 0
    if (picDivisor > 1) {
      const lng = await deviceLongEdge(sn)
      if (lng > 0) { picMaxSize = Math.max(2, Math.round(lng / picDivisor)); opts.push('max_size=' + picMaxSize) }
      else logPanel(dev, '读不到设备分辨率（wm size），本次缩放设置未生效（' + picScale + '）')
    }
    // 把**真正用上**的画面参数记在会话上 → 结束时回报给 UI（
    // "选了原画也没用，还是 有线 · 1/2" —— 因为以前这个值根本没回报，UI 显示的是自己的兜底常数）
    dev.pic = { wireless: picWireless, scale: picDivisor, fps: Math.min(120, Number(picFps) || 0), maxSize: picMaxSize }
    dev.picKey = picKeyNow   // 记下这组参数 → 下次 Start 时比对，变了就重建（见函数开头）
    const cmd = 'CLASSPATH=' + JAR_REMOTE + ' app_process / com.genymobile.scrcpy.Server ' + SERVER_VERSION + ' ' + opts.join(' ')
    // 服务器输出【必须接住】：以前是 stdio:'ignore'，等于把 UHID / 编码器 / 权限 的报错全扔了，
    // 出问题只能靠猜（2026-09-26 排查 UHID 时吃的亏）。错误行直接转给网页显示。
    dev.serverProc = spawn(ADB, ['-s', sn, 'shell', cmd], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const onServerOut = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        const s = line.trim()
        if (!s) continue
        log(sn + ' [server] ' + s)
        sendToClients(dev, { msg: 'log', data: 'server: ' + s })
        if (/uhid|exception|error|fail|denied|permission/i.test(s)) {
          sendToClients(dev, { ok: false, error: 'server: ' + s })
        }
      }
    }
    dev.serverProc.stdout.on('data', onServerOut)
    dev.serverProc.stderr.on('data', onServerOut)
    dev.serverProc.on('exit', (code) => { log(sn + ': server 进程退出 (' + code + ')'); dev.serverProc = null })

    // ④ 等就绪：/proc/net/unix 出现 @scrcpy（不等它会拿到永不吐字节的死连接）
    const t0 = Date.now()
    for (;;) {
      const r = await shell(sn, 'cat /proc/net/unix', { allowFail: true })
      if (/@scrcpy/.test(String(r.out))) break
      if (Date.now() - t0 > 30000) throw new Error('等 server 就绪超时（30s）')
      await sleep(300)
    }

    // ⑤ 认领我们自己的 pid（起之前没有、现在多出来的那个）
    const after = await appProcessPids(sn)
    dev.serverPids = after.filter((p) => before.indexOf(p) < 0)
    log(sn + ': server pid = ' + (dev.serverPids.join(',') || '（认不出来，停流时就不 kill）'))

    // ⑥ 开 WS 端点：core 的浏览器半区连它（协议见 CONTRACT §5）
    dev.ws = createWsServer()
    dev.ws.onOpen = (client) => {
      replayGop(dev, client)
      // 建键盘是在网页连上之前做完的，那时的汇报发给 0 个客户端 → 这里补一次
      //（2026-09-26 实测界面显示"UHID 状态未知"就是被这个时序坑的）
      if (typeof dev.uhid === 'boolean') {
        client.sendText(JSON.stringify({ msg: 'hid', ok: dev.uhid, confirmed: dev.uhidConfirmed === true }))
      }
      // 客户端刚连上：把起流时存下的诊断行补发到日志面板（否则那行只在控制台里）
      flushLogPanel(dev)
      note2ui(dev, 'WS 已连 · 广播=' + (dev.broadcasting ? '开' : '关')
        + ' · 缓存帧=' + ((dev.gop && dev.gop.frames.length) || 0)
        + ' · 设备帧=' + ((dev.st && dev.st.frames) || 0)
        + ' · video=' + (dev.videoSock ? '通' : '断') + ' control=' + (dev.controlSock ? '通' : '断'))
    }
    dev.ws.onClose = () => { dev.lastClientSeen = Date.now() }
    dev.ws.onText = (client, text) => handleWsCommand(dev, client, text)
    dev.wsPort = await dev.ws.listen()

    // ⑦ 连两路 socket：第 1 个 = video，第 2 个 = control（间隔一下，顺序不能反）
    dev.videoSock = await connectSocket(dev.tunnelPort)
    await sleep(300)
    dev.controlSock = await connectSocket(dev.tunnelPort)
    dev.videoSock.on('data', (c) => onVideoData(dev, c))
    dev.videoSock.on('close', () => warn(sn + ': video socket 关了'))
    dev.controlSock.on('error', (e) => warn(sn + ': control socket 出错 ' + e.message))
    // 读服务器在 control 上回的"设备消息"：其中 UHID 输出（type=2）到达 = 设备**真的**把我们的
    // 虚拟键盘挂上了 —— 这是唯一能自己拿到的确认信号（dumpsys/getevent 在华为机上读不全）
    dev.controlSock.on('data', (chunk) => {
      try {
        const b = Buffer.from(chunk)
        const type = b.length ? b[0] : -1
        if (type === 2) {
          dev.uhidConfirmed = true
          log(sn + ': 收到 UHID 输出 —— 设备已确认虚拟键盘存在')
          sendToClients(dev, { msg: 'hid', ok: dev.uhid === true, confirmed: true })
        } else {
          log(sn + ': 设备消息 type=' + type + ' · ' + b.toString('hex').slice(0, 40))
        }
      } catch (e) {}
    })

    // ⑧ 建虚拟键盘：PC 键盘直输用（失败不影响投屏，只影响打字）—— 成败都推到网页上，别再当黑盒
    try {
      const r = uhidKeyboardCreate(dev)
      if (!r.ok) sendToClients(dev, { ok: false, error: 'UHID 键盘不可用：' + r.error })
      else sendToClients(dev, { msg: 'hid', ok: true })
    } catch (e) {
      dev.uhid = false
      sendToClients(dev, { ok: false, error: 'UHID 键盘创建失败：' + String((e && e.message) || e) })
      sendToClients(dev, { msg: 'hid', ok: false })
    }

    dev.ready = true
    log(sn + ': 就绪 · ws://127.0.0.1:' + dev.wsPort + ' · 隧道 tcp:' + dev.tunnelPort)
    // 回报**真实生效**的画面参数（旧注释说"安卓没有 scale 概念所以不返回"，结果 UI 自己编了个 1/2）
    const pic = dev.pic || { wireless: false, scale: 1, fps: 0, maxSize: 0 }
    logPanel(dev, '画面参数 · ' + (pic.wireless ? '无线' : '有线') + ' · 缩放 ' + (pic.scale === 1 ? '原画' : '1/' + pic.scale) +
        '（max_size=' + (pic.maxSize || '未限制') + '）· 最高帧率 ' + (pic.fps || '不限'))
    return { ok: true, sn: sn, port: dev.wsPort, wireless: pic.wireless, scale: pic.scale, frameRate: pic.fps }
  } catch (e) {
    try { await stopStream(sn) } catch (e2) {}
    return { ok: false, error: String((e && e.message) || e) }
  }
}

async function stopStream(sn) {
  const dev = sessions.get(sn)
  if (!dev) return { ok: true, sn: sn }
  sessions.delete(sn)
  try { uhidKeyboardDestroy(dev) } catch (e) {}
  try { if (dev.ws) dev.ws.close() } catch (e) {}
  try { if (dev.videoSock) dev.videoSock.destroy() } catch (e) {}
  try { if (dev.controlSock) dev.controlSock.destroy() } catch (e) {}
  try { if (dev.serverProc) dev.serverProc.kill() } catch (e) {}
  // 只 kill 我们自己认领到的 pid；认不出来就不动（避免误杀用户在别的工具里跑的 app_process）
  if (dev.serverPids && dev.serverPids.length) {
    await shell(sn, 'kill -9 ' + dev.serverPids.join(' '), { allowFail: true })
  } else if (dev.ready) {
    warn(sn + ': 没认领到 server pid，跳过 kill（防止误杀其它 app_process）')
  }
  await adbExec(sn, ['forward', '--remove', 'tcp:' + dev.tunnelPort], { allowFail: true })
  log(sn + ': 已停流')
  return { ok: true, sn: sn }
}

// ------------------------------------------------------------
// actions（core 按契约调）
// ------------------------------------------------------------
async function actionListDevices() {
  const adbInfo = resolveAdb()
  if (!adbInfo.path) return []
  ADB = adbInfo.path
  const list = await rawDevices()
  const out = []
  for (const d of list) {
    let model = ''
    if (d.online) {
      if (modelCache.has(d.sn)) model = modelCache.get(d.sn)
      else { model = await deviceModel(d.sn); if (model) modelCache.set(d.sn, model) }
    }
    const sess = sessions.get(d.sn)
    out.push({ sn: d.sn, name: model || d.sn, model: model, online: d.online, streaming: !!(sess && sess.ready) })
  }
  return out
}

async function actionSnapshot(sn) {
  const adbInfo = resolveAdb()
  if (!adbInfo.path) return { ok: false, error: '没找到 adb' }
  ADB = adbInfo.path
  try {
    // exec-out 拿原始字节（shell 会把 PNG 的 \n 弄坏，别用 shell）
    const bytes = await adbExecOut(sn, ['exec-out', 'screencap', '-p'])
    if (!bytes || bytes.length < 100) return { ok: false, error: '截图返回空（设备可能锁屏）' }
    return { ok: true, bytes: bytes, mediaType: 'image/png' }
  } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
}

function parseAttrs(s) {
  const out = {}
  const re = /([\w-]+)="([^"]*)"/g
  let m
  while ((m = re.exec(s)) !== null) out[m[1]] = m[2]
  return out
}

/** uiautomator dump 的 XML → 契约里的统一控件清单 {type,text,id,clickable,fx,fy,w,h} */
function parseUiXml(xml, size) {
  const nodes = []
  const re = /<node\b([^>]*?)\/?>/g
  let m
  while ((m = re.exec(String(xml))) !== null) {
    const a = parseAttrs(m[1])
    const mb = String(a.bounds || '').match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/)
    if (!mb) continue
    const x1 = +mb[1], y1 = +mb[2], x2 = +mb[3], y2 = +mb[4]
    if (x2 <= x1 || y2 <= y1) continue
    if (a.enabled === 'false') continue
    const text = String(a.text || ''), desc = String(a['content-desc'] || '')
    const id = String(a['resource-id'] || ''), cls = String(a['class'] || '')
    const clickable = a.clickable === 'true'
    // 只留"有点东西"的节点：有文字/描述，或可点击，或带资源名（与鸿蒙侧的筛选原则一致）
    if (!text && !desc && !clickable && !id) continue
    const sw = size ? size.w : 0, sh = size ? size.h : 0
    nodes.push({
      type: (cls.split('.').pop() || cls).slice(0, 40),
      text: text.slice(0, 60),
      desc: desc.slice(0, 60),
      id: id,
      clickable: clickable,
      fx: sw ? clamp01(((x1 + x2) / 2) / sw) : 0,
      fy: sh ? clamp01(((y1 + y2) / 2) / sh) : 0,
      w: x2 - x1, h: y2 - y1,
    })
  }
  const seen = {}, dedup = []
  for (const n of nodes) {
    const k = (n.text || n.desc || n.id || '') + '|' + n.type + '|' + Math.round(n.fx * 100) + '|' + Math.round(n.fy * 100)
    if (seen[k]) continue
    seen[k] = true
    dedup.push(n)
  }
  dedup.sort((a, b) => a.fy - b.fy || a.fx - b.fx)
  return dedup.slice(0, 100)
}

async function actionDumpLayout(sn) {
  const adbInfo = resolveAdb()
  if (!adbInfo.path) return { ok: false, error: '没找到 adb' }
  ADB = adbInfo.path
  const remote = '/sdcard/dsh-scrcpy-ui.xml'
  try {
    await shell(sn, 'uiautomator dump ' + remote, { allowFail: true })
    const raw = await adbExecOut(sn, ['exec-out', 'cat', remote])
    shell(sn, 'rm -f ' + remote, { allowFail: true })
    const xml = raw.toString('utf8')
    if (!xml || xml.indexOf('<hierarchy') < 0) return { ok: false, error: 'uiautomator dump 没拿到有效 XML（H5/游戏/自绘界面常常拿不到）' }
    // 坐标系要用【当前显示方向】的空间（见 layoutSpace 的说明）——不能直接用 wm size
    const box = xmlBounds(xml)
    const space = await layoutSpace(sn, box.maxX, box.maxY)
    const items = parseUiXml(xml, space)
    if (!items.length) return { ok: false, error: '未解析到可用控件（布局为空或全部不可见）' }
    return { ok: true, items: items, realW: space.w, realH: space.h, spaceSource: space.source }
  } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
}

function needControl(sn) {
  const dev = sessions.get(sn)
  if (!dev || !dev.controlSock) return { ok: false, error: '设备 ' + sn + ' 还没投屏连接：触控/文本要经投屏的 control 通道发（先点「投屏」）' }
  if (!dev.st.width || !dev.st.height) return { ok: false, error: '还没收到帧尺寸，等画面出来再操作' }
  return { ok: true, dev: dev }
}

async function actionTap(sn, args) {
  const c = needControl(sn)
  if (!c.ok) return c
  const x = fxToPx(c.dev, args && args.fx), y = fyToPx(c.dev, args && args.fy)
  const d = injectTouch(c.dev, 0, x, y)
  if (!d.ok) return d
  await sleep(40)
  return injectTouch(c.dev, 1, x, y)
}

async function actionLongpress(sn, args) {
  const c = needControl(sn)
  if (!c.ok) return c
  const ms = Math.max(100, Math.min(10000, Number(args && args.holdMs) || 2000))
  const x = fxToPx(c.dev, args && args.fx), y = fyToPx(c.dev, args && args.fy)
  const d = injectTouch(c.dev, 0, x, y)
  if (!d.ok) return d
  await sleep(ms)
  return injectTouch(c.dev, 1, x, y)
}

async function actionKey(sn, args) {
  const name = String((args && args.key) || '')
  const code = EDIT_KEYCODES[name] || KEYCODES[name]
  if (!code) return { ok: false, error: '不支持的按键：' + name + '（支持 ' + Object.keys(EDIT_KEYCODES).concat(Object.keys(KEYCODES)).join(' / ') + '）' }
  const r = await shell(sn, 'input keyevent ' + code, { allowFail: true })
  if (r.code !== 0 && String(r.err).trim()) return { ok: false, error: String(r.err).trim() }
  return { ok: true, key: name }
}

// 读设备剪贴板：安卓没有官方途径（cmd clipboard 在 AOSP 里没有实现）。
// 按"从新到旧逐个试、成功就停、全失败就静默"处理 —— 某些国产 ROM 可能补了 cmd clipboard。
let clipProbe = null   // null=未知 / true=可用 / false=不可用
async function actionReadClipboard(sn) {
  if (clipProbe === false) return { ok: false, unsupported: true }
  const attempts = ['cmd clipboard get-primary-clip', 'cmd clipboard get']
  for (const cmd of attempts) {
    const r = await shell(sn, cmd, { allowFail: true })
    if (r && r.code === 0) {
      const text = String(r.out || '').replace(/\r?\n$/, '')
      if (text && text.indexOf('No shell command implementation') < 0) {
        clipProbe = true
        return { ok: true, text: text }
      }
    }
  }
  clipProbe = false
  return { ok: false, unsupported: true }
}
async function actionInput(sn, args) {
  const text = String((args && args.text) || '')
  if (!text) return { ok: false, error: '缺少 text' }
  const dev = sessions.get(sn)
  // 有 control 通道就优先走 scrcpy 的 INJECT_TEXT（UTF-8，支持中文）；否则退回 adb（仅 ASCII）
  if (dev && dev.controlSock) {
    const r = injectTextViaControl(dev, text)
    if (r.ok) return { ok: true, text: text }
  }
  const r = await shell(sn, 'input text ' + JSON.stringify(text), { allowFail: true })
  return r.code === 0 ? { ok: true, text: text } : { ok: false, error: String(r.err).trim() || '文本注入失败' }
}

// ------------------------------------------------------------
// handlers（core 用 provider:call 转发，不认识里面的形状）
// ------------------------------------------------------------
async function handlerEnvDetect() {
  const a = resolveAdb()
  const v = await adbVersion(a.path)
  return {
    ok: true,
    // 构建戳**不在这里显示**（"和 adb 在一块的 provider build 那行"删掉）——
    //   它改到「连接设置」的按钮行左边，走 cfg:describe.build
    items: [
      { key: 'adb', label: 'adb', ok: v.ok, version: v.version, path: a.path, source: a.source, error: v.error },
    ],
  }
}
async function handlerCfgDescribe() {
  return {
    ok: true,
    // 构建戳：core 把它显示在「取消/保存」按钮行左边，
    //   一眼看出跑的是哪版 provider（版本号不动，见 ~/.dsh/AGENTS.md）
    build: PROVIDER_BUILD,
    fields: [
      { key: 'adbPath', group: 'env', label: { zh: 'adb 路径（adb.exe）', en: 'adb path (adb.exe)' }, type: 'text', placeholder: { zh: '留空 = 自动检测（ADB 环境变量 / Android SDK 默认位置 / PATH）', en: 'empty = auto-detect (ADB env var / Android SDK default / PATH)' } },
      // 「最大边长」已删除：画面参数改由 **core 的四件套**统一提供
      //   （wiredScale / wiredFps / wirelessScale / wirelessFps），provider 只负责读这几个 key 并让它生效。
    ],
  }
}
async function handlerCfgGet() { return { ok: true, config: readConfig() } }
async function handlerCfgSave(args) {
  const prev = readConfig()
  const cfg = {
    adbPath: (args && args.adbPath !== undefined) ? String(args.adbPath || '').trim() : prev.adbPath,
    // 画面四件套（core 传过来的 key，原样持久化 —— CONTRACT 要求）
    wiredScale: (args && args.wiredScale !== undefined) ? String(args.wiredScale || prev.wiredScale) : prev.wiredScale,
    wiredFps: (args && args.wiredFps !== undefined) ? (Number(args.wiredFps) > 0 ? Number(args.wiredFps) : prev.wiredFps) : prev.wiredFps,
    wirelessScale: (args && args.wirelessScale !== undefined) ? String(args.wirelessScale || prev.wirelessScale) : prev.wirelessScale,
    wirelessFps: (args && args.wirelessFps !== undefined) ? (Number(args.wirelessFps) > 0 ? Number(args.wirelessFps) : prev.wirelessFps) : prev.wirelessFps,
  }
  const r = writeConfig(cfg)
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true, config: cfg }
}

// ------------------------------------------------------------
// 插件出口：把自己登记到 core 的注册表
// ------------------------------------------------------------
let pollTimer = null

async function pushDevices(ctx) {
  try {
    ctx.scrcpyProviders.setDevices('android', await actionListDevices())
  } catch (e) { /* 设备列表拿不到时静默，别刷屏 */ }
}

export default {
  name: 'dsh-android-scrcpy',
  inject: ['scrcpyProviders'],
  apply(ctx) {
    const adbInfo = resolveAdb()
    if (adbInfo.path) ADB = adbInfo.path

    const reg = ctx.scrcpyProviders.register({
      id: 'android',
      label: { zh: '安卓', en: 'Android' },
      transport: 'adb',
      abi: 1,
      build: PROVIDER_BUILD,
      available: !!adbInfo.path,
      note: adbInfo.path ? '' : { zh: '没找到 adb（请在「连接设置」里填路径）', en: 'adb not found (set its path in Connection settings)' },
      capabilities: {
        // 界面上的按键按钮：**由 provider 声明**（数组顺序就是显示顺序）+ 双语显示名
        // "剩下的按钮让 prov 声明"；
        //   同日再定：enter / menu 不做按钮 —— enter 已经被 UHID 键盘覆盖（PC 上敲回车直接到设备），
        //   menu 在现代 Android 上多数 App 没反应。KEYCODES 里仍保留这两个码，只是不显示。
        keys: ['back', 'home', 'volumeUp', 'volumeDown', 'power'],
        keyLabels: {
          back: { zh: '返回', en: 'Back' }, home: { zh: '主页', en: 'Home' },
          volumeUp: { zh: '音量+', en: 'Vol+' }, volumeDown: { zh: '音量-', en: 'Vol−' },
          power: { zh: '电源', en: 'Power' },
        },
        // 允许 AI 用哪些键（"同时声明哪些可以让 ai 用"）
        //   这里故意只放 back/home：音量、电源会改变设备状态，让用户在界面上自己按更稳。
        //   界面上那 5 个按钮不受影响 —— 两者是分开声明的。
        aiKeys: ['back', 'home'],
        streams: true, log: false,
        // 画面四件套：**声明 = "core 定的这四个 key 我会读、会生效"**
        //   core 侧固定渲染：有线/无线 × 缩放/最低帧率；不声明则界面给"未声明画面选项"提示。
        //   默认值：有线 1/2 · 60fps；无线 1/4 · 30fps；两端都能跳到原画；帧率 120 封顶。
        picture: {
          wired: { scale: ['1', '1/2', '1/3', '1/4'], fps: [120, 90, 60, 30, 15], defaultScale: '1/2', defaultFps: 60 },
          wireless: { scale: ['1', '1/2', '1/3', '1/4'], fps: [60, 30, 15], defaultScale: '1/4', defaultFps: 30 },
        },
        // 键盘文案交给 provider（core 不该写死"UHID已启用"）
        //   ① 声明了这个对象 = "我有键盘输入"；② 两句文案双语，core 按当前语言挑（见 core 的 pickText）
        keyboard: {
          on: { zh: 'UHID已启用·键盘已接管', en: 'UHID on · keyboard captured' },
          off: { zh: '键盘未接管', en: 'Keyboard not captured' },
          notReady: { zh: '键盘未接管（UHID 未就绪）', en: 'Keyboard not captured (UHID not ready)' },
        },
      },
      actions: {
        listDevices: actionListDevices,
        // core 用到的：startStream / stopStream / snapshot / dumpLayout / input
        startStream: (sn) => startStream(sn),
        stopStream: (sn) => stopStream(sn),
        snapshot: (sn) => actionSnapshot(sn),
        dumpLayout: (sn) => actionDumpLayout(sn),
        input: (sn, a) => actionInput(sn, a),
        // 下面三个目前 core 不走（AI 手势是浏览器经 WS 直接发的），留着给"provider 侧直接调用"用
        tap: (sn, a) => actionTap(sn, a),
        longpress: (sn, a) => actionLongpress(sn, a),
        key: (sn, a) => actionKey(sn, a),
    clipboardText: (sn) => actionReadClipboard(sn),
      },
      handlers: {
        'env:detect': handlerEnvDetect,
        'cfg:describe': handlerCfgDescribe,
        'cfg:get': handlerCfgGet,
        'cfg:save': handlerCfgSave,
      },
    })

    pushDevices(ctx)
    pollTimer = setInterval(() => {
      pushDevices(ctx)
      // 空闲自杀：DSH 若被强杀，设备端的 app_process 会残留并占着编码器。
      // 没人看超过 5 分钟就主动收摊（鸿蒙那边是 sidecar 自己退出，同一个目的）。
      const now = Date.now()
      for (const entry of Array.from(sessions.entries())) {
        const sn = entry[0], dev = entry[1]
        const viewers = dev.ws ? dev.ws.clients.size : 0
        if (viewers === 0 && dev.ready && now - dev.lastClientSeen > 5 * 60 * 1000) {
          log(sn + ': 5 分钟没有观众，自动停流（防残留占设备）')
          stopStream(sn).catch(() => {})
        }
      }
    }, 3000)

    ctx.on('dispose', async () => {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
      for (const sn of Array.from(sessions.keys())) { try { await stopStream(sn) } catch (e) {} }
      try { reg() } catch (e) {}
    })
  },
}
