import LegalPage from '@/components/landing/LegalPage';
import privacy from '@/components/landing/legal/privacy.md?raw';
import terms from '@/components/landing/legal/terms.md?raw';

export default function LegalDocument() {
  return <LegalPage content={window.location.pathname === '/privacy' ? privacy : terms} />;
}
