const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { encode, createDecoder } = require('../lib/framing')

describe('encode', function () {
  it('prepends 4-byte big-endian length header', function () {
    const payload = Buffer.from('hello')
    const framed = encode(payload)
    assert.equal(framed.length, 4 + 5)
    assert.equal(framed.readUInt32BE(0), 5)
    assert.deepEqual(framed.subarray(4), payload)
  })

  it('handles empty payload', function () {
    const framed = encode(Buffer.alloc(0))
    assert.equal(framed.length, 4)
    assert.equal(framed.readUInt32BE(0), 0)
  })
})

describe('createDecoder', function () {
  it('decodes a single complete frame', function () {
    const packets = []
    const decode = createDecoder(function (pkt) { packets.push(Buffer.from(pkt)) })

    const payload = Buffer.from('test packet')
    decode(encode(payload))

    assert.equal(packets.length, 1)
    assert.deepEqual(packets[0], payload)
  })

  it('decodes multiple frames in one chunk', function () {
    const packets = []
    const decode = createDecoder(function (pkt) { packets.push(Buffer.from(pkt)) })

    const p1 = Buffer.from('first')
    const p2 = Buffer.from('second')
    const combined = Buffer.concat([encode(p1), encode(p2)])
    decode(combined)

    assert.equal(packets.length, 2)
    assert.deepEqual(packets[0], p1)
    assert.deepEqual(packets[1], p2)
  })

  it('handles split frames across chunks', function () {
    const packets = []
    const decode = createDecoder(function (pkt) { packets.push(Buffer.from(pkt)) })

    const framed = encode(Buffer.from('split me'))
    // Split in the middle
    const mid = Math.floor(framed.length / 2)
    decode(framed.subarray(0, mid))
    assert.equal(packets.length, 0)
    decode(framed.subarray(mid))
    assert.equal(packets.length, 1)
    assert.deepEqual(packets[0], Buffer.from('split me'))
  })

  it('handles header split across chunks', function () {
    const packets = []
    const decode = createDecoder(function (pkt) { packets.push(Buffer.from(pkt)) })

    const framed = encode(Buffer.from('header split'))
    // Split in the middle of the 4-byte header
    decode(framed.subarray(0, 2))
    assert.equal(packets.length, 0)
    decode(framed.subarray(2))
    assert.equal(packets.length, 1)
  })

  it('ignores zero-length frames (keepalives)', function () {
    const packets = []
    const decode = createDecoder(function (pkt) { packets.push(Buffer.from(pkt)) })

    const keepalive = Buffer.alloc(4, 0) // length = 0
    const real = encode(Buffer.from('real'))
    decode(Buffer.concat([keepalive, real]))

    assert.equal(packets.length, 1)
    assert.deepEqual(packets[0], Buffer.from('real'))
  })

  it('resets on oversized frame length (>65535)', function () {
    const packets = []
    const decode = createDecoder(function (pkt) { packets.push(Buffer.from(pkt)) })

    // Frame claiming 100000 bytes
    const bad = Buffer.alloc(4)
    bad.writeUInt32BE(100000, 0)
    decode(bad)

    // Should recover — next valid frame works
    decode(encode(Buffer.from('after bad')))
    assert.equal(packets.length, 1)
    assert.deepEqual(packets[0], Buffer.from('after bad'))
  })

  it('handles keepalive flood (1000 zero-length frames)', function () {
    const packets = []
    const decode = createDecoder(function (pkt) { packets.push(pkt) })

    const keepalive = Buffer.alloc(4, 0)
    const flood = Buffer.concat(Array(1000).fill(keepalive))
    decode(flood)

    // Zero-length frames are silently ignored — no packets emitted
    assert.equal(packets.length, 0)
  })

  it('handles rapid alternation of valid and invalid frame lengths', function () {
    const packets = []
    const decode = createDecoder(function (pkt) { packets.push(Buffer.from(pkt)) })

    for (let i = 0; i < 100; i++) {
      // Invalid: length > 65535
      const bad = Buffer.alloc(4)
      bad.writeUInt32BE(70000, 0)
      decode(bad)

      // Valid frame right after
      decode(encode(Buffer.from('ok')))
    }

    // Every valid frame after a reset should still be decoded
    assert.equal(packets.length, 100)
    for (const pkt of packets) {
      assert.deepEqual(pkt, Buffer.from('ok'))
    }
  })

  it('handles incomplete frame that never finishes (stale buffer)', function () {
    const packets = []
    const decode = createDecoder(function (pkt) { packets.push(Buffer.from(pkt)) })

    // Header claiming 1000 bytes, but only send 500
    const header = Buffer.alloc(4)
    header.writeUInt32BE(1000, 0)
    decode(Buffer.concat([header, Buffer.alloc(500)]))
    assert.equal(packets.length, 0) // waiting for remaining 500 bytes

    // Send a completely new valid frame after the stale data
    // The decoder is still waiting for the original 1000-byte frame
    // so the new data just extends the buffer
    decode(Buffer.alloc(500)) // now the 1000-byte frame completes
    assert.equal(packets.length, 1) // the 1000-byte payload is emitted

    // Next valid frame works normally
    decode(encode(Buffer.from('after stale')))
    assert.equal(packets.length, 2)
  })

  it('calls overflow callback when buffer exceeds 256KB', function () {
    let overflowed = false
    const decode = createDecoder(
      function () {},
      function () { overflowed = true }
    )

    // Feed many small valid frames followed by a large incomplete frame.
    // The incomplete frame's header claims 65535 bytes, but we only
    // trickle in 1-byte chunks so it never completes. Meanwhile the
    // buffer grows past MAX_BUFFER_SIZE (256KB).
    //
    // Strategy: one big chunk that contains a header claiming 65535 bytes
    // plus enough padding to push total buffer past 256KB in one shot.
    const maxBuf = 256 * 1024 // 262144
    const header = Buffer.alloc(4)
    header.writeUInt32BE(65535, 0)
    // Send header + (maxBuf + 1) bytes of "payload" — but the frame
    // needs 65535 bytes, and we send way more, so the frame completes.
    // Instead: send the whole thing as one blob > 256KB.
    // The overflow check runs BEFORE frame parsing, so a single chunk
    // larger than 256KB triggers it immediately.
    decode(Buffer.alloc(maxBuf + 1))

    assert.equal(overflowed, true)
  })
})
