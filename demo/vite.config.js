import {defineConfig} from 'vite';
import solid from 'vite-plugin-solid';

// The demo imports ../src/* which in turn imports Zero internals by relative
// path into ../node_modules. Allow Vite to serve files from the project root.
export default defineConfig({
  plugins: [solid()],
  server: {fs: {allow: ['..']}},
});
