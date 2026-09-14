// Bloom, step three: the scene plus its halo, premultiplied, so the page's
// own ground shows through wherever nothing was drawn.

struct Composite {
  strength: f32,
  pad0: f32,
  pad1: f32,
  pad2: f32,
}

@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var bloom: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> composite: Composite;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let base = textureSampleLevel(scene, samp, uv, 0.0);
  let halo = textureSampleLevel(bloom, samp, uv, 0.0) * composite.strength;
  let alpha = clamp(base.a + halo.a, 0.0, 1.0);
  let sum = base.rgb + halo.rgb;
  // Premultiplied colour may not exceed its alpha. Scaling the whole vector
  // keeps the gold gold where a per-channel clamp would bleach it white.
  let peak = max(max(sum.r, sum.g), sum.b);
  let rgb = sum * min(1.0, alpha / max(peak, 0.00001));

  return vec4f(rgb, alpha);
}
