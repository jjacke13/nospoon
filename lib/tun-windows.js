const { execFileSync } = require('child_process')
const { EventEmitter } = require('events')
const path = require('path')
const koffi = require('koffi')

// --- Load wintun.dll ---
const ARCH_MAP = { x64: 'x64', arm64: 'arm64', ia32: 'x86' }
const arch = ARCH_MAP[process.arch]
if (!arch) throw new Error(`Unsupported architecture: ${process.arch}`)
const dllPath = path.join(__dirname, '..', 'bin', `win32-${arch}`, 'wintun.dll')
const wintun = koffi.load(dllPath)

// Also need kernel32 for WaitForSingleObject and GetLastError
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
const WintunGetRunningDriverVersion = wintun.func(
  'uint32_t __stdcall WintunGetRunningDriverVersion()'
)

// kernel32 for async wait and error checking
const WaitForSingleObject = kernel32.func(
  'uint32_t __stdcall WaitForSingleObject(void *hHandle, uint32_t dwMilliseconds)'
)
const GetLastError = kernel32.func('uint32_t __stdcall GetLastError()')

const ADAPTER_NAME = 'Nospoon'
const TUNNEL_TYPE = 'Nospoon Tunnel'
const SESSION_CAPACITY = 0x400000 // 4 MiB ring buffer
const RECEIVE_BATCH_LIMIT = 64 // yield to event loop after this many packets
const ERROR_NO_MORE_ITEMS = 259
const ERROR_HANDLE_EOF = 38

function createTunDevice ({ ipv4, ipv6, mtu = 1400 }) {
  // Clean up stale adapter from a previous crash
  const stale = WintunOpenAdapter(ADAPTER_NAME)
  if (stale) WintunCloseAdapter(stale)

  // Create adapter
  const adapter = WintunCreateAdapter(ADAPTER_NAME, TUNNEL_TYPE, null)
  if (!adapter) throw new Error('Failed to create Wintun adapter (requires Administrator)')

  // Log wintun driver version for diagnostics
  const driverVer = WintunGetRunningDriverVersion()
  if (driverVer) {
    const major = (driverVer >> 16) & 0xffff
    const minor = driverVer & 0xffff
    console.log(`Wintun driver v${major}.${minor}`)
  }

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
  // Batch limit prevents event loop starvation under packet floods.
  function receiveLoop () {
    if (released) return

    let count = 0
    while (count < RECEIVE_BATCH_LIMIT) {
      const sizeOut = [0]
      const packetPtr = WintunReceivePacket(session, sizeOut)
      if (!packetPtr) {
        const err = GetLastError()
        if (err === ERROR_HANDLE_EOF) {
          tun.emit('error', new Error('Wintun session terminated by driver'))
          return
        }
        // ERROR_NO_MORE_ITEMS — no packets available, go wait
        break
      }

      const ab = koffi.view(packetPtr, sizeOut[0])
      const packet = Buffer.from(ab) // copy out of ring buffer
      WintunReleaseReceivePacket(session, packetPtr)
      tun.emit('data', packet)
      count++
    }

    if (released) return

    // If we hit batch limit, yield then continue draining
    if (count === RECEIVE_BATCH_LIMIT) {
      setImmediate(receiveLoop)
      return
    }

    // No more packets — wait asynchronously on worker thread
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
    if (!sendPtr) {
      const err = GetLastError()
      if (err === ERROR_HANDLE_EOF) {
        tun.emit('error', new Error('Wintun session terminated by driver'))
      }
      // ERROR_BUFFER_OVERFLOW → ring full, drop packet (recoverable)
      return false
    }
    const ab = koffi.view(sendPtr, packet.length)
    // Safe copy: handle Buffer.subarray() with non-zero byteOffset
    new Uint8Array(ab).set(new Uint8Array(packet.buffer, packet.byteOffset, packet.length))
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

  // Last-resort cleanup: if process exits without calling release(),
  // close the adapter so it doesn't persist as a stale interface.
  // Note: 'exit' handler can only run synchronous code — FFI calls are OK.
  process.on('exit', function () {
    tun.release()
  })

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
