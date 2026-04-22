const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { deriveDiscoveryKey, createTopicProof, verifyTopicProof } = require('../lib/swarm-topic')
const b4a = require('b4a')

describe('deriveDiscoveryKey', function () {
  it('returns a 32-byte buffer', function () {
    const key = deriveDiscoveryKey('test-topic')
    assert.equal(key.length, 32)
    assert.ok(Buffer.isBuffer(key) || b4a.isBuffer(key))
  })

  it('is deterministic', function () {
    const a = deriveDiscoveryKey('same-topic')
    const b = deriveDiscoveryKey('same-topic')
    assert.ok(b4a.equals(a, b))
  })

  it('different topics produce different keys', function () {
    const a = deriveDiscoveryKey('topic-one')
    const b = deriveDiscoveryKey('topic-two')
    assert.ok(!b4a.equals(a, b))
  })

  it('handles long topic strings', function () {
    const key = deriveDiscoveryKey('a'.repeat(1000))
    assert.equal(key.length, 32)
  })

  it('handles unicode topics', function () {
    const key = deriveDiscoveryKey('ελληνικά-topic')
    assert.equal(key.length, 32)
  })
})

describe('createTopicProof / verifyTopicProof', function () {
  const topicBuf = b4a.from('test-topic')
  const handshakeHash = b4a.alloc(32, 0xaa)

  it('returns a 32-byte proof', function () {
    const proof = createTopicProof(true, topicBuf, handshakeHash)
    assert.equal(proof.length, 32)
  })

  it('verifies a correct initiator proof', function () {
    const proof = createTopicProof(true, topicBuf, handshakeHash)
    assert.ok(verifyTopicProof(true, topicBuf, handshakeHash, proof))
  })

  it('verifies a correct responder proof', function () {
    const proof = createTopicProof(false, topicBuf, handshakeHash)
    assert.ok(verifyTopicProof(false, topicBuf, handshakeHash, proof))
  })

  it('initiator and responder proofs differ', function () {
    const initiator = createTopicProof(true, topicBuf, handshakeHash)
    const responder = createTopicProof(false, topicBuf, handshakeHash)
    assert.ok(!b4a.equals(initiator, responder))
  })

  it('rejects proof with wrong topic', function () {
    const proof = createTopicProof(true, topicBuf, handshakeHash)
    const wrongTopic = b4a.from('wrong-topic')
    assert.ok(!verifyTopicProof(true, wrongTopic, handshakeHash, proof))
  })

  it('rejects proof with wrong handshake hash', function () {
    const proof = createTopicProof(true, topicBuf, handshakeHash)
    const wrongHash = b4a.alloc(32, 0xbb)
    assert.ok(!verifyTopicProof(true, topicBuf, wrongHash, proof))
  })

  it('rejects initiator proof verified as responder', function () {
    const proof = createTopicProof(true, topicBuf, handshakeHash)
    assert.ok(!verifyTopicProof(false, topicBuf, handshakeHash, proof))
  })
})
