/** A path no page answers: said plainly, inside the rail, with the way home. Reported as `/unmatched` (`routeTemplateOf`). */
import { Link, useLocation } from "react-router-dom";
import { APP_ROUTES } from "@kinu.run/core";

export default function NotFoundPage() {
  const { pathname } = useLocation();

  return (
    <div className="flex h-full items-center justify-center p-6">
      <section data-not-found className="p-card px-5 py-8 text-center">
        <h2 className="t-title p-text">No page here</h2>
        <p className="t-meta mt-1 p-text-3 break-all">{pathname}</p>
        <Link to={APP_ROUTES.home} className="t-control mt-3 inline-block p-accent-fg">Go home →</Link>
      </section>
    </div>
  );
}
