// android/Dev/demo/demo-host.mjs —— 安卓投屏 demo 的 host 侧（**多设备版**）
//
// 目的：把「scrcpy-server 协议 ↔ 浏览器」这条路验通，不引入 DSH、不引入任何 npm 依赖。
// Node 22+。
//
// 用法：
//   node host.mjs --sn emulator-5554                      # 单台
//   node host.mjs --sn emulator-5554,emulator-5556        # 多台（逗号分隔）；本地端口自动 27183 / 27184 …
//   node host.mjs --sn emulator-5554 --probe              # 只解析前几帧然后退出，不起 HTTP
//   node host.mjs --sn emulator-5554 --max-size 1920      # 省流档位（帧会被缩放，宽高看 session packet）
//
// 页面：http://127.0.0.1:8080     路由：/devices /stream?sn= /touch /status
//
// 为什么是"一个 host 管多台"而不是"多个 host 进程"：这才是产品形状（一台设备一套 sidecar 会话），
// 而且多进程要处理跨端口 CORS，纯属自找麻烦。
//
// 分层（对应 PLAN-3.0.0 §5.4）：
//   协议层（安卓专属）：resolveAdb / startServer / waitReady / connectChannels / onVideoData / sendTouch
//   设备命令层（provider 内部接口形状）：deviceOnline(sn) / adbExec(sn,args) / shell(sn,cmd)
//
// 依赖的实测事实（细节见 PLAN-3.0.0 §7）：
//   * 前 4 字节 = codec id（'h264'）；接着 12 字节 session packet（首字节 MSB=1，宽高在 offset 4/8）
//   * 媒体包 12 字节头：bit6=config 包、bit5=关键帧、低 5 位+后 7 字节=61 位 PTS、offset 8-11=长度
//   * SPS/PPS 是单独的 config 包先发；socket 顺序 = 1 video / 2 control
//   * 就绪判据 = /proc/net/unix 出现 @scrcpy（**不等它会拿到永不吐字节的死连接**）
//   * server 生命周期跟着连接走、退得不及时 → 我们自己主动 kill

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const JAR_LOCAL = join(HERE, '..', 'scrcpy-server-v4.1')
const JAR_REMOTE = '/data/local/tmp/scrcpy-server.jar'
const SERVER_VERSION = '4.1'          // ⚠️ 必须与 scrcpy-server 完全一致，否则 server 直接失败
const GOP_MAX_BYTES = 16 * 1024 * 1024

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ts = () => new Date().toISOString().slice(11, 19)
const log = (...a) => console.log(`[${ts()}]`, ...a)
const warn = (...a) => console.error(`[${ts()}] ⚠️`, ...a)

function arg(name, def) {
  const i = process.argv.indexOf('--' + name)
  if (i < 0) return def
  const v = process.argv[i + 1]
  return v === undefined || v.startsWith('--') ? true : v
}

const SN_ARG = String(arg('sn', '') || '')
const SNS = SN_ARG.split(',').map((s) => s.trim()).filter(Boolean)
const HTTP_PORT = Number(arg('port', 8080))
const BASE_LOCAL_PORT = Number(arg('localport', 27183))
const MAX_SIZE = arg('max-size', '')
const ADB_ARG = arg('adb', '')
const PROBE = arg('probe', false) === true

if (!SNS.length) {
  console.error('用法: node host.mjs --sn <sn[,sn2...]> [--port 8080] [--max-size 1920] [--probe] [--adb <路径>]')
  process.exit(2)
}

// ---------------------------------------------------------------- 设备命令层
function resolveAdb() {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const cands = [
    process.env.ADB,
    process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe')
      : process.platform === 'darwin'
        ? join(home, 'Library', 'Android', 'sdk', 'platform-tools', 'adb')
        : join(home, 'Android', 'Sdk', 'platform-tools', 'adb'),
  ].filter(Boolean)
  for (const c of cands) if (existsSync(c)) return c
  if (spawnSync('adb', ['version'], { stdio: 'ignore' }).status === 0) return 'adb'
  throw new Error('找不到 adb：设 ADB 环境变量、加进 PATH，或用 --adb <路径>')
}

const ADB = ADB_ARG || resolveAdb()

/** 所有 adb 调用都必须带 -s <sn>：多设备时不带会直接报 "more than one device/emulator"。 */
function adbExec(sn, args, { allowFail = false } = {}) {
  return new Promise((res, rej) => {
    const p = spawn(ADB, ['-s', sn, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('error', rej)
    p.on('close', (code) => {
      if (code === 0 || allowFail) return res({ code, out, err })
      rej(new Error(`adb ${args.join(' ')} 失败 (exit ${code}): ${err.trim() || out.trim()}`))
    })
  })
}
const shell = (sn, cmd, o) => adbExec(sn, ['shell', cmd], o)

async function deviceOnline(sn) {
  const r = await adbExec(sn, ['devices'], { allowFail: true })
  return r.out.split('\n').some((l) => l.startsWith(sn) && /\sdevice$/.test(l.trim()))
}

// ---------------------------------------------------------------- 每台设备一份状态
const devices = new Map()

function newDevice(sn, localPort) {
  return {
    sn, localPort,
    serverProc: null, videoSock: null, controlSock: null,
    ready: false,
    st: { codecId: null, width: 0, height: 0, buf: Buffer.alloc(0), frames: 0, idrs: 0, bytes: 0, lastPts: 0 },
    gop: { config: null, frames: [], bytes: 0, overflow: false },
    viewers: new Set(),
  }
}

const REC_HEADER = 13, F_CONFIG = 0x01, F_KEY = 0x02, F_SESSION = 0x04
/** 会话尺寸变化（旋转 / 缩放档位变化）：payload = 8 字节 (w,h) BE。前端据此重建解码器。 */
function sessionRecord(dev) {
  const b = Buffer.alloc(8)
  b.writeUInt32BE(dev.st.width, 0)
  b.writeUInt32BE(dev.st.height, 4)
  return encodeRecord(F_SESSION, 0, b)
}
function encodeRecord(flags, ptsUs, payload) {
  const b = Buffer.alloc(REC_HEADER + payload.length)
  b.writeUInt32BE(payload.length, 0)
  b[4] = flags
  b.writeDoubleBE(ptsUs, 5)
  payload.copy(b, REC_HEADER)
  return b
}

// ---------------------------------------------------------------- 协议层：起 server / 连 socket
async function startDevice(dev) {
  const { sn, localPort } = dev
  if (!existsSync(JAR_LOCAL)) throw new Error(`找不到 ${JAR_LOCAL}（scrcpy-server v${SERVER_VERSION}）`)
  if (!(await deviceOnline(sn))) throw new Error(`设备 ${sn} 不在线`)

  // 残留 server 退得不及时，而它握着编码器 —— 先清掉
  const pidout = (await shell(sn, 'pidof app_process', { allowFail: true })).out.trim()
  if (pidout) {
    warn(`${sn}: 已有 app_process(${pidout})，清掉（demo 图方便；真实现里只清自己起的那个）`)
    await shell(sn, `kill -9 ${pidout}`, { allowFail: true })
    await sleep(400)
  }

  await adbExec(sn, ['push', JAR_LOCAL, JAR_REMOTE])
  await adbExec(sn, ['forward', '--remove', `tcp:${localPort}`], { allowFail: true })
  await adbExec(sn, ['forward', `tcp:${localPort}`, 'localabstract:scrcpy'])

  const opts = [
    'tunnel_forward=true', 'audio=false', 'control=true', 'cleanup=false',
    // 关掉不需要的两样，保留 frame_meta（关键帧标志/PTS/长度）与 stream_meta（codec id + 帧宽高）
    'send_device_meta=false', 'send_dummy_byte=false',
  ]
  if (MAX_SIZE) opts.push(`max_size=${MAX_SIZE}`)
  const cmd = `CLASSPATH=${JAR_REMOTE} app_process / com.genymobile.scrcpy.Server ${SERVER_VERSION} ${opts.join(' ')}`
  dev.serverProc = spawn(ADB, ['-s', sn, 'shell', cmd], { stdio: 'ignore' })
  dev.serverProc.on('exit', (code) => { log(`${sn}: server 进程退出 (exit ${code})`); dev.serverProc = null })

  const t0 = Date.now()
  for (;;) {
    const r = await shell(sn, 'cat /proc/net/unix', { allowFail: true })
    if (/@scrcpy/.test(r.out)) break
    if (Date.now() - t0 > 30_000) throw new Error(`${sn}: 等 server 就绪超时`)
    await sleep(300)
  }
  dev.ready = true
  log(`${sn}: 就绪（${Date.now() - t0} ms）· 隧道 tcp:${localPort} · 端口独立`)
}

function connectSocket(port) {
  return new Promise((res, rej) => {
    const s = connect({ host: '127.0.0.1', port }, () => res(s))
    s.on('error', rej)
  })
}

async function connectChannels(dev) {
  dev.videoSock = await connectSocket(dev.localPort)     // 第 1 个连接 = video
  await sleep(300)
  dev.controlSock = await connectSocket(dev.localPort)   // 第 2 个 = control
}

/** INJECT_TOUCH_EVENT：32 字节定长（字段偏移见 PLAN §7.3）。x/y 用**帧**坐标。 */
function sendTouch(dev, action, x, y) {
  if (!dev.controlSock) { warn(`${dev.sn}: control socket 不在，丢弃触摸`); return }
  const { width, height } = dev.st
  if (!width || !height) { warn(`${dev.sn}: 还没有帧尺寸，丢弃触摸`); return }
  const m = Buffer.alloc(32)
  m[0] = 2; m[1] = action
  m.writeBigUInt64BE(0xfffffffffffffffen, 2)
  m.writeInt32BE(Math.round(x), 10)
  m.writeInt32BE(Math.round(y), 14)
  m.writeUInt16BE(width, 18)
  m.writeUInt16BE(height, 20)
  m.writeUInt16BE(0xffff, 22)
  dev.controlSock.write(m)
}

// ---------------------------------------------------------------- 流解析 + GOP 缓存
function pushGop(gop, flags, payload) {
  if (flags & F_CONFIG) {
    gop.config = { flags, payload: Buffer.from(payload) }
    gop.frames = []; gop.bytes = 0; gop.overflow = false
    return
  }
  if (flags & F_KEY) {
    gop.frames = [{ flags, payload: Buffer.from(payload) }]
    gop.bytes = payload.length; gop.overflow = false
    return
  }
  if (!gop.config || gop.overflow) return
  gop.frames.push({ flags, payload: Buffer.from(payload) }); gop.bytes += payload.length
  if (gop.bytes > GOP_MAX_BYTES) {
    warn(`GOP 缓存超过上限，整段丢弃，等下一个关键帧`)
    gop.frames = []; gop.bytes = 0; gop.overflow = true
  }
}

function onVideoData(dev, chunk) {
  const { st, gop } = dev
  st.buf = st.buf.length ? Buffer.concat([st.buf, chunk]) : chunk
  for (;;) {
    if (st.codecId === null) {
      if (st.buf.length < 4) return
      st.codecId = st.buf.readUInt32BE(0)
      log(`${dev.sn}: codec id = 0x${st.codecId.toString(16)} = '${st.buf.subarray(0, 4).toString('latin1')}'`)
      st.buf = st.buf.subarray(4)
      continue
    }
    if (st.buf.length < 12) return
    const b0 = st.buf[0]

    if (b0 & 0x80) {                                        // session packet
      const w = st.buf.readUInt32BE(4)
      const h = st.buf.readUInt32BE(8)
      const changed = st.width > 0 && st.height > 0 && (st.width !== w || st.height !== h)
      st.width = w; st.height = h
      st.buf = st.buf.subarray(12)
      log(`${dev.sn}: 帧尺寸 ${w}x${h}${changed ? ' —— 分辨率变了，通知前端重建解码器' : ''}`)
      if (changed) {
        const rec = sessionRecord(dev)
        for (const v of dev.viewers) v.write(rec)
      }
      continue
    }

    const size = st.buf.readUInt32BE(8)
    if (st.buf.length < 12 + size) return
    const flags = (b0 & 0x40 ? F_CONFIG : 0) | (b0 & 0x20 ? F_KEY : 0)
    const ptsUs = Number(st.buf.readBigUInt64BE(0) & 0x1fffffffffffffffn)
    const payload = st.buf.subarray(12, 12 + size)
    st.buf = st.buf.subarray(12 + size)

    st.frames++; st.bytes += size; st.lastPts = ptsUs
    if (flags & F_KEY) st.idrs++
    pushGop(gop, flags, payload)

    const rec = encodeRecord(flags, ptsUs, payload)
    for (const v of dev.viewers) v.write(rec)

    if (PROBE && st.frames <= 5) {
      log(`${dev.sn}: #${st.frames} ${flags & F_CONFIG ? 'config' : 'media '} ${flags & F_KEY ? 'KEY' : '   '} pts=${ptsUs} size=${size}`)
    }
  }
}

// ---------------------------------------------------------------- HTTP
function streamRoute(dev, req, res) {
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  })
  let replayed = 0
  if (dev.gop.config) { res.write(encodeRecord(dev.gop.config.flags, 0, dev.gop.config.payload)); replayed++ }
  for (const f of dev.gop.frames) { res.write(encodeRecord(f.flags, 0, f.payload)); replayed++ }
  dev.viewers.add(res)
  log(`${dev.sn}: 观众 +1（现在 ${dev.viewers.size}），补发 ${replayed} 帧`)
  req.on('close', () => { dev.viewers.delete(res); log(`${dev.sn}: 观众 -1（现在 ${dev.viewers.size}）`) })
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify(obj))
}

function touchRoute(req, res) {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    try {
      const { sn, action, fx, fy } = JSON.parse(body || '{}')
      const dev = devices.get(sn)
      if (!dev) return json(res, 404, { ok: false, error: `没有设备 ${sn}` })
      sendTouch(dev, action, fx * dev.st.width, fy * dev.st.height)
      json(res, 200, { ok: true, sn, action })
    } catch (e) { json(res, 400, { ok: false, error: String(e) }) }
  })
}

const devInfo = (dev) => ({
  sn: dev.sn, localPort: dev.localPort, ready: dev.ready,
  codec: dev.st.codecId, width: dev.st.width, height: dev.st.height,
  frames: dev.st.frames, idrs: dev.st.idrs, bytes: dev.st.bytes, lastPtsUs: dev.st.lastPts,
  viewers: dev.viewers.size, gopFrames: dev.gop.frames.length, gopBytes: dev.gop.bytes,
})

function startHttp() {
  createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const p = url.pathname
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      })
      return res.end()
    }
    if (p === '/') {
      const idx = join(HERE, 'index.html')
      if (!existsSync(idx)) return json(res, 404, { error: 'index.html 不在' })
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(readFileSync(idx))
    }
    if (p === '/jmuxer.min.js') {
      const hit = join(HERE, 'jmuxer.min.js')
      if (!hit) return json(res, 404, { error: '找不到 jmuxer.min.js' })
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
      return res.end(readFileSync(hit))
    }
    if (p === '/devices') return json(res, 200, [...devices.values()].map(devInfo))
    if (p === '/status') return json(res, 200, [...devices.values()].map(devInfo))
    if (p === '/stream') {
      const dev = devices.get(url.searchParams.get('sn')) || [...devices.values()][0]
      if (!dev) return json(res, 404, { error: '没有设备' })
      return streamRoute(dev, req, res)
    }
    if (p === '/touch' && req.method === 'POST') return touchRoute(req, res)
    json(res, 404, { error: 'not found' })
  }).listen(HTTP_PORT, '127.0.0.1', () => {
    log(`HTTP 起来了：http://127.0.0.1:${HTTP_PORT}   （/devices /stream?sn= /touch /status）`)
  })
}

// ---------------------------------------------------------------- 收尾
let shuttingDown = false
async function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const dev of devices.values()) {
    try { for (const v of dev.viewers) v.end() } catch {}
    try { dev.videoSock?.destroy() } catch {}
    try { dev.controlSock?.destroy() } catch {}
    try { dev.serverProc?.kill() } catch {}
    try {
      const r = await shell(dev.sn, 'pidof app_process', { allowFail: true })
      const pid = r.out.trim()
      if (pid) { await shell(dev.sn, `kill -9 ${pid}`, { allowFail: true }); log(`${dev.sn}: 已清掉 server (pid ${pid})`) }
      await adbExec(dev.sn, ['forward', '--remove', `tcp:${dev.localPort}`], { allowFail: true })
      log(`${dev.sn}: 已移除 tcp:${dev.localPort}`)
    } catch {}
  }
  process.exit(code)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

// ---------------------------------------------------------------- main
log(`adb = ${ADB}`)
log(`设备 = ${SNS.join(', ')}`)
let i = 0
for (const sn of SNS) {
  const dev = newDevice(sn, BASE_LOCAL_PORT + i)
  devices.set(sn, dev)
  i++
  try {
    await startDevice(dev)
    await connectChannels(dev)
    dev.videoSock.on('data', (c) => onVideoData(dev, c))
    dev.videoSock.on('close', () => warn(`${sn}: video socket 关了`))
    dev.controlSock.on('error', (e) => warn(`${sn}: control socket 出错 ${e.message}`))
  } catch (e) {
    warn(`${sn}: 起不来 —— ${e.message}`)
    dev.ready = false
  }
}
log(`在线设备：${[...devices.values()].filter((d) => d.ready).map((d) => d.sn).join(', ') || '（无）'}`)

if (PROBE) {
  await sleep(4000)
  for (const dev of devices.values()) {
    log(`${dev.sn}: frames=${dev.st.frames} idrs=${dev.st.idrs} ${dev.st.width}x${dev.st.height} bytes=${dev.st.bytes}`)
  }
  await shutdown(0)
} else {
  startHttp()
}
