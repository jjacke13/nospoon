// iOS VPN worklet — runs inside Bare runtime (JSC) in Network Extension
// Unlike Android, there is NO TUN fd. Packets are shuttled via IPC.
// No protect()/protected dance needed — extension sockets bypass tunnel automatically.

/* global BareKit */

const HyperDHT = require('hyperdht')
const { encode, createDecoder, startKeepalive } = require('./framing')

const INITIAL_RETRY_MS = 1000
const MAX_RETRY_MS = 30000
const MAX_FAILURES_BEFORE_RESTART = 3

const ipc = BareKit.IPC

let dht = null
let activeConnection = null
let shuttingDown = false
let retryDelay = INITIAL_RETRY_MS
let consecutiveFailures = 0

function sendToSwift (msg) {
  ipc.write(Buffer.from(JSON.stringify(msg) + '\n'))
}

// Outbound packets arrive via IPC from Swift (NEPacketTunnelFlow),
// not from a TUN fd. No setupTun(), no tunWrite, no tunReady.
function handleOutboundPacket (b64) {
  if (!activeConnection || activeConnection.destroyed) return
  const packet = Buffer.from(b64, 'base64')
  activeConnection.write(encode(packet))
}

function connect (serverKey, connectOpts) {
  const serverPublicKey = Buffer.from(serverKey, 'hex')
  const connection = dht.connect(serverPublicKey, connectOpts)
  activeConnection = connection

  const decode = createDecoder(function (packet) {
    // Send inbound packets to Swift via IPC (instead of writing to TUN fd)
    sendToSwift({ type: 'packet', data: packet.toString('base64') })
  })

  connection.on('open', function () {
    retryDelay = INITIAL_RETRY_MS
    consecutiveFailures = 0
    // No protect() needed — extension sockets bypass tunnel automatically
    sendToSwift({ type: 'connected' })
    startKeepalive(connection)
  })

  connection.on('data', function (data) {
    decode(data)
  })

  connection.on('error', function (err) {
    sendToSwift({ type: 'error', message: err.message })
  })

  connection.on('close', function () {
    activeConnection = null
    if (shuttingDown) return

    consecutiveFailures++
    sendToSwift({ type: 'status', connected: false })

    // After repeated failures the DHT socket is likely dead
    // (NAT mapping expired, network changed). Restart DHT entirely.
    if (consecutiveFailures >= MAX_FAILURES_BEFORE_RESTART) {
      restartDht(serverKey, connectOpts)
      return
    }

    const jitter = Math.floor(Math.random() * 1000)
    const delay = retryDelay + jitter

    setTimeout(function () {
      if (!shuttingDown) connect(serverKey, connectOpts)
    }, delay)

    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS)
  })
}

// Simplified vs Android: no protect/protected dance needed
function restartDht (serverKey, connectOpts) {
  const oldDht = dht
  dht = new HyperDHT()
  try { oldDht.destroy() } catch (e) {}

  retryDelay = INITIAL_RETRY_MS
  consecutiveFailures = 0

  connect(serverKey, connectOpts)
}

function shutdown () {
  if (shuttingDown) return
  shuttingDown = true

  if (activeConnection) activeConnection.end()
  if (dht) dht.destroy()

  sendToSwift({ type: 'stopped' })
}

// Handle IPC messages from Swift
let ipcBuffer = ''

ipc.on('data', function (data) {
  ipcBuffer += data.toString()
  const lines = ipcBuffer.split('\n')
  ipcBuffer = lines.pop() // keep incomplete line

  for (const line of lines) {
    if (!line.trim()) continue

    let msg
    try { msg = JSON.parse(line) } catch (e) { continue }

    if (msg.type === 'start') {
      const config = msg.config || {}

      if (!config.server || typeof config.server !== 'string' ||
          !/^[0-9a-fA-F]{64}$/.test(config.server)) {
        sendToSwift({ type: 'error', message: 'Invalid server key: must be 64 hex characters' })
        return
      }

      dht = new HyperDHT()

      const connectOpts = {}
      if (config.seed) {
        if (typeof config.seed !== 'string' || !/^[0-9a-fA-F]{64}$/.test(config.seed)) {
          sendToSwift({ type: 'error', message: 'Invalid seed: must be 64 hex characters' })
          return
        }
        const seedBuf = Buffer.from(config.seed, 'hex')
        connectOpts.keyPair = HyperDHT.keyPair(seedBuf)
        sendToSwift({ type: 'identity', publicKey: connectOpts.keyPair.publicKey.toString('hex') })
      }

      connect(config.server, connectOpts)
    } else if (msg.type === 'packet') {
      // Outbound packet from Swift (NEPacketTunnelFlow)
      handleOutboundPacket(msg.data)
    } else if (msg.type === 'stop') {
      shutdown()
    }
  }
})

// Signal Swift that IPC is ready
sendToSwift({ type: 'ready' })
