// Persistent identity storage.
// Stores a random seed in ~/.nospoon/identity.json so the peer's
// public key stays stable across restarts.

const { fs, os, path, randomBytes } = require('./compat')

const HEX_RE = /^[0-9a-f]{64}$/

function getIdentityPath () {
  const dir = path.join(os.homedir(), '.nospoon')
  return { dir, file: path.join(dir, 'identity.json') }
}

function loadOrCreateSeed () {
  const { dir, file } = module.exports.getIdentityPath()

  // Try reading existing identity
  try {
    const raw = fs.readFileSync(file, 'utf-8')
    const data = JSON.parse(raw)
    if (data.v === 1 && HEX_RE.test(data.seedHex)) {
      return data.seedHex
    }
    console.error('WARNING: invalid identity file, regenerating')
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('WARNING: corrupt identity file, regenerating')
    }
  }

  // Generate new identity
  const seedHex = randomBytes(32).toString('hex')
  const content = JSON.stringify({ v: 1, seedHex }, null, 2) + '\n'

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, content, { mode: 0o600 })

  return seedHex
}

module.exports = { loadOrCreateSeed, getIdentityPath }
