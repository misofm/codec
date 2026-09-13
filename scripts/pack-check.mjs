import { spawnSync } from "node:child_process";
import { COPYFILE_EXCL } from "node:constants";
import { createHash } from "node:crypto";
import {
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(join(tmpdir(), "misofm-codec-packed-"));
const peers = ["4.0.0-rc.112", "4.0.0-rc.115"];
const receipts = [];
const packSource = process.env.CODEC_PACK_SOURCE;
const expectedSha256 = process.env.CODEC_PACK_EXPECTED_SHA256;
const destination = process.env.CODEC_PACK_DESTINATION
  ? resolve(process.env.CODEC_PACK_DESTINATION)
  : undefined;
const isWithin = (parent, target) => {
  const fromParent = relative(parent, target);
  return (
    fromParent === "" ||
    (!isAbsolute(fromParent) &&
      fromParent !== ".." &&
      !fromParent.startsWith(`..${sep}`))
  );
};
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
  if (expectedSha256 && !/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error(
      "CODEC_PACK_EXPECTED_SHA256 must be 64 lowercase hex digits",
    );
  }
  if (destination) {
    const [rootPath, destinationPath, destinationStat] = await Promise.all([
      realpath(root),
      realpath(destination),
      stat(destination),
    ]);
    if (!destinationStat.isDirectory() || isWithin(rootPath, destinationPath)) {
      throw new Error(
        "CODEC_PACK_DESTINATION must be an existing directory outside the repository",
      );
    }
    if ((await readdir(destinationPath)).length !== 0) {
      throw new Error("CODEC_PACK_DESTINATION must be empty");
    }
    if (process.env.CODEC_PACK_RECEIPT) {
      const receiptPath = resolve(process.env.CODEC_PACK_RECEIPT);
      const receiptDirectory = await realpath(dirname(receiptPath));
      if (isWithin(destinationPath, receiptDirectory)) {
        throw new Error(
          "CODEC_PACK_RECEIPT must be outside CODEC_PACK_DESTINATION",
        );
      }
    }
  }

  if (!packSource) run("bun", ["run", "build"], root);
  const [packed] = JSON.parse(
    run(
      "npm",
      [
        "pack",
        packSource ?? root,
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        scratch,
      ],
      root,
    ),
  );
  if (!packed?.filename || !Array.isArray(packed.files)) {
    throw new Error("npm pack did not return one complete package description");
  }
  const expectedPackage = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  if (
    packed.name !== expectedPackage.name ||
    packed.version !== expectedPackage.version
  ) {
    throw new Error(
      `packed identity ${packed.name}@${packed.version} does not match ${expectedPackage.name}@${expectedPackage.version}`,
    );
  }
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
  const tarballBytes = await readFile(tarball);
  const hash = createHash("sha256").update(tarballBytes).digest("hex");
  const integrity = `sha512-${createHash("sha512")
    .update(tarballBytes)
    .digest("base64")}`;
  if (packed.integrity && packed.integrity !== integrity) {
    throw new Error(
      `npm pack integrity ${packed.integrity} does not match computed ${integrity}`,
    );
  }
  if (expectedSha256 && expectedSha256 !== hash) {
    throw new Error(
      `packed tarball SHA-256 ${hash} does not match expected ${expectedSha256}`,
    );
  }
  const packedManifest = JSON.parse(
    run("tar", ["-xOf", tarball, "package/package.json"], root),
  );
  if (
    packedManifest.name !== expectedPackage.name ||
    packedManifest.version !== expectedPackage.version ||
    packedManifest.repository?.type !== expectedPackage.repository.type ||
    packedManifest.repository?.url !== expectedPackage.repository.url
  ) {
    throw new Error("packed package manifest has an unexpected identity");
  }
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
    tarballFilename: packed.filename,
    tarballSha256: hash,
    tarballIntegrity: integrity,
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
  if (destination) {
    const retainedTarball = join(destination, packed.filename);
    await copyFile(tarball, retainedTarball, COPYFILE_EXCL);
    const retainedHash = createHash("sha256")
      .update(await readFile(retainedTarball))
      .digest("hex");
    if (retainedHash !== hash) {
      await rm(retainedTarball, { force: true });
      throw new Error("retained tarball differs from the tested tarball");
    }
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
