// Makes bounded GitHub API requests for the synchronizer without exposing credentials to the browser.
export class GitHub {
  constructor(token = '', transport = fetch) {
    this.token = token;
    this.transport = transport;
  }

  async request(path, method = 'GET', body) {
    if (!path.startsWith('/repos/') || path.includes('..') || /[\r\n]/.test(path)) throw new Error('Invalid GitHub API path');
    const response = await this.transport(`https://api.github.com${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'AstralDeep-community', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`GitHub ${method} ${path.split('?')[0]} returned ${response.status}`);
    return response.status === 204 ? null : response.json();
  }

  async pages(path) {
    const items = [];
    for (let page = 1; page <= 100; page += 1) {
      const data = await this.request(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      if (!Array.isArray(data)) throw new Error('Expected a paginated GitHub list');
      items.push(...data);
      if (data.length < 100) return items;
    }
    throw new Error('Pagination limit reached; refusing incomplete board data');
  }
}
