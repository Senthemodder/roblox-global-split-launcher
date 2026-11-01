# Roblox Global Split-Tunnel & Bootstrapper (`roblox-global-split-launcher`)

A Windows Desktop App, Native System-Tray Launcher (`RobloxGlobalLauncher.exe`), and Setup Installer (`RobloxGlobalSplitSetup.exe`) that **auto-wires a free Cloudflare WARP + Sing-Box split-tunnel by default**, keeping **Global Roblox Accounts** safe from VNG regional migration while playing with **native direct ISP ping (no game VPN lag)**.

## Packaged Release Artifacts (`release/`)

- **Windows Setup Installer**: `release/RobloxGlobalSplitSetup.exe` (Self-contained GUI installer that installs to `%LOCALAPPDATA%\Programs\RobloxGlobalSplitLauncher`, creates Desktop & Start Menu shortcuts, and launches the app).
- **Portable ZIP Package**: `release/RobloxGlobalSplitLauncher-v1.0.0-win-x64.zip` (Contains `RobloxGlobalLauncher.exe`, `Start-RobloxGlobalSplit.bat`, pre-bundled `.runtime/bin/sing-box.exe`, default-wired Cloudflare WARP WireGuard profile, and compiled `dist/`).
- **Native Windows GUI & System Tray Launcher**: `RobloxGlobalLauncher.exe`

## How It Works (Wired by Default)

1. **Zero-Config Auto-Wired Cloudflare WARP + Sing-Box (`src/proxy/warp-provisioner.ts`, `src/proxy/singbox-runner.ts`)**:
   - On startup, automatically generates a Curve25519 WireGuard keypair, registers a free Cloudflare WARP tunnel, starts `sing-box.exe` on `127.0.0.1:7897`, and wires Windows `AutoConfigURL` PAC (`http://127.0.0.1:7899/proxy.pac`) by default.
2. **Split-Tunnel Routing Engine (`src/proxy/split-proxy.ts`, `src/proxy/domain-rules.ts`)**:
   - **Global Tunnel (`*.roblox.com`, `*.rbx.com`)**: Routes HTTPS API, authentication, account region checks, and Global Catalog queries (`catalog.roblox.com`, `thumbnails.roblox.com`) through the active non-VN tunnel (`WireGuard/WARP`, `SOCKS5`, `HTTP/HTTPS`, `VLESS`, `Shadowsocks`).
   - **Direct ISP (`128.116.0.0/17` UDP Gameplay & `*.rbxcdn.com` CDN)**: Routes all UDP gameplay packets and static asset downloads directly over your local ISP interface with zero VPN latency penalty.
   - **VNG Redirect & Telemetry Shield (`vnggames.com`, `zing.vn`)**: Blocks accidental redirects or login handshakes to VNG endpoints.
3. **Official Global Roblox Bootstrapper (`src/bootstrapper/roblox-bootstrapper.ts`)**:
   - Pulls official Global WindowsPlayer packages directly from `setup.rbxcdn.com/<versionUpload>-rbxPkgManifest.txt`, bypassing `roblox.com`'s regional VNG installer redirect, and binds `roblox-player:` to the Global `RobloxPlayerBeta.exe`.

## Commands

```powershell
# Build TypeScript, compile native EXE/ZIP/Installer, and run tests
npm run build
npm run package
npm test

# Launch the Default-Wired Split-Tunnel Proxy & Glorious Desktop Control Center UI
npm start
```
