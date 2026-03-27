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

// ── mode ────────────────────────────────────────────────────────────

describe('loadConfig — mode', function () {
  it('accepts "server"', function () {
    const cfg = loadConfig(writeConfig('s.json', { mode: 'server' }))
    assert.equal(cfg.mode, 'server')
  })

  it('accepts "client" with server key', function () {
    const cfg = loadConfig(writeConfig('c.json', { mode: 'client', server: VALID_KEY }))
    assert.equal(cfg.mode, 'client')
  })

  it('rejects missing mode', function () {
    assert.throws(function () {
      loadConfig(writeConfig('no-mode.json', {}))
    }, /mode/)
  })

  it('rejects invalid mode', function () {
    assert.throws(function () {
      loadConfig(writeConfig('bad-mode.json', { mode: 'relay' }))
    }, /mode/)
  })
})

// ── ip ──────────────────────────────────────────────────────────────

describe('loadConfig — ip', function () {
  it('defaults to 10.0.0.1/24 for server', function () {
    const cfg = loadConfig(writeConfig('s.json', { mode: 'server' }))
    assert.equal(cfg.ip, '10.0.0.1/24')
  })

  it('defaults to 10.0.0.2/24 for client', function () {
    const cfg = loadConfig(writeConfig('c.json', { mode: 'client', server: VALID_KEY }))
    assert.equal(cfg.ip, '10.0.0.2/24')
  })

  it('accepts custom ip', function () {
    const cfg = loadConfig(writeConfig('s.json', { mode: 'server', ip: '172.16.0.1/16' }))
    assert.equal(cfg.ip, '172.16.0.1/16')
  })

  it('rejects invalid ip', function () {
    assert.throws(function () {
      loadConfig(writeConfig('bad.json', { mode: 'server', ip: 'not-cidr' }))
    }, /ip/)
  })
})

// ── ipv6 ────────────────────────────────────────────────────────────

describe('loadConfig — ipv6', function () {
  it('omitted by default', function () {
    const cfg = loadConfig(writeConfig('s.json', { mode: 'server' }))
    assert.equal(cfg.ipv6, undefined)
  })

  it('accepts valid IPv6 CIDR', function () {
    const cfg = loadConfig(writeConfig('s.json', { mode: 'server', ipv6: 'fd00::1/64' }))
    assert.equal(cfg.ipv6, 'fd00::1/64')
  })

  it('rejects invalid IPv6', function () {
    assert.throws(function () {
      loadConfig(writeConfig('bad.json', { mode: 'server', ipv6: 'not-ipv6' }))
    }, /ipv6/)
  })
})

// ── seed / seedFile ─────────────────────────────────────────────────

describe('loadConfig — seed', function () {
  it('accepts inline seed', function () {
    const cfg = loadConfig(writeConfig('s.json', { mode: 'server', seed: VALID_SEED }))
    assert.equal(cfg.seed, VALID_SEED)
  })

  it('accepts seedFile', function () {
    const seedPath = writeSeedFile(VALID_SEED)
    const cfg = loadConfig(writeConfig('s.json', { mode: 'server', seedFile: seedPath }))
    assert.equal(cfg.seed, VALID_SEED)
  })

  it('trims whitespace from seedFile', function () {
    const seedPath = writeSeedFile('  ' + VALID_SEED + '\n')
    const cfg = loadConfig(writeConfig('s.json', { mode: 'server', seedFile: seedPath }))
    assert.equal(cfg.seed, VALID_SEED)
  })

  it('rejects both seed and seedFile', function () {
    const seedPath = writeSeedFile(VALID_SEED)
    assert.throws(function () {
      loadConfig(writeConfig('both.json', { mode: 'server', seed: VALID_SEED, seedFile: seedPath }))
    }, /mutually exclusive/)
  })

  it('rejects invalid seed hex', function () {
    assert.throws(function () {
      loadConfig(writeConfig('bad.json', { mode: 'server', seed: 'tooshort' }))
    }, /seed/)
  })

  it('rejects missing seedFile', function () {
    assert.throws(function () {
      loadConfig(writeConfig('bad.json', { mode: 'server', seedFile: '/tmp/nonexistent-nospoon-seed' }))
    }, /Cannot read seed file/)
  })

  it('rejects seedFile with invalid content', function () {
    const seedPath = writeSeedFile('not-hex-at-all')
    assert.throws(function () {
      loadConfig(writeConfig('bad.json', { mode: 'server', seedFile: seedPath }))
    }, /seedFile content/)
  })

  it('omitted seed is undefined (random key generated at runtime)', function () {
    const cfg = loadConfig(writeConfig('s.json', { mode: 'server' }))
    assert.equal(cfg.seed, undefined)
  })
})

// ── mtu ─────────────────────────────────────────────────────────────

describe('loadConfig — mtu', function () {
  it('defaults to 1400', function () {
    const cfg = loadConfig(writeConfig('s.json', { mode: 'server' }))
    assert.equal(cfg.mtu, 1400)
  })

  it('accepts custom mtu', function () {
    const cfg = loadConfig(writeConfig('s.json', { mode: 'server', mtu: 1200 }))
    assert.equal(cfg.mtu, 1200)
  })

  it('rejects mtu below 576', function () {
    assert.throws(function () {
      loadConfig(writeConfig('bad.json', { mode: 'server', mtu: 500 }))
    }, /MTU/)
  })

  it('rejects mtu above 65535', function () {
    assert.throws(function () {
      loadConfig(writeConfig('bad.json', { mode: 'server', mtu: 70000 }))
    }, /MTU/)
  })
})

// ── fullTunnel ──────────────────────────────────────────────────────

describe('loadConfig — fullTunnel', function () {
  it('defaults to false', function () {
    const cfg = loadConfig(writeConfig('s.json', { mode: 'server' }))
    assert.equal(cfg.fullTunnel, false)
  })

  it('accepts true', function () {
    const cfg = loadConfig(writeConfig('s.json', { mode: 'server', fullTunnel: true }))
    assert.equal(cfg.fullTunnel, true)
  })

  it('non-boolean values are treated as false', function () {
    const cfg = loadConfig(writeConfig('s.json', { mode: 'server', fullTunnel: 'yes' }))
    assert.equal(cfg.fullTunnel, false)
  })
})

// ── server-only: outInterface ───────────────────────────────────────

describe('loadConfig — outInterface (server only)', function () {
  it('omitted by default', function () {
    const cfg = loadConfig(writeConfig('s.json', { mode: 'server' }))
    assert.equal(cfg.outInterface, undefined)
  })

  it('accepts outInterface', function () {
    const cfg = loadConfig(writeConfig('s.json', { mode: 'server', outInterface: 'eth0' }))
    assert.equal(cfg.outInterface, 'eth0')
  })

  it('ignored in client mode', function () {
    const cfg = loadConfig(writeConfig('c.json', {
      mode: 'client', server: VALID_KEY, outInterface: 'eth0'
    }))
    assert.equal(cfg.outInterface, undefined)
  })
})

// ── server-only: peers ──────────────────────────────────────────────

describe('loadConfig — peers (server only)', function () {
  it('open mode when peers omitted', function () {
    const cfg = loadConfig(writeConfig('s.json', { mode: 'server' }))
    assert.equal(cfg.peers, undefined)
  })

  it('loads valid peers as Map', function () {
    const cfg = loadConfig(writeConfig('s.json', {
      mode: 'server',
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
        mode: 'server',
        peers: { [VALID_KEY]: '10.0.0.2', [VALID_KEY2]: '10.0.0.2' }
      }))
    }, /Duplicate/)
  })

  it('rejects peer IP outside subnet', function () {
    assert.throws(function () {
      loadConfig(writeConfig('outside.json', {
        mode: 'server',
        ip: '10.0.0.1/24',
        peers: { [VALID_KEY]: '192.168.1.5' }
      }))
    }, /not in server subnet/)
  })

  it('rejects peer with server own IP', function () {
    assert.throws(function () {
      loadConfig(writeConfig('self.json', {
        mode: 'server',
        ip: '10.0.0.1/24',
        peers: { [VALID_KEY]: '10.0.0.1' }
      }))
    }, /conflicts with server/)
  })

  it('rejects broadcast address', function () {
    assert.throws(function () {
      loadConfig(writeConfig('bcast.json', {
        mode: 'server',
        ip: '10.0.0.1/24',
        peers: { [VALID_KEY]: '10.0.0.255' }
      }))
    }, /broadcast/)
  })

  it('rejects network address', function () {
    assert.throws(function () {
      loadConfig(writeConfig('net.json', {
        mode: 'server',
        ip: '10.0.0.1/24',
        peers: { [VALID_KEY]: '10.0.0.0' }
      }))
    }, /network address/)
  })

  it('rejects loopback address', function () {
    assert.throws(function () {
      loadConfig(writeConfig('lo.json', {
        mode: 'server',
        peers: { [VALID_KEY]: '127.0.0.1' }
      }))
    }, /loopback/)
  })

  it('rejects 0.0.0.0', function () {
    assert.throws(function () {
      loadConfig(writeConfig('zero.json', {
        mode: 'server',
        peers: { [VALID_KEY]: '0.0.0.0' }
      }))
    }, /0\.0\.0\.0/)
  })

  it('rejects invalid peer key', function () {
    assert.throws(function () {
      loadConfig(writeConfig('badkey.json', {
        mode: 'server',
        peers: { 'not-a-hex-key': '10.0.0.2' }
      }))
    }, /peer key/)
  })

  it('rejects invalid peer IP', function () {
    assert.throws(function () {
      loadConfig(writeConfig('badip.json', {
        mode: 'server',
        peers: { [VALID_KEY]: 'not-an-ip' }
      }))
    }, /Invalid IP/)
  })

  it('accepts IPv6 peer address', function () {
    const cfg = loadConfig(writeConfig('v6.json', {
      mode: 'server',
      peers: { [VALID_KEY]: 'fd00::2' }
    }))
    assert.equal(cfg.peers.get(VALID_KEY), 'fd00::2')
  })

  it('accepts peer at top of range', function () {
    const cfg = loadConfig(writeConfig('top.json', {
      mode: 'server',
      ip: '10.0.0.1/24',
      peers: { [VALID_KEY]: '10.0.0.254' }
    }))
    assert.equal(cfg.peers.get(VALID_KEY), '10.0.0.254')
  })

  it('works with different subnet', function () {
    const cfg = loadConfig(writeConfig('other.json', {
      mode: 'server',
      ip: '172.16.5.1/24',
      peers: { [VALID_KEY]: '172.16.5.10' }
    }))
    assert.equal(cfg.peers.get(VALID_KEY), '172.16.5.10')
  })

  it('rejects peers as string', function () {
    assert.throws(function () {
      loadConfig(writeConfig('str.json', {
        mode: 'server',
        peers: 'not-an-object'
      }))
    }, /peers/)
  })

  it('treats peers as null like open mode', function () {
    const cfg = loadConfig(writeConfig('null.json', {
      mode: 'server',
      peers: null
    }))
    assert.equal(cfg.peers, undefined)
  })

  it('skips empty peers object (open mode)', function () {
    const cfg = loadConfig(writeConfig('empty.json', {
      mode: 'server',
      peers: {}
    }))
    assert.equal(cfg.peers, undefined)
  })
})

// ── client-only: server key ─────────────────────────────────────────

describe('loadConfig — server key (client only)', function () {
  it('accepts valid server key', function () {
    const cfg = loadConfig(writeConfig('c.json', { mode: 'client', server: VALID_KEY }))
    assert.equal(cfg.server, VALID_KEY)
  })

  it('rejects missing server key', function () {
    assert.throws(function () {
      loadConfig(writeConfig('no-key.json', { mode: 'client' }))
    }, /server/)
  })

  it('rejects invalid server key', function () {
    assert.throws(function () {
      loadConfig(writeConfig('bad-key.json', { mode: 'client', server: 'short' }))
    }, /server/)
  })
})

// ── JSONC comment stripping ─────────────────────────────────────────

describe('loadConfig — JSONC comments', function () {
  it('strips line comments', function () {
    const jsonc = `{
      // this is a comment
      "mode": "server"
    }`
    const cfg = loadConfig(writeConfig('comments.jsonc', jsonc))
    assert.equal(cfg.mode, 'server')
  })

  it('does not strip // inside strings', function () {
    const jsonc = `{
      "mode": "server",
      "outInterface": "eth0"
    }`
    const cfg = loadConfig(writeConfig('str.jsonc', jsonc))
    assert.equal(cfg.outInterface, 'eth0')
  })

  it('handles inline comments after values', function () {
    const jsonc = `{
      "mode": "server", // the mode
      "mtu": 1200 // custom mtu
    }`
    const cfg = loadConfig(writeConfig('inline.jsonc', jsonc))
    assert.equal(cfg.mode, 'server')
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

// ── full server config ──────────────────────────────────────────────

describe('loadConfig — full server config', function () {
  it('parses all fields together', function () {
    const seedPath = writeSeedFile(VALID_SEED)
    const cfg = loadConfig(writeConfig('full.json', {
      mode: 'server',
      ip: '172.16.0.1/16',
      ipv6: 'fd00::1/64',
      seedFile: seedPath,
      mtu: 1200,
      fullTunnel: true,
      outInterface: 'eth0',
      peers: { [VALID_KEY]: '172.16.0.2' }
    }))
    assert.equal(cfg.mode, 'server')
    assert.equal(cfg.ip, '172.16.0.1/16')
    assert.equal(cfg.ipv6, 'fd00::1/64')
    assert.equal(cfg.seed, VALID_SEED)
    assert.equal(cfg.mtu, 1200)
    assert.equal(cfg.fullTunnel, true)
    assert.equal(cfg.outInterface, 'eth0')
    assert.equal(cfg.peers.get(VALID_KEY), '172.16.0.2')
  })
})

// ── full client config ──────────────────────────────────────────────

describe('loadConfig — full client config', function () {
  it('parses all fields together', function () {
    const cfg = loadConfig(writeConfig('full.json', {
      mode: 'client',
      server: VALID_KEY,
      ip: '172.16.0.2/16',
      ipv6: 'fd00::2/64',
      seed: VALID_SEED,
      mtu: 1200,
      fullTunnel: true
    }))
    assert.equal(cfg.mode, 'client')
    assert.equal(cfg.server, VALID_KEY)
    assert.equal(cfg.ip, '172.16.0.2/16')
    assert.equal(cfg.ipv6, 'fd00::2/64')
    assert.equal(cfg.seed, VALID_SEED)
    assert.equal(cfg.mtu, 1200)
    assert.equal(cfg.fullTunnel, true)
    assert.equal(cfg.outInterface, undefined)
    assert.equal(cfg.peers, undefined)
  })
})
