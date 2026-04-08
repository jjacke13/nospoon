// Runtime compatibility layer for Node.js and Bare.
// On Node.js, uses standard built-in modules.
// On Bare, uses bare-* equivalents.
// The ternary guards ensure bare-* modules are never loaded on Node.js and vice versa.

const isBare = typeof Bare !== 'undefined'

exports.isBare = isBare
exports.platform = isBare ? Bare.platform : process.platform
exports.arch = isBare ? Bare.arch : process.arch
exports.argv = isBare ? Bare.argv : process.argv
exports.env = isBare ? Bare.env : process.env

exports.exit = function (code) {
  if (isBare) Bare.exit(code)
  else process.exit(code)
}

exports.onSignal = function (signal, handler) {
  if (isBare) Bare.on(signal, handler)
  else process.on(signal, handler)
}

exports.onExit = function (handler) {
  if (isBare) Bare.on('exit', handler)
  else process.on('exit', handler)
}

exports.fs = isBare ? require('bare-fs') : require('fs')
exports.path = isBare ? require('bare-path') : require('path')
exports.os = isBare ? require('bare-os') : require('os')
exports.childProcess = isBare ? require('bare-subprocess') : require('child_process')
exports.EventEmitter = (isBare ? require('bare-events') : require('events')).EventEmitter

// crypto.randomBytes: available natively on Node.js.
// On Bare, fall back to sodium-native (always in tree via hyperdht).
try {
  exports.randomBytes = require('crypto').randomBytes
} catch (e) {
  const b4a = require('b4a')
  const sodium = require('sodium-native')
  exports.randomBytes = function (n) {
    const buf = b4a.alloc(n)
    sodium.randombytes_buf(buf)
    return buf
  }
}
