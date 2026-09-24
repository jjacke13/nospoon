#pragma once
// Non-tunnel CLI verbs. None of these open a TUN or need root.
// Implemented in commands.cpp; dispatched from main.cpp.

namespace nospoon {

// genkey [seed-hex | seedfile] — generate a keypair, or derive one from an
// existing seed. Exit 0, or 1 on a bad seed.
int cmd_genkey(int argc, char** argv);

// inspect <config> — validate and print the resolved config, including the
// public key the seed derives to. Exit 0, or 1 on an invalid config.
int cmd_inspect(int argc, char** argv);

// check [config] — probe the public DHT bootstrap; with a client config,
// also dial its server using that config's identity.
// Exit 0 ok, 1 usage, 2 bootstrap failed, 3 dial failed.
int cmd_check(int argc, char** argv);

// init <dir> [-n N] — fresh deployment: server config + N client configs.
// addclient <server-config> [-n N] — extend one, preserving its comments.
// Exit 0, or 1 on error.
int cmd_init(int argc, char** argv);
int cmd_addclient(int argc, char** argv);

}  // namespace nospoon
