#pragma once
// Minimal Unix-socket IPC helpers used by the Android two-phase VPN bridge.
// The parent (NospoonVpnService) hands us a connected SOCK_STREAM fd over
// which we exchange newline-delimited status messages and receive the TUN
// file descriptor via SCM_RIGHTS once the VPN is established.
//
// Counterpart in JS land lives at:
//   nospoon-bare/lib/binding.c (writeIpc, recvFd)
//   nospoon-bare/bin/cli.js    (--fd-socket plumbing)
//
// All functions here are blocking. Callers run them on the main thread —
// they're called once on connect and once at shutdown, never on the hot
// packet-forwarding path.

#ifndef _WIN32

#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

#include <cerrno>
#include <cstdio>
#include <cstring>
#include <string>
#include <string_view>

namespace nospoon::ipc {

// Write `msg` followed by '\n' to `fd`. Retries on EINTR. Returns true on
// success. Best-effort: if the parent has closed its end we just log and
// move on (the main loop will tear down via signal/close).
inline bool write_line(int fd, std::string_view msg) {
    if (fd < 0) return false;

    std::string buf;
    buf.reserve(msg.size() + 1);
    buf.append(msg);
    buf.push_back('\n');

    size_t off = 0;
    while (off < buf.size()) {
        ssize_t n = ::write(fd, buf.data() + off, buf.size() - off);
        if (n < 0) {
            if (errno == EINTR) continue;
            std::fprintf(stderr,
                "ipc: write_line(fd=%d) failed: %s\n", fd, std::strerror(errno));
            return false;
        }
        off += static_cast<size_t>(n);
    }
    return true;
}

// Block on `fd` until a single file descriptor arrives via SCM_RIGHTS.
// Returns the received fd, or -1 on error.
//
// We expect one byte of payload alongside the fd (the parent sends a single
// dummy byte) — that lets the kernel actually deliver the cmsg, since
// recvmsg with iov_len = 0 may drop ancillary data on some platforms.
inline int recv_fd(int fd) {
    if (fd < 0) return -1;

    char dummy = 0;
    struct iovec iov{};
    iov.iov_base = &dummy;
    iov.iov_len  = 1;

    char cmsgbuf[CMSG_SPACE(sizeof(int))];
    std::memset(cmsgbuf, 0, sizeof(cmsgbuf));

    struct msghdr msg{};
    msg.msg_iov        = &iov;
    msg.msg_iovlen     = 1;
    msg.msg_control    = cmsgbuf;
    msg.msg_controllen = sizeof(cmsgbuf);

    ssize_t n;
    do {
        n = ::recvmsg(fd, &msg, 0);
    } while (n < 0 && errno == EINTR);

    if (n <= 0) {
        std::fprintf(stderr,
            "ipc: recvmsg(fd=%d) failed: %s\n",
            fd, n < 0 ? std::strerror(errno) : "EOF");
        return -1;
    }

    for (struct cmsghdr* c = CMSG_FIRSTHDR(&msg); c; c = CMSG_NXTHDR(&msg, c)) {
        if (c->cmsg_level == SOL_SOCKET && c->cmsg_type == SCM_RIGHTS) {
            int received = -1;
            std::memcpy(&received, CMSG_DATA(c), sizeof(received));
            return received;
        }
    }

    std::fprintf(stderr,
        "ipc: recvmsg(fd=%d) returned %zd bytes but no SCM_RIGHTS cmsg\n",
        fd, n);
    return -1;
}

}  // namespace nospoon::ipc

#endif  // !_WIN32
