/**
 * The name a person sees for the box (D93): kept in a file the box's shell rc reads, never given to the kernel. Plain
 * strings only, so the desktop's start and the scripts that read it import no platform module.
 */
/** The name the box shows a person in place of its host name, written at each start (D93). */
export const SHOWN_NAME_FILE = '/etc/devbox-shown-name';

/** The rc every shell a person opens on the box starts from: the terminal's and the desktop's. */
export const SHELL_RC_FILE = '/etc/devbox-shell.bashrc';

/**
 * The person's own rc first, then the box's shown name in place of the host (`\h`, `\H`) wherever the prompt it left
 * names one, its title included; a prompt that names no host is left as it is (D93). The kernel keeps the platform's
 * name: renamed, each lookup of the box's own name waited about 400 ms on the platform's DNS and answered an address
 * that is not the box.
 */
export const SHELL_RC = [
  '[ -f /etc/bash.bashrc ] && . /etc/bash.bashrc',
  '[ -f ~/.bashrc ] && . ~/.bashrc',
  `__kinu_shown=$(cat ${SHOWN_NAME_FILE} 2>/dev/null)`,
  'if [ -n "$__kinu_shown" ]; then PS1=${PS1//\\\\h/$__kinu_shown}; PS1=${PS1//\\\\H/$__kinu_shown}; fi',
  'unset __kinu_shown',
].join('\n');
