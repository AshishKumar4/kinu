// The picture at rest, drawn once per change into its own texture, laid under each
// frame's moving strokes as it is: premultiplied in, premultiplied out.

@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSampleLevel(source, samp, uv, 0.0);
}
