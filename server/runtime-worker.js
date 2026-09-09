import repl from "node:repl";
import { PassThrough } from "node:stream";
import { inspect } from "node:util";
import { randomUUID } from "node:crypto";
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
const outputCache = new Map();
const OUTPUT_LIMIT = 100000, CACHE_LIMIT = 4_000_000;
let nextId = 0,
  content = [],
  textBytes = 0,
  imageBytes = 0,
  overflow = [],
  overflowLength = 0,
  cacheExceeded = false;
const send = (value) => process.send?.(value);
function write(value) {
  const text =
    typeof value === "string"
      ? value
      : inspect(value, { depth: null, maxArrayLength: null, maxStringLength: null, breakLength: 100 });
  let end = overflow.length ? 0 : Math.min(text.length, OUTPUT_LIMIT - textBytes);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end-1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  textBytes += end;
  if (end) content.push({ type: "text", text: text.slice(0, end) });
  if (text.length > end) {
    const tail = text.slice(end);
    const available = Math.max(0, CACHE_LIMIT - overflowLength - (overflow.length ? 1 : 0));
    let take = Math.min(tail.length, available);
    if (take < tail.length && /[\uD800-\uDBFF]/.test(tail[take-1]) && /[\uDC00-\uDFFF]/.test(tail[take])) take--;
    if (take) {
      overflow.push(tail.slice(0, take));
      overflowLength += take + (overflow.length > 1 ? 1 : 0);
    }
    if (tail.length > available) cacheExceeded = true;
  }
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
runtime.context.browser = createBrowser({
  request,
  sessionId: process.env.BROWSER_RELAY_RUNTIME_SESSION_ID,
});
runtime.context.display = image;
runtime.context.print = write;
runtime.context.readOutput = (cursor) => {
  if (!outputCache.has(cursor))
    throw Object.assign(new Error("Runtime output expired; use the retained result variable or capture it again"), { code: "stale_output" });
  write(outputCache.get(cursor));
};
runtime.context.console = {
  log: (...v) => v.forEach(write),
  error: (...v) => v.forEach(write),
  warn: (...v) => v.forEach(write),
};
// Node REPL routes rejected top-level await through its domain instead of the
// eval callback. Bridge that path so a browser error is returned immediately.
let finishRun;
runtime._domain.on("error", (error) => finishRun?.(error));
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
    overflow = [];
    overflowLength = 0;
    cacheExceeded = false;
    let finished = false;
    const complete = (error, result) => {
      if (finished) return;
      finished = true;
      finishRun = undefined;
      try {
        if (error)
          write({
            error: error.name,
            message: error.message,
            code: error.code,
            ...(error.payload ? { details: error.payload } : {}),
          });
        else if (result !== undefined) {
          const observation = result?.observation || result;
          if (observation?.data && observation.format === "png")
            image(observation);
          else if (observation?.screenshot) {
            image(observation.screenshot);
            const { screenshot, ...state } = observation;
            write(state);
          } else write(result);
        }
      } catch (outputError) {
        error = outputError;
        write({ error: outputError.name, message: outputError.message });
      }
      let runtimeOutput;
      if (overflow.length) {
        const cursor = `output_${randomUUID()}`;
        while (outputCache.size >= 3) outputCache.delete(outputCache.keys().next().value);
        outputCache.set(cursor, overflow.join("\n"));
        runtimeOutput = {
          truncated: true, nextCursor: cursor,
          remainingCharacters: overflowLength,
          readWith: `readOutput(${JSON.stringify(cursor)})`,
          ...(cacheExceeded ? {code:"output_cache_limit",message:"Runtime output exceeded the 4M-character continuation cache. Preserve large results in variables and print selected parts."} : {}),
        };
        // This control block has its own budget, so a clipped observation cannot
        // hide the cursor needed to recover its text and browser-page metadata.
        content.push({ type: "text", text: JSON.stringify({runtimeOutput}) });
      }
      send({ type: "result", id: message.id, content, isError: !!error || cacheExceeded, ...(runtimeOutput ? {runtimeOutput} : {}) });
    };
    finishRun = complete;
    try {
      runtime.eval(
        message.code + "\n",
        runtime.context,
        "browser-relay-exec",
        complete,
      );
    } catch (error) {
      complete(error);
    }
  }
});
process.on("disconnect", () => process.exit(0));
