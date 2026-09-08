import repl from "node:repl";
import { PassThrough } from "node:stream";
import { inspect } from "node:util";
import { createBrowser } from "./sdk.js";

// This process is an interruption/crash boundary for TRUSTED agent code, not a
// security sandbox. It is only launched by local CLI/MCP, never by the HTTP hub.
const input = new PassThrough(),
  output = new PassThrough();
output.resume();
const runtime = repl.start({
  prompt: "",
  input,
  output,
  terminal: false,
  useGlobal: false,
  ignoreUndefined: true,
});
const pending = new Map();
let nextId = 0,
  content = [],
  textBytes = 0,
  imageBytes = 0;
const send = (value) => process.send?.(value);
function write(value) {
  const text =
    typeof value === "string"
      ? value
      : inspect(value, { depth: 5, maxArrayLength: 50, breakLength: 100 });
  if (textBytes > 100000) return;
  textBytes += text.length;
  content.push({ type: "text", text: text.slice(0, 100000) });
}
function image(value) {
  const shot = value?.observation?.data ? value.observation : value;
  if (!shot?.data || shot.format !== "png")
    throw new Error("display() expects a Browser Relay screenshot");
  if (imageBytes + shot.data.length > 24_000_000)
    throw new Error(
      "Image output exceeds this call's limit; use fewer screenshots or a smaller clip",
    );
  imageBytes += shot.data.length;
  content.push({ type: "image", data: shot.data, mimeType: "image/png" });
  const { data, ...meta } = shot;
  write(meta);
}
const request = (method, path, body) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    send({ type: "request", id, method, path, body });
  });
runtime.context.browser = createBrowser({ request });
runtime.context.display = image;
runtime.context.print = write;
runtime.context.console = {
  log: (...v) => v.forEach(write),
  error: (...v) => v.forEach(write),
  warn: (...v) => v.forEach(write),
};
process.on("message", (message) => {
  if (message.type === "response") {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error)
      waiter.reject(
        Object.assign(new Error(message.error.message), message.error),
      );
    else waiter.resolve(message.result);
  }
  if (message.type === "exec") {
    content = [];
    textBytes = 0;
    imageBytes = 0;
    runtime.eval(
      message.code + "\n",
      runtime.context,
      "browser-relay-exec",
      (error, result) => {
        if (error) write(`${error.name}: ${error.message}`);
        else if (result !== undefined) {
          const observation = result?.observation || result;
          if (observation?.data && observation.format === "png")
            image(observation);
          else write(result);
        }
        send({ type: "result", id: message.id, content, isError: !!error });
      },
    );
  }
});
process.on("disconnect", () => process.exit(0));
