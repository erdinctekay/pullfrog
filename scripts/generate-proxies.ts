import { mkdirSync, writeFileSync } from "node:fs";

const proxies = [
  { dest: "dist/index.js", source: "../index.ts" },
  { dest: "dist/internal.js", source: "../internal/index.ts" },
];

mkdirSync("dist", { recursive: true });

for (const proxy of proxies) {
  writeFileSync(proxy.dest, `export * from "${proxy.source}";\n`);
  writeFileSync(proxy.dest.replace(/\.js$/, ".d.ts"), `export * from "${proxy.source}";\n`);
}
