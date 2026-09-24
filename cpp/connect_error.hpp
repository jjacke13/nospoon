#pragma once
// Human-readable names and triage hints for hyperdht ConnectError codes.
//
// The codes come back as bare negative integers from HyperDHT::connect().
// A log line saying "-3" is unreadable in the field, so every place that
// surfaces one goes through here.
//
// The hints mirror the triage notes in CLAUDE.md — keep the two in sync.
//
// FOLLOW-UP: `connect_error_name` belongs upstream, next to the enum in
// hyperdht/dht.hpp — it is the library's own strerror(). Three consumers
// already hand-maintain their own copy (wrappers/kotlin Types.kt:26,
// examples/android Types.kt, wrappers/rust error.rs:75), and a code added
// upstream prints UNKNOWN here until someone remembers this file. Move it
// when the pin is next bumped (bundle with the HYPERDHT_DEBUG=ON revert so
// it costs one rebuild, not two). The hints stay here: "peers list" is a
// nospoon concept and :49737 is this deployment's field knowledge.

#include <hyperdht/dht.hpp>

namespace nospoon {

inline const char* connect_error_name(int e) {
    using namespace hyperdht;
    switch (e) {
        case ConnectError::NONE:                   return "NONE";
        case ConnectError::DESTROYED:              return "DESTROYED";
        case ConnectError::PEER_NOT_FOUND:         return "PEER_NOT_FOUND";
        case ConnectError::PEER_CONNECTION_FAILED: return "PEER_CONNECTION_FAILED";
        case ConnectError::NO_ADDRESSES:           return "NO_ADDRESSES";
        case ConnectError::HOLEPUNCH_FAILED:       return "HOLEPUNCH_FAILED";
        case ConnectError::HOLEPUNCH_TIMEOUT:      return "HOLEPUNCH_TIMEOUT";
        case ConnectError::RELAY_FAILED:           return "RELAY_FAILED";
        case ConnectError::SERVER_ERROR:           return "SERVER_ERROR";
        default:                                   return "UNKNOWN";
    }
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
