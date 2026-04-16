// Input validation functions for nospoon.
// Pure JS — no Node.js built-in dependencies.

const HEX_RE = /^[0-9a-fA-F]{64}$/
const CIDR_V4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/
const HEX16_RE = /^[0-9a-fA-F]{1,4}$/

function isIPv4 (str) {
  if (typeof str !== 'string') return false
  const parts = str.split('.')
  if (parts.length !== 4) return false
  for (let i = 0; i < 4; i++) {
    const n = parseInt(parts[i], 10)
    if (isNaN(n) || n < 0 || n > 255 || String(n) !== parts[i]) return false
  }
  return true
}

function isIPv6 (str) {
  if (typeof str !== 'string') return false

  const dc = str.split('::')
  if (dc.length > 2) return false

  if (dc.length === 2) {
    const left = dc[0] ? dc[0].split(':') : []
    const right = dc[1] ? dc[1].split(':') : []
    if (left.length + right.length > 7) return false
    return left.every(isHex16) && right.every(isHex16)
  }

  const groups = str.split(':')
  return groups.length === 8 && groups.every(isHex16)
}

function isHex16 (group) {
  return HEX16_RE.test(group)
}

function validateHex64 (value, label) {
  if (!HEX_RE.test(value)) {
    return { valid: false, error: `${label} must be exactly 64 hex characters` }
  }
  return { valid: true, value }
}

function validateCidr (value, label) {
  if (!CIDR_V4_RE.test(value)) {
    return { valid: false, error: `${label} must be in CIDR format (e.g. 10.0.0.1/24)` }
  }
  const [ip, prefix] = value.split('/')
  const octets = ip.split('.').map(Number)
  const pfx = parseInt(prefix, 10)
  if (octets.some(function (o) { return o > 255 }) || pfx > 32) {
    return { valid: false, error: `${label} has invalid IP octets or prefix length` }
  }
  return { valid: true, value }
}

function validateCidrV6 (value, label) {
  const parts = value.split('/')
  if (parts.length !== 2) {
    return { valid: false, error: `${label} must be in CIDR format (e.g. fd00::1/64)` }
  }
  const prefix = parseInt(parts[1], 10)
  if (!isIPv6(parts[0]) || isNaN(prefix) || prefix < 1 || prefix > 128) {
    return { valid: false, error: `${label} must be a valid IPv6 CIDR (e.g. fd00::1/64)` }
  }
  return { valid: true, value }
}

function validateMtu (value) {
  const mtu = parseInt(value, 10)
  if (isNaN(mtu) || mtu < 576 || mtu > 65535) {
    return { valid: false, error: 'MTU must be between 576 and 65535' }
  }
  return { valid: true, value: mtu }
}

function validateKeepalive (value) {
  if (value === false) return { valid: true, value: false }
  const ms = parseInt(value, 10)
  if (isNaN(ms) || ms < 1000 || ms > 300000) {
    return { valid: false, error: 'keepalive must be false or between 1000 and 300000 ms' }
  }
  return { valid: true, value: ms }
}

module.exports = { isIPv4, isIPv6, validateHex64, validateCidr, validateCidrV6, validateMtu, validateKeepalive }
