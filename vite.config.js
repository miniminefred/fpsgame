import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Dev server on 8090 so it coexists with the blobgame on 8080.
export default defineConfig({
  server: {
    port: 8090,
    strictPort: true,
    open: true,
  },
  preview: {
    port: 8090,
    strictPort: true,
  },
  build: {
    // The three dev harnesses are listed as build inputs, and the reason is the
    // build gate rather than the output. `npm run build` is what this project
    // relies on to catch the import mistakes HMR hides — but Vite's default
    // input is index.html alone, so src/dev-*.js was never in the graph at all
    // and the gate did not cover a line of it. dev-guns.js imports two named
    // exports from weapons.js; rename either and the build stayed green while
    // the harness was silently broken.
    //
    // They cost nothing in the game's own bundle: separate entries, and the
    // shipped index.html never references them.
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        devGuns: resolve(import.meta.dirname, 'dev-guns.html'),
        devModels: resolve(import.meta.dirname, 'dev-models.html'),
        devSounds: resolve(import.meta.dirname, 'dev-sounds.html'),
      },
    },
  },
});
