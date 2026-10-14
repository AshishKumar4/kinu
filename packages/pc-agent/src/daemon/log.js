// Kinu PC agent — the daemon's log line, and the words of a caught value in it.
'use strict';

function log(...a) { console.log(new Date().toISOString(), ...a); }

/** What a caught value says: its message, or the value itself when it carries
 *  none — a `throw 'text'` and an `Error('')` both reach these logs. */
function errorDetail(err) {
  const message = err?.message;

  return message === undefined || message === '' ? err : message;
}

module.exports = { log, errorDetail };
