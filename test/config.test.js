const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const HyperDHT = require('hyperdht')

const { loadConfig } = require('../lib/config')

let tmpDir

beforeEach(function () {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nospoon-test-'))
})

afterEach(function () {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeConfig (filename, content) {
  const filepath = path.join(tmpDir, filename)
  if (typeof content === 'string') {
    fs.writeFileSync(filepath, content)
  } else {
    fs.writeFileSync(filepath, JSON.stringify(content))
  }
  return filepath
}

function writeSeedFile (seed) {
  const filepath = path.join(tmpDir, 'seed')
  fs.writeFileSync(filepath, seed)
  return filepath
}

// Generate a seed + pubkey pair for tests
function genKey (seedHex) {
  const keyPair = HyperDHT.keyPair(Buffer.from(seedHex, 'hex'))
  return keyPair.publicKey.toString('hex')
}

const SEED_A = 'aa'.repeat(32)
const SEED_B = 'bb'.repeat(32)
const SEED_C = 'cc'.repeat(32)
const PUB_A = genKey(SEED_A)
const PUB_B = genKey(SEED_B)
const PUB_C = genKey(SEED_C)

function minimalConfig (overrides) {
  const base = {
    topic: 'test',
    seed: SEED_A,
    peers: { [PUB_A]: '10.0.0.1', [PUB_B]: '10.0.0.2' }
  }
  return Object.assign(base, overrides)
}

// ── topic ──────────────────────────────────────────────────────────

describe('loadConfig — topic', function () {
  it('accepts valid topic', function () {
    const cfg = loadConfig(writeConfig('t.json', minimalConfig()))
    assert.equal(cfg.topic, 'test')
  })

  it('trims whitespace', function () {
    const cfg = loadConfig(writeConfig('t.json', minimalConfig({ topic: '  my-group  ' })))
    assert.equal(cfg.topic, 'my-group')
  })

  it('rejects missing topic', function () {
    assert.throws(function () {
      loadConfig(writeConfig('no.json', { seed: SEED_A, peers: { [PUB_A]: '10.0.0.1', [PUB_B]: '10.0.0.2' } }))
    }, /topic/)
  })

  it('rejects empty string topic', function () {
    assert.throws(function () {
      loadConfig(writeConfig('empty.json', minimalConfig({ topic: '' })))
    }, /topic/)
  })
})

// ── migration errors ───────────────────────────────────────────────

describe('loadConfig — old format migration', function () {
  it('rejects "mode" field', function () {
    assert.throws(function () {
      loadConfig(writeConfig('old.json', { mode: 'server' }))
    }, /no longer supported.*topic/)
  })

  it('rejects "server" field', function () {
    assert.throws(function () {
      loadConfig(writeConfig('old.json', minimalConfig({ server: PUB_A })))
    }, /no longer supported/)
  })

  it('rejects "fullTunnel" field', function () {
    assert.throws(function () {
      loadConfig(writeConfig('old.json', minimalConfig({ fullTunnel: true })))
    }, /no longer supported.*exitNode/)
  })
})

// ── seed (required) ─────────────────────────────────────────────────

describe('loadConfig — seed', function () {
  it('requires seed', function () {
    assert.throws(function () {
      loadConfig(writeConfig('no.json', { topic: 'test', peers: { [PUB_A]: '10.0.0.1', [PUB_B]: '10.0.0.2' } }))
    }, /seed.*required/)
  })

  it('accepts inline seed', function () {
    const cfg = loadConfig(writeConfig('t.json', minimalConfig()))
    assert.equal(cfg.seed, SEED_A)
  })

  it('accepts seedFile', function () {
    const seedPath = writeSeedFile(SEED_A)
    const cfg = loadConfig(writeConfig('t.json', minimalConfig({ seed: undefined, seedFile: seedPath })))
    assert.equal(cfg.seed, SEED_A)
  })

  it('trims whitespace from seedFile', function () {
    const seedPath = writeSeedFile('  ' + SEED_A + '\n')
    const cfg = loadConfig(writeConfig('t.json', minimalConfig({ seed: undefined, seedFile: seedPath })))
    assert.equal(cfg.seed, SEED_A)
  })

  it('rejects both seed and seedFile', function () {
    const seedPath = writeSeedFile(SEED_A)
    assert.throws(function () {
      loadConfig(writeConfig('both.json', minimalConfig({ seedFile: seedPath })))
    }, /mutually exclusive/)
  })

  it('rejects invalid seed hex', function () {
    assert.throws(function () {
      loadConfig(writeConfig('bad.json', minimalConfig({ seed: 'tooshort' })))
    }, /seed/)
  })
})

// ── peers (required, includes self) ─────────────────────────────────

describe('loadConfig — peers', function () {
  it('requires peers', function () {
    assert.throws(function () {
      loadConfig(writeConfig('no.json', { topic: 'test', seed: SEED_A }))
    }, /peers.*required/)
  })

  it('requires at least 2 peers', function () {
    assert.throws(function () {
      loadConfig(writeConfig('one.json', { topic: 'test', seed: SEED_A, peers: { [PUB_A]: '10.0.0.1' } }))
    }, /at least 2/)
  })

  it('requires own pubkey in peers', function () {
    assert.throws(function () {
      loadConfig(writeConfig('no-self.json', { topic: 'test', seed: SEED_A, peers: { [PUB_B]: '10.0.0.2', [PUB_C]: '10.0.0.3' } }))
    }, /Own public key not found/)
  })

  it('derives own IP from peers map', function () {
    const cfg = loadConfig(writeConfig('t.json', minimalConfig()))
    assert.equal(cfg.ip, '10.0.0.1/24')
  })

  it('loads peers as Map', function () {
    const cfg = loadConfig(writeConfig('t.json', minimalConfig()))
    assert.ok(cfg.peers instanceof Map)
    assert.equal(cfg.peers.size, 2)
  })

  it('rejects duplicate IP', function () {
    assert.throws(function () {
      loadConfig(writeConfig('dup.json', minimalConfig({ peers: { [PUB_A]: '10.0.0.1', [PUB_B]: '10.0.0.1' } })))
    }, /Duplicate/)
  })

  it('rejects peers not in same subnet', function () {
    assert.throws(function () {
      loadConfig(writeConfig('out.json', minimalConfig({ peers: { [PUB_A]: '10.0.0.1', [PUB_B]: '192.168.1.5' } })))
    }, /not in subnet/)
  })

  it('rejects broadcast address', function () {
    assert.throws(function () {
      loadConfig(writeConfig('bcast.json', minimalConfig({ peers: { [PUB_A]: '10.0.0.1', [PUB_B]: '10.0.0.255' } })))
    }, /broadcast/)
  })

  it('rejects network address', function () {
    assert.throws(function () {
      loadConfig(writeConfig('net.json', minimalConfig({ peers: { [PUB_A]: '10.0.0.1', [PUB_B]: '10.0.0.0' } })))
    }, /network address/)
  })

  it('rejects loopback', function () {
    assert.throws(function () {
      loadConfig(writeConfig('lo.json', minimalConfig({ peers: { [PUB_A]: '10.0.0.1', [PUB_B]: '127.0.0.1' } })))
    }, /loopback/)
  })

  it('accepts 3 peers', function () {
    const cfg = loadConfig(writeConfig('t.json', minimalConfig({
      peers: { [PUB_A]: '10.0.0.1', [PUB_B]: '10.0.0.2', [PUB_C]: '10.0.0.3' }
    })))
    assert.equal(cfg.peers.size, 3)
  })
})

// ── prefix ──────────────────────────────────────────────────────────

describe('loadConfig — prefix', function () {
  it('defaults to /24', function () {
    const cfg = loadConfig(writeConfig('t.json', minimalConfig()))
    assert.equal(cfg.prefix, 24)
    assert.ok(cfg.ip.endsWith('/24'))
  })

  it('accepts custom prefix', function () {
    const cfg = loadConfig(writeConfig('t.json', minimalConfig({
      prefix: 16,
      peers: { [PUB_A]: '10.0.0.1', [PUB_B]: '10.0.1.2' }
    })))
    assert.equal(cfg.prefix, 16)
    assert.equal(cfg.ip, '10.0.0.1/16')
  })

  it('rejects prefix > 30', function () {
    assert.throws(function () {
      loadConfig(writeConfig('bad.json', minimalConfig({ prefix: 31 })))
    }, /prefix/)
  })
})

// ── mtu ─────────────────────────────────────────────────────────────

describe('loadConfig — mtu', function () {
  it('defaults to 1400', function () {
    const cfg = loadConfig(writeConfig('t.json', minimalConfig()))
    assert.equal(cfg.mtu, 1400)
  })

  it('accepts custom mtu', function () {
    const cfg = loadConfig(writeConfig('t.json', minimalConfig({ mtu: 1200 })))
    assert.equal(cfg.mtu, 1200)
  })

  it('rejects mtu below 576', function () {
    assert.throws(function () {
      loadConfig(writeConfig('bad.json', minimalConfig({ mtu: 500 })))
    }, /MTU/)
  })
})

// ── exitNode / exitVia ──────────────────────────────────────────────

describe('loadConfig — exitNode / exitVia', function () {
  it('exitNode defaults to false', function () {
    const cfg = loadConfig(writeConfig('t.json', minimalConfig()))
    assert.equal(cfg.exitNode, false)
  })

  it('accepts exitNode true', function () {
    const cfg = loadConfig(writeConfig('t.json', minimalConfig({ exitNode: true })))
    assert.equal(cfg.exitNode, true)
  })

  it('accepts exitVia pointing to a peer', function () {
    const cfg = loadConfig(writeConfig('t.json', minimalConfig({ exitVia: '10.0.0.2' })))
    assert.equal(cfg.exitVia, '10.0.0.2')
  })

  it('rejects exitVia not in peers map', function () {
    assert.throws(function () {
      loadConfig(writeConfig('bad.json', minimalConfig({ exitVia: '10.0.0.99' })))
    }, /peers map/)
  })

  it('rejects exitVia pointing to own IP', function () {
    assert.throws(function () {
      loadConfig(writeConfig('bad.json', minimalConfig({ exitVia: '10.0.0.1' })))
    }, /own IP/)
  })

  it('rejects exitNode + exitVia together', function () {
    assert.throws(function () {
      loadConfig(writeConfig('bad.json', minimalConfig({ exitNode: true, exitVia: '10.0.0.2' })))
    }, /mutually exclusive/)
  })
})

// ── JSONC comments ──────────────────────────────────────────────────

describe('loadConfig — JSONC comments', function () {
  it('strips line comments', function () {
    const jsonc = `{
      // this is a comment
      "topic": "test",
      "seed": "${SEED_A}",
      "peers": { "${PUB_A}": "10.0.0.1", "${PUB_B}": "10.0.0.2" }
    }`
    const cfg = loadConfig(writeConfig('comments.jsonc', jsonc))
    assert.equal(cfg.topic, 'test')
  })
})

// ── file errors ─────────────────────────────────────────────────────

describe('loadConfig — file errors', function () {
  it('throws on missing file', function () {
    assert.throws(function () {
      loadConfig('/tmp/nonexistent-nospoon-config.json')
    }, /Cannot read config file/)
  })

  it('throws on invalid JSON', function () {
    const filepath = path.join(tmpDir, 'broken.json')
    fs.writeFileSync(filepath, '{not json}')
    assert.throws(function () {
      loadConfig(filepath)
    }, /Invalid JSON/)
  })
})

// ── full config ────────────────────────────────────────────────────

describe('loadConfig — full config', function () {
  it('parses all fields together', function () {
    const cfg = loadConfig(writeConfig('full.json', {
      topic: 'my-mesh',
      seed: SEED_A,
      prefix: 16,
      ipv6: 'fd00::1/64',
      mtu: 1200,
      exitNode: true,
      outInterface: 'eth0',
      peers: { [PUB_A]: '10.0.0.1', [PUB_B]: '10.0.1.2', [PUB_C]: '10.0.2.3' }
    }))
    assert.equal(cfg.topic, 'my-mesh')
    assert.equal(cfg.ip, '10.0.0.1/16')
    assert.equal(cfg.ipv6, 'fd00::1/64')
    assert.equal(cfg.seed, SEED_A)
    assert.equal(cfg.mtu, 1200)
    assert.equal(cfg.exitNode, true)
    assert.equal(cfg.outInterface, 'eth0')
    assert.equal(cfg.peers.size, 3)
  })
})
