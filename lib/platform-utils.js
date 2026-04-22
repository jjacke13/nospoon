// Shared helpers for platform-specific modules (full-tunnel-*.js).
// Extracted to avoid duplication across Linux, macOS, and Windows implementations.

const { childProcess } = require('./compat')
const { execFileSync, execFile } = childProcess

const IFACE_RE = /^[a-zA-Z0-9_-]+$/
const IFACE_RE_WIN = /^[a-zA-Z0-9_\- ]+$/

function validateInterface (name, allowSpaces) {
  const re = allowSpaces ? IFACE_RE_WIN : IFACE_RE
  if (!re.test(name)) {
    throw new Error(`Invalid interface name: ${name}`)
  }
  return name
}

function run (cmd, args, opts) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf-8' }).trim()
  } catch (err) {
    const msg = err.stderr || err.message
    if (opts && opts.strict) {
      throw new Error(`${cmd} ${args.join(' ')} failed: ${msg}`)
    }
    console.error(`Command failed: ${cmd} ${args.join(' ')}`)
    console.error(msg)
    return null
  }
}

// Non-blocking variant for shutdown cleanup — fire and forget
function runAsync (cmd, args) {
  const child = execFile(cmd, args, function (err) {
    if (err) console.error(`Cleanup: ${cmd} ${args.join(' ')} failed`)
  })
  if (child.unref) child.unref()
}

module.exports = { validateInterface, run, runAsync }
