// MVP Discord bot implementing threaded "Atlas Room" chat mode.
// Uses discord.js v14 and OpenAI's chat completions. Keep sessions in-memory.

import 'dotenv/config';
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
  Events,
} from 'discord.js';

const {
  DISCORD_TOKEN,
  OPENAI_API_KEY,
  OPENAI_MODEL = 'gpt-3.5-turbo',
  GEMINI_API_KEY,
  GEMINI_MODEL = 'gemini-2.5-flash-lite',
  LLM_PROVIDER = 'gemini', // 'openai' | 'gemini'
  SYSTEM_PROMPT = 'You are a discord user if user are chating or serious questioning you academic question, academic respond should be no more than 1000 varcharacters. If user is chating you can join the coversation casually, limited in 150 characters.',
  MOCK_OPENAI = 'false',
  DELETE_THREAD_ON_END = 'false',
  DEBUG_LOG = 'false',
} = process.env;

// Validate environment
if (!DISCORD_TOKEN) throw new Error('Missing DISCORD_TOKEN');
const provider = LLM_PROVIDER.toLowerCase();
if (!['openai', 'gemini'].includes(provider)) throw new Error('LLM_PROVIDER must be "openai" or "gemini"');
// Validate model keys based on provider
if (provider === 'openai' && !OPENAI_API_KEY && MOCK_OPENAI !== 'true') {
  throw new Error('Missing OPENAI_API_KEY');
}
if (provider === 'gemini' && !GEMINI_API_KEY) {
  throw new Error('Missing GEMINI_API_KEY');
}

// Basic runtime toggles
const REQUIRE_PREFIX = false; // set true to only reply to messages starting with TRIGGER_PREFIX
const TRIGGER_PREFIX = '?';
const SHOULD_DELETE_ON_END = DELETE_THREAD_ON_END === 'true'; // otherwise archive
const debug = (...args) => {
  if (DEBUG_LOG === 'true') console.log('[atlas-debug]', ...args);
};

const THREAD_PREFIX = 'beluga-cat';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

// Session store keyed by thread ID
const sessions = new Map();
const TTL_MS = 20 * 60 * 1000; // 20 minutes inactivity
const COOLDOWN_MS = 1_000; // shorter cooldown
const MEMORY_LIMIT = 40; // keep last 40 turns
const MAX_TOKENS = 800; // allow longer replies

client.once(Events.ClientReady, (c) => {
  console.log(`Atlas Simulator ready as ${c.user.tag}`);
  c.user.setPresence({ activities: [{ name: 'type /ask to start a chat' }], status: 'online' });
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;

    // /ask can be used in a normal channel to spawn a thread session
    if (message.content.startsWith('/ask') && message.channel.type === ChannelType.GuildText) {
      const topic = message.content.replace('/ask', '').trim() || 'chat';
      debug('Starting thread session', { channel: message.channel.id, topic });
      return startThreadSession(message, topic);
    }

    // Handle commands inside active threads
    if (message.channel.isThread()) {
      let session = sessions.get(message.channel.id);
      if (!session) session = ensureSessionFromExistingThread(message.channel);
      if (!session) debug('No session found for thread', message.channel.id, 'content:', message.content);

      if (message.content === '/stop') return endSession(message.channel, 'Session ended by user.');
      if (message.content === '/reset') return resetSession(message.channel, session);

      if (message.content.startsWith('/') || message.content.startsWith('!')) return; // ignore other commands
      if (!session) return;
      await handleThreadMessage(message, session);
    }
  } catch (err) {
    console.error('Error handling message', err);
  }
});

async function startThreadSession(triggerMessage, topic) {
  const threadName = `${THREAD_PREFIX} • ${topic}`.slice(0, 95);
  const thread = await triggerMessage.startThread({
    name: threadName,
    autoArchiveDuration: 60, // minutes
  });

  const session = {
    topic,
    startedBy: triggerMessage.author.id,
    lastActive: Date.now(),
    cooldownUntil: 0,
    memory: [],
  };

  sessions.set(thread.id, session);

  await thread.send(
    `I'm active in this thread now. Topic: **${topic}**.\n` +
      'Use `/stop` to end, `/reset` to clear memory. I time out after 20 minutes of inactivity.',
  );

  await sendReply(thread, session, 'How can I help?');
}

async function handleThreadMessage(message, session) {
  if (REQUIRE_PREFIX && !message.content.startsWith(TRIGGER_PREFIX)) return;

  const content = REQUIRE_PREFIX ? message.content.slice(TRIGGER_PREFIX.length).trim() : message.content.trim();
  if (!content) {
    debug('Empty content in thread message; message.content:', message.content);
    return;
  }

  const now = Date.now();
  if (session.cooldownUntil > now) return; // respect cooldown

  session.lastActive = now;
  session.lastSpeaker = message.author.id;
  session.memory.push({ role: 'user', content });
  trimMemory(session.memory);

  session.cooldownUntil = now + COOLDOWN_MS;
  const reply = await getModelReply(session.memory);
  session.memory.push({ role: 'assistant', content: reply });
  trimMemory(session.memory);

  session.lastSpeaker = client.user.id;
  await message.channel.send(reply);
}

function trimMemory(memory) {
  const extra = memory.length - MEMORY_LIMIT;
  if (extra > 0) memory.splice(0, extra);
}

async function sendReply(thread, session, text) {
  session.memory.push({ role: 'assistant', content: text });
  trimMemory(session.memory);
  session.lastSpeaker = client.user.id;
  await thread.send(text);
}

async function endSession(thread, reason = 'Session ended.') {
  sessions.delete(thread.id);

  try {
    await thread.send(reason);
  } catch (err) {
    console.warn('Could not send end notice:', err.message);
  }

  if (SHOULD_DELETE_ON_END) {
    try {
      await thread.delete(`Atlas session ended: ${reason}`);
      return;
    } catch (err) {
      console.warn('Could not delete thread, falling back to archive:', err.message);
    }
  }

  try {
    if (!thread.archived) await thread.setArchived(true, 'Atlas session ended');
  } catch (err) {
    console.warn('Could not archive thread:', err.message);
  }
}

async function resetSession(thread, session) {
  if (!session) return thread.send('No active session to reset.');
  session.memory = [];
  session.lastActive = Date.now();
  session.cooldownUntil = 0;
  session.lastSpeaker = undefined;
  await thread.send('Memory cleared for this session.');
}

function ensureSessionFromExistingThread(thread) {
  const name = thread.name || '';
  if (!name.toLowerCase().startsWith(THREAD_PREFIX.toLowerCase())) return null;

  const topic = name.includes('•') ? name.split('•').slice(1).join('•').trim() || 'chat' : 'chat';
  const session = {
    topic,
    startedBy: thread.ownerId || 'unknown',
    lastActive: Date.now(),
    cooldownUntil: 0,
    memory: [],
  };

  sessions.set(thread.id, session);
  debug('Rehydrated session from existing thread', thread.id, 'topic:', topic);
  return session;
}

async function getModelReply(memory) {
  if (MOCK_OPENAI === 'true' && provider === 'openai') {
    const lastUser = [...memory].reverse().find((m) => m.role === 'user')?.content || 'your message';
    return `Mock reply (no OpenAI): I heard "${lastUser}".`;
  }

  if (provider === 'gemini') {
    debug('Using Gemini provider with model', GEMINI_MODEL);
    return getGeminiReply(memory);
  }

  debug('Using OpenAI provider with model', OPENAI_MODEL);
  return getOpenAIReply(memory);
}

async function getOpenAIReply(memory) {
  const body = {
    model: OPENAI_MODEL,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...memory],
    max_tokens: MAX_TOKENS,
    temperature: 0.7,
  };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('OpenAI error', res.status, text);
    return 'Sorry, I ran into an error talking to OpenAI.';
  }

  const json = await res.json();
  return json.choices?.[0]?.message?.content?.trim() || 'Hmm, I got an empty reply.';
}

async function getGeminiReply(memory) {

  const mergedMemory = [];
  for (const msg of memory) {
    if (mergedMemory.length > 0 && mergedMemory[mergedMemory.length - 1].role === msg.role) {
      mergedMemory[mergedMemory.length - 1].content += "\n" + msg.content;
    } else {
      mergedMemory.push({ ...msg });
    }
  }
  const contents = memory.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const body = {
    model: GEMINI_MODEL,
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents,
    generationConfig: {
      maxOutputTokens: MAX_TOKENS,
      temperature: 0.7,
    },
  };

  // Gemini models like gemini-1.5-flash/gpt supports v1 generateContent; v1beta may not list newer models
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('Gemini error', res.status, text);
    return 'Sorry, I ran into an error talking to Gemini.';
  }

  const json = await res.json();
  const reply = json.candidates?.[0]?.content?.parts?.map((p) => p.text).join('\n').trim();
  return reply || 'Hmm, I got an empty reply.';
}

// Periodic cleanup for inactivity
setInterval(() => {
  const now = Date.now();
  for (const [threadId, session] of sessions) {
    if (now - session.lastActive > TTL_MS) {
      const thread = client.channels.cache.get(threadId);
      if (thread) endSession(thread, 'Session timed out after inactivity.');
      else sessions.delete(threadId);
    }
  }
}, 60_000);

client.login(DISCORD_TOKEN);
