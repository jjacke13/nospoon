const os = require('os')

function createTunDevice (opts) {
  const platform = os.platform()

  if (platform === 'linux') {
    return require('./tun-linux').createTunDevice(opts)
  }

  if (platform === 'darwin') {
    return require('./tun-darwin').createTunDevice(opts)
  }

  if (platform === 'win32') {
    return require('./tun-windows').createTunDevice(opts)
  }

  throw new Error(`Unsupported platform: ${platform}`)
}

module.exports = { createTunDevice }
