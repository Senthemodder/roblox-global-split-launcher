# Task Instructions

- [x] "ui looks too ai, stop with the round corners, make it white and more anti gravity style" (user, verbatim)
  - Evidence: `npm run build; npm run package; npm test` -> `✔ DashboardServer serves Desktop Control Center HTML and manages upstream profiles (101.0361ms) | ✔ Release packager compiles RobloxGlobalLauncher.exe, builds ZIP, and compiles working RobloxGlobalSplitSetup.exe installer (4920.7734ms) | ℹ tests 8 | ℹ pass 8 | ℹ fail 0` (asserts `border-radius: 0 !important` and `--bg-surface: #FFFFFF` across web UI, `RobloxGlobalLauncher.cs`, and `RobloxGlobalSplitSetup.cs`).
- [x] "add me a shortcut so i can test, also push" (user, verbatim)
  - Evidence: Created `C:\Users\Dell\Desktop\Roblox Global Split-Tunnel.lnk` (1550 bytes) & `C:\Users\Dell\Desktop\Roblox Global Split-Tunnel Setup.lnk` (1331 bytes) and pushed `main` to `https://github.com/Senthemodder/roblox-global-split-launcher.git`.
- [x] "actually wire it by default, create me an ui, package it into a zip, create me an installer, make it glorious" (user, verbatim)
  - Evidence: `npm run build; npm run package; npm test` -> `Compiled Native Launcher : D:\Users\Dell\Documents\GitHub\roblox-global-split-launcher\RobloxGlobalLauncher.exe | Created Portable ZIP : D:\Users\Dell\Documents\GitHub\roblox-global-split-launcher\release\RobloxGlobalSplitLauncher-v1.0.0-win-x64.zip (16.42 MB) | Created Setup Installer : D:\Users\Dell\Documents\GitHub\roblox-global-split-launcher\release\RobloxGlobalSplitSetup.exe (16.43 MB) | ℹ tests 8 | ℹ pass 8 | ℹ fail 0`
- [x] "no no no i mean like playing without a VPN, using global client, on a global account" (user, verbatim)
  - Evidence: `npm test` -> `✔ Split-tunnel route evaluator routes *.roblox.com to GLOBAL_TUNNEL and UDP/CDN to DIRECT_ISP (4.5098ms)`
- [x] "yeah can we wire up an app like thí" (user, verbatim)
  - Evidence: `npm run build; npm test` -> `ℹ tests 8 | ℹ pass 8 | ℹ fail 0`
- [x] "(Recommended) Windows Desktop App / Bootstrapper (installs & launches Global Roblox + routes only *.roblox.com API traffic while keeping UDP gameplay direct)" (user selection)
  - Evidence: `node dist/cli.js status` -> `Latest Global WindowsPlayer : 0.745.0.7451137 (version-5a21b87bbc2641cf)` and `✔ Bootstrapper fetches real Global WindowsPlayer version and manifest from setup.rbxcdn.com (367.8093ms)`
- [x] "(Recommended) Support standard proxy/tunnel configs (SOCKS5, HTTP, WireGuard/WARP, VLESS/Shadowsocks) for the *.roblox.com API route" (user selection)
  - Evidence: `npm test` -> `✔ Tunnel URI parser supports SOCKS5, HTTP, WireGuard/WARP, VLESS, and Shadowsocks (7.5398ms)` and `✔ SplitTunnelProxyServer tunnels *.roblox.com through SOCKS5 upstream and blocks vnggames.com (61.4857ms)`
- [x] "(Recommended) Node.js / TypeScript (CLI + Desktop UI)" (user selection)
  - Evidence: `npm test` -> `✔ DashboardServer serves Desktop Control Center HTML and manages upstream profiles (101.0361ms)` and `node dist/cli.js catalog Fedora` -> `=== Roblox Global Catalog Results (10 items for 'Fedora') ===`
