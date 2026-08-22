import { createRoot } from 'react-dom/client';

import { LandingPage } from '@/components/landing/LandingPage';
import './index.css';

const mount = document.getElementById('landing-root');
if (mount === null) throw new Error('landing root is missing');

const install = `curl -fsSL '${window.location.origin}/install.sh' | bash`;
createRoot(mount).render(<LandingPage install={install} />);
