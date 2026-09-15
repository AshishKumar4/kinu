// One instance per pulse: the stretch of an edge's curve the pulse currently
// lights, from a transparent tail to a bright head. The same triangle-strip
// extrusion a stroke gets, with `along` carrying the fade.

import { Palette, View, glow_scale, recede, to_clip, tone_color } from "./palette.wgsl";

@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var<uniform> palette: Palette;

const SEGMENTS: u32 = 14u;

struct Varying {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
  @location(1) edge: f32,
  @location(2) along: f32,
}

@vertex fn vs_main(
  @builtin(vertex_index) vertex: u32,
  @location(0) curve: vec4f,
  @location(1) span: vec4f,
  @location(2) look: vec4f,
  @location(3) identity: vec4f,
) -> Varying {
  // curve: x0 y0 cx cy; span: x1 y1 tail head; look: width glow tone alpha;
  // identity the shader ignores. Tail and head are t values on the
  // whole curve and may run either way — a returning pulse has tail past head.
  let step = vertex / 2u;
  let side = f32(vertex % 2u) * 2.0 - 1.0;
  let along = f32(step) / f32(SEGMENTS);
  let s = mix(span.z, span.w, along);
  let u = 1.0 - s;
  let p0 = curve.xy * view.resolution;
  let p1 = curve.zw * view.resolution;
  let p2 = span.xy * view.resolution;
  let point = u * u * p0 + 2.0 * u * s * p1 + s * s * p2;
  var tangent = 2.0 * u * (p1 - p0) + 2.0 * s * (p2 - p1);

  if (dot(tangent, tangent) < 1e-6) {
    tangent = vec2f(1.0, 0.0);
  }

  let normal = normalize(vec2f(-tangent.y, tangent.x));
  let half_width = (look.x * view.ratio + 0.9) * 0.5;
  let pixel = point + normal * side * half_width;
  let glow = look.y;
  let rgb = recede(palette, mix(tone_color(palette, look.z, glow), palette.bright.rgb, glow * 0.6)) * glow_scale(palette, glow);
  // Pulses share the paper lift, so the whole mesh steps up as one.
  let lifted = look.w * mix(1.0, 2.4, palette.mode);

  var out: Varying;
  out.position = to_clip(view, pixel);
  out.color = vec4f(rgb, lifted);
  out.edge = side;
  out.along = along;

  return out;
}

@fragment fn fs_main(in: Varying) -> @location(0) vec4f {
  let coverage = 1.0 - in.edge * in.edge;
  let alpha = in.color.a * coverage * pow(in.along, 1.4);

  return vec4f(in.color.rgb * alpha, alpha);
}
