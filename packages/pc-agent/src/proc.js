'use strict';

/** One proc reader for the daemon, its standalone supervisor and repository runners.
 * @param {typeof import('node:fs')} fs
 */
function createProcReader(fs) {
  /** @param {Error} error */
  function procEntryGone(error) {
    return 'code' in error && (error.code === 'ENOENT' || error.code === 'ESRCH');
  }

  /** @param {number | string} pid @param {string} name @param {boolean} required */
  function procFile(pid, name, required = false) {
    try {
      return fs.readFileSync(`/proc/${pid}/${name}`, 'utf8');
    } catch (error) {
      if (!required && error instanceof Error && procEntryGone(error)) return undefined;
      throw error;
    }
  }

  /** The command name can contain spaces, parentheses and newlines; only its final closing parenthesis separates fields.
   * @param {string} text
   */
  function parseProcStat(text) {
    const end = text.lastIndexOf(')');
    const fields = text.slice(end + 2).trim().split(/\s+/);

    return {
      comm: text.slice(text.indexOf('(') + 1, end),
      state: fields[0] ?? '',
      ppid: Number(fields[1]),
      group: Number(fields[2]),
      session: Number(fields[3]),
      cpuTicks: Number(fields[11]) + Number(fields[12]) + Number(fields[13]) + Number(fields[14]),
      tasks: Number(fields[17]),
      startTicks: fields[19] ?? '',
    };
  }

  /**
   * @overload
   * @param {number | string} pid
   * @param {string} name
   * @param {true} required
   * @returns {ReturnType<typeof parseProcStat>}
   */
  /**
   * @overload
   * @param {number | string} pid
   * @param {string} [name]
   * @param {boolean} [required]
   * @returns {ReturnType<typeof parseProcStat> | undefined}
   */
  /** @param {number | string} pid @param {string} name @param {boolean} required */
  function procStat(pid, name = 'stat', required = false) {
    const text = procFile(pid, name, required);

    return text === undefined ? undefined : parseProcStat(text);
  }

  return { procEntryGone, procFile, procStat, parseProcStat };
}

module.exports = { ...createProcReader(require('node:fs')), createProcReader };
