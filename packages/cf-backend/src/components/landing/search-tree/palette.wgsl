// The theme's tokens on the GPU. A stroke names a tone; this module turns it
// into a colour the same way renderer-canvas.ts does on the CPU.

export struct Palette {
  accent: vec4f,
  bright: vec4f,
  ash: vec4f,
  // 0 on the dark ground, 1 on paper: paper gets no HDR push, so the bloom
  // gilds instead of blowing out.
  mode: f32,
  pad0: f32,
  pad1: f32,
  pad2: f32,
}

export struct View {
  resolution: vec2f,
  ratio: f32,
  time: f32,
}

// Tones: 0 an ordinary attempt, cooler the weaker it scores; 1 the kept
// path, the theme's gold on the dark ground and its deepened text-grade gold
// on paper; 2 ash; 3 an ember.
export fn tone_color(palette: Palette, tone: f32, glow: f32) -> vec3f {
  if (tone > 2.5) {
    return mix(palette.accent.rgb, palette.ash.rgb, 0.35);
  }

  if (tone > 1.5) {
    return palette.ash.rgb;
  }

  if (tone > 0.5) {
    return mix(palette.accent.rgb, palette.bright.rgb, palette.mode);
  }

  return mix(palette.ash.rgb, palette.accent.rgb, 0.35 + 0.65 * glow);
}

// Luminous strokes carry more than one unit of light on the dark ground; the
// bright pass reads that headroom, and the composite brings the hue back.
export fn glow_scale(palette: Palette, glow: f32) -> f32 {
  return 1.0 + glow * 0.7 * (1.0 - palette.mode);
}

export fn to_clip(view: View, pixel: vec2f) -> vec4f {
  return vec4f(pixel.x / view.resolution.x * 2.0 - 1.0, 1.0 - pixel.y / view.resolution.y * 2.0, 0.0, 1.0);
}
