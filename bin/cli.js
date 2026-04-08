#!/usr/bin/env node

const { path, childProcess, platform, argv, env, exit, randomBytes } = require('../lib/compat')
const { execFileSync } = childProcess
const { loadConfig } = require('../lib/config')
const { startServer } = require('../lib/server')
const { startClient } = require('../lib/client')

const args = argv.slice(2)
const command = args[0]

function printUsage () {
  console.log(`
nospoon - P2P VPN over HyperDHT

Usage:
  nospoon up [config]     Start VPN (default: /etc/nospoon/config.jsonc)
  nospoon genkey          Generate a seed + public key pair

Config file format (JSONC):
  Server:
    {
      "mode": "server",
      "ip": "10.0.0.1/24",       // TUN address (default: 10.0.0.1/24)
      "seedFile": "/path/seed",   // or "seed": "64-hex-chars"
      "mtu": 1400,                // default: 1400
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
    if (platform === 'win32') {
      try {
        execFileSync('net', ['session'], { stdio: 'ignore' })
      } catch {
        console.error('Error: nospoon requires Administrator privileges on Windows')
        console.error('Right-click your terminal and select "Run as Administrator"')
        exit(1)
      }
    }

    const defaultConfig = platform === 'win32'
      ? path.join(env.PROGRAMDATA || 'C:\\ProgramData', 'nospoon', 'config.jsonc')
      : '/etc/nospoon/config.jsonc'
    const configPath = args[1] || defaultConfig
    const config = loadConfig(configPath)

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
