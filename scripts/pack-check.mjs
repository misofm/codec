import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, cp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(join(tmpdir(), "misofm-codec-packed-"));
const peers = ["4.0.0-rc.112", "4.0.0-rc.115"];
const receipts = [];
const run = (command, args, cwd) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed\n${result.error ?? ""}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
};

try {
  run("bun", ["run", "build"], root);
  const [packed] = JSON.parse(
    run("npm", ["pack", "--json", "--pack-destination", scratch], root),
  );
  const names = packed.files.map((file) => file.path);
  for (const required of [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/node.js",
    "wasm/flac-encoder.wasm",
    "wasm/flac-decoder.wasm",
    "THIRD_PARTY_NOTICES.md",
    "docs/architecture.md",
    "docs/adapter-integration.md",
    "vendor/licenses/libFLAC.txt",
  ]) {
    if (!names.includes(required))
      throw new Error(`packed package lacks ${required}`);
  }
  for (const name of names) {
    if (
      /^(node_modules|\.cache|native|test|consumer)\//.test(name) ||
      name.endsWith(".tar.xz")
    ) {
      throw new Error(`unexpected packed file: ${name}`);
    }
  }
  const tarball = join(scratch, packed.filename);
  const hash = createHash("sha256")
    .update(await readFile(tarball))
    .digest("hex");
  for (const peer of peers) {
    const directory = join(scratch, peer);
    await mkdir(directory);
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify(
        {
          name: "isolated-codec-consumer",
          private: true,
          type: "module",
          dependencies: { "@misofm/codec": `file:${tarball}`, effect: peer },
          devDependencies: { typescript: "5.9.3", "@types/node": "22.20.2" },
        },
        null,
        2,
      ),
    );
    await cp(join(root, "consumer"), join(directory, "consumer"), {
      recursive: true,
    });
    run("bun", ["install", "--ignore-scripts"], directory);
    await writeFile(
      join(directory, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            lib: ["ES2022", "DOM"],
            strict: true,
            exactOptionalPropertyTypes: true,
            noUncheckedIndexedAccess: true,
            skipLibCheck: true,
            outDir: "compiled",
            types: ["node"],
          },
          include: ["consumer/**/*.ts"],
        },
        null,
        2,
      ),
    );
    run(
      "node",
      ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"],
      directory,
    );
    const bun = JSON.parse(
      run("bun", ["compiled/server.js"], directory).trim(),
    );
    const node = JSON.parse(
      run("node", ["compiled/server.js"], directory).trim(),
    );
    // Bun bundles the installed tarball's portable entrypoint; no repository alias.
    run(
      "bun",
      [
        "build",
        "./consumer/browser.ts",
        "--target=browser",
        "--outfile=browser.js",
      ],
      directory,
    );
    const bundle = await readFile(join(directory, "browser.js"), "utf8");
    if (/node:(?:fs|crypto|path)|require\(["'](?:fs|path)["']\)/.test(bundle)) {
      throw new Error("portable browser bundle contains a server dependency");
    }
    const browser = JSON.parse(
      run(
        "node",
        [join(root, "scripts/browser-consumer.mjs"), directory],
        root,
      ).trim(),
    );
    receipts.push({ effect: peer, bun, node, browser });
    process.stdout.write(
      `packed consumer passed: Effect ${peer}, Bun, Node, Chromium/Firefox/WebKit\n`,
    );
  }
  const report = {
    tarballSha256: hash,
    packedBytes: packed.size,
    unpackedBytes: packed.unpackedSize,
    files: names,
    consumers: receipts,
  };
  if (process.env.CODEC_PACK_RECEIPT) {
    await writeFile(
      resolve(process.env.CODEC_PACK_RECEIPT),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
