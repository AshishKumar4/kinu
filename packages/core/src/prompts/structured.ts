const JSON_FENCE = /```(?:json)?\s*([\s\S]*?)```/i;

export function jsonObjectOnlyInstruction(): string {
  return 'Return ONLY a single minified JSON object. Do not include markdown fences or prose.';
}

export function jsonArrayOnlyInstruction(): string {
  return 'Return ONLY a single minified JSON array. Do not include markdown fences or prose.';
}

export function extractJsonObject(text: string): unknown {
  return JSON.parse(extractBalancedJson(text, '{', '}'));
}

export function extractJsonArray(text: string): unknown {
  return JSON.parse(extractBalancedJson(text, '[', ']'));
}

function extractBalancedJson(text: string, open: '{' | '[', close: '}' | ']'): string {
  const fenced = text.match(JSON_FENCE);
  const src = fenced ? fenced[1] : text;
  const start = src.indexOf(open);
  if (start === -1) throw new Error(`no JSON ${open === '{' ? 'object' : 'array'} in model output`);

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated JSON ${open === '{' ? 'object' : 'array'} in model output`);
}
