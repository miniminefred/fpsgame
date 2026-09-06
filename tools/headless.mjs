// A browser, for tools that have to run the real builder without one.
//
// `buildLevel` is pure geometry, but it pulls in textures.js, which paints
// canvas textures — so a minimal DOM has to exist before the module graph is
// loaded. That is the whole of what this file is: importing it installs the
// stub, and nothing that comes after has to know.
//
// It is its own file because there were two copies of it, in the props sweep and
// the nav sweep, and a third was wanted for the fingerprint. A stub that drifts
// is worse than no stub: the tool goes on running and starts measuring a
// slightly different game, which is the lesson `modelInfo` taught the props
// sweep when it silently fit-tested every model-backed prop at its declared size
// instead of its real one.
//
// Import it for its side effect, first, before anything under src/:
//
//   import './headless.mjs';
//   const { buildLevel } = await import('../src/gen/build.js');

const noopCtx = () => new Proxy({}, {
  get: (_t, prop) => {
    if (prop === 'canvas') return { width: 0, height: 0 };
    return (...a) => {
      // Gradients are the one return value textures.js actually uses.
      if (String(prop).startsWith('create')) {
        return { addColorStop() {} };
      }
      if (String(prop) === 'getImageData') {
        return { data: new Uint8ClampedArray(4), width: 1, height: 1 };
      }
      return undefined;
    };
  },
  set: () => true,
});

globalThis.document = {
  createElement: () => {
    const c = { width: 0, height: 0, style: {}, nodeType: 1 };
    c.getContext = () => noopCtx();
    c.toDataURL = () => 'data:,';
    c.addEventListener = () => {};
    return c;
  },
  createElementNS: () => ({}),
};
globalThis.self = globalThis.self ?? globalThis;
