import test from 'node:test';
import assert from 'node:assert/strict';

test('local server registers all three analysis tools with their real handlers', async () => {
  // Import without starting a listener or making upstream API calls.
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const { default: app } = await import('../server.js');
    for (const tool of ['rate', 'viral', 'saturation']) {
      const { default: handler } = await import(`../api/${tool}.js`);
      const route = app._router.stack.find(layer => layer.route?.path === `/api/${tool}`)?.route;
      assert.ok(route?.methods.get, `${tool} must have a local GET endpoint`);
      assert.equal(route.stack[0].handle, handler);
    }
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});