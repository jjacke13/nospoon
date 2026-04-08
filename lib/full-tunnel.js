const { platform } = require('./compat')

const impl = platform === 'darwin'
  ? require('./full-tunnel-darwin')
  : platform === 'win32'
    ? require('./full-tunnel-windows')
    : require('./full-tunnel-linux')

module.exports = {
  enableServerForwarding: impl.enableServerForwarding,
  disableServerForwarding: impl.disableServerForwarding,
  enableClientFullTunnel: impl.enableClientFullTunnel,
  addHostExemption: impl.addHostExemption,
  disableClientFullTunnel: impl.disableClientFullTunnel
}
