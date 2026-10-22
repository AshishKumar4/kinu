/**
 * A flow of a few steps on its own page (docs/DESIGN-SYSTEM.md §2: Welcome, Deploy): the logo, the page title, a dot
 * per step, the step in a 520 card, and its actions at the card's foot. The page centres it in a 520 column.
 */
import type { ReactNode } from "react";
import { KinuLogo } from "@/components/ui/KinuLogo";

export function FlowStep({ title, steps, at, children, footer }: { title: string; steps: readonly string[]; at: number; children: ReactNode; footer?: ReactNode }) {
  return (
    <>
      <div className="mb-6 flex justify-center"><KinuLogo /></div>
      <h1 className="t-page-title text-center">{title}</h1>
      <ol aria-label="Steps" className="mb-5 mt-6 flex items-center justify-center gap-1.5">
        {steps.map((step, index) => (
          <li key={step} aria-current={index === at ? "step" : undefined} aria-label={step}>
            <span className={`p-flow-dot${index === at ? " p-flow-dot-here" : ""}${index < at ? " p-flow-dot-done" : ""}`} />
          </li>
        ))}
      </ol>
      <section className="p-flow-card">
        {children}
        {footer !== undefined && <footer className="p-flow-foot">{footer}</footer>}
      </section>
    </>
  );
}
