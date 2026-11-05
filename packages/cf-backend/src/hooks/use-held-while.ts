/** A switch that holds only while `condition` does: once it lapses the switch is off, and stays off until set again. */
import { useState } from "react";

export function useHeldWhile(condition: boolean, initial = false): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(initial);

  // Adjusted in render, so no frame shows it held past its condition.
  if (!condition && on) setOn(false);

  return [on, setOn];
}
