const { childProcess } = require('./compat')
const { execFileSync } = childProcess
const binding = require('./binding')
const { createTunFromFd } = require('./tun-fd')

function createTunDevice ({ name, ipv4, ipv6, mtu = 1400 }) {
  const result = binding.tunCreateLinux(name || '')
  const tunName = result.name
  const fd = result.fd

  execFileSync('ip', ['addr', 'add', ipv4, 'dev', tunName])
  if (ipv6) {
    execFileSync('ip', ['-6', 'addr', 'add', ipv6, 'dev', tunName])
  }
  execFileSync('ip', ['link', 'set', tunName, 'mtu', String(mtu)])
  execFileSync('ip', ['link', 'set', tunName, 'up'])

  const addrs = ipv6 ? `${ipv4} + ${ipv6}` : ipv4
  console.log(`TUN device ${tunName} up with ${addrs} (MTU ${mtu})`)

  return createTunFromFd(fd, tunName, { mtu })
}

module.exports = { createTunDevice }
