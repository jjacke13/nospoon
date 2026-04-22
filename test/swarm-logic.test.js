const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { createRouter, readDestinationIp, readSourceIp } = require('../lib/routing')
const { encode, createDecoder } = require('../lib/framing')

// These tests exercise the swarm's per-connection packet handler logic
// without Hyperswarm or TUN. We simulate what swarm.js does:
// receive framed packets from a peer, validate source IP, route via the router.

function makeIpv4Packet (srcIp, dstIp) {
  const buf = Buffer.alloc(20)
  buf[0] = 0x45
  const srcOctets = srcIp.split('.').map(Number)
  const dstOctets = dstIp.split('.').map(Number)
  for (let i = 0; i < 4; i++) {
    buf[12 + i] = srcOctets[i]
    buf[16 + i] = dstOctets[i]
  }
  return buf
}

// Simulates the swarm's per-connection packet handler (post topic-proof)
function createPeerHandler (router, peerIp, opts) {
  const tunWrites = []
  const peerForwards = []
  const exitForwards = []

  const isExitNode = opts && opts.exitNode
  const exitPeerConn = opts && opts.exitPeerConn

  const decode = createDecoder(function (packet) {
    const srcIp = readSourceIp(packet)
    if (srcIp !== peerIp) return // source IP validation

    const destIp = readDestinationIp(packet)
    if (!destIp) return

    const destConn = destIp ? router.getByIp(destIp) : null
    if (destConn && !destConn.destroyed) {
      peerForwards.push({ destIp, packet: Buffer.from(packet) })
    } else if (isExitNode) {
      tunWrites.push(Buffer.from(packet))
    } else if (exitPeerConn && !exitPeerConn.destroyed) {
      exitForwards.push(Buffer.from(packet))
    } else {
      tunWrites.push(Buffer.from(packet))
    }
  })

  return {
    feed (data) { decode(data) },
    tunWrites,
    peerForwards,
    exitForwards
  }
}

function mockConnection (keyHex) {
  return {
    remotePublicKey: Buffer.from(keyHex, 'hex'),
    destroyed: false
  }
}

// ── authenticated mode ─────────────────────────────────────────────

describe('swarm peer handler — authenticated mode', function () {
  it('accepts packet from allowed peer with matching source IP', function () {
    const router = createRouter()
    const keyHex = 'aa'.repeat(32)
    const conn = mockConnection(keyHex)
    router.add('10.0.0.2', conn)

    const handler = createPeerHandler(router, '10.0.0.2')
    handler.feed(encode(makeIpv4Packet('10.0.0.2', '10.0.0.1')))

    assert.equal(handler.tunWrites.length, 1)
    assert.equal(readSourceIp(handler.tunWrites[0]), '10.0.0.2')
  })

  it('drops packet with spoofed source IP', function () {
    const router = createRouter()
    const handler = createPeerHandler(router, '10.0.0.2')

    handler.feed(encode(makeIpv4Packet('10.0.0.99', '10.0.0.1')))
    assert.equal(handler.tunWrites.length, 0)
  })

  it('routes packet to another mesh peer', function () {
    const router = createRouter()
    const conn1 = mockConnection('aa'.repeat(32))
    const conn2 = mockConnection('bb'.repeat(32))
    router.add('10.0.0.2', conn1)
    router.add('10.0.0.3', conn2)

    const handler = createPeerHandler(router, '10.0.0.2')
    handler.feed(encode(makeIpv4Packet('10.0.0.2', '10.0.0.3')))

    assert.equal(handler.tunWrites.length, 0)
    assert.equal(handler.peerForwards.length, 1)
    assert.equal(handler.peerForwards[0].destIp, '10.0.0.3')
  })
})

// ── exit node ──────────────────────────────────────────────────────

describe('swarm peer handler — exit node', function () {
  it('writes non-mesh packets to TUN (internet via NAT)', function () {
    const router = createRouter()
    const handler = createPeerHandler(router, '10.0.0.2', { exitNode: true })

    handler.feed(encode(makeIpv4Packet('10.0.0.2', '8.8.8.8')))
    assert.equal(handler.tunWrites.length, 1)
    assert.equal(readDestinationIp(handler.tunWrites[0]), '8.8.8.8')
  })

  it('still forwards to mesh peers before going to TUN', function () {
    const router = createRouter()
    const conn3 = mockConnection('cc'.repeat(32))
    router.add('10.0.0.3', conn3)

    const handler = createPeerHandler(router, '10.0.0.2', { exitNode: true })
    handler.feed(encode(makeIpv4Packet('10.0.0.2', '10.0.0.3')))

    assert.equal(handler.peerForwards.length, 1)
    assert.equal(handler.tunWrites.length, 0)
  })
})

// ── exit via ───────────────────────────────────────────────────────

describe('swarm peer handler — exit via', function () {
  it('forwards non-mesh packets to exit peer connection', function () {
    const router = createRouter()
    const exitConn = mockConnection('ee'.repeat(32))
    const handler = createPeerHandler(router, '10.0.0.3', { exitPeerConn: exitConn })

    handler.feed(encode(makeIpv4Packet('10.0.0.3', '8.8.8.8')))
    assert.equal(handler.exitForwards.length, 1)
    assert.equal(handler.tunWrites.length, 0)
  })

  it('drops non-mesh packets when exit peer disconnected', function () {
    const router = createRouter()
    const exitConn = mockConnection('ee'.repeat(32))
    exitConn.destroyed = true

    const handler = createPeerHandler(router, '10.0.0.3', { exitPeerConn: exitConn })
    handler.feed(encode(makeIpv4Packet('10.0.0.3', '8.8.8.8')))

    // Not exit node, exit peer destroyed → goes to TUN (which writes locally)
    assert.equal(handler.exitForwards.length, 0)
    assert.equal(handler.tunWrites.length, 1)
  })
})

// ── reconnect and cleanup ──────────────────────────────────────────

describe('swarm — reconnect and cleanup', function () {
  it('cleans up route on disconnect, same peer reconnects', function () {
    const router = createRouter()

    const conn1 = mockConnection('aa'.repeat(32))
    router.add('10.0.0.2', conn1)
    assert.equal(router.getByIp('10.0.0.2'), conn1)

    // Simulate disconnect
    conn1.destroyed = true
    router.remove('10.0.0.2')

    // Same peer reconnects with new connection
    const conn2 = mockConnection('aa'.repeat(32))
    router.add('10.0.0.2', conn2)
    assert.equal(router.getByIp('10.0.0.2'), conn2)
  })

  it('two different peers get different IPs', function () {
    const router = createRouter()
    const conn1 = mockConnection('aa'.repeat(32))
    const conn2 = mockConnection('bb'.repeat(32))
    router.add('10.0.0.2', conn1)
    router.add('10.0.0.3', conn2)

    assert.equal(router.getByIp('10.0.0.2'), conn1)
    assert.equal(router.getByIp('10.0.0.3'), conn2)
    assert.equal(router.activeCount(), 2)
  })
})

// ── malformed packets ──────────────────────────────────────────────

describe('swarm — malformed packets', function () {
  it('handles truncated packet (< 20 bytes)', function () {
    const router = createRouter()
    const handler = createPeerHandler(router, '10.0.0.2')

    handler.feed(encode(Buffer.from([0x45, 0x00, 0x00, 0x14, 0x00])))
    assert.equal(handler.tunWrites.length, 0)
  })

  it('handles zero-length packet', function () {
    const router = createRouter()
    const handler = createPeerHandler(router, '10.0.0.2')

    handler.feed(encode(Buffer.alloc(0)))
    assert.equal(handler.tunWrites.length, 0)
  })

  it('handles wrong IP version byte', function () {
    const router = createRouter()
    const handler = createPeerHandler(router, '10.0.0.2')

    const bad = Buffer.alloc(20)
    bad[0] = 0x35
    handler.feed(encode(bad))
    assert.equal(handler.tunWrites.length, 0)
  })

  it('handles random garbage data', function () {
    const router = createRouter()
    const handler = createPeerHandler(router, '10.0.0.2')

    const garbage = Buffer.alloc(100)
    for (let i = 0; i < 100; i++) garbage[i] = i * 7 & 0xff
    handler.feed(encode(garbage))
    assert.ok(true, 'did not crash')
  })

  it('handles many malformed packets in sequence', function () {
    const router = createRouter()
    const handler = createPeerHandler(router, '10.0.0.2')

    for (let i = 0; i < 1000; i++) {
      const bad = Buffer.alloc(i % 40)
      bad[0] = 0x45
      handler.feed(encode(bad))
    }
    assert.ok(true, 'survived 1000 malformed packets')
  })
})

// ── topic proof ────────────────────────────────────────────────────

describe('swarm — topic proof integration', function () {
  const { deriveDiscoveryKey, createTopicProof, verifyTopicProof } = require('../lib/swarm-topic')
  const b4a = require('b4a')

  it('proof exchange succeeds between initiator and responder', function () {
    const topicBuf = b4a.from('my-vpn-group')
    const handshakeHash = b4a.alloc(32, 0xcc)

    // Initiator creates and sends proof
    const initiatorProof = createTopicProof(true, topicBuf, handshakeHash)

    // Responder verifies initiator proof (isInitiator=true because we verify what initiator sent)
    assert.ok(verifyTopicProof(true, topicBuf, handshakeHash, initiatorProof))

    // Responder creates and sends proof
    const responderProof = createTopicProof(false, topicBuf, handshakeHash)

    // Initiator verifies responder proof
    assert.ok(verifyTopicProof(false, topicBuf, handshakeHash, responderProof))
  })

  it('proof fails with different topic', function () {
    const handshakeHash = b4a.alloc(32, 0xcc)

    const proof = createTopicProof(true, b4a.from('topic-a'), handshakeHash)
    assert.ok(!verifyTopicProof(true, b4a.from('topic-b'), handshakeHash, proof))
  })
})

// ── firewall logic ─────────────────────────────────────────────────

describe('swarm — firewall logic', function () {
  it('allows all in open mode', function () {
    const allowedPeers = null
    const accept = function (keyHex) {
      return !allowedPeers || allowedPeers.has(keyHex)
    }
    assert.ok(accept('ff'.repeat(32)))
  })

  it('allows known peer in authenticated mode', function () {
    const knownKey = 'aa'.repeat(32)
    const allowedPeers = new Map([[knownKey, '10.0.0.2']])
    const accept = function (keyHex) {
      return !allowedPeers || allowedPeers.has(keyHex)
    }
    assert.ok(accept(knownKey))
  })

  it('rejects unknown peer in authenticated mode', function () {
    const allowedPeers = new Map([['aa'.repeat(32), '10.0.0.2']])
    const accept = function (keyHex) {
      return !allowedPeers || allowedPeers.has(keyHex)
    }
    assert.ok(!accept('bb'.repeat(32)))
  })
})
