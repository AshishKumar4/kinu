/**
 * The Worker bundle's load cost, which every isolate pays before it serves: V8 keeps each module's
 * source text for lazy compilation, and a module with one character above U+00FF is stored two bytes
 * per character. Measured 2026-09-26 on main abbd2c74b5 in workerd (used heap after claim and setup):
 * 76.4 MB as built unminified, 58.1 MB minified, 48.7 MB minified with ASCII-only output, against the
 * isolate's 128 MB. The client environment is untouched.
 */
import remapping from "@jridgewell/remapping";
import MagicString from "magic-string";
import * as v from "valibot";
import type { Plugin } from "vite";

const EncodedMapSchema = v.object({ mappings: v.string(), names: v.array(v.string()) });

/** Every character outside ASCII as a `\u` escape, valid in strings, templates, regexes and identifiers. */
function asciiOnly(code: string): MagicString | null {
  const edits = new MagicString(code);
  let changed = false;

  for (let index = 0; index < code.length; index++) {
    const unit = code.charCodeAt(index);

    if (unit < 0x80) continue;
    edits.overwrite(index, index + 1, `\\u${unit.toString(16).padStart(4, "0")}`);
    changed = true;
  }

  return changed ? edits : null;
}

export function workerLoadCost(): Plugin {
  return {
    name: "kinu:worker-load-cost",
    configEnvironment(name) {
      if (name === "client") return null;

      return {
        build: {
          minify: "oxc",
          rolldownOptions: {
            output: {
              // Names survive bundling and both minify passes: DO classes, `Error.name`, `constructor.name` readers.
              keepNames: true,
              minify: { compress: { keepNames: { function: true, class: true } }, mangle: { keepNames: true } },
            },
          },
        },
      };
    },
    // After minification, which prints escapes back as raw characters; the chunk's map is composed through the edit.
    generateBundle(_options, bundle) {
      if (this.environment.name === "client") return;

      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        const edits = asciiOnly(chunk.code);

        if (edits === null) continue;
        const escaped = edits.generateMap({ hires: true, source: chunk.fileName });
        chunk.code = edits.toString();

        if (chunk.map !== null) {
          const composed = v.parse(EncodedMapSchema, JSON.parse(remapping([escaped.toString(), chunk.map.toString()], () => null).toString()));
          chunk.map = { ...chunk.map, mappings: composed.mappings, names: composed.names };
        }
      }
    },
  };
}
