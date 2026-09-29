# dsh-android-scrcpy

**DSH 的安卓投屏 provider** —— 让 DSH 通过 `adb` 连上安卓设备：看画面、点/滑、按键、读控件树、给 AI 看。

界面、AI 工具、设备与焦点、路由、门槛**全在 core 里**；本包只负责"**这台设备怎么连、怎么点、怎么出画面**"。

## 这是什么

| | |
|---|---|
| 角色 | dsh-scrcpy 的 **provider**（安卓平台） |
| 依赖 | 需要 **`dsh-scrcpy-core`**（不装它本包不激活）。本包**不声明**对 core 的包依赖 —— 两包**自由装**，互不自动拉取 |
| 传输 | `adb`：USB 调试，或已配对的**无线调试** |
| 协议 | **scrcpy-server 4.1** 的 video + control 两路 socket；本 provider **在流路径里**：自己解包、自己维护 GOP 缓存、自己把画面尺寸推给浏览器半区 |
| sidecar 生命周期 | `scrcpy-server.jar` → `adb push` → 设备上 `app_process` 起进程 → `adb forward` 分配端口；就绪判据 = `/proc/net/unix` 里出现 `@scrcpy` |
| 没有 | 浏览器半区、AI 工具、AI 提示词、UI 注册、焦点逻辑（都归 core） |

## 特点

| 特点 | 说明 |
|---|---|
| **跨平台多设备** | 多台同时投屏，各自独立会话与独立标签页；**安卓和鸿蒙可以同时显示，互不冲突**。操作只作用于当前聚焦（面板可见）的那台，不会点错 |
| **UHID 虚拟外接键盘** | PC 键盘直接变成设备的**外接键盘**（发的是真 HID 报告），不是"文本注入"那种替代方案 |
| **转屏** | 转屏后画面跟着走，**不需要重连、不会黑屏**（重建只由流里的 SPS 驱动，平台无关） |
| **切页 / 暂停** | 切走时自动暂停：**不用常驻、也不用断开重连**，暂停期间**占资源很少**；切回来**立刻出画**（provider 侧缓存"配置 + 最近关键帧起到现在的帧"并补发）；**暂停期间转过屏，切回来也不崩** |
| **画质** | 有线 / 无线**分别**配缩放与帧率；两端都能到原画，帧率 120 封顶 |
| **AI 操作与权限** | 界面与全部 AI 工具在 core（截图识别 / 控件清单 / 点击 / 长按 / 按键 / 文字输入）；**权限四项各自"禁止使用 / 每次确认 / 无需确认"三态，后三项依赖截图**，关掉时工具直接报原因、不反复重试 |
| **自由装卸** | provider 不含界面、不含 AI、不写提示词；装 core + 装对应平台的 provider 即可，两个 provider 各装各的、互不拉依赖 |

## 安装

在 DSH 的**插件面板**里装上两个包：

| 顺序 | 装什么 | 地址 |
|---|---|---|
| 1 | **core** —— 界面与 AI 工具都在这里 | `@nszzj/dsh-scrcpy-core` |
| 2 | **本包** `@nszzj/dsh-android-scrcpy` —— 安卓 provider | `@nszzj/dsh-android-scrcpy` |

- 两包各装一次，别只装 provider（core 缺了本包不会激活）
- 装完 **完全退出 DSH 再打开**（宿主半区改动只有重启才生效；浏览器半区刷新即可）
- 只装 provider 不装 core：本包因注入不满足而静默不激活（设计如此，不是 bug）

## 快速开始

1. 设备端打开 **USB 调试**，确认 `adb devices` 能看到它（无线调试同理）
2. DSH 顶部菜单 → 设备列表里出现这台设备（core 每 3 秒拉一次，本包只负责上报）
3. 「连接设置」里可以配：
   - **adb 路径**（不在 PATH 时）
   - **画面四件套**：有线 `1/2` · 60fps、无线 `1/4` · 30fps（默认值；两端都能到"原画"，帧率 120 封顶）

## 环境要求

- `adb`（按「连接设置里的路径 → 环境变量 → PATH」依次找）
- 一台安卓设备 + USB 调试（或已配对的无线调试）
- **不需要 Java** —— scrcpy-server 由设备上的 `app_process` 直接跑

## 目录结构

```
lib/index.js                 provider 实现（3.0.0 形状：传输 / 发现 / 动作 / 环境检测 / 连接配置 + 画面四件套）
resources/scrcpy-server-v4.1  scrcpy 项目自己的服务器文件，运行时 adb push 到设备
cordis.patch.yml             DSH 插件清单
Dev/demo/                    独立测试件（不依赖 DSH，也不进 npm 包）
Dev/doc.md                   开发资料说明（含"基于 core 开发 provider"的链接）
```

## 已知限制

- **连接中途不能改缩放/帧率**：两个平台都不支持中途换档，要换就**断开重连**（改设置只对下次连接生效）
- **首次连接/授权类弹窗**要人在设备上点确认，provider 不能代劳
- 断流/切后台后的恢复依赖 **GOP 补发**；若设备端太久没出关键帧，恢复会慢一点

## 二次开发

- 本目录的开发资料（每个 demo 是干嘛的、怎么跑）→ [`Dev/doc.md`](Dev/doc.md)
- **基于 core 开发一个 provider**（契约、core 会调你的动作、文案与语言规则、坐标与画面尺寸的坑）→
  [core/Dev/doc.md](https://github.com/ns-zzj/dsh-scrcpy-core/blob/main/Dev/doc.md)
- 逐字段契约以 core 的 `CONTRACT.md` 为准

## 许可与第三方

- 本包：**MIT**
- 随包发布 `resources/scrcpy-server-v4.1` —— 来自 [Genymobile/scrcpy](https://github.com/Genymobile/scrcpy)，**Apache-2.0**，
  版权 `Copyright (C) 2018 Genymobile` / `Copyright (C) 2018-2026 Romain Vimont`，**原样分发、未修改**。
  出处、许可与**完整许可文本**见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
- `Dev/demo/jmuxer.min.js`（开发件，不随 npm 包发布，但随 Git 仓库分发）→ 声明在 [`Dev/demo/THIRD_PARTY_NOTICES.md`](Dev/demo/THIRD_PARTY_NOTICES.md)
