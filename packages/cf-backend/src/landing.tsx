import { createRoot } from 'react-dom/client';

import { buildCliInstallCommand } from '@/cli/install-command';
import { LandingPage } from '@/components/landing/LandingPage';
import './index.css';

const mount = document.getElementById('landing-root');
if (mount === null) throw new Error('landing root is missing');

const install = buildCliInstallCommand({ origin: window.location.origin });
createRoot(mount).render(<LandingPage install={install} />);
