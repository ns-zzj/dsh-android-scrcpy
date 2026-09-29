# 开发资料（本目录）

> **基于 core 开发 provider** → [core/Dev/doc.md](https://github.com/ns-zzj/dsh-scrcpy-core/blob/main/Dev/doc.md)
> （契约、core 会调你的动作、你要上报什么、文案与语言规则、画面四件套、坐标与画面尺寸的坑 —— 想给别的平台接一个 provider 就看那份。）

## Dev/demo/ —— 独立测试件（不依赖 DSH，也不进 npm 包）

这些是 **1.0.0 时代**做安卓 provider 时的验证件；3.0 的实现现在是 `lib/index.js`，
但这些 demo 对**协议细节**（scrcpy 的两路 socket、包格式、GOP 缓存、触摸注入）仍然是最直接的参考。

| 文件 | 干什么 | 怎么跑 |
|---|---|---|
| `demo-host.mjs` | 浏览器 demo 的 host：起 scrcpy-server / 等就绪 / 读 video+control 两路 socket / 解析包 / GOP 缓存 / HTTP + 帧记录 / 触摸注入 —— 按"协议层 / 设备命令层"分层写的 | `node android/Dev/demo/demo-host.mjs`（参数见文件头注释） |
| `index-1x.html` | 上面那个 host 配套的前端页面 | 用它打印的地址在浏览器打开 |
| `selftest.mjs` | 不开浏览器的命令行自检：验多设备 `/stream`、GOP 缓存、触摸注入 | `node android/Dev/demo/selftest.mjs`（参数见文件头注释） |

跑它们需要 `adb` 和一台连着调试的安卓设备。
