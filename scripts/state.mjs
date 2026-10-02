// Reads one durable community-state snapshot and advances its data-only branch without rewriting history.
export const statePaths = ['state/claims.json', 'state/claim-protocol.json', 'data/awards.json'];

function root(config) {
  if (config.coordinator !== 'AstralDeep/astraldeep.github.io' || config.stateBranch !== 'community-state') throw new Error('Invalid community state destination');
  return `/repos/${config.coordinator}`;
}

function sha(value) {
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error('Invalid community state commit');
  return value;
}

function validate(files) {
  if (!files || Object.keys(files).sort().join('\n') !== [...statePaths].sort().join('\n')) throw new Error('Invalid community state file set');
  for (const content of Object.values(files)) {
    if (typeof content !== 'string' || Buffer.byteLength(content) > 2000000) throw new Error('Invalid community state content');
    JSON.parse(content);
  }
}

export async function readState(api, config) {
  const path = root(config);
  const head = await api.request(`${path}/git/ref/heads/${config.stateBranch}`);
  const commit = sha(head.object?.sha);
  const metadata = await api.request(`${path}/git/commits/${commit}`);
  const tree = await api.request(`${path}/git/trees/${sha(metadata.tree?.sha)}?recursive=1`);
  if (tree.truncated !== false || !Array.isArray(tree.tree)) throw new Error('Invalid community state tree');
  const invalid = tree.tree.some(entry => entry.type === 'tree'
    ? !['state', 'data'].includes(entry.path)
    : entry.type !== 'blob' || entry.mode !== '100644' || !statePaths.includes(entry.path));
  const paths = tree.tree.filter(entry => entry.type === 'blob').map(entry => entry.path).sort();
  if (invalid || paths.join('\n') !== [...statePaths].sort().join('\n')) throw new Error('Invalid community state tree');
  const files = {};
  for (const name of statePaths) {
    const file = await api.request(`${path}/contents/${name}?ref=${commit}`);
    if (file.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string' || file.content.length > 2800000) throw new Error('Invalid community state file');
    files[name] = Buffer.from(file.content, 'base64').toString('utf8');
  }
  validate(files);
  return { sha: commit, files };
}

export async function persistState(api, config, snapshot, files) {
  const path = root(config);
  sha(snapshot.sha); validate(snapshot.files); validate(files);
  const current = await readState(api, config);
  if (current.sha !== snapshot.sha || statePaths.some(name => current.files[name] !== snapshot.files[name])) throw new Error('Community state changed; retry reconciliation from its new head');
  if (statePaths.every(name => files[name] === snapshot.files[name])) return snapshot.sha;
  const tree = await api.request(`${path}/git/trees`, 'POST', {
    tree: statePaths.map(name => ({ path: name, mode: '100644', type: 'blob', content: files[name] })),
  });
  const commit = await api.request(`${path}/git/commits`, 'POST', {
    message: 'Update bounty reservations and points', tree: sha(tree.sha), parents: [snapshot.sha],
  });
  const candidate = sha(commit.sha);
  await api.request(`${path}/git/refs/heads/${config.stateBranch}`, 'PATCH', { sha: candidate, force: false });
  const verified = await readState(api, config);
  if (verified.sha !== candidate || statePaths.some(name => verified.files[name] !== files[name])) throw new Error('Community state persistence could not be verified');
  return candidate;
}
