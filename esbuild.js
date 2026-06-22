const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** Shared problem-matcher friendly logging for watch mode. */
const logPlugin = {
  name: "log",
  setup(build) {
    let label = build.initialOptions.outfile || "build";
    build.onStart(() => console.log(`[build] start ${label}`));
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        if (location) console.error(`    ${location.file}:${location.line}:${location.column}`);
      });
      console.log(`[build] done ${label} (${result.errors.length} errors)`);
    });
  },
};

/** The extension host bundle (Node / CommonJS). `vscode` is provided by the host. */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: "dist/extension.js",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  plugins: [logPlugin],
};

/** The webview bundle (browser / IIFE). markdown-it + highlight.js are inlined here. */
const webviewConfig = {
  entryPoints: ["src/webview/main.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  outfile: "media/webview.js",
  sourcemap: !production,
  minify: production,
  plugins: [logPlugin],
};

async function main() {
  const ctxs = await Promise.all([
    esbuild.context(extensionConfig),
    esbuild.context(webviewConfig),
  ]);
  if (watch) {
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log("[build] watching...");
  } else {
    await Promise.all(ctxs.map((c) => c.rebuild()));
    await Promise.all(ctxs.map((c) => c.dispose()));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
