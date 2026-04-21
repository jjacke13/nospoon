#!/usr/bin/env node

const { isBare, path, childProcess, platform, argv, env, exit, randomBytes } = require('../lib/compat')
const { execFileSync } = childProcess
const { loadConfig } = require('../lib/config')
const { startServer } = require('../lib/server')
const { startClient } = require('../lib/client')
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
nospoon - P2P VPN over HyperDHT

Usage:
  nospoon up [options] [config]   Start VPN (default config: /etc/nospoon/config.jsonc)
  nospoon genkey                  Generate a seed + public key pair

Options:
  --tun-fd=N       Use an existing TUN file descriptor instead of creating one.
                   Useful for Android (fd from VpnService), containers, or
                   running without root when TUN is pre-created.
  --utun           Used with --tun-fd on macOS — strip/prepend the 4-byte
                   utun AF header. Not needed on Linux or Android.

Config file format (JSONC):
  Server:
    {
      "mode": "server",
      "ip": "10.0.0.1/24",       // TUN address (default: 10.0.0.1/24)
      "seedFile": "/path/seed",   // or "seed": "64-hex-chars"
      "mtu": 1400,                // default: 1400
      "keepalive": 25000,         // NAT keepalive in ms (default: 25000)
      "fullTunnel": true,         // enable NAT for clients
      "outInterface": "eth0",     // NAT interface (default: auto)
      "peers": {                  // omit for open mode
        "<client-pubkey>": "10.0.0.2"
      }
    }

  Client:
    {
      "mode": "client",
      "server": "<server-pubkey-64hex>",
      "ip": "10.0.0.2/24",       // TUN address (default: 10.0.0.2/24)
      "seed": "64-hex-chars",     // for authenticated mode
      "keepalive": 25000,         // NAT keepalive in ms (default: 25000)
      "fullTunnel": true          // route all traffic through VPN
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
    const seed = randomBytes(32)
    const keyPair = HyperDHT.keyPair(seed)
    console.log('Seed (keep secret):  ', seed.toString('hex'))
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

      // Override startClient to use two-phase: connect DHT, then receive TUN fd
      config.onConnected = function () {
        // Tell parent we're connected — parent will establish VPN and send TUN fd
        binding.writeIpc(fdSocket, 'CONNECTED')
        console.log('Waiting for TUN fd from parent...')

        // Block until parent sends the TUN fd via SCM_RIGHTS
        const tunFd = binding.recvFd(fdSocket)
        console.log('Received TUN fd ' + tunFd + ' from parent')
        return createTunFromFd(tunFd, 'tun0', { mtu: config.mtu })
      }
    }

    if (config.mode === 'server') {
      await startServer(config)
    } else {
      await startClient(config)
    }
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
