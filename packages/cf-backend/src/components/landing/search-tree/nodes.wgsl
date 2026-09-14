// One instance per point: frontier tips, the seed, the best node, and the
// embers a pruned branch throws off. A quad with a radial falloff, and a
// wider halo for the ones that glow.

import { Palette, View, glow_scale, recede, to_clip, tone_color } from "./palette.wgsl";

@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var<uniform> palette: Palette;

struct Varying {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
  @location(1) local: vec2f,
  @location(2) glow: f32,
}

@vertex fn vs_main(
  @builtin(vertex_index) vertex: u32,
  @location(0) point: vec4f,
  @location(1) look: vec4f,
) -> Varying {
  // point: x y radius glow; look: tone alpha layer -
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  let corner = corners[vertex];
  let glow = point.w;
  let reach = (point.z * view.ratio + 0.75) * (1.0 + 2.2 * glow);
  let centre = point.xy * view.resolution;
  // A tip's core runs hot: toward the bright end of the palette as it glows.
  let rgb = recede(palette, mix(tone_color(palette, look.x, glow), palette.bright.rgb, glow * 0.6)) * glow_scale(palette, glow);

  var out: Varying;
  out.position = to_clip(view, centre + corner * reach);
  out.color = vec4f(rgb, look.y);
  out.local = corner;
  out.glow = glow;

  return out;
}

@fragment fn fs_main(in: Varying) -> @location(0) vec4f {
  let distance = length(in.local);
  let core_radius = 1.0 / (1.0 + 2.2 * in.glow);
  let core = 1.0 - smoothstep(core_radius * 0.55, core_radius, distance);
  let halo = (1.0 - smoothstep(core_radius, 1.0, distance)) * 0.28 * in.glow;
  let alpha = in.color.a * clamp(core + halo, 0.0, 1.0);

  return vec4f(in.color.rgb * alpha, alpha);
}
