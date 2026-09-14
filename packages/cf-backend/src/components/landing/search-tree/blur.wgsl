// Bloom, step two: a separable nine-tap Gaussian. Two effects share this
// source, one per direction, each with its own `blur.direction`.

struct Blur {
  direction: vec2f,
  texel: vec2f,
}

@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> blur: Blur;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let offsets = array<f32, 5>(0.0, 1.4, 3.3, 5.2, 7.1);
  let weights = array<f32, 5>(0.227, 0.316, 0.07, 0.012, 0.002);
  let step = blur.direction * blur.texel;
  var sum = textureSampleLevel(source, samp, uv, 0.0) * weights[0];

  for (var index = 1u; index < 5u; index = index + 1u) {
    let offset = step * offsets[index];
    sum = sum + textureSampleLevel(source, samp, uv + offset, 0.0) * weights[index];
    sum = sum + textureSampleLevel(source, samp, uv - offset, 0.0) * weights[index];
  }

  return sum;
}
