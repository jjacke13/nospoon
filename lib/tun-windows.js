const b4a = require('b4a')
const { childProcess, path, arch, EventEmitter, onExit } = require('./compat')
const { execFileSync } = childProcess
const binding = require('./binding')

const ADAPTER_NAME = 'Nospoon'
const TUNNEL_TYPE = 'Nospoon Tunnel'
const SESSION_CAPACITY = 0x400000 // 4 MiB ring buffer
const RECEIVE_BATCH_LIMIT = 64
const ERROR_NO_MORE_ITEMS = 259
const ERROR_HANDLE_EOF = 38

function createTunDevice ({ ipv4, ipv6, mtu = 1400 }) {
  // Load wintun.dll — next to executable (standalone) or in project bin/ (dev)
  const ARCH_MAP = { x64: 'x64', arm64: 'arm64', ia32: 'x86' }
  const wintunArch = ARCH_MAP[arch]
  if (!wintunArch) throw new Error(`Unsupported architecture: ${arch}`)
  const dllPath = isBare
    ? path.join(path.dirname(Bare.argv[0]), 'wintun.dll')
    : path.join(__dirname, '..', 'bin', `win32-${wintunArch}`, 'wintun.dll')
  binding.wintunLoad(dllPath)

  // Clean up stale adapter
  const stale = binding.wintunOpenAdapter(ADAPTER_NAME)
  if (stale) binding.wintunCloseAdapter(stale)

  // Create adapter + session
  const adapter = binding.wintunCreateAdapter(ADAPTER_NAME, TUNNEL_TYPE)
  const driverVer = binding.wintunGetDriverVersion()
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
    'name=' + ADAPTER_NAME, 'source=static',
    'addr=' + ipAddr, 'mask=' + netmask
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
    ADAPTER_NAME, 'mtu=' + String(mtu), 'store=active'
  ], { encoding: 'utf-8' })

  const session = binding.wintunStartSession(adapter, SESSION_CAPACITY)
  const readEvent = binding.wintunGetReadWaitEvent(session)

  const tun = new EventEmitter()
  tun.name = ADAPTER_NAME
  let released = false

  function receiveLoop () {
    if (released) return

    let count = 0
    while (count < RECEIVE_BATCH_LIMIT) {
      const packet = binding.wintunReceivePacket(session)
      if (!packet) {
        const err = binding.wintunGetLastError()
        if (err === ERROR_HANDLE_EOF) {
          tun.emit('error', new Error('Wintun session terminated by driver'))
          return
        }
        break
      }
      tun.emit('data', packet)
      count++
    }

    if (released) return

    if (count === RECEIVE_BATCH_LIMIT) {
      setImmediate(receiveLoop)
      return
    }

    // Wait asynchronously — blocking call runs in addon on worker thread
    binding.waitForSingleObject(readEvent, 1000)
    setImmediate(receiveLoop)
  }

  setImmediate(receiveLoop)

  tun.write = function (packet) {
    if (released || !packet || packet.length === 0) return false
    return binding.wintunSendPacket(session, packet)
  }

  tun.release = function () {
    if (released) return
    released = true
    try { binding.wintunEndSession(session) } catch (e) {}
    try { binding.wintunCloseAdapter(adapter) } catch (e) {}
  }

  onExit(function () { tun.release() })

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
