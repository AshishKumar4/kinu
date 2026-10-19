The device daemon of device protocol 4, as rc23 (next-rc b46b07f66, 2026-10-19) installs it: the files
`buildDaemonFiles` (packages/cli/src/daemon-build.ts) builds from that commit's `packages/pc-agent/src`, the builder
scripts/build-cli-dist.sh ships. Its sandbox.js and pty.js are byte-identical to the protocol-3 production daemon's
(0.2.0+2620e7c05). Each file carries `.txt` so no linter or gate reads it as source.

Tests start it as an installed daemon and push it the current build, so the protocol-4 daemon on an owner's machine
is proved to update to protocol 5. Delete this directory with the update path once no protocol-4 daemon remains.
