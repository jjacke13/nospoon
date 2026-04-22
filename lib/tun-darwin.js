const { childProcess } = require('./compat')
const { execFileSync } = childProcess
const binding = require('./binding')
const { createTunFromFd } = require('./tun-fd')
const { prefixToNetmask } = require('./validation')

function createTunDevice ({ name, ipv4, ipv6, mtu = 1400 }) {
  const result = binding.tunCreateDarwin()
  const tunName = result.name
  const fd = result.fd

  const ipAddr = ipv4.split('/')[0]
  const prefix = parseInt(ipv4.split('/')[1] || '24', 10)
  const netmask = prefixToNetmask(prefix)

  execFileSync('ifconfig', [tunName, 'inet', ipAddr, ipAddr, 'netmask', netmask])
  if (ipv6) {
    const v6Addr = ipv6.split('/')[0]
    const v6Prefix = ipv6.split('/')[1] || '64'
    execFileSync('ifconfig', [tunName, 'inet6', v6Addr, 'prefixlen', v6Prefix])
  }
  execFileSync('ifconfig', [tunName, 'mtu', String(mtu), 'up'])
  execFileSync('route', ['add', '-net', ipv4, '-interface', tunName])

  const addrs = ipv6 ? `${ipv4} + ${ipv6}` : ipv4
  console.log(`TUN device ${tunName} up with ${addrs} (MTU ${mtu})`)

  return createTunFromFd(fd, tunName, { mtu, stripAF: true, prependAF: true })
}

module.exports = { createTunDevice }
