# Working-tab indicator

The working tab keeps its website title. A multicolor, softly diffused glow wraps the
page edge while Browser Relay is reading or acting on the page.
The website favicon keeps its identity with a green status dot in its lower
right corner, sized to remain visible in a normal 16px browser tab icon. The
toolbar badge is a steady dot during work, rather than a rapidly changing
spinner. Reduced-motion settings use a steady glow and dot.

Opening an ordinary tab, automatically attaching the debugger, enabling log
capture, discovering tabs, claiming a session or sending heartbeats does not
start the effect. Modern activity follows the executing task, including waits;
legacy CDP activity excludes connection setup and discovery commands.

The old title animation mistakenly treated every forwarded CDP command as work.
The daemon enables Runtime/Log capture whenever a tab attaches, so merely opening
a page triggered the blue/white title prefix. Activity now begins at the task
boundary, with an explicit classifier for legacy commands.

The indicator coalesces short operations with a 600 ms settling interval and
clears on cancellation, disconnect or tab closure. Navigation transfers an
active task's effect to the new main document. A page-side lease restores the
favicon and removes the edge light if the extension stops renewing it.

Icons come from Chrome's local favicon cache via the
[`favicon` API](https://developer.chrome.com/docs/extensions/how-to/ui/favicons).
This requires the `favicon` permission; the extension already requests `tabs`,
so Chrome documents no additional permission warning for this combination.
No external favicon service is used. Rendering or injection failure is cosmetic
and must never fail or repeat a browser action.

Chrome can retain an existing favicon candidate even after another link is
appended. While active, the indicator therefore decorates existing icon links
and preserves their attributes. Cleanup restores the latest site-owned values,
including title/icon updates made by the website during work. No title is
rewritten. The edge light uses a closed shadow root, fixed positioning,
`pointer-events: none`, `inert` and `aria-hidden`. It does not change the website
layout, intercept input or enter the accessibility tree. The light fades in
and out over 360ms. Four soft color pools move in two independent fields:
cyan/violet and pink/amber. Their unequal 3.8s and 5.1s alternating timelines
use different phases, asymmetric paths, scale changes and local opacity shifts.
There is no full-perimeter rotation or synchronized breathing. Changes unfold
locally over roughly one or two seconds instead of a slow rainbow circuit.
A faint static spectrum keeps inactive areas from becoming completely dark.
Two restrained, fully blurred layers (9px close bloom and 20px diffusion) soften
the edges. Both use square extents with no rounded frame or crisp border layer.
Only opacity and the color-field transforms animate; the edge mask stays still,
and gradients and blur radii remain fixed. The central page content stays clear,
printing hides the decoration, and reduced-motion mode stops both fields.

Validation: `node --test tests/activity.test.mjs` and
`BROWSER_RELAY_E2E=1 node --test tests/browser-activity.test.mjs`. The browser
regression checks actual Chrome favicon selection, ordinary tabs opened before
and during work, icon restoration, cancellation, navigation, reduced motion,
page-side expiry, overlay isolation, click-through and rapid stop/start cleanup.
The fixture is `tests/fixtures/activity.html`.
