// Root entry so OpenCode v2 can load this plugin from the repo directory (`file://<dir>`), which
// loads the directory's root index.js. npm consumers resolve `exports["."]` → dist/index.js.
export { default } from './dist/index.js'
