import { GROUP_COMMANDS, validateGroupCommand } from '../extension/groups.js';

/** Thin HTTP SDK. Import from @linsoai/browser-relay/server/client.js. */
export function createClient(baseUrl = 'http://127.0.0.1:18795') {
  async function request(method, path, params = {}) {
    const url = new URL(path, baseUrl);
    const options = { method, headers: { 'Content-Type': 'application/json' } };
    if (method === 'GET') {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    } else options.body = JSON.stringify(params);
    const response = await fetch(url, options);
    const data = await response.json();
    if (!response.ok || data.ok === false) {
      throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status, ...data });
    }
    return data;
  }
  async function groupCommand(action, params = {}) {
    validateGroupCommand(action, params);
    const spec = GROUP_COMMANDS[action];
    return request(spec.method, spec.path, params);
  }
  return {
    request,
    tabs: () => request('GET', '/api/tabs'),
    groups: {
      list: (params) => groupCommand('list', params),
      tabs: (groupId) => groupCommand('tabs', { groupId }),
      create: (params) => groupCommand('create', params),
      update: (params) => groupCommand('update', params),
      addTabs: (params) => groupCommand('add-tabs', params),
      removeTabs: (chromeTabIds) => groupCommand('remove-tabs', { chromeTabIds }),
    },
  };
}
