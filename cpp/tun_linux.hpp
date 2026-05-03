#pragma once
// Linux TUN device: open, configure IP + MTU, read/write via uv_poll.
// Requires CAP_NET_ADMIN or root.

#include <uv.h>

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <functional>
#include <string>
#include <vector>

#include <fcntl.h>
#include <sys/ioctl.h>
#include <unistd.h>
#include <linux/if.h>
#include <linux/if_tun.h>

namespace nospoon {

class Tun {
public:
    using OnPacketCb = std::function<void(const uint8_t* data, size_t len)>;

    Tun() = default;
    ~Tun() { close(); }

    Tun(const Tun&) = delete;
    Tun& operator=(const Tun&) = delete;

    // Adopt an externally-provided TUN file descriptor (Android VpnService
    // path). The parent has already configured IP/MTU/routes via
    // VpnService.Builder before calling establish(); we just read/write on
    // the fd. Marks the fd non-blocking so uv_poll never stalls the loop.
    int adopt_fd(int fd, int mtu, const std::string& name = "tun0") {
        if (fd_ >= 0) {
            fprintf(stderr, "Tun::adopt_fd: already owns fd %d\n", fd_);
            return -1;
        }
        if (fd < 0) return -1;

        int flags = fcntl(fd, F_GETFL, 0);
        if (flags >= 0) fcntl(fd, F_SETFL, flags | O_NONBLOCK);

        fd_   = fd;
        mtu_  = mtu;
        name_ = name.empty() ? std::string("tun0") : name;
        fprintf(stderr, "  TUN adopted fd %d as %s (MTU %d)\n",
                fd_, name_.c_str(), mtu_);
        return 0;
    }

    // Open TUN device, configure IPv4 (+ optional IPv6) + MTU, bring up.
    // ip_cidr: "10.0.0.1/24"
    // ipv6_cidr: "fd00::1/64" (empty for IPv4-only)
    // Returns 0 on success, -1 on error.
    int open(const std::string& ip_cidr, int mtu,
             const std::string& ipv6_cidr = {}) {
        fd_ = ::open("/dev/net/tun", O_RDWR);
        if (fd_ < 0) {
            perror("open /dev/net/tun");
            return -1;
        }

        struct ifreq ifr{};
        ifr.ifr_flags = IFF_TUN | IFF_NO_PI;
        if (ioctl(fd_, TUNSETIFF, &ifr) < 0) {
            perror("ioctl TUNSETIFF");
            ::close(fd_);
            fd_ = -1;
            return -1;
        }
        name_ = ifr.ifr_name;

        // Configure with ip commands
        char cmd[256];
        snprintf(cmd, sizeof(cmd), "ip addr add %s dev %s",
                 ip_cidr.c_str(), name_.c_str());
        if (system(cmd) != 0) {
            fprintf(stderr, "Failed: %s\n", cmd);
            ::close(fd_);
            fd_ = -1;
            return -1;
        }

        if (!ipv6_cidr.empty()) {
            snprintf(cmd, sizeof(cmd), "ip -6 addr add %s dev %s",
                     ipv6_cidr.c_str(), name_.c_str());
            if (system(cmd) != 0) {
                fprintf(stderr, "Failed: %s\n", cmd);
                // IPv6 is optional — keep going (matches JS behavior).
            }
        }

        snprintf(cmd, sizeof(cmd), "ip link set %s mtu %d up",
                 name_.c_str(), mtu);
        if (system(cmd) != 0) {
            fprintf(stderr, "Failed: %s\n", cmd);
            ::close(fd_);
            fd_ = -1;
            return -1;
        }

        mtu_ = mtu;
        if (ipv6_cidr.empty()) {
            fprintf(stderr, "  TUN %s opened (%s, MTU %d)\n",
                    name_.c_str(), ip_cidr.c_str(), mtu);
        } else {
            fprintf(stderr, "  TUN %s opened (%s + %s, MTU %d)\n",
                    name_.c_str(), ip_cidr.c_str(), ipv6_cidr.c_str(), mtu);
        }
        return 0;
    }

    // Register fd with libuv event loop for readable events.
    void start(uv_loop_t* loop, OnPacketCb on_packet) {
        if (fd_ < 0) return;
        on_packet_ = std::move(on_packet);
        uv_poll_init(loop, &poll_, fd_);
        poll_.data = this;
        uv_poll_start(&poll_, UV_READABLE, on_poll);
        poll_active_ = true;
    }

    // Write an IP packet to the TUN device.
    int write(const uint8_t* data, size_t len) {
        if (fd_ < 0) return -1;
        return static_cast<int>(::write(fd_, data, len));
    }

    void close() {
        if (poll_active_) {
            uv_poll_stop(&poll_);
            poll_active_ = false;
        }
        if (fd_ >= 0) {
            ::close(fd_);
            fd_ = -1;
        }
    }

    int fd() const { return fd_; }
    const std::string& name() const { return name_; }
    int mtu() const { return mtu_; }

private:
    static void on_poll(uv_poll_t* handle, int status, int events) {
        if (status < 0) return;
        auto* self = static_cast<Tun*>(handle->data);
        if (!(events & UV_READABLE)) return;

        uint8_t buf[65536];
        auto n = ::read(self->fd_, buf, sizeof(buf));
        if (n <= 0) return;

        if (self->on_packet_) {
            self->on_packet_(buf, static_cast<size_t>(n));
        }
    }

    int fd_ = -1;
    int mtu_ = 1400;
    std::string name_;
    OnPacketCb on_packet_;
    uv_poll_t poll_{};
    bool poll_active_ = false;
};

}  // namespace nospoon
