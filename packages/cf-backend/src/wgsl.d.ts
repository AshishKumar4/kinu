/**
 * A `.wgsl` import is the shader source object `@vgpu/wgsl`'s Vite plugin
 * emits after resolving the module's imports: what `draw()` and `effect()`
 * take as their shader. The plugin is registered for the client environment
 * only (vite.config.ts), which is the only graph that imports one.
 */
declare module '*.wgsl' {
  const source: import('vgpu').ShaderSource;
  export default source;
}
