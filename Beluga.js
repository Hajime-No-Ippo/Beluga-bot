// Discord bot implementing threaded "Beluga cat" chat mode.
// Uses discord.js v14 and OpenAI's chat completions. Keep sessions in-memory.

import 'dotenv/config';
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  REST,
  Routes,
  ApplicationCommandOptionType,
} from 'discord.js';

const {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_GUILD_ID,
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

// Thread name define for LLM sessions
const THREAD_PREFIX = 'beluga-cat';

// System prompt for the LLM
// Random beluga-style quotes in JSON array
const BELUGA_QUOTES = [
  'What if I rename the server to “beluga fan club” 👀',
  'Meow? Sorry, wrong cat. Beluga mode on.',
  'Average beluga enjoyer detected. Proceeding with chaos.',
  'Ping? More like *pong* — stay hydrated.',
  'Fun fact: this bot runs on vibes and caffeine.',
  'brb, installing more brain cells...',
  'You pressed the funny button. Congrats.',
  'Beluga says: be weird, be kind.',
  'How can i pass my exam.',
];

// Define slash commands, Build slash commands
const COMMAND_DEFS = [
  { name: 'ping', description: 'Check bot latency' },
  { name: 'uptime', description: 'Show bot uptime' },
  { name: 'info', description: 'Show bot/server info' },
  { name: 'beluga', description: 'Random beluga-style message' },
  {
    name: 'ask',
    description: 'Start a Beluga thread',
    options: [
      {
        name: 'question',
        description: 'Topic or question to start with',
        type: ApplicationCommandOptionType.String,
        required: false,
      },
    ],
  },
  {
    name: 'say',
    description: 'Make the bot repeat something',
    options: [
      {
        name: 'text',
        description: 'What should I say?',
        type: ApplicationCommandOptionType.String,
        required: true,
      },
      {
        name: 'times',
        description: 'How many times should I say?',
        type: 4,
        required: false,
        min_value: 1,
        max_value: 10,
      },
    ],
  },
  { name: 'stop', description: 'End the current thread session' },
  { name: 'reset', description: 'Clear memory for the current thread session' },
];

// Create Discord client, using Discord.js v14
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

// On ready for LLM thread
client.once(Events.ClientReady, (c) => {
  console.log(`Beluga ready as ${c.user.tag}`);
  c.user.setPresence({ activities: [{ name: 'type /ask to start a chat' }], status: 'online' });
});

client.once(Events.ClientReady, async () => {
  if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
    console.warn('Skipping slash command registration (missing DISCORD_CLIENT_ID).');
    return;
  }

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const route = DISCORD_GUILD_ID
    ? Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID)
    : Routes.applicationCommands(DISCORD_CLIENT_ID);

  try {
    console.log('Registering slash commands for Beluga:', COMMAND_DEFS.map((c) => c.name));
    await rest.put(route, { body: COMMAND_DEFS });
    console.log('Registered slash commands.');
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }
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

    if (message.channel.isThread()) {   // The basic condition, check if in a thread
      let session = sessions.get(message.channel.id);
      if (!session) session = ensureSessionFromExistingThread(message.channel);
      if (!session) debug('No session found for thread', message.channel.id, 'content:', message.content);

      // Secondeary conditions for commands, if true, and input mateches /stop or /reset
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

// Prefix thread name with ARCHIVED if the thread is being archived (session ended)
function prefixThreadName(name, prefix = 'ARCHIVED') {
  // Clean up prefix spacing
  const cleanPrefix = prefix.replace(/\s+/g, ' ').trim();
  // Check if already prefixed
  const already = name.startsWith(`[${cleanPrefix}] `) || name.startsWith(`${cleanPrefix} `);
  if (already) return name;

  const newName = `[${cleanPrefix}] ${name}`;
  // Discord thread name max length is 100
  return newName.slice(0, 100);
}


client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;

    // Handle slash commands of ping, uptime, info, beluga, ask, stop, reset, say
    if (interaction.commandName === 'ping') {
      const sent = await interaction.reply({ content: 'Pinging...', fetchReply: true });
      const latency = sent.createdTimestamp - interaction.createdTimestamp;
      const api = Math.round(client.ws.ping);
      await interaction.editReply(`Pong! ${latency}ms (API ${api}ms)`);
      return;
    }

    if (interaction.commandName === 'uptime') {
      const seconds = Math.floor(process.uptime());
      await interaction.reply(`Uptime: ${formatDuration(seconds)}`);
      return;
    }

    if (interaction.commandName === 'info') {
      const guildName = interaction.guild?.name || 'DM';
      const members = interaction.guild?.memberCount;
      const memberText = members ? `${members} members` : 'members unknown';
      const api = Math.round(client.ws.ping);
      await interaction.reply(`Bot: ${client.user.tag} • Server: ${guildName} • ${memberText} • API ${api}ms`);
      return;
    }

    if (interaction.commandName === 'beluga') {
      const choice = BELUGA_QUOTES[Math.floor(Math.random() * BELUGA_QUOTES.length)];
      await interaction.reply(choice);
      return;
    }

    if (interaction.commandName === 'ask') {
      if (interaction.channel?.type !== ChannelType.GuildText) {
        await interaction.reply({ content: 'Use this in a server text channel.', ephemeral: true });
        return;
      }
      const topic = interaction.options.getString('question')?.trim() || 'chat';
      const replyMessage = await interaction.reply({ content: 'Starting thread...', fetchReply: true });
      await startThreadSession(replyMessage, topic);
      return;
    }
    
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    if (interaction.commandName === 'say') {
      const text = interaction.options.getString('text', true).trim();
      const times = interaction.options.getInteger('times') ?? 1;
      console.log('timesRaw =', times, 'allowOptions =', interaction.options.data );
      if (!text) {
        await interaction.reply({ content: 'Please provide text to say.', ephemeral: true });
        return;
      }
      const cappedTimes = Math.max(1, Math.min(times, 10)); 
      const msg = text.slice(0, 2000); // final safety cap
      await interaction.reply({ content: msg, allowedMentions: { parse: [] } });
      for ( let i = 1; i < cappedTimes; i++ ){
        await sleep(700);
        await interaction.followUp({ content: msg, allowedMentions: { parse: [] } });
      }
      return;
    }

    if (interaction.commandName === 'stop' || interaction.commandName === 'reset') {
      if (!interaction.channel?.isThread()) {
        await interaction.reply({ content: 'Use this inside a Beluga thread.', ephemeral: true });
        return;
      }

      let session = sessions.get(interaction.channel.id);
      if (!session) session = ensureSessionFromExistingThread(interaction.channel);
      if (!session) { 
        await interaction.reply({ content: 'No active Beluga session in this thread.', ephemeral: true });
        return;
      }

      if (interaction.commandName === 'stop') {
        await interaction.reply('Ending session...');
        await endSession(interaction.channel, 'Session ended by user.');
        return;
      }

      await resetSession(interaction.channel, session);
      await interaction.reply({ content: 'Memory cleared for this session.', ephemeral: true });
      return;
    }
    // Catch all for unknown commands
  } catch (err) {
    console.error('Error handling interaction', err);
  }
});

// Start a new thread session from a trigger message /ask command 
async function startThreadSession(triggerMessage, topic) {
  const threadName = `${THREAD_PREFIX} • ${topic}`.slice(0, 95); // Discord thread name max 100 chars, enable restriction for prefix
  // Create thread, append the name and the maximum time for this thread, based on the Discord limits
  const thread = await triggerMessage.startThread({ 
    name: threadName,
    autoArchiveDuration: 60, // minutes
  });

  // Initialize session, best for maintaining context
  const session = {
    topic,
    startedBy: triggerMessage.author.id,
    lastActive: Date.now(),
    cooldownUntil: 0,
    memory: [],
  };

  sessions.set(thread.id, session);

  // Notify in thread
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

function formatDuration(totalSeconds) {
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
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
    const currentName = thread.name ?? 'thread';
    const renamed = prefixThreadName(currentName, 'ARCHIVED');
    if (renamed !== currentName) await thread.setName(renamed);
  } catch (err) {
    console.warn('Could not rename thread before archive:', err.message);
  }

  try {
    if (!thread.archived) await thread.setArchived(true, 'Begula service session ended');
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
