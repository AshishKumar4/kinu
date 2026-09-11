// KINU-LOCAL delta on upstream's suite: the borrowed-member cases upstream lists as valid
// (`schema.shape.id`) are invalid here, and the case-insensitive substring cases pin the ban a
// previous session narrowed to a lexical word (30 hidden violations, recorded 2026-08-17).
// See tools/oxlint/anti-slop/upstream.json.
import { RuleTester } from "oxlint/plugins-dev";

import { noForbiddenTermInSymbolNamesRule } from "./no-shape-in-symbol-names.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "forbiddenSymbolName" };

tester.run("anti-slop/no-shape-in-symbol-names", noForbiddenTermInSymbolNamesRule, {
	valid: [
		"const owner = { id: 1 }; const value = owner.id;",
		"const resizeImage = (value: Image) => value;",
		"interface Geometry {}",
	],
	invalid: [
		{ code: "const shape = 1;", errors: [error] },
		{ code: "function shapeOf() {}", errors: [error] },
		{ code: "type PayloadShape = { id: string };", errors: [error] },
		{ code: "type Payload = { shape: string };", errors: [error] },
		{
			code: "declare const owner: External; const shape = 'field'; const value = owner[shape];",
			errors: 2,
		},
		{ code: "declare const schema: ExternalSchema; const field = schema.shape.id;", errors: [error] },
		{ code: "declare const outer: External; const value = outer.inner.shape;", errors: [error] },
		{ code: "declare const schema: ExternalSchema; schema.shape.id.parse('x');", errors: [error] },
		{ code: "interface UserShape {}", errors: [error] },
		{ code: "const payload_shape = {};", errors: [error] },
		{ code: "const reshapeImage = (value: Image) => value;", errors: [error] },
		{ code: "interface ShapelessGeometry {}", errors: [error] },
	],
});
