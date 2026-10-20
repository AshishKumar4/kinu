import { MarkdownContent } from '@/components/surfaces/shared';
import { LandingFooter, LandingHeader } from './LandingChrome';

export default function LegalPage({ content }: { content: string }) {
  return (
    <div className="min-h-screen p-bg font-sans p-text">
      <LandingHeader />
      <main className="mx-auto max-w-3xl px-5 py-12 sm:px-8 sm:py-20">
        <article className="prose-chat break-words [&_h1]:mt-0 [&_h1]:mb-6 [&_h1]:text-3xl [&_h1]:font-medium [&_h1]:tracking-tight [&_h1]:p-text sm:[&_h1]:text-4xl [&_h2]:mt-10 [&_h2]:p-text [&_p]:my-4 [&_ul]:my-4 [&_li]:my-2">
          <MarkdownContent content={content} />
        </article>
      </main>
      <LandingFooter />
    </div>
  );
}
