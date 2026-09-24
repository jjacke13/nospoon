#pragma once
// Human-readable names and triage hints for hyperdht ConnectError codes.
//
// The codes come back as bare negative integers from HyperDHT::connect().
// A log line saying "-3" is unreadable in the field, so every place that
// surfaces one goes through here.
//
// The hints mirror the triage notes in CLAUDE.md — keep the two in sync.
//
// Names come from the library: `ConnectError::name()` in hyperdht/dht.hpp
// (added in pin 95cb5d9) is its strerror(), so a code added upstream is
// named here automatically. Only the hints live in nospoon — "peers list"
// is a nospoon concept the library knows nothing about, and :49737 is this
// deployment's field knowledge.

#include <hyperdht/dht.hpp>

namespace nospoon {

inline const char* connect_error_name(int e) {
    return hyperdht::ConnectError::name(e);
}

// What the failure means for the operator. Returns nullptr when there is
// nothing useful to add beyond the name.
inline const char* connect_error_hint(int e) {
    using namespace hyperdht;
    switch (e) {
        case ConnectError::PEER_NOT_FOUND:
            return "no node returned a record for this key. Either the server "
                   "is not running/announcing, or this network blocks the DHT "
                   "(bootstrap is UDP :49737).";
        case ConnectError::PEER_CONNECTION_FAILED:
            return "the record was found but no relay got an answer from the "
                   "server. The server is announcing but not replying to "
                   "handshakes — check that this client's key is in the "
                   "server's peers list.";
        case ConnectError::NO_ADDRESSES:
            return "the server answered but advertised no connectable address.";
        case ConnectError::HOLEPUNCH_FAILED:
        case ConnectError::HOLEPUNCH_TIMEOUT:
            return "handshake succeeded, NAT traversal did not. This is the "
                   "CGNAT/symmetric-NAT class — retry, or try another network.";
        case ConnectError::RELAY_FAILED:
            return "blind-relay pairing failed.";
        case ConnectError::SERVER_ERROR:
            return "the server rejected us at the protocol level (version "
                   "mismatch, or it returned an error payload).";
        case ConnectError::DESTROYED:
            return "the DHT was torn down mid-connect (usually our own "
                   "restart after repeated failures).";
        default:
            return nullptr;
    }
}

}  // namespace nospoon
