const { validateInterface: _validateInterface, run, runAsync, TUNNEL_DNS } = require('./platform-utils')

// Windows interface names can have spaces — wrap the shared validator
function validateInterface (name) {
  return _validateInterface(name, true)
}

// Runs a PowerShell snippet with -NoProfile for faster startup
function ps (script, opts) {
  return run('powershell', ['-NoProfile', '-NoLogo', '-Command', script], opts)
}

function psAsync (script) {
  runAsync('powershell', ['-NoProfile', '-NoLogo', '-Command', script])
}

// --- Default gateway detection ---
// Single PowerShell call returns both gateway IP and interface index
function getDefaultGateway () {
  const out = ps(
    "$r = Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Select-Object -First 1; " +
    "\"$($r.NextHop)|$($r.InterfaceIndex)\""
  )
  if (!out) return null
  const parts = out.split('|')
  if (parts.length < 2 || !parts[0] || !parts[1]) return null
  return { gateway: parts[0], ifIndex: parts[1].trim() }
}

// Get TUN adapter interface index
function getTunIfIndex (tunName) {
  return ps(`(Get-NetAdapter -Name '${tunName}').ifIndex`)
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

  if (outInterface) {
    run('netsh', ['interface', 'ipv4', 'set', 'interface', outInterface, 'forwarding=enabled'], strict)
  }

  // Try New-NetNat (Pro/Enterprise with working WMI provider)
  // Warns and continues without NAT if unavailable (broken WMI, VMs, Home edition)
  let natMethod = 'none'
  const natResult = ps(`New-NetNat -Name 'NospoonNAT' -InternalIPInterfaceAddressPrefix '${source}'`)
  if (natResult !== null) {
    natMethod = 'netnat'
    console.log('NAT enabled via New-NetNat')
  } else {
    console.log('')
    console.log('WARNING: NAT could not be enabled (MSFT_NetNat WMI class unavailable)')
    console.log('         Server will route packets between clients but full-tunnel')
    console.log('         internet access will NOT work. Use a Linux server instead.')
    console.log('')
  }

  return { source, tun, outInterface, natMethod }
}

function disableServerForwarding (natState) {
  if (!natState) return
  console.log('Removing NAT rules...')

  if (natState.natMethod === 'netnat') {
    ps("Remove-NetNat -Name 'NospoonNAT' -Confirm:$false")
  }

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
let savedNrptRuleName = null

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
  // We use 0.0.0.0 as gateway with the interface index to force via TUN
  run('route', ['add', '0.0.0.0', 'mask', '128.0.0.0',
    '0.0.0.0', 'metric', '1', 'if', savedTunIfIndex], strict)
  run('route', ['add', '128.0.0.0', 'mask', '128.0.0.0',
    '0.0.0.0', 'metric', '1', 'if', savedTunIfIndex], strict)

  // IPv6 leak prevention: blackhole IPv6 through TUN (same as WireGuard)
  // Packets hit the TUN, nospoon doesn't route IPv6, they get silently dropped.
  // TODO: when IPv6 tunneling is implemented, make this conditional —
  // if client has ipv6 configured, route IPv6 through tunnel instead of blackholing
  run('netsh', ['interface', 'ipv6', 'add', 'route', '::/1',
    'interface=' + savedTunIfIndex, 'metric=1'])
  run('netsh', ['interface', 'ipv6', 'add', 'route', '8000::/1',
    'interface=' + savedTunIfIndex, 'metric=1'])
  console.log('IPv6 blackholed through tunnel (leak prevention)')

  // DNS: use NRPT to force all DNS through VPN DNS (prevents DNS leak)
  // Save rule name for targeted removal (avoids wiping unrelated NRPT rules)
  savedNrptRuleName = ps(
    `(Add-DnsClientNrptRule -Namespace '.' -NameServers '${TUNNEL_DNS.join("','")}' -PassThru).Name`
  )
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

function disableClientFullTunnel ({ async: useAsync } = {}) {
  console.log('Restoring original routes...')

  const exec = useAsync ? runAsync : run
  const execPs = useAsync ? psAsync : ps

  // Remove IPv4 split routes
  exec('route', ['delete', '0.0.0.0', 'mask', '128.0.0.0'])
  exec('route', ['delete', '128.0.0.0', 'mask', '128.0.0.0'])

  // Remove IPv6 blackhole routes
  if (savedTunIfIndex) {
    exec('netsh', ['interface', 'ipv6', 'delete', 'route', '::/1',
      'interface=' + savedTunIfIndex])
    exec('netsh', ['interface', 'ipv6', 'delete', 'route', '8000::/1',
      'interface=' + savedTunIfIndex])
  }

  // Remove host route exemptions
  if (savedGateway) {
    for (const host of savedRemoteHosts) {
      exec('route', ['delete', host, 'mask', '255.255.255.255'])
    }
  }

  // Restore DNS — remove only our NRPT rule (not third-party rules)
  if (savedNrptRuleName) {
    execPs(`Remove-DnsClientNrptRule -Name '${savedNrptRuleName}' -Force`)
  }
  exec('ipconfig', ['/flushdns'])
  console.log('DNS restored (NRPT rule removed)')

  savedTunName = null
  savedRemoteHosts = []
  savedGateway = null
  savedTunIfIndex = null
  savedNrptRuleName = null
}

module.exports = {
  enableServerForwarding,
  disableServerForwarding,
  enableClientFullTunnel,
  addHostExemption,
  disableClientFullTunnel
}
