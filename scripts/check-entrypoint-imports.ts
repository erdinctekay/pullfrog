import { isBuiltin } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDir = dirname(fileURLToPath(import.meta.url));

const entryPoints = [
  resolve(scriptDir, "../entry.ts"),
  resolve(scriptDir, "../post.ts"),
  resolve(scriptDir, "../get-installation-token/entry.ts"),
  resolve(scriptDir, "../get-installation-token/post.ts"),
];

function isPathImport(specifier: string): boolean {
  return (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("/") ||
    specifier.startsWith("file:")
  );
}

async function checkEntrypointImports(): Promise<void> {
  const result = await build({
    entryPoints,
    outdir: resolve(scriptDir, "../.tmp/entrypoint-imports"),
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    packages: "external",
    logLevel: "silent",
  });

  if (!result.metafile) {
    throw new Error("expected esbuild metafile output");
  }

  const violations: string[] = [];
  const inputPaths = Object.keys(result.metafile.inputs);
  for (const inputPath of inputPaths) {
    const input = result.metafile.inputs[inputPath];
    for (const imported of input.imports) {
      if (!imported.external) {
        continue;
      }
      if (isPathImport(imported.path)) {
        continue;
      }
      if (isBuiltin(imported.path)) {
        continue;
      }
      violations.push(`${inputPath} -> ${imported.path}`);
    }
  }

  if (violations.length === 0) {
    console.log("entrypoint import guard passed");
    return;
  }

  console.error("entrypoint import guard failed. non-builtin package imports detected:");
  for (const violation of violations.sort()) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

await checkEntrypointImports();
