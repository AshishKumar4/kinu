import { createRoot, hydrateRoot } from 'react-dom/client';

import LegalPage from '@/components/landing/LegalPage';
import privacy from '@/components/landing/legal/privacy.md?raw';
import terms from '@/components/landing/legal/terms.md?raw';
import { publicRoot } from './public-page';

const root = publicRoot('legal-root');

const page = <LegalPage content={window.location.pathname === '/privacy' ? privacy : terms} />;

// scripts/prerender-landing.ts fills the built document; a dev template keeps its root empty.
if (root?.firstElementChild === null) createRoot(root).render(page);
else if (root !== null) hydrateRoot(root, page);
