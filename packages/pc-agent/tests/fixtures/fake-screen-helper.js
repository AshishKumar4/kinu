// The Linux screen helper's protocol, played without a desktop (linux-screen.test.js). argv: the mode, then what
// to do, as JSON: `probe` answers `probe`; `share` allows, refuses, or `waits` on its prompt until it is killed;
// `serve` accepts one token, draws `early` before it says it is ready, hands back `next`, draws `frames`, writes
// each line it is sent to `log`, and fails with `fail` after them when told to.
'use strict';

const fs = require('node:fs');

const [, , mode, said] = process.argv;

const told = JSON.parse(said);

function record(kind, payload) {
  const head = Buffer.alloc(5);

  head.writeUInt32BE(payload.byteLength, 0);
  head[4] = kind;
  process.stdout.write(Buffer.concat([head, payload]));
}

function say(event) {
  record(0, Buffer.from(JSON.stringify(event)));
}

function frame({ width, height, jpeg }) {
  const size = Buffer.alloc(4);

  size.writeUInt16BE(width, 0);
  size.writeUInt16BE(height, 2);
  record(1, Buffer.concat([size, Buffer.from(jpeg, 'hex')]));
}

if (mode === 'probe') {
  say({ type: 'probed', ...told.probe });
} else if (mode === 'share') {
  say({ type: 'asking' });

  if (told.share === 'waits') {
    fs.appendFileSync(told.log, 'asking\n');
    process.stdin.resume();
  } else if (told.share === 'refuse') {
    say({ type: 'failed', why: 'sharing was not allowed on this PC' });
    process.exitCode = 3;
  } else {
    say({ type: 'ready', width: told.width, height: told.height, token: told.token });
  }
} else if (mode === 'serve') {
  let first = true;
  let pending = '';

  process.stdin.on('data', (chunk) => {
    pending += chunk.toString('utf8');

    for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
      const line = pending.slice(0, end);

      pending = pending.slice(end + 1);
      fs.appendFileSync(told.log, `${line}\n`);

      if (!first) continue;
      first = false;

      if (line !== told.accepts) {
        say({ type: 'asking' });
        say({ type: 'failed', why: 'sharing was not allowed on this PC' });
        process.exit(3);
      }

      if (told.early !== undefined) frame(told.early);
      say({ type: 'ready', width: told.width, height: told.height, token: told.next });

      for (const drawn of told.frames) frame(drawn);

      if (told.fail !== undefined) {
        say({ type: 'failed', why: told.fail });
        process.exit(1);
      }
    }
  });
  process.stdin.on('end', () => { fs.appendFileSync(told.log, 'closed\n'); });
}
