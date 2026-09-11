import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, type Document, type Rule } from 'postcss';

const path = join(import.meta.dir, '..', 'src', 'index.css');

const stylesheet = parse(readFileSync(path, 'utf8'), { from: path, map: false });

const rules: { rule: Rule; properties: Set<string> }[] = [];

stylesheet.walkRules((rule) => {
  const properties = new Set(rule.nodes.filter((node) => node.type === 'decl').map((node) => node.prop.toLowerCase()));
  rules.push({ rule, properties });
});

function hasLayer(rule: Rule): boolean {
  let parent: Rule['parent'] | Document = rule.parent;

  while (parent !== undefined) {
    if (parent.type === 'atrule' && parent.name.toLowerCase() === 'layer') return true;
    parent = parent.parent;
  }

  return false;
}

describe('scroll container stylesheet contracts', () => {
  test('a rule that sets one overflow axis sets both', () => {
    const oneAxis = rules.filter(({ properties }) =>
      properties.has('overflow-x') !== properties.has('overflow-y'));

    expect(oneAxis.map(({ rule }) => rule.selector)).toEqual([]);
  });

  test('scrollbar defaults remain layered so components can override them', () => {
    const scrollbarRules = rules.filter(({ rule, properties }) =>
      properties.has('scrollbar-width') || properties.has('scrollbar-color')
        || rule.selector.includes('::-webkit-scrollbar'));

    expect(scrollbarRules.some(({ rule }) => rule.selector === '*')).toBe(true);
    expect(scrollbarRules.filter(({ rule }) => !hasLayer(rule)).map(({ rule }) => rule.selector)).toEqual([]);
  });
});
