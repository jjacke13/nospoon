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
exports.EventEmitter = (isBare ? require('bare-events') : require('events')).EventEmitter

// childProcess: Node.js has execFileSync/execFile; Bare only has spawn/spawnSync.
// Shim execFileSync/execFile on top of spawn for Bare.
if (isBare) {
  const subprocess = require('bare-subprocess')

  function execFileSync (file, args, opts) {
    const options = opts || {}
    const result = subprocess.spawnSync(file, args || [], options)
    if (result.status !== 0) {
      const stderr = result.stderr
        ? (typeof result.stderr === 'string' ? result.stderr : result.stderr.toString())
        : ''
      const err = new Error(`Command failed: ${file} ${(args || []).join(' ')}\n${stderr}`)
      err.status = result.status
      err.stdout = result.stdout
      err.stderr = result.stderr
      throw err
    }
    if (options.encoding === 'utf-8' || options.encoding === 'utf8') {
      return result.stdout ? result.stdout.toString('utf-8') : ''
    }
    return result.stdout
  }

  function execFile (file, args, callback) {
    const child = subprocess.spawn(file, args || [])
    let stdout = ''
    let stderr = ''
    if (child.stdout) child.stdout.on('data', function (d) { stdout += d.toString() })
    if (child.stderr) child.stderr.on('data', function (d) { stderr += d.toString() })
    child.on('exit', function (code) {
      if (code === 0) {
        if (callback) callback(null, stdout, stderr)
      } else {
        const err = new Error(`Command failed: ${file}`)
        err.code = code
        if (callback) callback(err, stdout, stderr)
      }
    })
    return child
  }

  exports.childProcess = {
    execFileSync,
    execFile,
    spawn: subprocess.spawn,
    spawnSync: subprocess.spawnSync
  }
} else {
  exports.childProcess = require('child_process')
}

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
