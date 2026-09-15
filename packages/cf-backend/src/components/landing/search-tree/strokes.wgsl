// One instance per branch: a quadratic curve grown to t, extruded into a
// triangle strip of SEGMENTS steps with a soft edge. Positions arrive in
// view-normalised units; the View uniform turns them into pixels.

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
  @location(1) tip: vec4f,
  @location(2) look: vec4f,
) -> Varying {
  // curve: x0 y0 cx cy; tip: x1 y1 t width; look: glow tone alpha layer
  let step = vertex / 2u;
  let side = f32(vertex % 2u) * 2.0 - 1.0;
  let grown = max(tip.z, 0.001);
  let s = grown * f32(step) / f32(SEGMENTS);
  let u = 1.0 - s;
  let p0 = curve.xy * view.resolution;
  let p1 = curve.zw * view.resolution;
  let p2 = tip.xy * view.resolution;
  let point = u * u * p0 + 2.0 * u * s * p1 + s * s * p2;
  var tangent = 2.0 * u * (p1 - p0) + 2.0 * s * (p2 - p1);

  if (dot(tangent, tangent) < 1e-6) {
    tangent = vec2f(1.0, 0.0);
  }

  let normal = normalize(vec2f(-tangent.y, tangent.x));
  let taper = 1.0 - 0.3 * (s / grown);
  let half_width = (tip.w * view.ratio * taper + 0.9) * 0.5;
  let pixel = point + normal * side * half_width;
  let glow = look.x;
  let rgb = recede(palette, tone_color(palette, look.y, glow)) * glow_scale(palette, glow);
  // On paper the mesh carries extra presence: a light-only lift that leaves
  // the dark picture exactly where it was, matching hero-canvas.ts.
  let lifted = look.z * mix(1.0, 2.4, palette.mode);

  var out: Varying;
  out.position = to_clip(view, pixel);
  out.color = vec4f(rgb, lifted);
  out.edge = side;
  out.along = s / grown;

  return out;
}

@fragment fn fs_main(in: Varying) -> @location(0) vec4f {
  let coverage = 1.0 - in.edge * in.edge;
  let alpha = in.color.a * coverage;

  return vec4f(in.color.rgb * alpha, alpha);
}
