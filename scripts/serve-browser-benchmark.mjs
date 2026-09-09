import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
const html = await readFile(
  new URL(
    `../tests/fixtures/${process.argv[2] === "gaps" ? "browser-gaps.html" : "automation.html"}`,
    import.meta.url,
  ),
  "utf8",
);
const server = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(
    req.url.startsWith("/frame")
      ? `<title>Frame</title><button onclick="this.textContent='Frame done'">${req.url.includes("cross") ? "Cross frame" : "Frame action"}</button>`
      : html,
  );
});
server.listen(Number(process.env.PORT || 0), "127.0.0.1", () =>
  console.log(`Benchmark fixture: http://127.0.0.1:${server.address().port}/`),
);
