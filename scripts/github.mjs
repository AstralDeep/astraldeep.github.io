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

  async closedBy(repository, number) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !Number.isSafeInteger(number) || number < 1) throw new Error('Invalid closure target');
    const [owner, name] = repository.split('/');
    const query = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){timelineItems(last:1,itemTypes:[CLOSED_EVENT]){nodes{... on ClosedEvent{id createdAt closer{__typename ... on PullRequest{url}}}}}}}}';
    const response = await this.transport('https://api.github.com/graphql', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'AstralDeep-community', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({ query, variables: { owner, name, number } }),
    });
    if (!response.ok) throw new Error(`GitHub closure lookup returned ${response.status}`);
    const result = await response.json();
    const nodes = result.data?.repository?.issue?.timelineItems?.nodes;
    if (result.errors || !Array.isArray(nodes)) throw new Error('Incomplete GitHub closure evidence');
    return nodes[0] || null;
  }
}
