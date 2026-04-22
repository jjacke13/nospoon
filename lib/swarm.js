// Swarm mesh — full mesh VPN over Hyperswarm.
// Replaces the old server.js + client.js with a single unified module.
// All peers are equal. Exit node (NAT) is a per-peer config flag.

const Hyperswarm = require('hyperswarm')
const HyperDHT = require('hyperdht')
const b4a = require('b4a')
const { exit, onSignal } = require('./compat')
const { createTunDevice } = require('./tun')
const { encode, createDecoder, startKeepalive } = require('./framing')
const { createRouter, readDestinationIp, readSourceIp } = require('./routing')
const { enableServerForwarding, disableServerForwarding, enableClientFullTunnel, addHostExemption, disableClientFullTunnel } = require('./full-tunnel')
const { deriveDiscoveryKey, createTopicProof, verifyTopicProof } = require('./swarm-topic')
const { loadOrCreateSeed } = require('./identity')
const { parseSubnet, ipToInt } = require('./config')

const PROOF_SIZE = 32

async function startSwarm (opts) {
  const {
    topic,
    ip = '10.0.0.1/24',
    ipv6,
    mtu = 1400,
    keepalive = 25000,
    exitNode = false,
    exitVia,
    outInterface,
    peers,
    ipcWrite,
    tun: externalTun
  } = opts

  let { seed, onConnected } = opts

  // Identity
  const seedHex = seed || loadOrCreateSeed()
  const seedBuf = b4a.from(seedHex, 'hex')
  const keyPair = HyperDHT.keyPair(seedBuf)

  // Hyperswarm
  const topicBuf = b4a.from(topic)
  const discoveryKey = deriveDiscoveryKey(topic)
  const swarm = new Hyperswarm({ keyPair })

  // TUN — deferred for Android two-phase
  let tun = externalTun || (onConnected ? null : createTunDevice({ ipv4: ip, ipv6, mtu }))

  // Routing
  const router = createRouter()
  const allowedPeers = peers || null
  const peerState = new Map() // pubkeyHex → { ip, connection, keepaliveInterval }

  // Open mode IP allocator
  const subnet = parseSubnet(ip)
  const myIpInt = ipToInt(ip.split('/')[0])
  const usedIps = new Set([myIpInt])

  function allocateIp () {
    for (let addr = (subnet.network + 1) >>> 0; addr < subnet.broadcast; addr = (addr + 1) >>> 0) {
      if (addr === myIpInt) continue
      if (usedIps.has(addr)) continue
      usedIps.add(addr)
      return intToIp(addr)
    }
    return null
  }

  function releaseIp (ipStr) {
    usedIps.delete(ipToInt(ipStr))
  }

  function intToIp (n) {
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.')
  }

  // Exit state
  let exitPeerConn = null
  let fullTunnelActive = false
  let natState = null
  let exiting = false

  // TUN read loop — route outbound packets
  function setupTunHandler () {
    tun.on('data', function (packet) {
      const destIp = readDestinationIp(packet)
      if (!destIp) return

      const peerConn = router.getByIp(destIp)
      if (peerConn && !peerConn.destroyed) {
        peerConn.write(encode(packet))
      } else if (exitPeerConn && !exitPeerConn.destroyed) {
        exitPeerConn.write(encode(packet))
      }
    })
  }

  if (tun) setupTunHandler()

  // Connection handler
  swarm.on('connection', function (connection) {
    const remoteKeyHex = connection.remotePublicKey.toString('hex')
    const remoteKeyShort = remoteKeyHex.slice(0, 8) + '...'

    // Authentication — reject unknown peers early
    if (allowedPeers && !allowedPeers.has(remoteKeyHex)) {
      console.log(`Rejected unknown peer: ${remoteKeyShort}`)
      connection.destroy()
      return
    }

    // Determine peer IP
    let peerIp = null
    if (allowedPeers) {
      peerIp = allowedPeers.get(remoteKeyHex)
    } else {
      peerIp = allocateIp()
      if (!peerIp) {
        console.log(`Subnet exhausted, rejecting peer: ${remoteKeyShort}`)
        connection.destroy()
        return
      }
    }

    // Send our topic proof
    const handshakeHash = connection.handshakeHash
    const isInitiator = connection.isInitiator
    const myProof = createTopicProof(isInitiator, topicBuf, handshakeHash)
    connection.write(myProof)

    // Topic proof state machine
    let proofVerified = false
    let proofBuf = b4a.alloc(0)

    function onProofData (data) {
      if (proofVerified) return

      proofBuf = b4a.concat([proofBuf, data])
      if (proofBuf.length < PROOF_SIZE) return

      const remoteProof = proofBuf.subarray(0, PROOF_SIZE)
      const remainder = proofBuf.subarray(PROOF_SIZE)

      if (!verifyTopicProof(!isInitiator, topicBuf, handshakeHash, remoteProof)) {
        console.log(`Topic proof failed for peer: ${remoteKeyShort}`)
        if (!allowedPeers) releaseIp(peerIp)
        connection.destroy()
        return
      }

      proofVerified = true
      connection.removeListener('data', onProofData)
      activateConnection(remainder)
    }

    connection.on('data', onProofData)

    function activateConnection (bufferedData) {
      // Tear down existing connection from same peer (reconnect)
      const existing = peerState.get(remoteKeyHex)
      if (existing) {
        if (existing.keepaliveInterval) clearInterval(existing.keepaliveInterval)
        if (existing.ip) router.remove(existing.ip)
        if (!allowedPeers && existing.ip) releaseIp(existing.ip)
        if (existing.connection && !existing.connection.destroyed) {
          existing.connection.destroy()
        }
      }

      router.add(peerIp, connection)
      const keepaliveInterval = startKeepalive(connection)
      peerState.set(remoteKeyHex, { ip: peerIp, connection, keepaliveInterval })

      console.log(`Peer connected: ${remoteKeyShort} → ${peerIp}`)

      // Android two-phase: create TUN after first peer connects
      if (!tun && onConnected) {
        if (ipcWrite) ipcWrite('STATUS:connected')
        tun = onConnected()
        onConnected = null
        setupTunHandler()
      }

      // Exit via: track the exit peer connection
      if (exitVia && peerIp === exitVia) {
        exitPeerConn = connection
        console.log(`Exit peer ${exitVia} connected`)

        if (!ipcWrite && !fullTunnelActive) {
          const remoteHost = connection.rawStream
            ? connection.rawStream.remoteHost
            : null
          if (remoteHost) {
            enableClientFullTunnel(remoteHost, tun.name)
            fullTunnelActive = true

            for (const [, state] of peerState) {
              if (state.connection && state.connection !== connection && state.connection.rawStream) {
                addHostExemption(state.connection.rawStream.remoteHost)
              }
            }
          }
        }
      }

      // Add host exemption for this peer if full tunnel is active
      if (fullTunnelActive && connection.rawStream && connection.rawStream.remoteHost) {
        addHostExemption(connection.rawStream.remoteHost)
      }

      // Framing decoder for IP packets
      const decode = createDecoder(function (packet) {
        const srcIp = readSourceIp(packet)
        if (srcIp !== peerIp) return // source IP validation

        const destIp = readDestinationIp(packet)
        if (!destIp) return

        const destConn = router.getByIp(destIp)
        if (destConn && !destConn.destroyed) {
          destConn.write(encode(packet))
        } else if (tun) {
          tun.write(packet)
        }
      })

      if (bufferedData && bufferedData.length > 0) {
        decode(bufferedData)
      }

      connection.on('data', decode)
    }

    connection.on('error', function (err) {
      console.error(`Connection error (${remoteKeyShort}):`, err.message)
    })

    connection.on('close', function () {
      const state = peerState.get(remoteKeyHex)
      if (state && state.connection === connection) {
        console.log(`Peer disconnected: ${remoteKeyShort}`)
        if (state.keepaliveInterval) clearInterval(state.keepaliveInterval)
        if (state.ip) router.remove(state.ip)
        if (!allowedPeers && state.ip) releaseIp(state.ip)
        peerState.delete(remoteKeyHex)
      }

      // Exit peer disconnected — null the ref but keep routes (kill switch)
      if (exitVia && peerIp === exitVia) {
        exitPeerConn = null
        if (!exiting) console.log(`Exit peer ${exitVia} disconnected — waiting for reconnection`)
      }

      if (!proofVerified && !allowedPeers) {
        releaseIp(peerIp)
      }
    })
  })

  // Join the swarm
  const discovery = swarm.join(discoveryKey)
  await discovery.flushed()

  // Exit node NAT
  if (exitNode) {
    const ipParts = ip.split('/')
    const octets = ipParts[0].split('.')
    const subnetStr = `${octets[0]}.${octets[1]}.${octets[2]}.0/${ipParts[1] || '24'}`

    if (!allowedPeers) {
      console.log('')
      console.log('WARNING: exitNode without peers creates an OPEN PROXY')
      console.log('         Anyone who joins the topic can route internet traffic through this peer')
      console.log('')
    }

    natState = enableServerForwarding(outInterface, subnetStr, tun.name)
  }

  // Status output
  const tunIp = ip.split('/')[0]
  console.log('')
  console.log('Swarm joined')
  console.log('TUN IP:       ', tunIp)
  console.log('Public key:   ', keyPair.publicKey.toString('hex'))
  console.log('Topic:        ', topic)
  console.log('Discovery key:', discoveryKey.toString('hex').slice(0, 16) + '...')
  if (allowedPeers) {
    console.log('Peers:        ', allowedPeers.size, 'configured')
    for (const [key, pIp] of allowedPeers) {
      console.log(`  ${key.slice(0, 8)}... → ${pIp}`)
    }
  } else {
    console.log('Mode:          OPEN (any peer with the topic can join)')
  }
  if (exitNode) console.log('Exit node:     ENABLED')
  if (exitVia) console.log('Exit via:     ', exitVia)

  // Shutdown
  function shutdown () {
    if (exiting) return
    exiting = true
    console.log('\nShutting down...')

    for (const [, state] of peerState) {
      if (state.keepaliveInterval) clearInterval(state.keepaliveInterval)
    }

    if (natState) disableServerForwarding(natState)
    if (fullTunnelActive) disableClientFullTunnel({ async: true })
    if (tun) try { tun.release() } catch (e) {}

    swarm.destroy().then(function () {
      exit(0)
    }).catch(function () {
      exit(0)
    })
    setTimeout(function () { exit(0) }, 2000)
  }

  onSignal('SIGINT', shutdown)
  onSignal('SIGTERM', shutdown)

  return { swarm, tun, seed: seedBuf, keyPair }
}

module.exports = { startSwarm }
