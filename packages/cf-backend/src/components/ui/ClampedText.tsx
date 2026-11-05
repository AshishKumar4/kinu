/** Words held to two lines, with a way to read them whole once they run past: measured, so it never depends on a count. */
import { useLayoutEffect, useRef, useState } from "react";
import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import { Button } from "./Button";

export function ClampedText({ text }: { text: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [long, setLong] = useState(false);

  // Read only while clamped: opened, the words fit by definition and the control stays to fold them again.
  useLayoutEffect(() => {
    const element = box.current;

    if (element === null || expanded) return undefined;
    const measure = () => setLong(element.scrollHeight > element.clientHeight + 1);
    const observer = new ResizeObserver(measure);

    measure();
    observer.observe(element);

    return () => observer.disconnect();
  }, [text, expanded]);

  return (
    <>
      <div ref={box} className={`t-body p-text-2 whitespace-pre-wrap break-words${expanded ? "" : " line-clamp-2"}`}>{text}</div>
      {long && (
        <Button variant="ghost" size="sm" className="mt-px" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}
          icon={expanded ? <CaretDownIcon size={10} /> : <CaretRightIcon size={10} />}>
          {expanded ? "collapse" : "expand"}
        </Button>
      )}
    </>
  );
}
