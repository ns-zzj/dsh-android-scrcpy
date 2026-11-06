# dsh-android-scrcpy

**The Android provider for DSH** — connects DSH to Android devices over `adb`: see the screen, tap/scroll, press keys, read the control tree, and let the AI do the same.

All UI, AI tools, device/focus state, routing and permission gates **live in core**; this package only knows **how to talk to this device, how to tap it, and how to produce frames**.

> **[中文](./README.md)** | English

## What it is

| | |
|---|---|
| Role | a **provider** of dsh-scrcpy (Android platform) |
| Dependency | needs **`dsh-scrcpy-core`** (without it this package stays inactive). It does **not** declare a package dependency on core — the two are installed freely and never pull each other |
| Transport | `adb`: USB debugging, or paired **wireless debugging** |
| Protocol | **scrcpy-server 4.1** video + control sockets; this provider **is on the stream path**: it unpacks the stream, keeps its own GOP cache, and pushes frame size to the client half |
| Sidecar lifecycle | `scrcpy-server.jar` → `adb push` → `app_process` on device → `adb forward` allocates a port; readiness = `@scrcpy` appearing in `/proc/net/unix` |
| Not included | client half, AI tools, AI prompts, UI registration, focus logic (all in core) |

## Highlights

| Feature | Detail |
|---|---|
| **Multiple devices across platforms** | Several devices mirror at once, each with its own session and tab; **Android and HarmonyOS can run side by side**. Operations only apply to the focused (visible) device, so they cannot hit the wrong one |
| **UHID virtual keyboard** | The PC keyboard becomes a **real external keyboard** of the device (true HID reports), not a text-injection stand-in |
| **Rotation** | The picture follows rotation with **no reconnect and no black screen** (rebuild is driven only by the SPS in the stream) |
| **Tab switch / pause** | Leaving a tab pauses instead of disconnecting: **no daemon, no reconnect**, very little resource use; coming back **paints immediately** (the provider buffers "config + the latest keyframe up to now" and replays it); rotating while paused still survives |
| **Quality** | Wired and wireless configure scale and frame rate **separately**; both reach native resolution, capped at 120 fps |
| **AI operations and permissions** | UI and all AI tools live in core (screenshot **handed directly to the AI** / control list / tap / long-press / keys / text input); **four permissions, each in three states**, the last three depending on screenshots — when off, tools return the reason instead of retrying |
| **Free install/uninstall** | No UI, no AI, no prompts here; install core plus the provider for your platform, both platforms independently |

## Install

In the DSH **plugin panel**, install two packages:

| Order | What | Address |
|---|---|---|
| 1 | **core** — UI and AI tools live there | `@nszzj/dsh-scrcpy-core` |
| 2 | **this package** `@nszzj/dsh-android-scrcpy` — Android provider | `@nszzj/dsh-android-scrcpy` |

- Install both, not just the provider (without core this package stays inactive)
- After installing, **fully quit DSH and reopen it** (host-side changes need a restart; client-side only needs a refresh)
- Provider without core: silently inactive because its injection is unsatisfied (by design, not a bug)

## Quick start

1. Enable **USB debugging** on the device and confirm `adb devices` lists it (same for wireless debugging)
2. The device appears in the DSH menu's device list (core polls every 3 seconds; this provider only reports)
3. In **Connection settings** you can configure:
   - **adb path** (when it is not on `PATH`)
   - **Picture set**: wired `1/2` · 60fps, wireless `1/4` · 30fps (defaults; both can reach native resolution, frame rate capped at 120)

## Requirements

- `adb` (looked up via the path in Connection settings → environment → `PATH`)
- An Android device with USB debugging (or paired wireless debugging)
- **No Java needed** — `scrcpy-server` runs through `app_process` on the device

## Layout

```
lib/index.js                 provider implementation (transport / discovery / actions / env detection / connection config + picture set)
resources/scrcpy-server-v4.1  scrcpy's own server binary, pushed to the device at runtime
cordis.patch.yml             DSH plugin manifest
Dev/demo/                    standalone test harness (no DSH dependency, not shipped on npm)
Dev/doc.md                   development notes (links to "writing a provider on core")
```

## Known limitations

- **Scale / frame rate cannot change mid-connection**: neither platform supports it; disconnect and reconnect (settings apply to the next connection)
- **First-connection / authorization dialogs** must be confirmed on the device; the provider cannot do it for you
- Recovery after a dropped stream or a backgrounded app relies on **GOP replay**; if the device has not produced a keyframe for a long time, recovery is slower

## Development

- Local development notes (what each demo does, how to run it) → [`Dev/doc.md`](Dev/doc.md)
- **Writing a provider on top of core** (contract, actions core will call, wording and language rules, coordinate and frame-size pitfalls) →
  [core/Dev/doc.md](https://github.com/ns-zzj/dsh-scrcpy-core/blob/main/Dev/doc.md)
- The authoritative field-by-field contract is core's `CONTRACT.md`

## License and third party

- This package: **MIT**
- Ships `resources/scrcpy-server-v4.1` from [Genymobile/scrcpy](https://github.com/Genymobile/scrcpy), **Apache-2.0**,
  `Copyright (C) 2018 Genymobile` / `Copyright (C) 2018-2026 Romain Vimont`, distributed **unmodified**.
  Origin, license and the full license text: [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
- `Dev/demo/jmuxer.min.js` (development only, not shipped on npm but distributed with the Git repo) → declared in [`Dev/demo/THIRD_PARTY_NOTICES.md`](Dev/demo/THIRD_PARTY_NOTICES.md)
