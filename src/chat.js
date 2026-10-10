'use strict';
// Chat controller: owns the session list, the transcript, and one in-flight
// request at a time. Knows nothing about the DOM — UI.render() is called with
// the current state and does the drawing.
//
// The persistence rule that shapes everything here: the page can go away at any
// moment — a DraconDex 5 side panel is destroyed when it closes or the app
// quits (and a 4.x host reloaded it on every pane re-render) — so the source of
// truth is the tables, not this object. Both halves of a turn are written the
// moment they exist — the user's message before the request goes out, the
// assistant's as soon as the stream ends — so losing the page mid-conversation
// loses nothing but an unfinished reply.

const Chat = {
  settings: null,
  sessions: [],
  sessionId: null,
  messages: [],
  moduleContext: null,   // set by the host when permissions.context allows it
  followPending: false,  // the page changed mid-reply; follow it when the reply ends
  view: 'chat',          // 'chat' | 'settings' | 'sessions'
  sending: false,
  streamText: '',        // the reply as it arrives, before it is persisted
  streamReasoning: '',   // streamed reasoning summary, when the model emits one
  abort: null,
  error: null,
  notice: null,
};

async function boot({ moduleContext = null } = {}) {
  Chat.moduleContext = moduleContext;
  Chat.settings = await Provider.readSettings();
  Chat.sessions = await Store.listSessions();
  // Fire-and-forget: a slow or offline catalog fetch must never delay the
  // chat becoming usable. Whatever it finds is picked up by the next send().
  Catalog.ensure();

  // Prefer a session already tied to this module, so re-opening the panel on a
  // module returns to that module's conversation rather than a global one.
  const key = moduleKey();
  let session = key ? Chat.sessions.find((s) => s.module_key === key) : null;
  if (!session) session = Chat.sessions.find((s) => !s.module_key) || Chat.sessions[0] || null;
  if (session) {
    Chat.sessionId = session.id;
    Chat.messages = await Store.listMessages(session.id);
  }

  const gate = Provider.connectionState(Chat.settings);
  if (!gate.ok) {
    Chat.view = 'settings';
    Chat.notice = Provider.describeGate(gate.reason);
  }
  UI.render();
}

function moduleKey() {
  const c = Chat.moduleContext;
  return c?.moduleId != null ? `module_${c.moduleId}` : null;
}

function currentSession() {
  return Chat.sessions.find((s) => s.id === Chat.sessionId) || null;
}

// DraconDex 5 keeps the side panel open across page changes and pushes a new
// context on every one, so this runs each time the user moves to another
// module — not once after mount, as on 4.x where the panel closed with its
// module. Follow the page: show that module's own conversation if it has one,
// otherwise an empty chat (the first send creates a session tagged with the
// module). A fresh untagged session nobody has typed in is adopted rather than
// left behind. Never mid-reply: a stream still writing into the current
// session finishes there, and the switch happens when it ends (see send()).
// No module open (context null) keeps whatever is on screen.
async function setModuleContext(context) {
  const before = moduleKey();
  Chat.moduleContext = context;
  if (moduleKey() === before) { UI.render(); return; }
  if (Chat.sending) { Chat.followPending = true; UI.render(); return; }
  await followModule();
}

async function followModule() {
  Chat.followPending = false;
  const key = moduleKey();
  if (!key) { UI.render(); return; }
  const existing = Chat.sessions.find((s) => s.module_key === key);
  if (existing) {
    if (existing.id !== Chat.sessionId) await selectSession(existing.id);
    else UI.render();
    return;
  }
  const session = currentSession();
  if (session && !session.module_key && !Chat.messages.length) {
    await Store.touchSession(session.id, { module_key: key });
    session.module_key = key;
    UI.render();
    return;
  }
  Chat.sessionId = null;
  Chat.messages = [];
  Chat.error = null;
  Chat.view = 'chat';
  UI.render();
}

async function newSession() {
  const c = Chat.moduleContext;
  const title = c?.moduleName ? `${c.moduleName}` : 'New chat';
  const session = await Store.createSession({
    title, model: Chat.settings.model, systemPrompt: null, moduleKey: moduleKey(),
  });
  Chat.sessions.unshift(session);
  Chat.sessionId = session.id;
  Chat.messages = [];
  Chat.error = null;
  Chat.view = 'chat';
  UI.render();
  return session;
}

async function selectSession(id) {
  Chat.sessionId = id;
  Chat.messages = await Store.listMessages(id);
  Chat.error = null;
  Chat.view = 'chat';
  UI.render();
}

async function removeSession(id) {
  await Store.deleteSession(id);
  Chat.sessions = Chat.sessions.filter((s) => s.id !== id);
  if (Chat.sessionId === id) {
    Chat.sessionId = Chat.sessions[0]?.id ?? null;
    Chat.messages = Chat.sessionId ? await Store.listMessages(Chat.sessionId) : [];
  }
  UI.render();
}

// The Responses API's `input` wants plain user/assistant turns carrying only
// role and content, so the stored rows (which also hold usage and errors) are
// mapped down. A turn that failed is dropped rather than sent as an assistant
// message — replaying an error back to the model as if it were a reply is how
// a stuck conversation stays stuck.
function wireMessages() {
  return Chat.messages
    .filter((m) => !m.error && m.content)
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
}

async function send(text) {
  const body = String(text || '').trim();
  if (!body || Chat.sending) return;

  Chat.settings = await Provider.readSettings();
  const gate = Provider.connectionState(Chat.settings);
  if (!gate.ok) {
    Chat.view = 'settings';
    Chat.notice = Provider.describeGate(gate.reason);
    UI.render();
    return;
  }

  let session = currentSession();
  if (!session) session = await newSession();

  // Persist before sending: if the panel is closed while the request is in
  // flight, the question is still there to retry.
  const userId = await Store.addMessage(session.id, { role: 'user', content: body });
  Chat.messages.push({ id: userId, session_ref: session.id, role: 'user', content: body, create_at: Store.nowIso() });

  // First message doubles as the session title — a list of "New chat" rows is
  // useless for finding anything later.
  if (Chat.messages.length === 1) {
    const title = body.length > 40 ? `${body.slice(0, 40)}…` : body;
    await Store.touchSession(session.id, { title });
    session.title = title;
  }

  Chat.sending = true;
  Chat.streamText = '';
  Chat.streamReasoning = '';
  Chat.error = null;
  UI.render();

  const result = await Provider.sendMessage({
    // AI Native's catalog preamble (if one was ever fetched) rides in front of
    // whatever system prompt the user configured — see src/catalog.js. Only
    // this outgoing copy is augmented; Chat.settings and the stored session
    // keep the user's own text exactly as they wrote it.
    settings: { ...Chat.settings, systemPrompt: Catalog.composeSystemPrompt(Chat.settings.systemPrompt) },
    messages: wireMessages(),
    onDelta: ({ text: t, reasoning }) => {
      if (t) Chat.streamText += t;
      if (reasoning) Chat.streamReasoning += reasoning;
      UI.renderStream();
    },
    onAbortReady: (abort) => { Chat.abort = abort; },
  });

  Chat.sending = false;
  Chat.abort = null;

  const content = result.text || '';
  if (result.ok) {
    const id = await Store.addMessage(session.id, {
      role: 'assistant', content, inTokens: result.inTokens, outTokens: result.outTokens,
    });
    Chat.messages.push({ id, session_ref: session.id, role: 'assistant', content, in_tokens: result.inTokens, out_tokens: result.outTokens, create_at: Store.nowIso() });
  } else {
    // Keep whatever streamed before the failure — a partial answer plus the
    // reason it stopped is more useful than discarding both.
    const id = await Store.addMessage(session.id, { role: 'assistant', content, error: result.error });
    Chat.messages.push({ id, session_ref: session.id, role: 'assistant', content, error: result.error, create_at: Store.nowIso() });
    Chat.error = result.error;
  }
  await Store.touchSession(session.id, {});
  Chat.streamText = '';
  Chat.streamReasoning = '';
  UI.render();
  if (Chat.followPending) await followModule();
}

function stop() {
  if (Chat.abort) Chat.abort();
}

async function retryLast() {
  // Drop the failed assistant turn, then resend the question that produced it.
  const last = Chat.messages[Chat.messages.length - 1];
  if (!last || last.role !== 'assistant' || !last.error) return;
  await Store.deleteMessage(last.id);
  Chat.messages.pop();
  const question = Chat.messages.pop();
  if (!question) { UI.render(); return; }
  await Store.deleteMessage(question.id);
  UI.render();
  await send(question.content);
}

async function saveSettings(patch) {
  for (const [k, v] of Object.entries(patch)) await Store.setConfig(k, v);
  Chat.settings = await Provider.readSettings();
  Chat.notice = null;
  UI.render();
}

window.Chat = Chat;
window.ChatActions = {
  boot, send, stop, retryLast, newSession, selectSession, removeSession,
  setModuleContext, saveSettings, currentSession,
};
