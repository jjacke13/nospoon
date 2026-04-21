const HyperDHT = require('hyperdht')
const b4a = require('b4a')
const { exit, onSignal } = require('./compat')
const { createTunDevice } = require('./tun')
const { encode, createDecoder, startKeepalive } = require('./framing')
const { enableClientFullTunnel, addHostExemption, disableClientFullTunnel } = require('./full-tunnel')

const INITIAL_RETRY_MS = 1000
const MAX_RETRY_MS = 30000
const MAX_FAILURES_BEFORE_RESTART = 3

async function startClient ({ server, ip = '10.0.0.2/24', ipv6, seed, mtu = 1400, fullTunnel, keepalive = 25000, tun: externalTun, onConnected, ipcWrite }) {
  const serverPublicKey = b4a.from(server, 'hex')
  let dht = new HyperDHT({ connectionKeepAlive: keepalive })

  // Two-phase (Android): no TUN yet — created after first DHT connection
  // Normal: TUN created immediately
  let tun = externalTun || (onConnected ? null : createTunDevice({ ipv4: ip, ipv6, mtu }))

  // Generate client key pair from seed (for authentication) or ephemeral
  const connectOpts = {}
  if (seed) {
    const seedBuf = b4a.from(seed, 'hex')
    connectOpts.keyPair = HyperDHT.keyPair(seedBuf)
    console.log('Client public key:', connectOpts.keyPair.publicKey.toString('hex'))
    console.log('(give this to the server operator for the peers config)')
    console.log('')
  }

  let shuttingDown = false
  let activeConnection = null
  let keepaliveInterval = null
  let retryDelay = INITIAL_RETRY_MS
  let fullTunnelActive = false
  let consecutiveFailures = 0

  function connect () {
    const connection = dht.connect(serverPublicKey, connectOpts)
    activeConnection = connection

    const decode = createDecoder(function (packet) {
      if (tun) tun.write(packet)
    })

    connection.on('open', function () {
      retryDelay = INITIAL_RETRY_MS
      consecutiveFailures = 0
      const remoteIp = deriveRemoteIp(ip)
      console.log('Connected to server')
      console.log(`Remote reachable at ${remoteIp}`)
      if (ipcWrite) ipcWrite('STATUS:connected')

      // Two-phase (Android): receive TUN fd now that DHT is connected
      if (!tun && onConnected) {
        tun = onConnected()
        onConnected = null // only call once

        // Wire TUN packets to the connection
        tun.on('data', function (packet) {
          if (activeConnection && !activeConnection.destroyed) {
            activeConnection.write(encode(packet))
          }
        })
      }

      keepaliveInterval = startKeepalive(connection)

      if (fullTunnel) {
        // Get the actual IP the DHT stream is talking to
        const serverHost = connection.rawStream
          ? connection.rawStream.remoteHost
          : null

        console.log('DHT remote endpoint:', serverHost)

        if (!fullTunnelActive) {
          enableClientFullTunnel(serverHost, tun.name)
          fullTunnelActive = true
        } else {
          // Reconnected — exempt the new server address if it changed
          addHostExemption(serverHost)
        }
      }
    })

    connection.on('data', function (data) {
      decode(data)
    })

    connection.on('error', function (err) {
      console.error('Connection error:', err.message)
    })

    connection.on('close', function () {
      activeConnection = null

      if (shuttingDown) return

      consecutiveFailures++
      if (ipcWrite) ipcWrite('STATUS:reconnecting')

      // If full tunnel is active and we've failed too many times,
      // the server's IP may have changed. DHT lookups to other nodes
      // go through tun0 (dead tunnel) and fail. We need to temporarily
      // remove the tunnel routes so DHT can reach the internet directly,
      // find the server at its new IP, and re-establish the tunnel.
      if (fullTunnelActive && consecutiveFailures >= MAX_FAILURES_BEFORE_RESTART) {
        console.log(`${consecutiveFailures} consecutive failures — restarting DHT to find server...`)
        restartDht()
        return
      }

      const jitter = Math.floor(Math.random() * 1000)
      const delay = retryDelay + jitter
      console.log(`Connection lost. Reconnecting in ${Math.round(delay / 1000)}s...`)

      setTimeout(function () {
        if (!shuttingDown) connect()
      }, delay)

      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS)
    })
  }

  // Full DHT restart: remove tunnel routes so DHT lookups can reach
  // the real internet, create a fresh DHT instance, and reconnect.
  // The tunnel routes are re-added when the new connection opens.
  function restartDht () {
    console.log('Removing tunnel routes for DHT restart...')
    disableClientFullTunnel()
    fullTunnelActive = false

    // Destroy old DHT, create fresh one
    const oldDht = dht
    dht = new HyperDHT({ connectionKeepAlive: keepalive })
    oldDht.destroy().catch(function () {})

    retryDelay = INITIAL_RETRY_MS
    consecutiveFailures = 0

    console.log('Routes removed, fresh DHT created — reconnecting...')
    connect()
  }

  // Route TUN packets to the active connection
  // (In two-phase mode, tun is null here — wired in onConnected callback)
  if (tun) {
    tun.on('data', function (packet) {
      if (activeConnection && !activeConnection.destroyed) {
        activeConnection.write(encode(packet))
      }
    })
  }

  connect()

  function shutdown () {
    if (shuttingDown) return
    shuttingDown = true
    console.log('\nShutting down...')
    if (keepaliveInterval) clearInterval(keepaliveInterval)
    if (fullTunnelActive) disableClientFullTunnel({ async: true })
    if (tun) try { tun.release() } catch (e) {}
    if (activeConnection) activeConnection.end()
    dht.destroy().then(function () {
      exit(0)
    }).catch(function () {
      exit(0)
    })
    setTimeout(function () { exit(0) }, 2000)
  }

  onSignal('SIGINT', shutdown)
  onSignal('SIGTERM', shutdown)

  return { dht, tun }
}

function deriveRemoteIp (clientCidr) {
  const parts = clientCidr.split('/')[0].split('.')
  return parts.slice(0, 3).concat('1').join('.')
}

module.exports = { startClient }
