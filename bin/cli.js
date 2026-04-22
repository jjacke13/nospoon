#!/usr/bin/env node

const { isBare, path, childProcess, platform, argv, env, exit } = require('../lib/compat')
const { execFileSync } = childProcess
const { loadConfig } = require('../lib/config')
const { startSwarm } = require('../lib/swarm')
const { createTunFromFd } = require('../lib/tun-fd')

// Node.js: argv = ['node', 'cli.js', ...args] → slice(2)
// Bare script: argv = ['bare', 'cli.js', ...args] → slice(2)
// Bare standalone: argv = ['nospoon', ...args] → slice(1)
const isStandalone = isBare && (argv.length < 2 || !argv[1].endsWith('.js'))
const args = argv.slice(isStandalone ? 1 : 2)
const command = args[0]

function getFlag (name) {
  const prefix = '--' + name + '='
  const arg = args.find(function (a) { return a.startsWith(prefix) })
  return arg ? arg.slice(prefix.length) : null
}

function hasFlag (name) {
  return args.indexOf('--' + name) !== -1
}

function printUsage () {
  console.log(`
nospoon - P2P mesh VPN over Hyperswarm

Usage:
  nospoon up [options] [config]   Start VPN (default config: /etc/nospoon/config.jsonc)
  nospoon genkey                  Show persistent identity (or generate with --new)

Options:
  --tun-fd=N       Use an existing TUN file descriptor instead of creating one.
                   Useful for Android (fd from VpnService), containers, or
                   running without root when TUN is pre-created.
  --utun           Used with --tun-fd on macOS — strip/prepend the 4-byte
                   utun AF header. Not needed on Linux or Android.

Config file format (JSONC):
  Minimal (open mode):
    {
      "topic": "my-secret-group",
      "ip": "10.0.0.1/24"
    }

  Authenticated (stable IPs):
    {
      "topic": "my-group",
      "ip": "10.0.0.1/24",
      "peers": {
        "<peer-pubkey-64hex>": "10.0.0.2"
      }
    }

  Exit node (offers internet NAT):
    {
      "topic": "my-group",
      "ip": "10.0.0.1/24",
      "exitNode": true
    }

  Exit user (routes internet through exit peer):
    {
      "topic": "my-group",
      "ip": "10.0.0.2/24",
      "exitVia": "10.0.0.1"
    }
`)
}

async function main () {
  if (!command || command === '--help' || command === '-h') {
    printUsage()
    exit(0)
  }

  if (command === 'genkey') {
    const HyperDHT = require('hyperdht')
    const { loadOrCreateSeed } = require('../lib/identity')

    let seedHex
    if (hasFlag('new')) {
      const { randomBytes } = require('../lib/compat')
      seedHex = randomBytes(32).toString('hex')
      console.log('Generated new seed (not saved):')
    } else {
      seedHex = loadOrCreateSeed()
      console.log('Persistent identity (~/.nospoon/identity.json):')
    }

    const keyPair = HyperDHT.keyPair(Buffer.from(seedHex, 'hex'))
    console.log('Seed (keep secret):  ', seedHex)
    console.log('Public key (share):  ', keyPair.publicKey.toString('hex'))
    exit(0)
  }

  if (command === 'up') {
    // Windows: require Administrator privileges for TUN/route operations
    if (platform === 'win32' && !getFlag('tun-fd')) {
      try {
        execFileSync('net', ['session'], { stdio: 'ignore' })
      } catch {
        console.error('Error: nospoon requires Administrator privileges on Windows')
        console.error('Right-click your terminal and select "Run as Administrator"')
        exit(1)
      }
    }

    // Find config path — skip flags (--tun-fd, --utun)
    const configArg = args.slice(1).find(function (a) { return !a.startsWith('--') })
    const defaultConfig = platform === 'win32'
      ? path.join(env.PROGRAMDATA || 'C:\\ProgramData', 'nospoon', 'config.jsonc')
      : '/etc/nospoon/config.jsonc'
    const configPath = configArg || defaultConfig
    const config = loadConfig(configPath)

    // --tun-fd=N: use an existing TUN fd instead of creating one
    const tunFdStr = getFlag('tun-fd')
    if (tunFdStr) {
      const fd = parseInt(tunFdStr, 10)
      if (isNaN(fd) || fd < 0) {
        console.error('Error: --tun-fd must be a non-negative integer')
        exit(1)
      }
      const isUtun = hasFlag('utun')
      config.tun = createTunFromFd(fd, 'tun0', {
        mtu: config.mtu,
        stripAF: isUtun,
        prependAF: isUtun
      })
      console.log(`Using existing TUN fd ${fd}` + (isUtun ? ' (utun mode)' : ''))
    }

    // --fd-socket=N: two-phase mode for Android.
    // Connect DHT first (no VPN routes active), signal parent via IPC,
    // then receive TUN fd via SCM_RIGHTS after VPN is established.
    const fdSocketStr = getFlag('fd-socket')
    if (fdSocketStr && !tunFdStr) {
      const fdSocket = parseInt(fdSocketStr, 10)
      if (isNaN(fdSocket) || fdSocket < 0) {
        console.error('Error: --fd-socket must be a non-negative integer')
        exit(1)
      }
      const binding = require('../lib/binding')

      config.ipcWrite = function (msg) {
        try { binding.writeIpc(fdSocket, msg) } catch (e) {}
      }

      config.onConnected = function () {
        binding.writeIpc(fdSocket, 'CONNECTED')
        console.log('Waiting for TUN fd from parent...')
        const tunFd = binding.recvFd(fdSocket)
        console.log('Received TUN fd ' + tunFd + ' from parent')
        return createTunFromFd(tunFd, 'tun0', { mtu: config.mtu })
      }
    }

    await startSwarm(config)
  } else {
    console.error(`Unknown command: ${command}`)
    printUsage()
    exit(1)
  }
}

main().catch(function (err) {
  console.error('Fatal:', err.message)
  exit(1)
})
