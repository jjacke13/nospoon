const HyperDHT = require('hyperdht')
const crypto = require('crypto')
const { createTunDevice } = require('./tun')
const { encode, createDecoder, startKeepalive } = require('./framing')
const { createRouter, readDestinationIp, readSourceIp } = require('./routing')
const { enableServerForwarding, disableServerForwarding } = require('./full-tunnel')

async function startServer ({ ip = '10.0.0.1/24', ipv6, seed, mtu = 1400, peers, fullTunnel, outInterface }) {
  const seedBuf = seed
    ? Buffer.from(seed, 'hex')
    : crypto.randomBytes(32)

  // peers is already a validated Map from config.js, or undefined for open mode
  const allowedPeers = peers || null

  const keyPair = HyperDHT.keyPair(seedBuf)
  const dht = new HyperDHT()
  const tun = createTunDevice({ ipv4: ip, ipv6, mtu })
  const router = createRouter()

  const serverOpts = {
    firewall (remotePublicKey) {
      if (!allowedPeers) return false // open mode, allow all
      const keyHex = remotePublicKey.toString('hex')
      const allowed = allowedPeers.has(keyHex)
      if (!allowed) {
        console.log(`Firewalled unknown peer: ${keyHex.slice(0, 8)}...`)
      }
      return !allowed // true = reject, false = allow
    }
  }

  const keepaliveIntervals = []

  const server = dht.createServer(serverOpts, function (connection) {
    const clientKeyHex = connection.remotePublicKey.toString('hex')
    const clientKeyShort = clientKeyHex.slice(0, 8) + '...'

    let clientIp = allowedPeers
      ? allowedPeers.get(clientKeyHex)
      : null

    console.log(`Client connected: ${clientKeyShort}` + (clientIp ? ` → ${clientIp}` : ''))
    keepaliveIntervals.push(startKeepalive(connection))

    if (clientIp) {
      router.add(clientIp, connection)
    }

    const decode = createDecoder(function (packet) {
      const srcIp = readSourceIp(packet)

      if (allowedPeers) {
        // Authenticated mode: verify source IP matches assigned IP
        if (srcIp !== clientIp) return
      } else if (!clientIp && srcIp) {
        // Open mode: learn client IP from first packet (skip IPv6 link-local)
        if (srcIp.startsWith('fe80:')) return
        const existing = router.getByIp(srcIp)
        if (existing && !existing.destroyed) {
          // IP already taken by another client — drop packet
          return
        }
        clientIp = srcIp
        router.add(clientIp, connection)
      } else if (clientIp && srcIp !== clientIp) {
        // Open mode: source IP changed after learning — drop
        return
      }

      const destIp = readDestinationIp(packet)
      const peerConn = destIp ? router.getByIp(destIp) : null

      if (peerConn && !peerConn.destroyed) {
        // Destination is another client — forward directly
        peerConn.write(encode(packet))
      } else {
        // Destination is the server or external — send to TUN
        tun.write(packet)
      }
    })

    connection.on('data', function (data) {
      decode(data)
    })

    connection.on('error', function (err) {
      console.error(`Connection error (${clientKeyShort}):`, err.message)
    })

    connection.on('close', function () {
      console.log(`Client disconnected: ${clientKeyShort}`)
      if (clientIp) {
        router.remove(clientIp)
      }
    })
  })

  // Route outgoing TUN packets to the correct client
  tun.on('data', function (packet) {
    const destIp = readDestinationIp(packet)
    if (!destIp) return

    const connection = router.getByIp(destIp)
    if (connection && !connection.destroyed) {
      connection.write(encode(packet))
    }
  })

  await server.listen(keyPair)

  // Enable NAT if full tunnel mode
  let natState = null
  if (fullTunnel) {
    // Derive subnet from server IP for iptables rules
    const ipParts = ip.split('/')
    const octets = ipParts[0].split('.')
    const subnet = `${octets[0]}.${octets[1]}.${octets[2]}.0/${ipParts[1] || '24'}`

    if (!allowedPeers) {
      console.log('')
      console.log('WARNING: fullTunnel without peers creates an OPEN PROXY')
      console.log('         Anyone with the public key can route internet traffic through this server')
      console.log('')
    }

    natState = enableServerForwarding(outInterface, subnet, tun.name)
  }

  const tunIp = ip.split('/')[0]

  console.log('')
  console.log('Server listening')
  console.log('TUN IP:     ', tunIp)
  console.log('Public key: ', keyPair.publicKey.toString('hex'))
  if (allowedPeers) {
    console.log('Allowed peers:', allowedPeers.size)
    for (const [key, peerIp] of allowedPeers) {
      console.log(`  ${key.slice(0, 8)}... → ${peerIp}`)
    }
  } else {
    console.log('Auth:        OPEN (no peers configured, any client can connect)')
  }

  let exiting = false
  function shutdown () {
    if (exiting) return
    exiting = true
    console.log('\nShutting down...')
    for (const interval of keepaliveIntervals) clearInterval(interval)
    if (natState) disableServerForwarding(natState)
    try { tun.release() } catch (e) {}
    server.close()
    dht.destroy().then(function () {
      process.exit(0)
    }).catch(function () {
      process.exit(0)
    })
    setTimeout(function () { process.exit(0) }, 2000)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  return { server, dht, tun, seed: seedBuf, keyPair }
}

module.exports = { startServer }
