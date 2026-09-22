/** `@vgpu/wgsl`'s Vite plugin emits a shader source object; it is registered for the client environment only. */
declare module '*.wgsl' {
  const source: import('vgpu').ShaderSource;
  export default source;
}
