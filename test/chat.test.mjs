// DraconDex 5 keeps the side panel open across page changes and pushes a new
// module context on each one. src/chat.js follows the page — but never while
// a reply is still streaming into the current session. Drives chat.js in a vm
// with fake Store/UI/Provider, the same way the panel would.
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

test('the chat follows the open module, deferring mid-reply', async () => {
const src = readFileSync(new URL('../src/chat.js', import.meta.url), 'utf8');
let nextId = 1; const sessions = []; const messages = [];
let release;
const ctx = {
  window: {}, console,
  UI: { render() {}, renderStream() {} },
  Catalog: { ensure() {}, composeSystemPrompt: (s) => s },
  Provider: {
    readSettings: async () => ({ model: 'm', systemPrompt: '' }),
    connectionState: () => ({ ok: true }), describeGate: () => '',
    sendMessage: () => new Promise((r) => { release = () => r({ ok: true, text: 'answer' }); }),
  },
  Store: {
    nowIso: () => 'now',
    listSessions: async () => sessions.slice(),
    listMessages: async (id) => messages.filter((m) => m.session_ref === id),
    createSession: async ({ title, moduleKey }) => { const s = { id: nextId++, title, module_key: moduleKey }; sessions.unshift(s); return { ...s }; },
    addMessage: async (sid, m) => { const id = nextId++; messages.push({ id, session_ref: sid, ...m }); return id; },
    touchSession: async (id, patch) => { Object.assign(sessions.find((s) => s.id === id), patch); },
  },
};
vm.createContext(ctx);
vm.runInContext(src, ctx);
const { Chat, ChatActions: A } = ctx.window;
const mod = (id) => ({ moduleId: id, moduleName: `M${id}`, kind: 'scribe' });

await A.boot({ moduleContext: mod(1) });
assert.equal(Chat.sessionId, null);
const sending = A.send('hello on 1');   // starts streaming
await new Promise((r) => setTimeout(r));
const s1 = Chat.sessionId; assert.ok(s1);
assert.equal(Chat.sending, true);
await A.setModuleContext(mod(2));        // page changes mid-reply
assert.equal(Chat.sessionId, s1, 'must not switch mid-reply');
assert.equal(Chat.followPending, true);
release(); await sending;
assert.equal(Chat.sending, false);
assert.equal(messages.filter((m) => m.session_ref === s1).length, 2, 'reply landed in the original session');
assert.equal(Chat.sessionId, null, 'followed to module 2 (no session yet)');
assert.equal(Chat.messages.length, 0);
await A.setModuleContext(mod(1));        // back to 1 → its conversation
assert.equal(Chat.sessionId, s1);
assert.equal(Chat.messages.length, 2);
await A.setModuleContext(null);          // no module: stay
assert.equal(Chat.sessionId, s1);
await A.setModuleContext(mod(1));
assert.equal(Chat.sessionId, s1);
});
