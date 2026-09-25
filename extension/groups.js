// Shared contract, used by the extension, HTTP router and MCP tools.
export const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']
const id = { type: 'integer', minimum: 0 }
const members = { type: 'array', minItems: 1, uniqueItems: true, items: id, description: 'Native numeric Chrome tab IDs, not CDP target IDs' }
const properties = {
  title: { type: 'string' },
  color: { type: 'string', enum: GROUP_COLORS },
  collapsed: { type: 'boolean' },
}
export const GROUP_COMMANDS = {
  list: { method: 'GET', path: '/api/groups', properties: { windowId: id, title: { type: 'string', description: 'Exact title; returns all matches' } }, required: [] },
  tabs: { method: 'GET', path: '/api/groups/tabs', properties: { groupId: id }, required: ['groupId'] },
  create: { method: 'POST', path: '/api/groups/create', properties: { chromeTabIds: members, ...properties }, required: ['chromeTabIds'] },
  update: { method: 'POST', path: '/api/groups/update', properties: { groupId: id, ...properties }, required: ['groupId'] },
  'add-tabs': { method: 'POST', path: '/api/groups/add-tabs', properties: { groupId: id, chromeTabIds: members }, required: ['groupId', 'chromeTabIds'] },
  'remove-tabs': { method: 'POST', path: '/api/groups/remove-tabs', properties: { chromeTabIds: members }, required: ['chromeTabIds'] },
}

export function groupError(message, status = 400, code = 'INVALID_ARGUMENT', details = {}) {
  return Object.assign(new Error(message), { status, code, ...details })
}

export function validateGroupCommand(action, params) {
  const spec = Object.hasOwn(GROUP_COMMANDS, action) ? GROUP_COMMANDS[action] : null
  if (!spec) throw groupError(`Unknown group command: ${action}`)
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw groupError('Expected an object')
  for (const key of Object.keys(params)) {
    if (!Object.hasOwn(spec.properties, key)) throw groupError(`Unknown parameter: ${key}`)
  }
  for (const key of spec.required) {
    if (params[key] === undefined) throw groupError(`${key} is required`)
  }
  for (const key of ['groupId', 'windowId']) {
    if (params[key] !== undefined && (!Number.isSafeInteger(params[key]) || params[key] < 0)) throw groupError(`${key} must be a non-negative integer`)
  }
  if (params.chromeTabIds !== undefined) {
    const ids = params.chromeTabIds
    if (!Array.isArray(ids) || !ids.length || ids.some(value => !Number.isSafeInteger(value) || value < 0) || new Set(ids).size !== ids.length) {
      throw groupError('chromeTabIds must be a non-empty array of unique non-negative integers')
    }
  }
  if (params.title !== undefined && typeof params.title !== 'string') throw groupError('title must be a string')
  if (params.color !== undefined && !GROUP_COLORS.includes(params.color)) throw groupError(`color must be one of: ${GROUP_COLORS.join(', ')}`)
  if (params.collapsed !== undefined && typeof params.collapsed !== 'boolean') throw groupError('collapsed must be a boolean')
  if (action === 'update' && !Object.keys(properties).some(key => params[key] !== undefined)) throw groupError('update requires title, color or collapsed')
  return params
}

export function createBrowserCommandHandler(chrome, attachedTabs, publicTabId = () => null) {
  function tabInfo(tab) {
    const attached = attachedTabs.get(tab.id)
    const connected = attached?.state === 'connected'
    return { id: connected ? publicTabId(tab.id) : null,
      chromeTabId: tab.id, windowId: tab.windowId, groupId: tab.groupId ?? -1,
      title: tab.title || '', url: tab.url || '', attached: connected }
  }
  function groupInfo(group) {
    return { id: group.id, title: group.title || '', color: group.color, windowId: group.windowId, collapsed: group.collapsed }
  }
  async function getGroup(groupId) {
    try { return await chrome.tabGroups.get(groupId) }
    catch { throw groupError(`No accessible group with groupId: ${groupId}`, 404, 'GROUP_NOT_FOUND') }
  }
  async function getMembers(ids) {
    return Promise.all(ids.map(async chromeTabId => {
      try { return await chrome.tabs.get(chromeTabId) }
      catch { throw groupError(`No accessible tab with chromeTabId: ${chromeTabId}`, 404, 'TAB_NOT_FOUND') }
    }))
  }
  return async function handleBrowserCommand(method, params = {}) {
    if (method === 'tabs.list') {
      return { tabs: (await chrome.tabs.query({})).map(tabInfo).filter(tab => tab.attached) }
    }
    if (!method.startsWith('groups.')) throw groupError(`Unknown browser command: ${method}`)
    const action = method.slice(7)
    validateGroupCommand(action, params)
    if (!chrome.tabGroups) throw groupError('Tab groups unavailable; reload the extension with tabGroups permission', 503, 'GROUPS_UNAVAILABLE')
    if (action === 'list') {
      const query = params.windowId === undefined ? {} : { windowId: params.windowId }
      const groups = (await chrome.tabGroups.query(query)).filter(group => params.title === undefined || (group.title || '') === params.title)
      return { groups: groups.map(groupInfo) }
    }
    if (action === 'tabs') {
      await getGroup(params.groupId)
      return { tabs: (await chrome.tabs.query({ groupId: params.groupId })).map(tabInfo) }
    }
    const changes = Object.fromEntries(Object.keys(properties).filter(key => params[key] !== undefined).map(key => [key, params[key]]))
    if (action === 'update') {
      await getGroup(params.groupId)
      return { group: groupInfo(await chrome.tabGroups.update(params.groupId, changes)) }
    }
    const tabs = await getMembers(params.chromeTabIds)
    if (action === 'remove-tabs') {
      await chrome.tabs.ungroup(params.chromeTabIds)
      return { chromeTabIds: params.chromeTabIds }
    }
    const existingGroup = action === 'add-tabs' ? await getGroup(params.groupId) : null
    const windowId = existingGroup?.windowId ?? tabs[0].windowId
    if (tabs.some(tab => tab.windowId !== windowId)) throw groupError('All tabs and the destination group must be in the same window', 409, 'CROSS_WINDOW')
    const groupId = await chrome.tabs.group({ tabIds: params.chromeTabIds, ...(existingGroup ? { groupId: params.groupId } : { createProperties: { windowId } }) })
    try {
      const group = Object.keys(changes).length ? await chrome.tabGroups.update(groupId, changes) : await getGroup(groupId)
      return { group: groupInfo(group) }
    } catch (err) {
      throw groupError(`Tabs were grouped, but reading/updating the group failed: ${err.message}`, 502, 'PARTIAL_SUCCESS', { partial: true, groupId })
    }
  }
}
