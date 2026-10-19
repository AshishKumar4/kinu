/** A person by their initial, in a hue of their own, the same wherever they appear. */

/** A name's own hue, the same wherever that person appears. */
function hueOf(name: string): number {
  let sum = 0;

  for (let at = 0; at < name.length; at += 1) sum += name.charCodeAt(at);

  return sum % 360;
}

export function Avatar({ name, size = 24 }: { name: string; size?: number }) {
  return (
    <span aria-hidden className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42), background: `hsl(${String(hueOf(name))} 45% 45%)` }}>
      {(name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}
