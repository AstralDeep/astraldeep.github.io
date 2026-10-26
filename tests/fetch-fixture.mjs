// Replaces fetch inside a spawned site script with routes serialized by release-fixture.mjs, keeping build tests offline.
import { readFileSync } from 'node:fs';

const routes = JSON.parse(readFileSync(process.env.ASTRAL_FETCH_FIXTURE, 'utf8'));
globalThis.fetch = async url => {
  const route = routes[String(url)];
  return route ? new Response(Buffer.from(route.body, 'base64'), { status: route.status }) : new Response('Not Found', { status: 404 });
};
