# 🐋🐱 Beluga Cat — Discord Bot

Beluga Cat is a playful Discord bot inspired by the chaotic “beluga” vibe — memes, quick replies, tiny utilities, and fun interactions for your server.

<img width="200" height="200" alt="image" align-items="center" src="https://github.com/user-attachments/assets/245a90e6-764f-462c-9805-e9bdd01372c7"/>

> ✅ Works in servers  
> 🧵 Optional: thread-based “chat mode” (if enabled)  
> 🔒 Your token stays local — you host it yourself

---

## ✨ Features

- 🐋 **Beluga-style fun**: memes, random replies, silly interactions
- 💬 **Chat / Q&A** (optional): ask questions and get helpful answers
- 🧰 **Utilities**: ping, help, info, basic moderation tools (optional)
- 🧵 **Thread mode** (optional): keep conversations clean in dedicated threads
- ⚙️ **Easy to configure** with environment variables

---

## 🚀 Quick Start (for Server Owners)

### 1) Invite the bot
Use the invite link below:

- **Invite Link:** `<PUT_YOUR_INVITE_LINK_HERE>`

> If you don’t have an invite link yet, ask the bot owner/admin to generate one in the Discord Developer Portal.

### 2) Give it permissions
Recommended permissions:
- Read Messages / View Channels
- Send Messages
- Embed Links
- Attach Files (optional, for images/memes)
- Read Message History
- Use Slash Commands

If your bot supports thread mode:
- Create Public Threads
- Send Messages in Threads

---

## 🧾 Commands

> Type `/help` to see commands in your server (recommended).

### Fun
- `/beluga` — random beluga-style message
- `/meme` — sends a meme (if enabled)
- `/cat` — random cat content
- `/say <text>` — make the bot repeat something (optional)

### Chat / AI (if enabled)
- `/ask <question>` — ask the bot something
- `/stop` - stop the thread session and archive it
- `/reset` - reset the thread

### Utility
- `/ping` — bot latency
- `/info` — bot/server info
- `/uptime` — bot uptime (optional)

### Admin (optional)
- `/setup` — configure bot settings
- `/setchannel <channel>` — set where the bot talks
- `/toggle <feature>` — enable/disable modules

---

## ⚙️ Setup (Self-Hosting)

### Requirements
- Node.js **18+**
- A Discord Bot Token (Discord Developer Portal)
- (Optional) OpenAI / Gemini API key if AI features are enabled

### 1) Clone & install
```bash
git clone <YOUR_REPO_URL>
cd beluga-cat-bot
pnpm install
```
### 2) Start your robot
```bash
pnpm start
```
