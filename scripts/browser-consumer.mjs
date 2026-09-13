import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, firefox, webkit } from "playwright";

const directory = process.argv[2];
if (!directory)
  throw new Error(
    "usage: node scripts/browser-consumer.mjs CONSUMER_DIRECTORY",
  );
const routes = new Map([
  ["/browser.js", [join(directory, "browser.js"), "text/javascript"]],
  [
    "/wasm/flac-encoder.wasm",
    [
      join(directory, "node_modules/@misofm/codec/wasm/flac-encoder.wasm"),
      "application/wasm",
    ],
  ],
  [
    "/wasm/flac-decoder.wasm",
    [
      join(directory, "node_modules/@misofm/codec/wasm/flac-decoder.wasm"),
      "application/wasm",
    ],
  ],
]);
const server = createServer(async (request, response) => {
  try {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>Packed codec consumer</title>");
      return;
    }
    const route = routes.get(request.url);
    if (!route) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": route[1] });
    response.end(await readFile(route[0]));
  } catch (error) {
    response.writeHead(500);
    response.end(String(error));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const results = [];
try {
  for (const [name, browserType] of [
    ["chromium", chromium],
    ["firefox", firefox],
    ["webkit", webkit],
  ]) {
    const browser = await browserType.launch({
      headless: true,
      ...(name === "chromium" && process.env.CODEC_CHROMIUM_PATH
        ? { executablePath: process.env.CODEC_CHROMIUM_PATH }
        : {}),
    });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${address.port}/`);
      const result = await page.evaluate(async () => {
        const worker = new Worker("/browser.js", { type: "module" });
        try {
          return await new Promise((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error("codec worker timed out")),
              30000,
            );
            worker.onerror = (event) => {
              clearTimeout(timeout);
              reject(new Error(event.message));
            };
            worker.onmessage = ({ data }) => {
              clearTimeout(timeout);
              if (data.error) reject(new Error(data.error));
              else resolve(data);
            };
          });
        } finally {
          worker.terminate();
        }
      });
      results.push({
        browser: name,
        version: browser.version(),
        worker: result,
      });
    } finally {
      await browser.close();
    }
  }
  process.stdout.write(`${JSON.stringify(results)}\n`);
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
