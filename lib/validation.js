// Input validation functions extracted from cli.js for testability.

const net = require('net')

const HEX_RE = /^[0-9a-fA-F]{64}$/
const CIDR_V4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/

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
  if (!net.isIPv6(parts[0]) || isNaN(prefix) || prefix < 1 || prefix > 128) {
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

module.exports = { validateHex64, validateCidr, validateCidrV6, validateMtu }
