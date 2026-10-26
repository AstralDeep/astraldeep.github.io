// Reports whether the newest macos-v release differs from the live Downloads record so release-sync.yml redeploys Pages only then.
// Prints changed=true|false and appends it to the --github-output file through liveReleaseChange in release-discovery.mjs.
import { appendFile } from 'node:fs/promises';
import { GitHub } from './github.mjs';
import { liveReleaseChange } from './release-discovery.mjs';

const options = {};
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  const [flag, value] = [args[index], args[index + 1]];
  if (!['--live', '--github-output'].includes(flag) || Object.hasOwn(options, flag) || value === undefined || value.startsWith('--')) throw new Error('Expected --live URL [--github-output PATH]');
  options[flag] = value;
}
if (!options['--live']) throw new Error('Expected --live URL [--github-output PATH]');
const result = await liveReleaseChange(new GitHub(process.env.GITHUB_TOKEN || ''), options['--live']);
console.log(`newest=${result.newest ?? 'none'} live=${result.live ?? 'none'}`);
console.log(`changed=${result.changed}`);
if (options['--github-output']) await appendFile(options['--github-output'], `changed=${result.changed}\n`);
