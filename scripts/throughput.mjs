// Measures encode/decode throughput and scheduler dispatches of the working
// tree on Node, Bun, and browser workers. See benchmark/README.md.
//
// usage: node scripts/throughput.mjs [kinds=default] [rounds=3] [targets=node,bun,chromium,firefox,webkit]
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const kinds = (process.argv[2] ?? "default").split(",");
const rounds = Number(process.argv[3] ?? "3");
const targets = (process.argv[4] ?? "node,bun,chromium,firefox,webkit").split(
  ",",
);
const scratch = await mkdtemp(join(tmpdir(), "misofm-codec-throughput-"));

const run = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed\n${result.error ?? ""}\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout;
};

const summarize = (runtime, receipts) => {
  for (const receipt of receipts)
    process.stdout.write(
      `${runtime.padEnd(28)} ${receipt.scheduler.padEnd(8)} encode ${String(receipt.encode.milliseconds).padStart(8)} ms (${receipt.encode.realtime}x, ${receipt.encode.schedulerDispatches} dispatches, max gap ${receipt.encode.longestDispatchGapMs} ms)  decode ${String(receipt.decode.milliseconds).padStart(8)} ms (${receipt.decode.realtime}x, ${receipt.decode.schedulerDispatches} dispatches, max gap ${receipt.decode.longestDispatchGapMs} ms)\n`,
    );
};

const results = [];
try {
  // Wasm assets resolve relative to each bundle as ../wasm/*.wasm.
  await mkdir(join(scratch, "node"));
  await symlink(join(root, "wasm"), join(scratch, "wasm"));
  run("bun", [
    "build",
    "benchmark/throughput-node.ts",
    "--target=node",
    `--outfile=${join(scratch, "node", "throughput-node.js")}`,
  ]);
  run("bun", [
    "build",
    "benchmark/throughput-worker.ts",
    "--target=browser",
    `--outfile=${join(scratch, "throughput.js")}`,
  ]);
  for (const runtime of ["node", "bun"].filter((name) =>
    targets.includes(name),
  )) {
    const output = JSON.parse(
      run(runtime, [
        join(scratch, "node", "throughput-node.js"),
        kinds.join(","),
        String(rounds),
      ]).trim(),
    );
    results.push(output);
    summarize(output.runtime, output.receipts);
  }

  const server = createServer(async (request, response) => {
    const routes = {
      "/": ["text/html", null],
      "/throughput.js": ["text/javascript", join(scratch, "throughput.js")],
      "/wasm/flac-encoder.wasm": [
        "application/wasm",
        join(root, "wasm/flac-encoder.wasm"),
      ],
      "/wasm/flac-decoder.wasm": [
        "application/wasm",
        join(root, "wasm/flac-decoder.wasm"),
      ],
    };
    const route = routes[request.url];
    if (!route) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": route[0] });
    response.end(
      route[1] === null
        ? "<!doctype html><title>Codec throughput</title>"
        : await readFile(route[1]),
    );
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  try {
    for (const [name, browserType] of [
      ["chromium", chromium],
      ["firefox", firefox],
      ["webkit", webkit],
    ]) {
      if (!targets.includes(name)) continue;
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        const receipts = await page.evaluate(
          ({ kinds, rounds }) =>
            new Promise((done, fail) => {
              const worker = new Worker("/throughput.js", { type: "module" });
              worker.onerror = (event) => fail(new Error(event.message));
              worker.onmessage = ({ data }) => {
                worker.terminate();
                if (data.error) fail(new Error(data.error));
                else done(data.receipts);
              };
              worker.postMessage({ kinds, rounds });
            }),
          { kinds, rounds },
        );
        const runtime = `${name} ${browser.version()} worker`;
        results.push({ runtime, receipts });
        summarize(runtime, receipts);
      } finally {
        await browser.close();
      }
    }
  } finally {
    await new Promise((done) => server.close(done));
  }
  if (process.env.CODEC_THROUGHPUT_RECEIPT)
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(
        process.env.CODEC_THROUGHPUT_RECEIPT,
        `${JSON.stringify(results, null, 2)}\n`,
      ),
    );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
