const HyperDHT = require('hyperdht')
const b4a = require('b4a')
const { fs } = require('./compat')
const { isIPv4, isIPv6, validateHex64, validateCidr, validateCidrV6, validateMtu, validateKeepalive } = require('./validation')

const DEFAULT_KEEPALIVE_MS = 25000 // 25s — keeps NAT mappings alive (matches WireGuard default)
const DEFAULT_PREFIX = 24

function stripComments (text) {
  return text.split('\n').map(function (line) {
    let inString = false
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"' && (i === 0 || line[i - 1] !== '\\')) {
        inString = !inString
      }
      if (!inString && line[i] === '/' && line[i + 1] === '/') {
        return line.slice(0, i)
      }
    }
    return line
  }).join('\n')
}

function ipToInt (ip) {
  const octets = ip.split('.').map(Number)
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
}

function parseSubnet (cidr) {
  const [ip, prefixStr] = cidr.split('/')
  const prefix = parseInt(prefixStr || '24', 10)
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  const hostIp = ipToInt(ip)
  const network = (hostIp & mask) >>> 0
  const broadcast = (network | ~mask) >>> 0
  return { hostIp, network, broadcast, mask, prefix }
}

function require64 (value, field) {
  const result = validateHex64(value, field)
  if (!result.valid) throw new Error(result.error)
  return result.value
}

function requireCidrV6 (value, field) {
  const result = validateCidrV6(value, field)
  if (!result.valid) throw new Error(result.error)
  return result.value
}

function requireMtu (value) {
  const result = validateMtu(value)
  if (!result.valid) throw new Error(result.error)
  return result.value
}

function requireKeepalive (value) {
  const result = validateKeepalive(value)
  if (!result.valid) throw new Error(result.error)
  return result.value
}

function validatePeers (peers, prefix) {
  if (typeof peers !== 'object' || peers === null || Array.isArray(peers)) {
    throw new Error('"peers" must be an object mapping public keys to IPs')
  }

  if (Object.keys(peers).length < 2) {
    throw new Error('"peers" must contain at least 2 entries (including yourself)')
  }

  // Derive subnet from the first peer's IP to validate all are in the same subnet
  const firstIp = Object.values(peers)[0]
  if (!isIPv4(firstIp)) {
    throw new Error(`Invalid IP in peers: ${firstIp}`)
  }
  const firstInt = ipToInt(firstIp)
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  const network = (firstInt & mask) >>> 0
  const broadcast = (network | ~mask) >>> 0

  const seen = new Set()

  for (const [key, ip] of Object.entries(peers)) {
    require64(key, 'peer key')
    const label = key.slice(0, 8) + '...'

    if (!isIPv4(ip) && !isIPv6(ip)) {
      throw new Error(`Invalid IP for peer ${label}: ${ip}`)
    }

    if (isIPv4(ip)) {
      const ipInt = ipToInt(ip)
      if (ipInt === 0) throw new Error(`Invalid IP for peer ${label}: 0.0.0.0`)
      if ((ipInt >>> 24) === 127) throw new Error(`Invalid IP for peer ${label}: loopback address`)

      if ((ipInt & mask) >>> 0 !== network) {
        throw new Error(`Peer ${label} IP ${ip} is not in subnet`)
      }
      if (ipInt === network) throw new Error(`Peer ${label} IP ${ip} is the network address`)
      if (ipInt === broadcast) throw new Error(`Peer ${label} IP ${ip} is the broadcast address`)
    }

    if (seen.has(ip)) throw new Error(`Duplicate IP assignment in peers: ${ip}`)
    seen.add(ip)
  }

  return new Map(Object.entries(peers))
}

function loadConfig (configPath) {
  let raw
  try {
    raw = fs.readFileSync(configPath, 'utf-8')
  } catch (err) {
    throw new Error(`Cannot read config file ${configPath}: ${err.message}`)
  }

  const stripped = stripComments(raw)

  let parsed
  try {
    parsed = JSON.parse(stripped)
  } catch (err) {
    throw new Error(`Invalid JSON in config file: ${err.message}`)
  }

  // Migration: reject old config format
  if (parsed.mode) {
    throw new Error('"mode" is no longer supported. Use "topic" instead (see docs)')
  }
  if (parsed.server) {
    throw new Error('"server" is no longer supported. Use "topic" + "peers" instead (see docs)')
  }
  if (parsed.fullTunnel !== undefined) {
    throw new Error('"fullTunnel" is no longer supported. Use "exitNode" or "exitVia" instead')
  }

  const config = {}

  // Topic — required
  if (!parsed.topic || typeof parsed.topic !== 'string' || parsed.topic.trim() === '') {
    throw new Error('"topic" (non-empty string) is required')
  }
  config.topic = parsed.topic.trim()

  // Seed — required (the peer's identity)
  if (parsed.seed && parsed.seedFile) {
    throw new Error('"seed" and "seedFile" are mutually exclusive')
  }
  if (parsed.seedFile) {
    let content
    try {
      content = fs.readFileSync(parsed.seedFile, 'utf-8').trim()
    } catch (err) {
      throw new Error(`Cannot read seed file ${parsed.seedFile}: ${err.message}`)
    }
    config.seed = require64(content, 'seedFile content')
  } else if (parsed.seed) {
    config.seed = require64(parsed.seed, 'seed')
  } else {
    throw new Error('"seed" or "seedFile" is required (your identity)')
  }

  // Peers — required (all members including self)
  if (!parsed.peers || typeof parsed.peers !== 'object' || Array.isArray(parsed.peers)) {
    throw new Error('"peers" (object mapping public keys to IPs) is required')
  }

  const prefix = parsed.prefix !== undefined ? parseInt(parsed.prefix, 10) : DEFAULT_PREFIX
  if (isNaN(prefix) || prefix < 1 || prefix > 30) {
    throw new Error('"prefix" must be between 1 and 30')
  }
  config.prefix = prefix

  config.peers = validatePeers(parsed.peers, prefix)

  // Derive own IP from seed → pubkey → peers lookup
  const seedBuf = b4a.from(config.seed, 'hex')
  const keyPair = HyperDHT.keyPair(seedBuf)
  const myPubKeyHex = keyPair.publicKey.toString('hex')

  if (!config.peers.has(myPubKeyHex)) {
    throw new Error('Own public key not found in "peers" map. Run "nospoon genkey" to see your public key')
  }

  const myIp = config.peers.get(myPubKeyHex)
  config.ip = myIp + '/' + prefix

  if (parsed.ipv6) {
    config.ipv6 = requireCidrV6(parsed.ipv6, 'ipv6')
  }

  // MTU, keepalive
  config.mtu = parsed.mtu !== undefined ? requireMtu(parsed.mtu) : 1400
  config.keepalive = parsed.keepalive !== undefined ? requireKeepalive(parsed.keepalive) : DEFAULT_KEEPALIVE_MS

  // Exit node / exit via
  config.exitNode = parsed.exitNode === true
  if (parsed.exitVia) {
    if (!isIPv4(parsed.exitVia)) {
      throw new Error('"exitVia" must be a valid IPv4 address')
    }
    // Verify exitVia is one of the peers
    let found = false
    for (const [, peerIp] of config.peers) {
      if (peerIp === parsed.exitVia) { found = true; break }
    }
    if (!found) {
      throw new Error('"exitVia" must be an IP from the peers map')
    }
    if (parsed.exitVia === myIp) {
      throw new Error('"exitVia" cannot be your own IP')
    }
    config.exitVia = parsed.exitVia
  }

  if (config.exitNode && config.exitVia) {
    throw new Error('"exitNode" and "exitVia" are mutually exclusive')
  }

  if (parsed.outInterface) {
    config.outInterface = parsed.outInterface
  }

  return config
}

module.exports = { loadConfig, parseSubnet, ipToInt }
