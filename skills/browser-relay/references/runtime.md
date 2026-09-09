# JavaScript runtime and browser actions

Use MCP `browser_exec({code, sessionId?, timeoutMs?})`. Each named session retains
top-level variables, `await`, and browser handles. Default timeout is 30 seconds,
maximum 120 seconds; a timeout kills that runtime and requests cancellation of
its pending browser tasks. `browser_exec_reset` discards one named session.
This is trusted local execution, not an OS security sandbox or page `eval`.

```js
var tabs = await browser.tabs();
print(tabs);
// Select the actual returned id for the task's URL/title.
var tab = browser.tab(tabs.find(t => t.url === 'https://example.com/app').id);
print(await tab.snapshot({diff:false}));
```

Keep the same variable bindings in later calls. All snippets must use targets
observed in the actual page; names below only illustrate the interface.

```js
var result = await tab.act([
  {type:'fill', target:{role:'textbox',name:'Search'}, text:'invoice'},
  {type:'select', target:{role:'combobox',name:'Owner'}, value:'alice'},
  {type:'check', target:{role:'checkbox',name:'Active only'}, checked:true},
  {type:'click', target:{role:'button',name:'Search records'}},
  {type:'wait', target:{selector:'[data-ready]'}, state:'visible'}
]);
print(result.observation.snapshot);
```

## SDK

Application code can use `import {createBrowser} from '@linsoai/browser-relay/sdk'`.
`createBrowser()` uses `BROWSER_RELAY_URL` or the remote device/host environment
variables. Inject `request(method,path,body)` for another transport.

| API | Result / purpose |
| --- | --- |
| `browser.tabs()` | Current `{id,title,url}` entries |
| `browser.tab(id)` | Handle for an existing discovered tab |
| `browser.open(url)` | New background tab handle |
| `browser.capabilities()` | Negotiated executor capabilities |
| `tab.snapshot({diff?,includeNodes?,maxLength?})` | AX text, URL, title, frames, viewport; default diff=true |
| `tab.screenshot({fullPage?,clip?})` | PNG base64, dimensions, screenshotId, imageToViewport |
| `tab.act(actions,{observe?,async?,timeoutMs?,diff?})` | Task with partial results and final observation |
| `tab.ref(ref)` / `tab.locator(css,{frameId?})` / `tab.getByRole(role,{name,frameId?,exact?})` | Locator handle |
| Locator `.click()` / `.doubleClick()` / `.fill(text)` / `.type(text)` | Action + resulting snapshot |
| Locator `.select(value)` / `.check(bool)` / `.hover()` / `.waitFor({state,timeoutMs})` | Action + resulting snapshot |
| Locator `.getByRole(role,{name,exact?})` | Descendant semantic locator scoped to this parent |
| `tab.clickAt(x,y,{screenshotId?,allowFocus?})` | Visual click |
| `tab.drag({x,y},{x,y},{screenshotId?,allowFocus?})` | Press, movement path, release |
| `tab.key('Control+A')` / `tab.scroll(deltaY,{x,y})` | Keyboard / wheel |
| `tab.goto(url)` / `tab.close()` | Explicit navigation / close |
| `tab.eval(expression)` | Page-context JavaScript; no access to SDK objects |
| `browser.tasks.get(id)` / `.wait(id)` / `.cancel(id)` | Inspect / await / cancel a job |

For efficiency, prefer `act` over multiple locator calls when several operations
are already determined. An action group is serialized as a whole at the
extension, so remote links do not carry each low-level CDP command separately.
`observe:'none'` suppresses the final snapshot only when another reliable check
is supplied by the workflow. `observe:'screenshot'` returns visual evidence.

## Action schema

Each action has `type`. A target is `{ref}`, `{selector,frameId?}`, or
`{role,name?,exact?,frameId?,scope?}`. Matching must be unique. Defaults are exact names.
`scope` is another observed target identifying an ancestor in the same document;
nesting is bounded. A snapshot's `within` points to its named container ref;
`includeNodes` also supplies `parentRef`. For example:

```js
await tab.getByRole('group',{name:'South'})
  .getByRole('button',{name:'Save'}).click({timeoutMs:1500});
// Equivalent batch target:
// {role:'button',name:'Save',scope:{role:'group',name:'South'}}
```

Cross-origin iframe and shadow DOM refs are resolved by Chrome's AX/CDP APIs.
Unavailable frames are listed in snapshot `warnings`, never silently guessed.

- `click`, `double_click`, `hover`: `target`, or numeric `x,y`; optional `button`
  (`left`, `middle`, `right`), `screenshotId`, `allowFocus`.
- `move`: numeric `x,y`, optional screenshotId/allowFocus.
- `drag`: starting `x,y`, `to:{x,y}` or `path:[{x,y},...]`; optional screenshotId.
- `fill`, `type`: `text`, optional `target`; fill requires a target. `clear:true`
  selects existing text. `submit:true` presses Enter after typing.
- `select`: `target`, `value` string or array of option values. Disabled options
  and disabled optgroups are rejected without changing the selection.
- `check`: `target`, boolean `checked`; native inputs and ARIA checkbox/radio/switch.
  Already-correct state is a no-op. Foreground changes dispatch mouse input and
  verify checked state; background DOM fallback reports `strategy:'dom'` and
  does not imply a trusted mouse event. A radio cannot be directly unchecked.
- `key`: `key`, e.g. `Enter`, `Escape`, `Control+A`, `Meta+A`, `Shift+Tab`.
- `scroll`: `target` or numeric `x,y`, plus `deltaX` and/or `deltaY` in pixels.
- `wait`: `target`, state `attached|visible|hidden|detached|enabled`, timeoutMs 1–20000.
- `navigate`: HTTP(S) `url`, or `about:blank`.

Target actions accept optional `timeoutMs` (1–20000) for readiness checks:
appearance, visibility, enabled state, occlusion, and pointer target stability.
Without it, readiness errors fail immediately. This is distinct from the task
timeout below. Waiting is cancellable; ambiguous targets, invalid selectors, and
stale refs are not silently retargeted. Once input has been dispatched, it is
never replayed. Parent iframe hit-testing checks the actual action point.
Locator `select(value, options)`, `check(checked, options)`, and `hover(options)`
accept the same action options.

A group contains 1–100 operations. Default task timeout is 20 seconds; maximum
120 seconds. Use async tasks when execution may exceed the local relay's
30-second command transport timeout. Task IDs and runtime bindings are separate
from tab IDs. Task history is bounded and does not survive extension restart.

```js
var job = await tab.act([{type:'wait',target:{selector:'.report-ready'},timeoutMs:20000}], {async:true});
print(job.id);
// Work on an independent tab, then:
print(await browser.tasks.wait(job.id));
```

## Images and coordinates

```js
var shot = await tab.screenshot();
display(shot);
// After inspecting the image, use its actual coordinates:
await tab.clickAt(420,180,{screenshotId:shot.screenshotId});
```

Image coordinates map to CSS viewport coordinates as
`x * scaleX + offsetX`, `y * scaleY + offsetY`. The executor validates viewport,
scroll position and URL before applying a screenshot-based coordinate. Screenshot
identity cannot detect every DOM animation; capture again if the UI changed.
`clip` is a document-CSS rectangle `{x,y,width,height}`. Full-page images can be
larger than the visible viewport; scroll to offscreen elements first.

## CLI / MCP / HTTP

CLI `exec --file workflow.js --json` returns mixed text/image content. Use
`--output screenshot.png` for a script that emits one image to a file. CLI `repl`
reads one JSON object per line (`{"code":"...","sessionId":"work"}`) and emits
one JSON result per line. Separate `exec` processes do not share JS variables.

Modern HTTP endpoints (also forwarded by the remote hub):

| Method | Path | Input |
| --- | --- | --- |
| GET | `/api/capabilities` | — |
| POST | `/api/observe` | tabId, mode, diff, sessionId, maxLength, includeNodes |
| POST | `/api/actions` | tabId, actions, observe, async, timeoutMs, sessionId |
| GET | `/api/tasks/:id` | — |
| POST | `/api/tasks/:id/cancel` | `{}` |
| POST | `/api/tabs/create` | url |
| POST | `/api/tabs/close` | tabId |

MCP exposes browser_observe, browser_actions, browser_task, browser_exec and
browser_exec_reset, plus the original tools. Screenshot results are image blocks.
Both NDJSON MCP stdio and legacy Content-Length framing are accepted.
There is deliberately no HTTP endpoint for executing local OS JavaScript.

## Playwright interoperability

```js
const browser = await chromium.connectOverCDP('http://127.0.0.1:18795');
const context = browser.contexts()[0];
// Discover/select a page from context.pages(); reuse the user's default context.
```

The local `/cdp` bridge gives each client virtual sessions and preserves the
extension attachment when clients disconnect. Browser profiles, creating
incognito contexts and window resizing are outside this bridge's contract.
Native Chrome downloads retain the user's configured download behavior.
This CDP endpoint is local-only; remote workflows use SDK/HTTP actions.
