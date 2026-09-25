# Chrome tab groups

Requires the group-capable CLI and Chrome extension (introduced in 1.5.5).
Use the same local or configured remote connection for discovery and subsequent
operations. CLI group commands accept `--remote <alias>` and `--remote-host`;
they do not accept `--session`. Page reads/actions still use a distinct session.

## Discover and read

```bash
browser-relay groups list --title 'Project A'
browser-relay groups list --window-id <returned-window-id>
browser-relay groups tabs --group-id <returned-group-id>
browser-relay read --tab <member-id> --session <task-name>
```

`list` returns `{ok,groups}`; groups contain `id`, `title`, `color`, `windowId`
and `collapsed`. Title matching is exact and returns all duplicates. Select by
window as well as title when needed. Group IDs last only for a browser session.

`tabs` returns `{ok,tabs}` with all accessible members, including unattached
pages. Each member has `id`, `chromeTabId`, `windowId`, `groupId`, `title`, `url`
and `attached`. Use the public `t_…` string `id` for reading/actions; use numeric
`chromeTabId` for group mutations. Unattached members have `id:null`; report
that limitation when reading a group instead of silently omitting those pages.
Ungrouped pages have `groupId:-1` and are not included in a group's members.
Collapsed groups can be queried without expanding them.

## Manage

Replace placeholders with IDs from discovery. Perform only the organization
the user requested, then query the affected group or tabs to verify the result.

```bash
browser-relay groups create --chrome-tab-ids <id1>,<id2> --title 'Research' --color blue
browser-relay groups update --group-id <group-id> --title '' --collapsed false
browser-relay groups add-tabs --group-id <group-id> --chrome-tab-ids <id1>,<id2>
browser-relay groups remove-tabs --chrome-tab-ids <id1>,<id2>
```

Creation requires at least one member. Adding a tab already in another group
moves it. Tabs and destination group must share a window; cross-window grouping
returns `CROSS_WINDOW`. Removing members keeps their pages open; an empty group
disappears. Valid colors: grey, blue, red, yellow, green, pink, purple, cyan,
orange. Empty title and `collapsed:false` are valid updates.

If `PARTIAL_SUCCESS` includes `partial:true` and `groupId`, grouping already
happened. Query that ID and retry only the failed property update. CLI emits
these details to stderr; SDK errors retain them in `error.payload`; MCP returns
an error result. Rediscover stale IDs before further changes.

## SDK and MCP

The runtime's `browser` and the SDK's `createBrowser()` expose:

```js
await browser.groups.list({title: 'Project A'}); // optional title/windowId
await browser.groups.tabs(groupId);
await browser.groups.create({chromeTabIds, title: 'Research', color: 'blue'});
await browser.groups.update({groupId, title: '', collapsed: false});
await browser.groups.addTabs({groupId, chromeTabIds});
await browser.groups.removeTabs(chromeTabIds);
```

Each returns the HTTP result envelope: `{ok,groups}`, `{ok,tabs}`, `{ok,group}`
or `{ok,chromeTabIds}`. MCP equivalents are `browser_groups_list`,
`browser_groups_tabs`, `browser_groups_create`, `browser_groups_update`,
`browser_groups_add_tabs` and `browser_groups_remove_tabs`. MCP remove-tabs takes
`{chromeTabIds}`; the SDK method takes the array directly.
