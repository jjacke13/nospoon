const { fs } = require('./compat')
const { isIPv4, isIPv6, validateHex64, validateCidr, validateCidrV6, validateMtu, validateKeepalive } = require('./validation')

const DEFAULT_KEEPALIVE_MS = 25000 // 25s — keeps NAT mappings alive (matches WireGuard default)

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

function requireCidr (value, field) {
  const result = validateCidr(value, field)
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

function validatePeers (peers, ownCidr) {
  if (typeof peers !== 'object' || peers === null || Array.isArray(peers)) {
    throw new Error('"peers" must be an object mapping public keys to IPs')
  }

  const subnet = ownCidr ? parseSubnet(ownCidr) : null
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

      if (subnet) {
        if ((ipInt & subnet.mask) >>> 0 !== subnet.network) {
          throw new Error(`Peer ${label} IP ${ip} is not in subnet`)
        }
        if (ipInt === subnet.network) throw new Error(`Peer ${label} IP ${ip} is the network address`)
        if (ipInt === subnet.broadcast) throw new Error(`Peer ${label} IP ${ip} is the broadcast address`)
        if (ipInt === subnet.hostIp) throw new Error(`Peer ${label} IP ${ip} conflicts with own IP`)
      }
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

  // Topic — required
  if (!parsed.topic || typeof parsed.topic !== 'string' || parsed.topic.trim() === '') {
    throw new Error('"topic" (non-empty string) is required')
  }

  const config = {}
  config.topic = parsed.topic.trim()

  // IP — required CIDR
  config.ip = parsed.ip
    ? requireCidr(parsed.ip, 'ip')
    : '10.0.0.1/24'

  if (parsed.ipv6) {
    config.ipv6 = requireCidrV6(parsed.ipv6, 'ipv6')
  }

  // Seed
  if (parsed.seed && parsed.seedFile) {
    throw new Error('"seed" and "seedFile" are mutually exclusive')
  }
  if (parsed.seed) {
    config.seed = require64(parsed.seed, 'seed')
  } else if (parsed.seedFile) {
    let content
    try {
      content = fs.readFileSync(parsed.seedFile, 'utf-8').trim()
    } catch (err) {
      throw new Error(`Cannot read seed file ${parsed.seedFile}: ${err.message}`)
    }
    config.seed = require64(content, 'seedFile content')
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
    const subnet = parseSubnet(config.ip)
    const exitInt = ipToInt(parsed.exitVia)
    if ((exitInt & subnet.mask) >>> 0 !== subnet.network) {
      throw new Error('"exitVia" IP is not in the configured subnet')
    }
    if (exitInt === subnet.hostIp) {
      throw new Error('"exitVia" cannot be this peer\'s own IP')
    }
    config.exitVia = parsed.exitVia
  }

  if (config.exitNode && config.exitVia) {
    throw new Error('"exitNode" and "exitVia" are mutually exclusive')
  }

  if (parsed.outInterface) {
    config.outInterface = parsed.outInterface
  }

  // Peers
  if (parsed.peers && Object.keys(parsed.peers).length > 0) {
    config.peers = validatePeers(parsed.peers, config.ip)
  }

  return config
}

module.exports = { loadConfig, parseSubnet, ipToInt }
