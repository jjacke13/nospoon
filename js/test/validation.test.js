const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { validateHex64, validateCidr, validateCidrV6, validateMtu } = require('../lib/validation')

describe('validateHex64', function () {
  it('accepts valid 64-char hex string', function () {
    const hex = 'ab'.repeat(32)
    const result = validateHex64(hex, 'key')
    assert.equal(result.valid, true)
    assert.equal(result.value, hex)
  })

  it('rejects too short', function () {
    assert.equal(validateHex64('abcd', 'key').valid, false)
  })

  it('rejects too long', function () {
    assert.equal(validateHex64('ab'.repeat(33), 'key').valid, false)
  })

  it('rejects non-hex characters', function () {
    const bad = 'zz' + 'ab'.repeat(31)
    assert.equal(validateHex64(bad, 'key').valid, false)
  })

  it('accepts uppercase hex', function () {
    const hex = 'AB'.repeat(32)
    assert.equal(validateHex64(hex, 'key').valid, true)
  })

  it('accepts mixed case hex', function () {
    const hex = 'aB'.repeat(32)
    assert.equal(validateHex64(hex, 'key').valid, true)
  })
})

describe('validateCidr', function () {
  it('accepts valid IPv4 CIDR', function () {
    const result = validateCidr('10.0.0.1/24', 'ip')
    assert.equal(result.valid, true)
    assert.equal(result.value, '10.0.0.1/24')
  })

  it('rejects missing prefix', function () {
    assert.equal(validateCidr('10.0.0.1', 'ip').valid, false)
  })

  it('rejects octet > 255', function () {
    assert.equal(validateCidr('256.0.0.1/24', 'ip').valid, false)
  })

  it('rejects prefix > 32', function () {
    assert.equal(validateCidr('10.0.0.1/33', 'ip').valid, false)
  })

  it('rejects garbage', function () {
    assert.equal(validateCidr('not-an-ip', 'ip').valid, false)
  })

  it('accepts /32 single host', function () {
    assert.equal(validateCidr('10.0.0.1/32', 'ip').valid, true)
  })

  it('accepts /0', function () {
    assert.equal(validateCidr('0.0.0.0/0', 'ip').valid, true)
  })
})

describe('validateCidrV6', function () {
  it('accepts valid IPv6 CIDR', function () {
    const result = validateCidrV6('fd00::1/64', 'ipv6')
    assert.equal(result.valid, true)
  })

  it('rejects missing prefix', function () {
    assert.equal(validateCidrV6('fd00::1', 'ipv6').valid, false)
  })

  it('rejects invalid IPv6', function () {
    assert.equal(validateCidrV6('not-ipv6/64', 'ipv6').valid, false)
  })

  it('rejects prefix > 128', function () {
    assert.equal(validateCidrV6('fd00::1/129', 'ipv6').valid, false)
  })

  it('rejects prefix 0', function () {
    assert.equal(validateCidrV6('fd00::1/0', 'ipv6').valid, false)
  })

  it('accepts full IPv6 address', function () {
    assert.equal(validateCidrV6('2001:0db8:85a3:0000:0000:8a2e:0370:7334/48', 'ipv6').valid, true)
  })
})

describe('validateMtu', function () {
  it('accepts 1400 (default)', function () {
    const result = validateMtu('1400')
    assert.equal(result.valid, true)
    assert.equal(result.value, 1400)
  })

  it('accepts minimum 576', function () {
    assert.equal(validateMtu('576').valid, true)
  })

  it('accepts maximum 65535', function () {
    assert.equal(validateMtu('65535').valid, true)
  })

  it('rejects below minimum', function () {
    assert.equal(validateMtu('575').valid, false)
  })

  it('rejects above maximum', function () {
    assert.equal(validateMtu('65536').valid, false)
  })

  it('rejects non-numeric', function () {
    assert.equal(validateMtu('abc').valid, false)
  })
})
