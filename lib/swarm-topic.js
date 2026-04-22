// Topic discovery key derivation and post-handshake capability proof.
// Uses BLAKE2b (via hypercore-crypto / sodium-universal) to:
// 1. Derive a 32-byte discovery key from a topic string (for DHT announcement)
// 2. Create/verify a capability proof binding the topic to a Noise session

const crypto = require('hypercore-crypto')
const sodium = require('sodium-universal')
const b4a = require('b4a')

const NOSPOON = b4a.from('nospoon')
const TOPIC_NS = crypto.namespace('nospoon/swarm-topic', 2)

// Derive a 32-byte discovery key from a plaintext topic string.
// BLAKE2b([domain, topic]) — the DHT only sees this hash, never the raw topic.
function deriveDiscoveryKey (topic) {
  return crypto.hash([NOSPOON, b4a.from(topic)])
}

// Create a capability proof binding the topic to a specific Noise session.
// Each side sends their proof after the handshake. The peer verifies it to
// confirm both sides know the same topic preimage.
function createTopicProof (isInitiator, topicBuf, handshakeHash) {
  const nsKey = isInitiator ? TOPIC_NS[0] : TOPIC_NS[1]
  const out = b4a.allocUnsafe(32)
  sodium.crypto_generichash(out, b4a.concat([nsKey, topicBuf, handshakeHash]))
  return out
}

function verifyTopicProof (isInitiator, topicBuf, handshakeHash, proof) {
  const expected = createTopicProof(isInitiator, topicBuf, handshakeHash)
  return b4a.equals(proof, expected)
}

module.exports = { deriveDiscoveryKey, createTopicProof, verifyTopicProof }
