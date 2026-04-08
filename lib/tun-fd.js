// Shared fd-based TUN packet I/O for Linux, macOS, and Android.
// Given a file descriptor and interface name, creates an EventEmitter
// with the same interface that server.js/client.js expect:
//   tun.on('data', cb), tun.write(buf), tun.release(), tun.name
//
// Uses manual fs.read/write loops (proven on Android/Bare, works on Node.js).
// Replaces fs.createReadStream/createWriteStream which don't work on device
// fds under Bare.

const b4a = require('b4a')
const { fs, EventEmitter } = require('./compat')

// macOS utun AF header constants
const AF_INET = 2
const AF_INET6 = 30

function noop () {}

function createTunFromFd (fd, name, opts) {
  const mtu = opts.mtu || 1400
  const stripAF = opts.stripAF || false
  const prependAF = opts.prependAF || false

  const tun = new EventEmitter()
  tun.name = name

  let released = false
  const buf = b4a.alloc(mtu + 200)

  // Recursive read loop — fs.read with position -1 uses read() (not pread()),
  // which blocks in libuv's thread pool until a packet arrives.
  function readLoop () {
    if (released) return
    fs.read(fd, buf, 0, buf.length, -1, function (err, n) {
      if (released) return
      if (err) {
        tun.emit('error', err)
        setTimeout(readLoop, 100)
        return
      }
      if (n > 0) {
        let packet = b4a.from(buf.subarray(0, n))
        if (stripAF && packet.length > 4) {
          packet = packet.subarray(4)
        }
        tun.emit('data', packet)
      }
      readLoop()
    })
  }

  tun.write = function (packet) {
    if (released || packet.length < 1) return false
    if (prependAF) {
      const version = (packet[0] >>> 4) & 0x0f
      const header = b4a.alloc(4)
      header.writeUInt32BE(version === 6 ? AF_INET6 : AF_INET, 0)
      const frame = b4a.concat([header, packet])
      fs.write(fd, frame, 0, frame.length, null, noop)
    } else {
      fs.write(fd, packet, 0, packet.length, null, noop)
    }
    return true
  }

  tun.release = function () {
    if (released) return
    released = true
    try { fs.closeSync(fd) } catch (e) {}
  }

  readLoop()
  return tun
}

module.exports = { createTunFromFd }
