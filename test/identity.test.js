const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

// Use a temp dir so tests don't touch the real ~/.nospoon
const tmpDir = path.join(os.tmpdir(), 'nospoon-identity-test-' + process.pid)
const identityDir = path.join(tmpDir, '.nospoon')
const identityFile = path.join(identityDir, 'identity.json')

// Monkey-patch the module's path before loading
const identity = require('../lib/identity')
const originalGetPath = identity.getIdentityPath

beforeEach(function () {
  // Override getIdentityPath to use temp dir
  identity.getIdentityPath = function () {
    return { dir: identityDir, file: identityFile }
  }
  // Clean up temp dir
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

afterEach(function () {
  identity.getIdentityPath = originalGetPath
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('loadOrCreateSeed', function () {
  it('creates identity file when missing', function () {
    const seed = identity.loadOrCreateSeed()
    assert.match(seed, /^[0-9a-f]{64}$/)
    assert.ok(fs.existsSync(identityFile))
  })

  it('reads existing identity file', function () {
    const firstSeed = identity.loadOrCreateSeed()
    const secondSeed = identity.loadOrCreateSeed()
    assert.equal(firstSeed, secondSeed)
  })

  it('returns 64-char lowercase hex', function () {
    const seed = identity.loadOrCreateSeed()
    assert.equal(seed.length, 64)
    assert.match(seed, /^[0-9a-f]+$/)
  })

  it('creates directory with correct structure', function () {
    identity.loadOrCreateSeed()
    const data = JSON.parse(fs.readFileSync(identityFile, 'utf-8'))
    assert.equal(data.v, 1)
    assert.match(data.seedHex, /^[0-9a-f]{64}$/)
  })

  it('regenerates corrupted identity file', function () {
    fs.mkdirSync(identityDir, { recursive: true })
    fs.writeFileSync(identityFile, 'not json')
    const seed = identity.loadOrCreateSeed()
    assert.match(seed, /^[0-9a-f]{64}$/)
  })
})
