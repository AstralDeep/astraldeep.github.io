// Reports PR CI failures and review readiness using provider metadata and trusted workflow path filters.
const CONFIG = {
  AstralDeep: ['ci.yml'], AstralPlane: ['ci.yml'], AstralPrimitives: ['ci.yml'],
  AstralProjection: ['ci.yml', 'android-ci.yml', 'apple-ci.yml'], LETS: ['ci.yml', 'security.yml'],
};
const BOT_ID = 41898282;
const REVIEWER = { login: 'armstrongsam25', id: 16158892 };
const FAILED = new Set(['failure', 'timed_out', 'startup_failure', 'stale', 'cancelled']);
const MARKER = '<!-- astral-pr-ci:v1:';

async function pages(method, args, key) {
  const result = [];
  for (let page = 1; page <= 100; page++) {
    const { data } = await method({ ...args, per_page: 100, page });
    const items = key ? data[key] : data;
    result.push(...items);
    if (items.length < 100) return result;
  }
  throw new Error('Pagination limit exceeded');
}

function glob(pattern, file) {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*').replace(/\u0001/g, '(?:.*/)?');
  return new RegExp(`^${source}$`).test(file);
}

function applies(text, files) {
  const match = text.match(/^  pull_request:([^\n]*)(?:\n|$)((?:(?: {4,}[^\n]*|[ \t]*)\n)*)/m);
  if (!match) throw new Error('Monitored workflow has no pull_request trigger');
  const block = match[1] + '\n' + match[2];
  if (/paths-ignore:|^\s+-\s*['"]?!/m.test(block)) throw new Error('Unsupported workflow path exclusions');
  if (!/^    paths:/m.test(block)) return true;
  const patterns = [...block.matchAll(/^      -\s+['"]?([^'"\n]+)['"]?\s*$/gm)].map(item => item[1].trim());
  if (!patterns.length) throw new Error('Empty workflow path filter');
  return files.some(file => patterns.some(pattern => glob(pattern, file)));
}

async function content(github, owner, repo, path, ref) {
  const { data } = await github.rest.repos.getContent({ owner, repo, path, ref });
  if (data.type !== 'file' || data.encoding !== 'base64') throw new Error('Expected workflow file');
  return Buffer.from(data.content, 'base64').toString('utf8');
}

function matches(run, pr, metadata) {
  return run.event === 'pull_request' && run.repository?.id === metadata.id &&
    run.head_sha === pr.head.sha && run.head_branch === pr.head.ref &&
    run.head_repository?.id === pr.head.repo.id;
}

function select(runs, expected, pr, metadata) {
  const selected = new Map();
  for (const run of runs) {
    if (!expected.includes(run.path) || !matches(run, pr, metadata)) continue;
    const previous = selected.get(run.path);
    if (!previous || run.id > previous.id) selected.set(run.path, run);
  }
  return selected;
}

function signature(selected) {
  return JSON.stringify([...selected.values()].map(run => [run.path, run.id, run.run_attempt, run.status, run.conclusion]).sort());
}

function receipt(comment, pr) {
  if (comment.user?.id !== BOT_ID || comment.user?.type !== 'Bot' || !comment.body.startsWith(MARKER)) return null;
  const value = comment.body.slice(MARKER.length).split(' -->')[0];
  try {
    const data = JSON.parse(Buffer.from(value, 'base64url').toString());
    return data.head === pr.head.sha && data.number === pr.number ? data : null;
  } catch { return null; }
}

function mark(pr, status) {
  return MARKER + Buffer.from(JSON.stringify({ number: pr.number, head: pr.head.sha, status })).toString('base64url') + ' -->';
}

function safe(value) {
  return String(value).replace(/[^a-zA-Z0-9 ._:()/-]/g, '').slice(0, 180);
}

async function processPr({ github, args, metadata, pr, dryRun }) {
  if (pr.state !== 'open' || pr.base.ref !== 'main' || pr.base.repo.id !== metadata.id || !pr.head.repo || !/^[a-f0-9]{40}$/.test(pr.head.sha)) return { number: pr.number, status: 'ineligible' };
  const files = await pages(github.rest.pulls.listFiles, { ...args, pull_number: pr.number });
  if (files.length !== pr.changed_files) throw new Error('Incomplete PR file inventory');
  const names = files.flatMap(file => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])]);
  const expected = [];
  for (const name of CONFIG[args.repo]) {
    const path = '.github/workflows/' + name;
    const text = await content(github, args.owner, args.repo, path, pr.base.sha);
    if (applies(text, names)) expected.push(path);
  }
  const runs = await pages(github.rest.actions.listWorkflowRunsForRepo, { ...args, event: 'pull_request', head_sha: pr.head.sha }, 'workflow_runs');
  const selected = select(runs, expected, pr, metadata);
  const comments = await pages(github.rest.issues.listComments, { ...args, issue_number: pr.number });
  const receipts = comments.map(comment => ({ comment, data: receipt(comment, pr) })).filter(item => item.data);
  const failed = [...selected.values()].filter(run => run.status === 'completed' && FAILED.has(run.conclusion));
  const ready = expected.length > 0 && expected.every(path => selected.get(path)?.status === 'completed' && selected.get(path)?.conclusion === 'success');
  let status, body;
  if (failed.length) {
    status = 'failed';
    const lines = [];
    for (const run of failed) {
      const jobs = await pages(github.rest.actions.listJobsForWorkflowRun, { ...args, run_id: run.id, filter: 'latest' }, 'jobs');
      for (const job of jobs.filter(job => FAILED.has(job.conclusion))) {
        const step = job.steps?.find(step => FAILED.has(step.conclusion));
        lines.push(`- [${safe(job.name)}](https://github.com/${args.owner}/${args.repo}/actions/runs/${run.id}/job/${job.id})${step ? ` — ${safe(step.name)}` : ''} (${safe(job.conclusion)})`);
      }
      if (!jobs.some(job => FAILED.has(job.conclusion))) lines.push(`- [${safe(run.name)}](https://github.com/${args.owner}/${args.repo}/actions/runs/${run.id}) (${safe(run.conclusion)})`);
    }
    body = `${mark(pr, status)}\n@${safe(pr.user.login)}, CI needs fixes on \`${pr.head.sha.slice(0, 7)}\`.\n\n${lines.join('\n')}\n\nPlease open the failed job logs, fix the reported CI issues, and push your changes to this PR. CI will run again automatically. Other checks may still be running.`;
  } else if (ready && !pr.draft) {
    status = 'passed';
    body = `${mark(pr, status)}\nAll applicable PR CI workflows passed for \`${pr.head.sha.slice(0, 7)}\`.\n\n${expected.map(path => { const run = selected.get(path); return `- [${safe(run.name)}](https://github.com/${args.owner}/${args.repo}/actions/runs/${run.id})`; }).join('\n')}\n\nReady for maintainer code review.`;
  } else return { number: pr.number, status: ready ? 'draft' : 'pending', expected, observed: [...selected.keys()] };
  let existing = receipts.find(item => item.data.status === status);
  const freshRuns = await pages(github.rest.actions.listWorkflowRunsForRepo, { ...args, event: 'pull_request', head_sha: pr.head.sha }, 'workflow_runs');
  if (signature(select(freshRuns, expected, pr, metadata)) !== signature(selected)) return { number: pr.number, status: 'superseded' };
  const { data: current } = await github.rest.pulls.get({ ...args, pull_number: pr.number });
  if (current.state !== 'open' || current.head.sha !== pr.head.sha || (status === 'passed' && current.draft)) return { number: pr.number, status: 'superseded' };
  if (status === 'passed' && pr.user.id !== REVIEWER.id && !existing) {
    const { data: reviewer } = await github.rest.users.getByUsername({ username: REVIEWER.login });
    if (reviewer.id !== REVIEWER.id) throw new Error('Maintainer identity mismatch');
    const alreadyRequested = current.requested_reviewers.some(user => user.id === REVIEWER.id);
    let pending = receipts.find(item => item.data.status === 'review-pending');
    if (alreadyRequested && !pending) body += `\n\n@${REVIEWER.login}, the latest commit is ready for your review.`;
    else if (!dryRun) {
      if (!pending) {
        const { data: comment } = await github.rest.issues.createComment({ ...args, issue_number: pr.number, body: body.replace(mark(pr, 'passed'), mark(pr, 'review-pending')) });
        pending = { comment, data: { status: 'review-pending' } };
      }
      if (!alreadyRequested) {
        const reviews = await pages(github.rest.pulls.listReviews, { ...args, pull_number: pr.number });
        if (!reviews.some(review => review.user?.id === REVIEWER.id && review.commit_id === pr.head.sha && review.submitted_at)) {
          await github.rest.pulls.requestReviewers({ ...args, pull_number: pr.number, reviewers: [REVIEWER.login] });
        }
      }
      await github.rest.issues.updateComment({ ...args, comment_id: pending.comment.id, body });
      existing = { comment: { ...pending.comment, body }, data: { status: 'passed' } };
    }
  }
  if (!dryRun) {
    if (existing && existing.comment.body !== body && status !== 'passed') await github.rest.issues.updateComment({ ...args, comment_id: existing.comment.id, body });
    else if (!existing) await github.rest.issues.createComment({ ...args, issue_number: pr.number, body });
    if (status === 'passed') {
      for (const previous of receipts.filter(item => item.data.status === 'failed')) {
        await github.rest.issues.updateComment({ ...args, comment_id: previous.comment.id, body: `${mark(pr, 'resolved')}\nThe CI failures previously reported for \`${pr.head.sha.slice(0, 7)}\` are resolved. All applicable PR CI workflows now pass.` });
      }
    }
  }
  return { number: pr.number, status: dryRun ? 'would-' + status : status, unchanged: Boolean(existing), expected };
}

async function coordinate({ github, context, dryRun = false }) {
  dryRun = dryRun === true || dryRun === 'true';
  const args = context.repo;
  if (context.serverUrl !== 'https://github.com' || context.apiUrl !== 'https://api.github.com' || context.ref !== 'refs/heads/main' || args.owner !== 'AstralDeep' || !CONFIG[args.repo]) throw new Error('Untrusted controller context');
  if (!['workflow_run', 'schedule', 'workflow_dispatch'].includes(context.eventName)) throw new Error('Unsupported controller event');
  const { data: metadata } = await github.rest.repos.get(args);
  if (metadata.private || metadata.archived || metadata.default_branch !== 'main') throw new Error('Unsupported repository state');
  if (context.eventName === 'workflow_run' && context.payload.workflow_run.event !== 'pull_request') return { status: 'ignored' };
  const prs = await pages(github.rest.pulls.list, { ...args, state: 'open', base: 'main' });
  const results = [];
  const errors = [];
  for (const summary of prs) {
    try {
      const { data: pr } = await github.rest.pulls.get({ ...args, pull_number: summary.number });
      results.push(await processPr({ github, args, metadata, pr, dryRun }));
    } catch (error) { errors.push({ number: summary.number, message: String(error.message).slice(0, 300) }); }
  }
  return { status: errors.length ? 'incomplete' : 'complete', dryRun, results, errors };
}

module.exports = { coordinate, applies, glob, receipt, matches };
