# Windows Implementation Plan

Prerequisites: config-file changes must be committed on main and rebased into this branch
before implementation begins. All code below assumes the new `nospoon up [config]` API.

---

## Step 1: Add wintun.dll to the repo

Download prebuilt signed DLLs from https://www.wintun.net/ and place them:

```
bin/
  win32-x64/wintun.dll      (~300 KB)
  win32-arm64/wintun.dll     (~300 KB)
```

These are NOT self-compiled — must use the signed prebuilts (unsigned DLLs won't load
due to Windows driver signing requirements).

Add to `package.json` files list so they're included in npm publish:

```json
"files": ["bin/", "lib/", "bin/cli.js"]
```

---

## Step 2: Create `lib/tun-windows.js`

### Interface contract (same as tun-linux.js and tun-darwin.js)

```javascript
// Input
createTunDevice({ ipv4: '10.0.0.2/24', ipv6: 'fd00::2/64', mtu: 1400 })

// Returns an EventEmitter with:
//   tun.name        — adapter name (string, e.g. "Nospoon")
//   tun.on('data')  — emits raw IP packets (Buffer)
//   tun.write(buf)  — sends raw IP packets
//   tun.release()   — cleanup (close session, remove adapter)
```

### Implementation

```javascript
const { execFileSync } = require('child_process')
const { EventEmitter } = require('events')
const path = require('path')
const koffi = require('koffi')

// --- Load wintun.dll ---
const arch = process.arch === 'x64' ? 'x64' : 'arm64'
const dllPath = path.join(__dirname, '..', 'bin', `win32-${arch}`, 'wintun.dll')
const wintun = koffi.load(dllPath)

// Also need kernel32 for WaitForSingleObject
const kernel32 = koffi.load('kernel32.dll')

// --- Opaque handle types ---
const WINTUN_ADAPTER = koffi.opaque('WINTUN_ADAPTER')
const WINTUN_SESSION = koffi.opaque('WINTUN_SESSION')

// --- Declare wintun functions (__stdcall) ---
const WintunCreateAdapter = wintun.func(
  'WINTUN_ADAPTER *__stdcall WintunCreateAdapter(str16 Name, str16 TunnelType, void *GUID)'
)
const WintunOpenAdapter = wintun.func(
  'WINTUN_ADAPTER *__stdcall WintunOpenAdapter(str16 Name)'
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

// kernel32 for async wait
const WaitForSingleObject = kernel32.func(
  'uint32_t __stdcall WaitForSingleObject(void *hHandle, uint32_t dwMilliseconds)'
)

const ADAPTER_NAME = 'Nospoon'
const TUNNEL_TYPE = 'Nospoon Tunnel'
const SESSION_CAPACITY = 0x400000  // 4 MiB ring buffer

function createTunDevice ({ ipv4, ipv6, mtu = 1400 }) {
  // Clean up stale adapter from a previous crash
  const stale = WintunOpenAdapter(ADAPTER_NAME)
  if (stale) WintunCloseAdapter(stale)

  // Create adapter
  const adapter = WintunCreateAdapter(ADAPTER_NAME, TUNNEL_TYPE, null)
  if (!adapter) throw new Error('Failed to create Wintun adapter (requires Administrator)')

  // Configure IP via netsh
  const ipAddr = ipv4.split('/')[0]
  const prefix = parseInt(ipv4.split('/')[1] || '24', 10)
  const netmask = prefixToNetmask(prefix)

  execFileSync('netsh', [
    'interface', 'ipv4', 'set', 'address',
    'name=' + ADAPTER_NAME,
    'source=static',
    'addr=' + ipAddr,
    'mask=' + netmask
  ], { encoding: 'utf-8' })

  if (ipv6) {
    const v6Addr = ipv6.split('/')[0]
    const v6Prefix = ipv6.split('/')[1] || '64'
    execFileSync('netsh', [
      'interface', 'ipv6', 'add', 'address',
      'interface=' + ADAPTER_NAME,
      'address=' + v6Addr + '/' + v6Prefix
    ], { encoding: 'utf-8' })
  }

  execFileSync('netsh', [
    'interface', 'ipv4', 'set', 'subinterface',
    ADAPTER_NAME,
    'mtu=' + String(mtu),
    'store=active'
  ], { encoding: 'utf-8' })

  // Start session
  const session = WintunStartSession(adapter, SESSION_CAPACITY)
  if (!session) {
    WintunCloseAdapter(adapter)
    throw new Error('Failed to start Wintun session')
  }

  const readEvent = WintunGetReadWaitEvent(session)

  // Build the tun EventEmitter (same interface as Linux/macOS)
  const tun = new EventEmitter()
  tun.name = ADAPTER_NAME
  let released = false

  // --- Async receive loop ---
  // WintunReceivePacket is non-blocking. When empty, use
  // WaitForSingleObject.async() to wait without blocking the event loop.
  function receiveLoop () {
    if (released) return

    // Drain all available packets
    while (true) {
      const sizeOut = [0]
      const packetPtr = WintunReceivePacket(session, sizeOut)
      if (!packetPtr) break

      const ab = koffi.view(packetPtr, sizeOut[0])
      const packet = Buffer.from(ab)  // copy out of ring buffer
      WintunReleaseReceivePacket(session, packetPtr)
      tun.emit('data', packet)
    }

    if (released) return

    // No more packets — wait asynchronously
    WaitForSingleObject.async(readEvent, 1000, function () {
      receiveLoop()
    })
  }

  // Start receiving after a tick (let caller attach 'data' handler first)
  setImmediate(receiveLoop)

  // --- Write ---
  tun.write = function (packet) {
    if (released || !packet || packet.length === 0) return false
    const sendPtr = WintunAllocateSendPacket(session, packet.length)
    if (!sendPtr) return false  // ring full, drop packet
    const ab = koffi.view(sendPtr, packet.length)
    new Uint8Array(ab).set(packet)
    WintunSendPacket(session, sendPtr)
    return true
  }

  // --- Release ---
  tun.release = function () {
    if (released) return
    released = true
    try { WintunEndSession(session) } catch (e) {}
    try { WintunCloseAdapter(adapter) } catch (e) {}
  }

  const addrs = ipv6 ? `${ipv4} + ${ipv6}` : ipv4
  console.log(`TUN device ${ADAPTER_NAME} up with ${addrs} (MTU ${mtu})`)

  return tun
}

function prefixToNetmask (prefix) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return [
    (mask >>> 24) & 0xff, (mask >>> 16) & 0xff,
    (mask >>> 8) & 0xff, mask & 0xff
  ].join('.')
}

module.exports = { createTunDevice }
```

### Key differences from Linux/macOS

| Aspect | Linux | macOS | Windows |
|--------|-------|-------|---------|
| TUN creation | `ioctl(/dev/net/tun)` | `socket(PF_SYSTEM)` + `connect` | `WintunCreateAdapter()` |
| Packet read | `fs.createReadStream(fd)` | `fs.createReadStream(fd)` | `WintunReceivePacket()` ring buffer |
| Packet write | `fs.createWriteStream(fd)` | `fs.createWriteStream(fd)` (with AF header) | `WintunAllocateSendPacket()` + `WintunSendPacket()` |
| Async wait | Kernel signals fd readable | Kernel signals fd readable | `WaitForSingleObject.async(readEvent)` |
| IP config | `ip addr add` | `ifconfig` | `netsh interface ipv4 set address` |
| Packet format | Raw IP (IFF_NO_PI) | 4-byte AF header (stripped) | Raw IP (no header) |

### Complexity note

Linux/macOS use Node.js `fs.createReadStream/WriteStream` on a file descriptor.
Windows wintun uses a ring buffer with explicit receive/send calls. The async receive
loop using `WaitForSingleObject.async()` is the main complexity — it runs the blocking
wait on a koffi worker thread and calls back when packets arrive.

---

## Step 3: Create `lib/full-tunnel-windows.js`

### Interface contract (same as Linux/macOS)

```javascript
module.exports = {
  enableServerForwarding (outInterface, subnet, tunName) → natState,
  disableServerForwarding (natState),
  enableClientFullTunnel (remoteHost, tunName),
  addHostExemption (remoteHost),
  disableClientFullTunnel ()
}
```

### Implementation

```javascript
const { execFileSync } = require('child_process')

const IFACE_RE = /^[a-zA-Z0-9_\- ]+$/  // Windows names can have spaces
const TUNNEL_DNS = ['1.1.1.1', '8.8.8.8']

function validateInterface (name) {
  if (!IFACE_RE.test(name)) throw new Error(`Invalid interface name: ${name}`)
  return name
}

function run (cmd, args, opts) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf-8' }).trim()
  } catch (err) {
    const msg = err.stderr || err.message
    if (opts && opts.strict) throw new Error(`${cmd} ${args.join(' ')} failed: ${msg}`)
    console.error(`Command failed: ${cmd} ${args.join(' ')}`)
    console.error(msg)
    return null
  }
}

// --- Default gateway detection ---
// Uses PowerShell Get-NetRoute (most reliable on Windows)
function getDefaultGateway () {
  const gw = run('powershell', ['-Command',
    "(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Select-Object -First 1).NextHop"
  ])
  const idx = run('powershell', ['-Command',
    "(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Select-Object -First 1).InterfaceIndex"
  ])
  if (!gw || !idx) return null
  return { gateway: gw, ifIndex: idx.trim() }
}

// Get TUN adapter interface index
function getTunIfIndex (tunName) {
  return run('powershell', ['-Command',
    `(Get-NetAdapter -Name '${tunName}').ifIndex`
  ])
}

// =======================================================================
// SERVER: NAT forwarding
// =======================================================================

function enableServerForwarding (outInterface, subnet, tunName) {
  const tun = validateInterface(tunName || 'Nospoon')
  const source = subnet || '10.0.0.0/24'
  const strict = { strict: true }

  console.log('Enabling IP forwarding and NAT...')

  // Enable forwarding on both interfaces
  run('netsh', ['interface', 'ipv4', 'set', 'interface', tun, 'forwarding=enabled'], strict)

  // Detect outgoing interface
  if (outInterface) {
    run('netsh', ['interface', 'ipv4', 'set', 'interface', outInterface, 'forwarding=enabled'], strict)
  }

  // Create NAT
  // NOTE: only ONE New-NetNat allowed per host. May conflict with Docker/Hyper-V.
  run('powershell', ['-Command',
    `New-NetNat -Name 'NospoonNAT' -InternalIPInterfaceAddressPrefix '${source}'`
  ], strict)

  console.log('NAT enabled (experimental on Windows — Linux recommended for server)')

  return { source, tun, outInterface }
}

function disableServerForwarding (natState) {
  if (!natState) return
  console.log('Removing NAT rules...')

  run('powershell', ['-Command', "Remove-NetNat -Name 'NospoonNAT' -Confirm:$false"])
  run('netsh', ['interface', 'ipv4', 'set', 'interface', natState.tun, 'forwarding=disabled'])
  if (natState.outInterface) {
    run('netsh', ['interface', 'ipv4', 'set', 'interface', natState.outInterface, 'forwarding=disabled'])
  }
}

// =======================================================================
// CLIENT: Full tunnel (split routes + DNS)
// =======================================================================

let savedTunName = null
let savedRemoteHosts = []
let savedGateway = null
let savedTunIfIndex = null

function enableClientFullTunnel (remoteHost, tunName) {
  if (!remoteHost || typeof remoteHost !== 'string') {
    throw new Error('Cannot determine DHT server address for host route')
  }

  const tun = validateInterface(tunName || 'Nospoon')
  const strict = { strict: true }

  const gw = getDefaultGateway()
  if (!gw || !gw.gateway) throw new Error('Cannot detect default gateway')

  const tunIdx = getTunIfIndex(tun)
  if (!tunIdx) throw new Error('Cannot find Nospoon adapter interface index')

  savedTunName = tun
  savedGateway = gw
  savedTunIfIndex = tunIdx.trim()

  console.log(`Routing all traffic through tunnel (server ${remoteHost} exempted)`)

  // Host route: DHT server goes via real gateway
  // Windows `route add` needs gateway IP AND interface index
  run('route', ['add', remoteHost, 'mask', '255.255.255.255',
    gw.gateway, 'metric', '1', 'if', gw.ifIndex], strict)
  savedRemoteHosts.push(remoteHost)

  // Split routes via TUN
  // Windows route needs a gateway — use the TUN adapter's own IP
  // We use 0.0.0.0 as gateway with the interface index to force via TUN
  run('route', ['add', '0.0.0.0', 'mask', '128.0.0.0',
    '0.0.0.0', 'metric', '1', 'if', savedTunIfIndex], strict)
  run('route', ['add', '128.0.0.0', 'mask', '128.0.0.0',
    '0.0.0.0', 'metric', '1', 'if', savedTunIfIndex], strict)

  // DNS: use NRPT to force all DNS through VPN DNS (prevents DNS leak)
  run('powershell', ['-Command',
    `Add-DnsClientNrptRule -Namespace '.' -NameServers '${TUNNEL_DNS.join("','")}'`
  ])
  run('ipconfig', ['/flushdns'])
  console.log(`DNS set to ${TUNNEL_DNS.join(', ')} via NRPT`)

  console.log('Full tunnel active — all traffic goes through VPN (kill switch enabled)')
}

function addHostExemption (remoteHost) {
  if (!remoteHost || !savedGateway) return
  if (savedRemoteHosts.includes(remoteHost)) return

  run('route', ['add', remoteHost, 'mask', '255.255.255.255',
    savedGateway.gateway, 'metric', '1', 'if', savedGateway.ifIndex])
  savedRemoteHosts.push(remoteHost)
  console.log(`Added host route exemption for ${remoteHost}`)
}

function disableClientFullTunnel () {
  console.log('Restoring original routes...')

  // Remove split routes
  run('route', ['delete', '0.0.0.0', 'mask', '128.0.0.0'])
  run('route', ['delete', '128.0.0.0', 'mask', '128.0.0.0'])

  // Remove host route exemptions
  if (savedGateway) {
    for (const host of savedRemoteHosts) {
      run('route', ['delete', host, 'mask', '255.255.255.255'])
    }
  }

  // Restore DNS (remove NRPT rules)
  run('powershell', ['-Command',
    "Get-DnsClientNrptRule | Remove-DnsClientNrptRule -Force"
  ])
  run('ipconfig', ['/flushdns'])
  console.log('DNS restored (NRPT rules removed)')

  savedTunName = null
  savedRemoteHosts = []
  savedGateway = null
  savedTunIfIndex = null
}

module.exports = {
  enableServerForwarding,
  disableServerForwarding,
  enableClientFullTunnel,
  addHostExemption,
  disableClientFullTunnel
}
```

### Command mapping

| Action | Linux | macOS | Windows |
|--------|-------|-------|---------|
| Default gateway | `ip route show default` | `route -n get default` | `Get-NetRoute -DestinationPrefix '0.0.0.0/0'` |
| Host route add | `ip route add X/32 via GW dev DEV` | `route add -host X GW` | `route add X mask 255.255.255.255 GW metric 1 if IDX` |
| Split route add | `ip route add 0.0.0.0/1 dev tun0` | `route add -net 0.0.0.0/1 -interface utun0` | `route add 0.0.0.0 mask 128.0.0.0 0.0.0.0 metric 1 if IDX` |
| Enable forwarding | `sysctl -w net.ipv4.ip_forward=1` | `sysctl -w net.inet.ip.forwarding=1` | `netsh interface ipv4 set interface X forwarding=enabled` |
| NAT | `iptables -t nat ... MASQUERADE` | `pfctl -f rules.conf` | `New-NetNat -Name X -InternalIPInterfaceAddressPrefix Y` |
| DNS set | `resolvectl dns tun0 1.1.1.1` | `networksetup -setdnsservers Wi-Fi 1.1.1.1` | `Add-DnsClientNrptRule -Namespace '.' -NameServers '1.1.1.1'` |
| DNS restore | `resolvectl revert tun0` | `networksetup -setdnsservers Wi-Fi Empty` | `Get-DnsClientNrptRule \| Remove-DnsClientNrptRule` |
| rp_filter | `sysctl -w rp_filter=2` | (not needed) | (not needed) |

---

## Step 4: Update dispatchers

### `lib/tun.js` — add `win32` case

```javascript
const os = require('os')

function createTunDevice (opts) {
  const platform = os.platform()

  if (platform === 'linux') {
    return require('./tun-linux').createTunDevice(opts)
  }

  if (platform === 'darwin') {
    return require('./tun-darwin').createTunDevice(opts)
  }

  if (platform === 'win32') {
    return require('./tun-windows').createTunDevice(opts)
  }

  throw new Error(`Unsupported platform: ${platform}`)
}

module.exports = { createTunDevice }
```

### `lib/full-tunnel.js` — add `win32` case

```javascript
const os = require('os')
const platform = os.platform()

let impl
if (platform === 'darwin') {
  impl = require('./full-tunnel-darwin')
} else if (platform === 'win32') {
  impl = require('./full-tunnel-windows')
} else {
  impl = require('./full-tunnel-linux')
}

module.exports = {
  enableServerForwarding: impl.enableServerForwarding,
  disableServerForwarding: impl.disableServerForwarding,
  enableClientFullTunnel: impl.enableClientFullTunnel,
  addHostExemption: impl.addHostExemption,
  disableClientFullTunnel: impl.disableClientFullTunnel
}
```

---

## Step 5: Admin check in `bin/cli.js`

Add before `loadConfig()` on Windows:

```javascript
if (command === 'up' && process.platform === 'win32') {
  try {
    execFileSync('net', ['session'], { stdio: 'ignore' })
  } catch {
    console.error('Error: nospoon requires Administrator privileges on Windows')
    console.error('Right-click your terminal and select "Run as Administrator"')
    process.exit(1)
  }
}
```

The `net session` command fails if not running as Administrator — standard detection trick.

---

## Step 6: Update `package.nix` (Linux/macOS only — no change needed)

Nix doesn't build for Windows. The npm package handles Windows distribution.
`meta.platforms = lib.platforms.linux` stays as-is. Windows users install via `npm install -g nospoon`.

The wintun.dll files in `bin/win32-*/` will be included in the npm tarball but ignored
on Linux/macOS (only loaded when `process.platform === 'win32'`).

---

## Step 7: Update `.gitignore`

Ensure `bin/win32-*/wintun.dll` is NOT gitignored (it needs to be committed).

---

## Implementation Order

```
1. [x] Write WINDOWS.md (research)              ← done
2. [x] Write WINDOWS-IMPL.md (this plan)        ← done
3. [ ] Commit config-file changes on main
4. [ ] Rebase windows-support on main
5. [ ] Download wintun.dll prebuilts, add to bin/win32-*/
6. [ ] Create lib/tun-windows.js
7. [ ] Create lib/full-tunnel-windows.js
8. [ ] Update lib/tun.js dispatcher
9. [ ] Update lib/full-tunnel.js dispatcher
10.[ ] Add admin check in bin/cli.js
11.[ ] Test on Windows (VM or native):
       - Client mode (connect to Linux server)
       - Client full-tunnel mode
       - Server mode (experimental)
       - Cleanup on Ctrl+C
       - Cleanup after crash (stale adapter)
       - DNS leak test (dnsleaktest.com)
12.[ ] Update README with Windows instructions
```

---

## Known Limitations

1. **Server NAT is experimental on Windows** — `New-NetNat` has a single-instance limit
   and conflicts with Docker/Hyper-V. Linux is the recommended server platform.

2. **No `rp_filter` equivalent** — Windows doesn't have reverse path filtering.
   Not needed since the split-route approach works differently on Windows.

3. **PowerShell dependency** — `Get-NetRoute`, `Add-DnsClientNrptRule`, `New-NetNat`
   require PowerShell. Available on all Windows 10/11 systems.

4. **First-use driver install** — first call to `WintunCreateAdapter` installs the kernel
   driver, which may cause a brief delay and a Windows Security dialog.

5. **Interface names with spaces** — Windows adapter names can contain spaces (unlike
   Linux/macOS). The `validateInterface` regex and all `netsh`/`route` commands handle this.

---

## Testing Checklist

- [ ] `nospoon up client.jsonc` connects to a Linux server
- [ ] Packets flow bidirectionally (ping server TUN IP from client)
- [ ] Full tunnel routes all traffic through VPN
- [ ] DNS resolves through VPN (no leak)
- [ ] Ctrl+C cleanly removes adapter and routes
- [ ] Kill process → restart → stale adapter cleaned up
- [ ] Non-admin launch shows clear error message
- [ ] `nospoon genkey` works (no admin needed)
- [ ] Server mode creates NAT (experimental)
- [ ] IPv6 TUN address works
- [ ] Custom MTU works
