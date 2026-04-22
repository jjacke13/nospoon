const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')

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

const VALID_SEED = 'ab'.repeat(32)
const VALID_KEY = 'cd'.repeat(32)
const VALID_KEY2 = 'ef'.repeat(32)

// ── topic ──────────────────────────────────────────────────────────

describe('loadConfig — topic', function () {
  it('accepts valid topic', function () {
    const cfg = loadConfig(writeConfig('t.json', { topic: 'my-group' }))
    assert.equal(cfg.topic, 'my-group')
  })

  it('trims whitespace', function () {
    const cfg = loadConfig(writeConfig('t.json', { topic: '  my-group  ' }))
    assert.equal(cfg.topic, 'my-group')
  })

  it('rejects missing topic', function () {
    assert.throws(function () {
      loadConfig(writeConfig('no.json', {}))
    }, /topic/)
  })

  it('rejects empty string topic', function () {
    assert.throws(function () {
      loadConfig(writeConfig('empty.json', { topic: '' }))
    }, /topic/)
  })

  it('rejects whitespace-only topic', function () {
    assert.throws(function () {
      loadConfig(writeConfig('ws.json', { topic: '   ' }))
    }, /topic/)
  })

  it('rejects non-string topic', function () {
    assert.throws(function () {
      loadConfig(writeConfig('num.json', { topic: 123 }))
    }, /topic/)
  })
})

// ── migration errors ───────────────────────────────────────────────

describe('loadConfig — old format migration', function () {
  it('rejects "mode" field with migration message', function () {
    assert.throws(function () {
      loadConfig(writeConfig('old.json', { mode: 'server' }))
    }, /no longer supported.*topic/)
  })

  it('rejects "server" field with migration message', function () {
    assert.throws(function () {
      loadConfig(writeConfig('old.json', { topic: 'x', server: VALID_KEY }))
    }, /no longer supported/)
  })

  it('rejects "fullTunnel" field with migration message', function () {
    assert.throws(function () {
      loadConfig(writeConfig('old.json', { topic: 'x', fullTunnel: true }))
    }, /no longer supported.*exitNode/)
  })
})

// ── ip ──────────────────────────────────────────────────────────────

describe('loadConfig — ip', function () {
  it('defaults to 10.0.0.1/24', function () {
    const cfg = loadConfig(writeConfig('t.json', { topic: 'test' }))
    assert.equal(cfg.ip, '10.0.0.1/24')
  })

  it('accepts custom ip', function () {
    const cfg = loadConfig(writeConfig('t.json', { topic: 'test', ip: '172.16.0.1/16' }))
    assert.equal(cfg.ip, '172.16.0.1/16')
  })

  it('rejects invalid ip', function () {
    assert.throws(function () {
      loadConfig(writeConfig('bad.json', { topic: 'test', ip: 'not-cidr' }))
    }, /ip/)
  })
})

// ── ipv6 ────────────────────────────────────────────────────────────

describe('loadConfig — ipv6', function () {
  it('omitted by default', function () {
    const cfg = loadConfig(writeConfig('t.json', { topic: 'test' }))
    assert.equal(cfg.ipv6, undefined)
  })

  it('accepts valid IPv6 CIDR', function () {
    const cfg = loadConfig(writeConfig('t.json', { topic: 'test', ipv6: 'fd00::1/64' }))
    assert.equal(cfg.ipv6, 'fd00::1/64')
  })

  it('rejects invalid IPv6', function () {
    assert.throws(function () {
      loadConfig(writeConfig('bad.json', { topic: 'test', ipv6: 'not-ipv6' }))
    }, /ipv6/)
  })
})

// ── seed / seedFile ─────────────────────────────────────────────────

describe('loadConfig — seed', function () {
  it('accepts inline seed', function () {
    const cfg = loadConfig(writeConfig('t.json', { topic: 'test', seed: VALID_SEED }))
    assert.equal(cfg.seed, VALID_SEED)
  })

  it('accepts seedFile', function () {
    const seedPath = writeSeedFile(VALID_SEED)
    const cfg = loadConfig(writeConfig('t.json', { topic: 'test', seedFile: seedPath }))
    assert.equal(cfg.seed, VALID_SEED)
  })

  it('trims whitespace from seedFile', function () {
    const seedPath = writeSeedFile('  ' + VALID_SEED + '\n')
    const cfg = loadConfig(writeConfig('t.json', { topic: 'test', seedFile: seedPath }))
    assert.equal(cfg.seed, VALID_SEED)
  })

  it('rejects both seed and seedFile', function () {
    const seedPath = writeSeedFile(VALID_SEED)
    assert.throws(function () {
      loadConfig(writeConfig('both.json', { topic: 'test', seed: VALID_SEED, seedFile: seedPath }))
    }, /mutually exclusive/)
  })

  it('rejects invalid seed hex', function () {
    assert.throws(function () {
      loadConfig(writeConfig('bad.json', { topic: 'test', seed: 'tooshort' }))
    }, /seed/)
  })

  it('rejects missing seedFile', function () {
    assert.throws(function () {
      loadConfig(writeConfig('bad.json', { topic: 'test', seedFile: '/tmp/nonexistent-nospoon-seed' }))
    }, /Cannot read seed file/)
  })

  it('rejects seedFile with invalid content', function () {
    const seedPath = writeSeedFile('not-hex-at-all')
    assert.throws(function () {
      loadConfig(writeConfig('bad.json', { topic: 'test', seedFile: seedPath }))
    }, /seedFile content/)
  })

  it('omitted seed is undefined (persistent identity used at runtime)', function () {
    const cfg = loadConfig(writeConfig('t.json', { topic: 'test' }))
    assert.equal(cfg.seed, undefined)
  })
})

// ── mtu ─────────────────────────────────────────────────────────────

describe('loadConfig — mtu', function () {
  it('defaults to 1400', function () {
    const cfg = loadConfig(writeConfig('t.json', { topic: 'test' }))
    assert.equal(cfg.mtu, 1400)
  })

  it('accepts custom mtu', function () {
    const cfg = loadConfig(writeConfig('t.json', { topic: 'test', mtu: 1200 }))
    assert.equal(cfg.mtu, 1200)
  })

  it('rejects mtu below 576', function () {
    assert.throws(function () {
      loadConfig(writeConfig('bad.json', { topic: 'test', mtu: 500 }))
    }, /MTU/)
  })

  it('rejects mtu above 65535', function () {
    assert.throws(function () {
      loadConfig(writeConfig('bad.json', { topic: 'test', mtu: 70000 }))
    }, /MTU/)
  })
})

// ── exitNode / exitVia ──────────────────────────────────────────────

describe('loadConfig — exitNode / exitVia', function () {
  it('exitNode defaults to false', function () {
    const cfg = loadConfig(writeConfig('t.json', { topic: 'test' }))
    assert.equal(cfg.exitNode, false)
  })

  it('accepts exitNode true', function () {
    const cfg = loadConfig(writeConfig('t.json', { topic: 'test', exitNode: true }))
    assert.equal(cfg.exitNode, true)
  })

  it('accepts exitVia within subnet', function () {
    const cfg = loadConfig(writeConfig('t.json', { topic: 'test', ip: '10.0.0.2/24', exitVia: '10.0.0.1' }))
    assert.equal(cfg.exitVia, '10.0.0.1')
  })

  it('rejects exitVia outside subnet', function () {
    assert.throws(function () {
      loadConfig(writeConfig('bad.json', { topic: 'test', ip: '10.0.0.2/24', exitVia: '192.168.1.1' }))
    }, /not in the configured subnet/)
  })

  it('rejects exitVia pointing to own IP', function () {
    assert.throws(function () {
      loadConfig(writeConfig('bad.json', { topic: 'test', ip: '10.0.0.1/24', exitVia: '10.0.0.1' }))
    }, /own IP/)
  })

  it('rejects exitVia with invalid IP', function () {
    assert.throws(function () {
      loadConfig(writeConfig('bad.json', { topic: 'test', exitVia: 'not-an-ip' }))
    }, /exitVia/)
  })

  it('rejects exitNode + exitVia together', function () {
    assert.throws(function () {
      loadConfig(writeConfig('bad.json', { topic: 'test', ip: '10.0.0.2/24', exitNode: true, exitVia: '10.0.0.1' }))
    }, /mutually exclusive/)
  })
})

// ── outInterface ───────────────────────────────────────────────────

describe('loadConfig — outInterface', function () {
  it('omitted by default', function () {
    const cfg = loadConfig(writeConfig('t.json', { topic: 'test' }))
    assert.equal(cfg.outInterface, undefined)
  })

  it('accepts outInterface', function () {
    const cfg = loadConfig(writeConfig('t.json', { topic: 'test', outInterface: 'eth0' }))
    assert.equal(cfg.outInterface, 'eth0')
  })
})

// ── peers ──────────────────────────────────────────────────────────

describe('loadConfig — peers', function () {
  it('open mode when peers omitted', function () {
    const cfg = loadConfig(writeConfig('t.json', { topic: 'test' }))
    assert.equal(cfg.peers, undefined)
  })

  it('loads valid peers as Map', function () {
    const cfg = loadConfig(writeConfig('t.json', {
      topic: 'test',
      peers: { [VALID_KEY]: '10.0.0.2', [VALID_KEY2]: '10.0.0.3' }
    }))
    assert.ok(cfg.peers instanceof Map)
    assert.equal(cfg.peers.size, 2)
    assert.equal(cfg.peers.get(VALID_KEY), '10.0.0.2')
    assert.equal(cfg.peers.get(VALID_KEY2), '10.0.0.3')
  })

  it('rejects duplicate IP in peers', function () {
    assert.throws(function () {
      loadConfig(writeConfig('dup.json', {
        topic: 'test',
        peers: { [VALID_KEY]: '10.0.0.2', [VALID_KEY2]: '10.0.0.2' }
      }))
    }, /Duplicate/)
  })

  it('rejects peer IP outside subnet', function () {
    assert.throws(function () {
      loadConfig(writeConfig('outside.json', {
        topic: 'test',
        ip: '10.0.0.1/24',
        peers: { [VALID_KEY]: '192.168.1.5' }
      }))
    }, /not in subnet/)
  })

  it('rejects peer with own IP', function () {
    assert.throws(function () {
      loadConfig(writeConfig('self.json', {
        topic: 'test',
        ip: '10.0.0.1/24',
        peers: { [VALID_KEY]: '10.0.0.1' }
      }))
    }, /conflicts with own/)
  })

  it('rejects broadcast address', function () {
    assert.throws(function () {
      loadConfig(writeConfig('bcast.json', {
        topic: 'test',
        ip: '10.0.0.1/24',
        peers: { [VALID_KEY]: '10.0.0.255' }
      }))
    }, /broadcast/)
  })

  it('rejects network address', function () {
    assert.throws(function () {
      loadConfig(writeConfig('net.json', {
        topic: 'test',
        ip: '10.0.0.1/24',
        peers: { [VALID_KEY]: '10.0.0.0' }
      }))
    }, /network address/)
  })

  it('rejects loopback address', function () {
    assert.throws(function () {
      loadConfig(writeConfig('lo.json', {
        topic: 'test',
        peers: { [VALID_KEY]: '127.0.0.1' }
      }))
    }, /loopback/)
  })

  it('rejects 0.0.0.0', function () {
    assert.throws(function () {
      loadConfig(writeConfig('zero.json', {
        topic: 'test',
        peers: { [VALID_KEY]: '0.0.0.0' }
      }))
    }, /0\.0\.0\.0/)
  })

  it('rejects invalid peer key', function () {
    assert.throws(function () {
      loadConfig(writeConfig('badkey.json', {
        topic: 'test',
        peers: { 'not-a-hex-key': '10.0.0.2' }
      }))
    }, /peer key/)
  })

  it('rejects invalid peer IP', function () {
    assert.throws(function () {
      loadConfig(writeConfig('badip.json', {
        topic: 'test',
        peers: { [VALID_KEY]: 'not-an-ip' }
      }))
    }, /Invalid IP/)
  })

  it('accepts IPv6 peer address', function () {
    const cfg = loadConfig(writeConfig('v6.json', {
      topic: 'test',
      peers: { [VALID_KEY]: 'fd00::2' }
    }))
    assert.equal(cfg.peers.get(VALID_KEY), 'fd00::2')
  })

  it('accepts peer at top of range', function () {
    const cfg = loadConfig(writeConfig('top.json', {
      topic: 'test',
      ip: '10.0.0.1/24',
      peers: { [VALID_KEY]: '10.0.0.254' }
    }))
    assert.equal(cfg.peers.get(VALID_KEY), '10.0.0.254')
  })

  it('skips empty peers object (open mode)', function () {
    const cfg = loadConfig(writeConfig('empty.json', {
      topic: 'test',
      peers: {}
    }))
    assert.equal(cfg.peers, undefined)
  })
})

// ── JSONC comment stripping ─────────────────────────────────────────

describe('loadConfig — JSONC comments', function () {
  it('strips line comments', function () {
    const jsonc = `{
      // this is a comment
      "topic": "test"
    }`
    const cfg = loadConfig(writeConfig('comments.jsonc', jsonc))
    assert.equal(cfg.topic, 'test')
  })

  it('does not strip // inside strings', function () {
    const jsonc = `{
      "topic": "test",
      "outInterface": "eth0"
    }`
    const cfg = loadConfig(writeConfig('str.jsonc', jsonc))
    assert.equal(cfg.outInterface, 'eth0')
  })

  it('handles inline comments after values', function () {
    const jsonc = `{
      "topic": "test", // the topic
      "mtu": 1200 // custom mtu
    }`
    const cfg = loadConfig(writeConfig('inline.jsonc', jsonc))
    assert.equal(cfg.topic, 'test')
    assert.equal(cfg.mtu, 1200)
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
    const seedPath = writeSeedFile(VALID_SEED)
    const cfg = loadConfig(writeConfig('full.json', {
      topic: 'my-mesh',
      ip: '172.16.0.1/16',
      ipv6: 'fd00::1/64',
      seedFile: seedPath,
      mtu: 1200,
      exitNode: true,
      outInterface: 'eth0',
      peers: { [VALID_KEY]: '172.16.0.2' }
    }))
    assert.equal(cfg.topic, 'my-mesh')
    assert.equal(cfg.ip, '172.16.0.1/16')
    assert.equal(cfg.ipv6, 'fd00::1/64')
    assert.equal(cfg.seed, VALID_SEED)
    assert.equal(cfg.mtu, 1200)
    assert.equal(cfg.exitNode, true)
    assert.equal(cfg.outInterface, 'eth0')
    assert.equal(cfg.peers.get(VALID_KEY), '172.16.0.2')
  })

  it('parses exit-via config', function () {
    const cfg = loadConfig(writeConfig('exit.json', {
      topic: 'my-mesh',
      ip: '172.16.0.2/16',
      exitVia: '172.16.0.1',
      seed: VALID_SEED
    }))
    assert.equal(cfg.topic, 'my-mesh')
    assert.equal(cfg.ip, '172.16.0.2/16')
    assert.equal(cfg.exitVia, '172.16.0.1')
    assert.equal(cfg.exitNode, false)
    assert.equal(cfg.seed, VALID_SEED)
  })
})
