const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { createRouter, readDestinationIp, readSourceIp } = require('../lib/routing')

// Helper: build a minimal IPv4 packet header (20 bytes)
// srcIp and dstIp are dotted-quad strings like '10.0.0.1'
function makeIpv4Packet (srcIp, dstIp) {
  const buf = Buffer.alloc(20)
  buf[0] = 0x45 // version=4, IHL=5

  const srcOctets = srcIp.split('.').map(Number)
  const dstOctets = dstIp.split('.').map(Number)

  for (let i = 0; i < 4; i++) {
    buf[12 + i] = srcOctets[i]
    buf[16 + i] = dstOctets[i]
  }

  return buf
}

// Helper: build a minimal IPv6 packet header (40 bytes)
function makeIpv6Packet (srcIp, dstIp) {
  const buf = Buffer.alloc(40)
  buf[0] = 0x60 // version=6

  const srcBytes = ipv6ToBytes(srcIp)
  const dstBytes = ipv6ToBytes(dstIp)

  srcBytes.copy(buf, 8)
  dstBytes.copy(buf, 24)

  return buf
}

function ipv6ToBytes (addr) {
  // Expand :: notation
  const halves = addr.split('::')
  let groups

  if (halves.length === 2) {
    const left = halves[0] ? halves[0].split(':') : []
    const right = halves[1] ? halves[1].split(':') : []
    const missing = 8 - left.length - right.length
    groups = [...left, ...Array(missing).fill('0'), ...right]
  } else {
    groups = addr.split(':')
  }

  const buf = Buffer.alloc(16)
  for (let i = 0; i < 8; i++) {
    const val = parseInt(groups[i] || '0', 16)
    buf[i * 2] = (val >> 8) & 0xff
    buf[i * 2 + 1] = val & 0xff
  }
  return buf
}

describe('readSourceIp', function () {
  it('reads IPv4 source address', function () {
    const pkt = makeIpv4Packet('192.168.1.100', '10.0.0.1')
    assert.equal(readSourceIp(pkt), '192.168.1.100')
  })

  it('reads IPv6 source address', function () {
    const pkt = makeIpv6Packet('fd00::2', 'fd00::1')
    assert.equal(readSourceIp(pkt), 'fd00::2')
  })

  it('returns null for empty buffer', function () {
    assert.equal(readSourceIp(Buffer.alloc(0)), null)
  })

  it('returns null for truncated IPv4 packet', function () {
    assert.equal(readSourceIp(Buffer.alloc(10)), null)
  })
})

describe('readDestinationIp', function () {
  it('reads IPv4 destination address', function () {
    const pkt = makeIpv4Packet('10.0.0.2', '10.0.0.1')
    assert.equal(readDestinationIp(pkt), '10.0.0.1')
  })

  it('reads IPv6 destination address', function () {
    const pkt = makeIpv6Packet('fd00::2', 'fd00::1')
    assert.equal(readDestinationIp(pkt), 'fd00::1')
  })

  it('returns null for unknown version', function () {
    const buf = Buffer.alloc(20)
    buf[0] = 0x35 // version=3
    assert.equal(readDestinationIp(buf), null)
  })
})

describe('createRouter', function () {
  it('adds and retrieves a route', function () {
    const router = createRouter()
    const conn = { remotePublicKey: Buffer.from('aa'.repeat(32), 'hex') }
    router.add('10.0.0.2', conn)
    assert.equal(router.getByIp('10.0.0.2'), conn)
  })

  it('returns undefined for unknown IP', function () {
    const router = createRouter()
    assert.equal(router.getByIp('10.0.0.99'), undefined)
  })

  it('removes a route', function () {
    const router = createRouter()
    const conn = { remotePublicKey: Buffer.from('bb'.repeat(32), 'hex') }
    router.add('10.0.0.3', conn)
    router.remove('10.0.0.3')
    assert.equal(router.getByIp('10.0.0.3'), undefined)
  })

  it('overwrites existing route for same IP', function () {
    const router = createRouter()
    const conn1 = { remotePublicKey: Buffer.from('cc'.repeat(32), 'hex') }
    const conn2 = { remotePublicKey: Buffer.from('dd'.repeat(32), 'hex') }
    router.add('10.0.0.2', conn1)
    router.add('10.0.0.2', conn2)
    assert.equal(router.getByIp('10.0.0.2'), conn2)
  })

  it('tracks active count', function () {
    const router = createRouter()
    const conn1 = { remotePublicKey: Buffer.from('ee'.repeat(32), 'hex') }
    const conn2 = { remotePublicKey: Buffer.from('ff'.repeat(32), 'hex') }
    assert.equal(router.activeCount(), 0)
    router.add('10.0.0.2', conn1)
    assert.equal(router.activeCount(), 1)
    router.add('10.0.0.3', conn2)
    assert.equal(router.activeCount(), 2)
    router.remove('10.0.0.2')
    assert.equal(router.activeCount(), 1)
  })

  it('looks up IP by public key', function () {
    const router = createRouter()
    const keyHex = 'ab'.repeat(32)
    const conn = { remotePublicKey: Buffer.from(keyHex, 'hex') }
    router.add('10.0.0.5', conn)
    assert.equal(router.getIpByKey(keyHex), '10.0.0.5')
  })

  it('returns null for unknown public key', function () {
    const router = createRouter()
    assert.equal(router.getIpByKey('00'.repeat(32)), null)
  })
})
