package com.nospoon.vpn

object NativeHelper {
    init {
        System.loadLibrary("nospoon_exec")
    }

    // Fork+exec preserving all fds (including TUN fd).
    // Returns int[2] = { pid, stdout_read_fd }, or null on error.
    // Child's stdout is captured via pipe. stderr goes to logcat.
    @JvmStatic
    external fun exec(args: Array<String>): IntArray?

    // Send SIGTERM to child process.
    @JvmStatic
    external fun kill(pid: Int)

    // Non-blocking waitpid. Returns:
    //   -2 = still running
    //   -1 = error
    //   0+ = exit code
    @JvmStatic
    external fun waitpid(pid: Int): Int
}
