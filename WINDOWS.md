# Windows Support — Research & Implementation Plan

## Overview

Porting nospoon to Windows requires two new platform-specific modules: TUN device creation
(via wintun.dll) and full-tunnel networking (via netsh/route commands). The rest of the
codebase (server, client, routing, framing, config, validation) is pure JavaScript and
works on Windows unchanged.

**Effort summary:**

| Component | Status | Effort |
|-----------|--------|--------|
| lib/server.js, lib/client.js | Pure JS | None |
| lib/routing.js, lib/framing.js | Pure JS | None |
| lib/config.js, lib/validation.js | Pure JS | None |
| lib/tun.js (dispatcher) | Add `win32` case | Trivial |
| lib/tun-windows.js | **NEW** | High |
| lib/full-tunnel.js (dispatcher) | Add `win32` case | Trivial |
| lib/full-tunnel-windows.js | **NEW** | High |
| wintun.dll distribution | Ship in package | Low |
| package.nix (Windows) | Not applicable | — |

---

## Part 1: TUN Device — Wintun

### What is Wintun?

Wintun is a minimal Layer 3 TUN driver for Windows, created by the WireGuard project.
It provides a virtual network adapter for reading/writing raw IP packets — the Windows
equivalent of Linux's `/dev/net/tun`. The entire userspace API is a single DLL with
13 exported functions.

- License: prebuilt signed DLLs are redistributable alongside software that uses them
- Supported: Windows 7 through 11 (amd64, arm64, x86, arm32)
- Size: ~300 KB per architecture
- Source: https://www.wintun.net/

### Wintun API (C Signatures)

```c
// Adapter management
WINTUN_ADAPTER_HANDLE WintunCreateAdapter(LPCWSTR Name, LPCWSTR TunnelType, GUID *RequestedGUID);
WINTUN_ADAPTER_HANDLE WintunOpenAdapter(LPCWSTR Name);
VOID WintunCloseAdapter(WINTUN_ADAPTER_HANDLE Adapter);
VOID WintunGetAdapterLuid(WINTUN_ADAPTER_HANDLE Adapter, NET_LUID *Luid);

// Session management
WINTUN_SESSION_HANDLE WintunStartSession(WINTUN_ADAPTER_HANDLE Adapter, DWORD Capacity);
VOID WintunEndSession(WINTUN_SESSION_HANDLE Session);

// Packet I/O (ring buffer)
HANDLE WintunGetReadWaitEvent(WINTUN_SESSION_HANDLE Session);
BYTE * WintunReceivePacket(WINTUN_SESSION_HANDLE Session, DWORD *PacketSize);
VOID   WintunReleaseReceivePacket(WINTUN_SESSION_HANDLE Session, const BYTE *Packet);
BYTE * WintunAllocateSendPacket(WINTUN_SESSION_HANDLE Session, DWORD PacketSize);
VOID   WintunSendPacket(WINTUN_SESSION_HANDLE Session, const BYTE *Packet);

// Utility
VOID WintunSetLogger(WINTUN_LOGGER_CALLBACK NewLogger);
DWORD WintunGetRunningDriverVersion(VOID);
```

All functions are `__stdcall` (WINAPI calling convention).

### Lifecycle

```
1. Load wintun.dll
2. WintunCreateAdapter("Nospoon", "Nospoon Tunnel", NULL)
3. Configure IP via netsh (see below)
4. WintunStartSession(adapter, 0x400000)  // 4 MiB ring buffer
5. WintunGetReadWaitEvent(session)        // save event handle
6. Read/write loop:
   Receive: WintunReceivePacket() -> process -> WintunReleaseReceivePacket()
   Send:    WintunAllocateSendPacket() -> fill buffer -> WintunSendPacket()
   Wait:    WaitForSingleObject(readEvent, timeout) when no packets
7. WintunEndSession(session)
8. WintunCloseAdapter(adapter)            // also removes the adapter
```

### Ring Buffer I/O

- `WintunReceivePacket()` is **non-blocking**. Returns NULL when empty
  (GetLastError = ERROR_NO_MORE_ITEMS).
- Must call `WaitForSingleObject(readEvent, timeout)` to wait for packets.
- **Cannot block the Node.js event loop.** Use koffi's `.async()` for WaitForSingleObject.
- Packets are raw Layer 3 (IPv4/IPv6). No packet info header (like Linux IFF_NO_PI).
- The pointer from WintunReceivePacket is valid only until WintunReleaseReceivePacket.
  Must copy data out before releasing.
- Send: allocate -> write into buffer -> send. Packets transmit in allocation order.
- Both read and write are thread-safe.

### Koffi Bindings

nospoon already uses koffi (^2.15.2) for TUN on Linux and macOS. The same approach
works for wintun.dll on Windows:

```javascript
const koffi = require('koffi')
const path = require('path')

// Load wintun.dll shipped with the package
const dllPath = path.join(__dirname, '..', 'bin', 'win32-x64', 'wintun.dll')
const wintun = koffi.load(dllPath)

// Opaque handles
const WINTUN_ADAPTER = koffi.opaque('WINTUN_ADAPTER')
const WINTUN_SESSION = koffi.opaque('WINTUN_SESSION')

// Declare functions (__stdcall)
const WintunCreateAdapter = wintun.func(
  'WINTUN_ADAPTER *__stdcall WintunCreateAdapter(str16 Name, str16 TunnelType, void *GUID)'
)
const WintunCloseAdapter = wintun.func(
  'void __stdcall WintunCloseAdapter(WINTUN_ADAPTER *Adapter)'
)
const WintunStartSession = wintun.func(
  'WINTUN_SESSION *__stdcall WintunStartSession(WINTUN_ADAPTER *Adapter, uint32_t Capacity)'
)
const WintunEndSession = wintun.func(
  'void __stdcall WintunEndSession(WINTUN_SESSION *Session)'
)
const WintunGetReadWaitEvent = wintun.func(
  'void *__stdcall WintunGetReadWaitEvent(WINTUN_SESSION *Session)'
)
const WintunReceivePacket = wintun.func(
  'void *__stdcall WintunReceivePacket(WINTUN_SESSION *Session, _Out_ uint32_t *PacketSize)'
)
const WintunReleaseReceivePacket = wintun.func(
  'void __stdcall WintunReleaseReceivePacket(WINTUN_SESSION *Session, void *Packet)'
)
const WintunAllocateSendPacket = wintun.func(
  'void *__stdcall WintunAllocateSendPacket(WINTUN_SESSION *Session, uint32_t PacketSize)'
)
const WintunSendPacket = wintun.func(
  'void __stdcall WintunSendPacket(WINTUN_SESSION *Session, void *Packet)'
)
```

### Async Receive Loop (non-blocking)

The critical challenge: `WaitForSingleObject` blocks. Must not block the Node.js event loop.

```javascript
const kernel32 = koffi.load('kernel32.dll')
const WaitForSingleObject = kernel32.func(
  'uint32_t __stdcall WaitForSingleObject(void *hHandle, uint32_t dwMilliseconds)'
)

function receiveLoop (session, readEvent, onPacket) {
  const sizeOut = [0]
  const packetPtr = WintunReceivePacket(session, sizeOut)
  if (packetPtr) {
    const ab = koffi.view(packetPtr, sizeOut[0])
    onPacket(Buffer.from(ab))  // copy out of ring buffer
    WintunReleaseReceivePacket(session, packetPtr)
    setImmediate(() => receiveLoop(session, readEvent, onPacket))
  } else {
    // No packets — wait asynchronously on worker thread
    WaitForSingleObject.async(readEvent, 1000, () => {
      receiveLoop(session, readEvent, onPacket)
    })
  }
}
```

### IP Configuration After Adapter Creation

Wintun only creates the adapter. IP config is done separately via netsh
(same pattern as Linux's `ip addr add`):

```
netsh interface ipv4 set address name="Nospoon" source=static addr=10.0.0.2 mask=255.255.255.0
netsh interface ipv4 set subinterface "Nospoon" mtu=1400 store=active
```

The adapter name is what was passed to `WintunCreateAdapter()`.
The adapter is already "up" after creation — no equivalent of `ip link set up`.

### Distributing wintun.dll

**Recommended: ship in the npm package.**

```
bin/
  win32-x64/wintun.dll    (~300 KB)
  win32-arm64/wintun.dll   (~300 KB)
```

Must use the **prebuilt signed DLLs** from wintun.net. Self-compiled DLLs won't load
due to Windows driver signing requirements.

### Cleanup on Crash

If the process crashes without calling `WintunCloseAdapter`, the adapter persists.
Handle via `process.on('exit')` and consider cleaning stale adapters at startup:

```javascript
const existing = WintunOpenAdapter('Nospoon')
if (existing) WintunCloseAdapter(existing)
```

---

## Part 2: Full Tunnel — Windows Networking

### Command Mapping (Linux -> Windows)

| Linux command | Windows equivalent |
|---|---|
| `ip route show default` | `powershell -Command "(Get-NetRoute -DestinationPrefix '0.0.0.0/0' \| Select -First 1).NextHop"` |
| `ip route add <ip>/32 via <gw> dev <dev>` | `route add <ip> mask 255.255.255.255 <gw> metric 1 if <idx>` |
| `ip route add 0.0.0.0/1 dev tun0` | `route add 0.0.0.0 mask 128.0.0.0 <tunIp> metric 1 if <tunIdx>` |
| `ip route add 128.0.0.0/1 dev tun0` | `route add 128.0.0.0 mask 128.0.0.0 <tunIp> metric 1 if <tunIdx>` |
| `ip route del ...` | `route delete ...` |
| `sysctl -w net.ipv4.ip_forward=1` | `netsh interface ipv4 set interface "<name>" forwarding=enabled` |
| `iptables -t nat ... MASQUERADE` | `New-NetNat -Name "NospoonNAT" -InternalIPInterfaceAddressPrefix "10.0.0.0/24"` |
| `iptables -D ...` | `Remove-NetNat -Name "NospoonNAT" -Confirm:$false` |
| `sysctl -w rp_filter=2` | (not needed on Windows) |
| `ip addr add 10.0.0.1/24 dev tun0` | `netsh interface ipv4 set address name="<name>" source=static addr=10.0.0.1 mask=255.255.255.0` |
| `ip link set tun0 mtu 1400` | `netsh interface ipv4 set subinterface "<name>" mtu=1400 store=active` |
| `ip link set tun0 up` | (already up after wintun creation) |

### Client Full Tunnel (Split Routes)

The split-route strategy (0.0.0.0/1 + 128.0.0.0/1) works identically on Windows.
Key difference: Windows `route add` requires a **gateway IP** (next hop), not just a device.
Use the TUN adapter's own IP as the gateway.

```javascript
// Get default gateway
const gwOutput = execFileSync('powershell', ['-Command',
  "(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Select -First 1 | " +
  "Format-List NextHop, InterfaceIndex | Out-String).Trim()"
], { encoding: 'utf-8' })

// Get TUN interface index
const tunIdx = execFileSync('powershell', ['-Command',
  "(Get-NetAdapter -Name 'Nospoon').ifIndex"
], { encoding: 'utf-8' }).trim()

// Host route exemption for DHT server
execFileSync('route', ['add', serverHost, 'mask', '255.255.255.255', gateway, 'metric', '1', 'if', gwIfIndex])

// Split routes via TUN
const tunGateway = tunIp.split('/')[0]  // e.g. "10.0.0.2"
execFileSync('route', ['add', '0.0.0.0', 'mask', '128.0.0.0', tunGateway, 'metric', '1', 'if', tunIdx])
execFileSync('route', ['add', '128.0.0.0', 'mask', '128.0.0.0', tunGateway, 'metric', '1', 'if', tunIdx])
```

### Server NAT (Windows)

Windows NAT options:

1. **New-NetNat** (Windows 10/11, Server 2016+) — closest to iptables MASQUERADE:
   ```powershell
   New-NetNat -Name "NospoonNAT" -InternalIPInterfaceAddressPrefix "10.0.0.0/24"
   ```
   Limitation: only ONE NetNat instance allowed per host. Conflicts with Docker/Hyper-V.

2. **Internet Connection Sharing** — legacy, runs DHCP server, may conflict.

3. **RRAS** — Windows Server only, removed from desktop editions.

**Recommendation:** Server mode NAT on Windows is fragile. Document as "experimental"
or "Linux recommended for server mode". Client mode is the primary Windows use case.

### DNS Leak Prevention

Windows is prone to DNS leaks due to "Smart Multi-Homed Name Resolution" (SMHNR),
which sends DNS queries out ALL interfaces simultaneously.

**Best approach — NRPT (Name Resolution Policy Table):**

```powershell
# Force all DNS through VPN DNS server
Add-DnsClientNrptRule -Namespace "." -NameServers "1.1.1.1"

# Cleanup
Get-DnsClientNrptRule | Remove-DnsClientNrptRule -Force
ipconfig /flushdns
```

**Alternative — set DNS on TUN adapter:**

```
netsh interface ipv4 set dnsservers name="Nospoon" source=static address=1.1.1.1 validate=no
netsh interface ipv4 add dnsservers name="Nospoon" address=8.8.8.8 index=2 validate=no
```

### Windows Firewall

May need to allow TUN traffic:

```
netsh advfirewall firewall add rule name="Nospoon VPN (In)" dir=in action=allow program="<path-to-node.exe>" enable=yes
netsh advfirewall firewall add rule name="Nospoon VPN (Out)" dir=out action=allow program="<path-to-node.exe>" enable=yes
```

Cleanup on shutdown:
```
netsh advfirewall firewall delete rule name="Nospoon VPN (In)"
netsh advfirewall firewall delete rule name="Nospoon VPN (Out)"
```

---

## Part 3: Privileges

**Everything requires Administrator.** Same as Linux/macOS requiring root.

- Creating a wintun adapter (installs a kernel driver)
- `route add` / `netsh interface ipv4 add route`
- `netsh interface ipv4 set address`
- `netsh advfirewall firewall add rule`
- `New-NetNat`

All operations fail with "The requested operation requires elevation" if not running
as Administrator. No per-command elevation (no `sudo` equivalent).

**How to run:** Right-click terminal -> "Run as Administrator" -> `nospoon up config.jsonc`

**Admin check at startup:**
```javascript
try {
  execFileSync('net', ['session'], { stdio: 'ignore' })
} catch {
  console.error('Error: nospoon requires Administrator privileges')
  console.error('Right-click your terminal and select "Run as Administrator"')
  process.exit(1)
}
```

---

## Part 4: Implementation Plan

### Files to create

1. **`lib/tun-windows.js`** (~150-200 lines)
   - Load wintun.dll via koffi
   - Declare all 13 API functions
   - `createTunDevice({ ipv4, ipv6, mtu })` — create adapter, configure IP, start session
   - Async receive loop using `WaitForSingleObject.async()`
   - Return EventEmitter with `write()`, `on('data')`, `release()`, `name`
   - Cleanup stale adapters on startup
   - Same interface as `tun-linux.js` and `tun-darwin.js`

2. **`lib/full-tunnel-windows.js`** (~200-250 lines)
   - `enableServerForwarding()` — netsh forwarding + New-NetNat
   - `disableServerForwarding()` — Remove-NetNat + disable forwarding
   - `enableClientFullTunnel()` — save gateway, host route, split routes, DNS (NRPT)
   - `addHostExemption()` — add host route for reconnected server
   - `disableClientFullTunnel()` — remove routes, restore DNS, flush cache
   - Firewall rule management

3. **`bin/win32-x64/wintun.dll`** (~300 KB, prebuilt from wintun.net)
4. **`bin/win32-arm64/wintun.dll`** (~300 KB, prebuilt from wintun.net)

### Files to modify

1. **`lib/tun.js`** — add `else if (platform === 'win32')` to require tun-windows
2. **`lib/full-tunnel.js`** — add `else if (platform === 'win32')` to require full-tunnel-windows
3. **`package.nix`** — add `meta.platforms = lib.platforms.linux ++ ["x86_64-windows"]`?
   Actually, Nix doesn't build for Windows. The npm package handles Windows distribution.

### Testing

- Requires a Windows machine (native or VM)
- Must run as Administrator
- Test both client and server modes
- Test full-tunnel routing and DNS leak prevention
- Test cleanup on normal exit and crash (Ctrl+C, kill)

### Known Risks

| Risk | Mitigation |
|------|------------|
| `WaitForSingleObject` blocking event loop | Use koffi `.async()` — runs on worker thread |
| Ring buffer pointer lifetime | Copy data via `Buffer.from(koffi.view(...))` before releasing |
| Stale adapters after crash | Clean up at startup with `WintunOpenAdapter` + `WintunCloseAdapter` |
| New-NetNat single instance limit | Document server mode as experimental on Windows |
| DNS leaks (SMHNR) | Use NRPT rules for leak prevention |
| Driver signing | Must use prebuilt signed DLLs from wintun.net |
| First-use driver install | May trigger Windows Security dialog on first adapter creation |

---

## References

- [Wintun — Layer 3 TUN Driver for Windows](https://www.wintun.net/)
- [WireGuard/wintun (GitHub)](https://github.com/WireGuard/wintun)
- [wintun.h API header](https://github.com/WireGuard/wintun/blob/master/api/wintun.h)
- [Wintun example.c](https://git.zx2c4.com/wintun/tree/example/example.c)
- [Koffi documentation](https://koffi.dev/)
- [Koffi async calls](https://koffi.dev/functions#asynchronous-calls)
- [New-NetNat (Microsoft)](https://learn.microsoft.com/en-us/powershell/module/netnat/new-netnat)
- [Windows NAT capabilities and limitations](https://techcommunity.microsoft.com/blog/virtualization/windows-nat-winnat----capabilities-and-limitations/382303)
- [NRPT for VPN DNS](https://directaccess.richardhicks.com/2018/04/23/always-on-vpn-and-the-name-resolution-policy-table-nrpt/)
- [P2P VPN with Wintun](https://www.0xmm.in/posts/peer-to-peer-windows-part1/)
- [@xiaobaidadada/node-tuntap2-wintun (npm)](https://www.npmjs.com/package/@xiaobaidadada/node-tuntap2-wintun)
