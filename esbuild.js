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
  // @anthropic-ai/claude-agent-sdk 是 ESM（内部用 import.meta.url + createRequire），
  // 打成 CJS 时 import.meta.url 变 undefined 会在加载期直接抛错——用 __filename 顶上。
  // 注意：这会把 SDK 内部的 import.meta.url 指向 dist/extension.js，而 vsix 里没有
  // node_modules。目前安全，因为我们显式传了 pathToClaudeCodeExecutable（指向用户
  // 本机的 claude CLI），SDK 不需要按相对路径找自带资源。若将来升级 SDK 后出现
  // "模块找不到"类错误（且只在装好的扩展里复现、开发环境正常），先怀疑这里。
  define: { "import.meta.url": "__importMetaUrl" },
  banner: { js: "const __importMetaUrl = require('url').pathToFileURL(__filename).href;" },
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
