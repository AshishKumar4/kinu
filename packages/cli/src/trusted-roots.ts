// First of the CLI's imports, so every module after it fetches through the trust it installs (pc-agent/src/daemon/trust.js).
import { installTrustedRoots } from '../../pc-agent/src/daemon/trust.js';

installTrustedRoots();
