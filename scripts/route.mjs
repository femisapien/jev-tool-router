import {
  closeAllSessions,
  routeTool,
} from '../src/router-core.mjs';

const request = process.argv.slice(2).join(' ').trim();
if (!request) {
  throw new Error(
    'Usage: npm run route -- "I need to inspect a Blender scene"',
  );
}

try {
  const result = await routeTool({ request });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await closeAllSessions();
}
