// Bloom, step one: keep what shines. Reads the scene at half resolution and
// passes through the light above the threshold, so the halo comes from the
// gold and the best path rather than from every faint ash stroke.

@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let source = textureSampleLevel(scene, samp, uv, 0.0);
  let light = max(max(source.r, source.g), source.b);
  let keep = smoothstep(0.3, 0.9, light);

  return source * keep;
}
