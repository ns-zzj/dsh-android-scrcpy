// android/Dev/demo/selftest.mjs —— 不开浏览器，从命令行验多设备 /stream、GOP 缓存、触摸注入
//
// 用法（先另开一个终端跑 host.mjs）：
//   node host.mjs --sn emulator-5554,emulator-5556
//   node selftest.mjs            # 默认 8080

const PORT = Number(process.argv[2] || 8080)
const REC = 13
const base = `http://127.0.0.1:${PORT}`

function parseRecords(buf, onRec) {
  for (;;) {
    if (buf.length < REC) return buf
    const len = buf.readUInt32BE(0)
    if (buf.length < REC + len) return buf
    onRec(buf[4], buf.readDoubleBE(5), len)
    buf = buf.subarray(REC + len)
  }
}

let devices
try {
  devices = await (await fetch(`${base}/devices`)).json()
} catch (e) {
  console.error(`连不上 ${base}：${e.message}\n先确认 host.mjs 在跑。`)
  process.exit(1)
}
console.log(`设备 ${devices.length} 台：`)
for (const d of devices) {
  console.log(`  ${d.sn.padEnd(16)} ready=${d.ready}  ${d.width || '?'}x${d.height || '?'}  frames=${d.frames} idrs=${d.idrs} viewers=${d.viewers}`)
}

// 每台各读 2 秒
const summary = []
for (const d of devices) {
  const res = await fetch(`${base}/stream?sn=${encodeURIComponent(d.sn)}`)
  if (!res.ok || !res.body) { console.log(`${d.sn}: /stream 返回 ${res.status}`); continue }
  const reader = res.body.getReader()
  let buf = Buffer.alloc(0)
  const c = { config: 0, key: 0, p: 0, bytes: 0, firstPts: 0, lastPts: 0 }
  const t0 = Date.now()
  while (Date.now() - t0 < 2000) {
    const { value, done } = await reader.read()
    if (done) break
    buf = Buffer.concat([buf, Buffer.from(value)])
    buf = parseRecords(buf, (flags, pts, len) => {
      if (flags & 1) c.config++
      else if (flags & 2) c.key++
      else c.p++
      c.bytes += len
      if (!c.firstPts) c.firstPts = pts
      c.lastPts = pts
    })
  }
  await reader.cancel().catch(() => {})
  if (c.p > 1 && c.lastPts > c.firstPts) {
    const perFrame = (c.lastPts - c.firstPts) / 1000 / c.p
    console.log(`${d.sn}: 2 秒 config=${c.config} key=${c.key} p=${c.p} payload=${c.bytes} B   平均帧间隔≈${perFrame.toFixed(0)}ms（≈${(1000 / perFrame).toFixed(1)}fps）`)
  } else {
    console.log(`${d.sn}: 2 秒 config=${c.config} key=${c.key} p=${c.p} payload=${c.bytes} B`)
  }
  summary.push({ sn: d.sn, ...c })
}

// 新观众 GOP 回放（拿第一台）
if (devices[0]) {
  const res = await fetch(`${base}/stream?sn=${encodeURIComponent(devices[0].sn)}`)
  const reader = res.body.getReader()
  let buf = Buffer.alloc(0)
  const got = { config: 0, key: 0 }
  const t0 = Date.now()
  while (Date.now() - t0 < 800) {
    const { value } = await reader.read()
    if (!value) break
    buf = Buffer.concat([buf, Buffer.from(value)])
    buf = parseRecords(buf, (flags) => { if (flags & 1) got.config++; else if (flags & 2) got.key++ })
    if (got.config && got.key) break
  }
  await reader.cancel().catch(() => {})
  console.log(`新观众（${devices[0].sn}）${Date.now() - t0}ms 内拿到 config=${got.config} key=${got.key} → ${got.config && got.key ? '✅ GOP 缓存生效' : '❌ 没拿到可解码起点'}`)
}

// 每台发一次 down+up
for (const d of devices) {
  const out = []
  for (const action of [0, 1]) {
    const r = await fetch(`${base}/touch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sn: d.sn, action, fx: 0.5, fy: 0.5 }),
    })
    out.push(`${action}→${r.status}`)
  }
  console.log(`${d.sn}: POST /touch ${out.join(' ')}  (${out.every((s) => s.endsWith('200')) ? '✅' : '❌'})`)
}
