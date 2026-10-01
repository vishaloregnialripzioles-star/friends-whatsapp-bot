require("dotenv").config();

const makeWASocket = require("@whiskeysockets/baileys").default;
const {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
  Browsers,
  normalizeMessageContent,
  jidNormalizedUser
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const qrcode = require("qrcode-terminal");
const pino = require("pino");
const Groq = require("groq-sdk");

const PREFIX = (process.env.PREFIX || "!").trim() || "!";
const BOT_NAME = process.env.BOT_NAME || "FriendsBot";
const WHATSAPP_ENABLED = String(process.env.WHATSAPP_ENABLED).toLowerCase() === "true";
const ALLOWED_GROUP_ID = (process.env.ALLOWED_GROUP_ID || "").trim();
const PAIRING_PHONE_NUMBER = (process.env.PAIRING_PHONE_NUMBER || "").replace(/\D/g, "");
const OWNER_PHONE_NUMBER = (process.env.OWNER_PHONE_NUMBER || process.env.PAIRING_PHONE_NUMBER || "").replace(/\D/g, "");
const AUTH_DIR = (process.env.AUTH_DIR || "auth_info").trim() || "auth_info";
const COOLDOWN_MS = Math.max(0, Number(process.env.COOLDOWN_MS || 1500));
const GROQ_API_KEY = (process.env.GROQ_API_KEY || "").trim();
const AI_MODEL = (process.env.AI_MODEL || "openai/gpt-oss-20b").trim();
const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;

const cooldowns = new Map();
let reconnectTimer = null;
let isConnecting = false;
let isWhatsAppConnected = false;
let hasSentConnectionNotice = false;
const sentMessageIds = new Set();

function getMessageText(message) {
  if (!message) return "";

  // Baileys can wrap normal messages in ephemeral/view-once containers.
  // Unwrap them before reading the actual text.
  let content = normalizeMessageContent(message) || message;

  for (let i = 0; i < 4 && content; i++) {
    if (content.ephemeralMessage?.message) {
      content = content.ephemeralMessage.message;
      continue;
    }
    if (content.viewOnceMessage?.message) {
      content = content.viewOnceMessage.message;
      continue;
    }
    if (content.viewOnceMessageV2?.message) {
      content = content.viewOnceMessageV2.message;
      continue;
    }
    if (content.documentWithCaptionMessage?.message) {
      content = content.documentWithCaptionMessage.message;
      continue;
    }
    break;
  }

  return (
    content?.conversation ||
    content?.extendedTextMessage?.text ||
    content?.imageMessage?.caption ||
    content?.videoMessage?.caption ||
    content?.documentMessage?.caption ||
    ""
  ).trim();
}

function formatUptime(seconds) {
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [
    d ? `${d}d` : "",
    h ? `${h}h` : "",
    m ? `${m}m` : "",
    `${sec}s`
  ].filter(Boolean).join(" ");
}

function randomChoice(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function isCoolingDown(sender) {
  if (!sender || COOLDOWN_MS <= 0) return false;
  const now = Date.now();
  const last = cooldowns.get(sender) || 0;
  if (now - last < COOLDOWN_MS) return true;
  cooldowns.set(sender, now);
  if (cooldowns.size > 5000) {
    for (const [key, timestamp] of cooldowns) {
      if (now - timestamp > COOLDOWN_MS * 10) cooldowns.delete(key);
    }
  }
  return false;
}

async function askGroq(prompt, sender) {
  if (!groq) {
    return "⚠️ *AI is not configured yet.*\nAdd GROQ_API_KEY in Render Environment Variables and redeploy.";
  }

  const completion = await groq.chat.completions.create({
    model: AI_MODEL,
    messages: [
      {
        role: "system",
        content:
          "You are FriendsBot, a friendly, concise AI assistant for a private friends WhatsApp group. " +
          "Be helpful, natural, and respectful. Keep answers reasonably short for WhatsApp. " +
          "Do not claim to have access to private WhatsApp data, messages, contacts, or the user device."
      },
      { role: "user", content: prompt }
    ],
    temperature: 0.7,
    max_tokens: 400,
    user: sender ? String(sender).slice(0, 64) : undefined
  });

  const answer = completion.choices?.[0]?.message?.content?.trim();
  if (!answer) throw new Error("Groq returned an empty response");
  return "🤖 *" + BOT_NAME + " AI*\n\n" + answer;
}
function helpText() {
  return [
    "✨ *" + BOT_NAME + " — Commands*",
    "",
    "*Basics*  " + PREFIX + "ping | " + PREFIX + "help | " + PREFIX + "status | " + PREFIX + "uptime | " + PREFIX + "about | " + PREFIX + "prefix",
    "*Group*  " + PREFIX + "groupid | " + PREFIX + "groupinfo | " + PREFIX + "admins",
    "*Admin only*  " + PREFIX + "kick @member | " + PREFIX + "lock | " + PREFIX + "unlock",
    "*Fun*  " + PREFIX + "8ball | " + PREFIX + "coinflip | " + PREFIX + "roll 2d6 | " + PREFIX + "choose A | B | " + PREFIX + "rps | " + PREFIX + "random",
    PREFIX + "wyr A | B | " + PREFIX + "ship A | B | " + PREFIX + "joke | " + PREFIX + "meme | " + PREFIX + "fact | " + PREFIX + "quote | " + PREFIX + "fortune",
    PREFIX + "compliment | " + PREFIX + "hug | " + PREFIX + "roast | " + PREFIX + "truth | " + PREFIX + "dare | " + PREFIX + "riddle | " + PREFIX + "reverse | " + PREFIX + "rate",
    "*AI*  " + PREFIX + "ai <message> (set GROQ_API_KEY in Render)",
    "",
    "Kick/lock/unlock require you and the bot to be group admins."
  ].join("\n");
}

function handleCommand(command, args, context) {
  const subject = args.join(" ").trim();
  switch (command) {
    case "ping":
      return "🏓 *Pong!* " + BOT_NAME + " is online and responding.";
    case "help":
    case "commands":
      return helpText();
    case "status":
      return (isWhatsAppConnected ? "🟢 WhatsApp connected" : "🟠 WhatsApp is reconnecting") +
        "\n⏱️ Uptime: *" + formatUptime(process.uptime()) + "*\n🔤 Prefix: *" + PREFIX + "*";
    case "about":
      return ["🤖 *" + BOT_NAME + "*", "", "Private friends-group bot", "Built with Node.js + Baileys", "Prefix: " + PREFIX, "Use " + PREFIX + "help to see commands."].join("\n");
    case "uptime":
      return "⏱️ Uptime: *" + formatUptime(process.uptime()) + "*";
    case "prefix":
      return "🔤 Current prefix: *" + PREFIX + "*";
    case "groupid":
    case "id":
      return context && context.isGroup
        ? "🆔 This group's ID:\n" + context.jid + "\nSet ALLOWED_GROUP_ID to this value in Render if you want to lock the bot to this group."
        : "ℹ️ Use " + PREFIX + "groupid inside a group chat.";
    case "8ball":
      if (!subject) return "🔮 Use " + PREFIX + "8ball <question>";
      return "🔮 *" + randomChoice(["Absolutely ✨", "Probably 😎", "Maybe... 👀", "Not looking good 😂", "Ask me again later.", "The answer is hidden in the clouds ☁️"]) + "*";
    case "coinflip":
    case "flip":
      return Math.random() < 0.5 ? "🪙 *Heads!*" : "🪙 *Tails!*";
    case "dice":
    case "roll": {
      const match = (args[0] || "1d6").match(/^(?:(\d+)d)?(\d+)$/i);
      if (!match) return "🎲 Use " + PREFIX + "roll [dice]d[sides] (example: " + PREFIX + "roll 2d6).";
      const count = Number(match[1] || 1), sides = Number(match[2]);
      if (count < 1 || count > 20 || sides < 2 || sides > 1000) return "🎲 Choose 1–20 dice and 2–1000 sides.";
      const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
      return count === 1 ? "🎲 Rolled *" + rolls[0] + "* (d" + sides + ")" : "🎲 Rolls: " + rolls.join(", ") + "\nTotal: *" + rolls.reduce((a,b)=>a+b,0) + "*";
    }
    case "choose": {
      if (!subject) return "🤔 Use " + PREFIX + "choose option A | option B";
      let options = subject.includes("|") ? subject.split("|") : subject.includes(",") ? subject.split(",") : args;
      options = options.map((x) => x.trim()).filter(Boolean);
      return options.length < 2 ? "🤔 Give me at least two options, separated with | or commas." : "🤔 I choose: *" + randomChoice(options) + "*";
    }
    case "rps": {
      const aliases = { r: "rock", p: "paper", s: "scissors" };
      const player = aliases[(args[0] || "").toLowerCase()] || (args[0] || "").toLowerCase();
      const choices = ["rock", "paper", "scissors"];
      if (!choices.includes(player)) return "✊ Use " + PREFIX + "rps rock, " + PREFIX + "rps paper, or " + PREFIX + "rps scissors.";
      const bot = randomChoice(choices);
      const win = (player === "rock" && bot === "scissors") || (player === "paper" && bot === "rock") || (player === "scissors" && bot === "paper");
      return "✊ You: *" + player + "*\n🤖 Me: *" + bot + "*\n" + (player === bot ? "It's a tie!" : win ? "You win! 🎉" : "I win! 😄");
    }
    case "random": {
      const min = args.length ? Number(args[0]) : 1, max = args.length > 1 ? Number(args[1]) : 100;
      if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max || max - min > 1000000000) return "🎯 Use " + PREFIX + "random [min] [max] with whole numbers.";
      return "🎯 Random number: *" + (Math.floor(Math.random() * (max - min + 1)) + min) + "*";
    }
    case "wyr": {
      const choices = subject.includes("|") ? subject.split("|").map(x=>x.trim()).filter(Boolean) : subject.split(/\s+or\s+/i).map(x=>x.trim()).filter(Boolean);
      return choices.length === 2 ? "🤔 Would you rather…\nA) " + choices[0] + "\nB) " + choices[1] : "Use " + PREFIX + "wyr option A | option B";
    }
    case "ship": {
      const names = subject.split(/\s*\|\s*/).map(x=>x.trim()).filter(Boolean);
      if (names.length !== 2) return "💞 Use " + PREFIX + "ship name A | name B";
      return "💞 *" + names[0] + " + " + names[1] + "*: " + Math.floor(Math.random() * 101) + "% match (just for fun!)";
    }
    case "joke":
      return randomChoice(["😂 Why did the computer go to the doctor? It had a bad byte.", "😎 I told my code I needed a break. It said: 'You already have 404.'", "🤖 My Wi-Fi and I have a complicated relationship. It's always disconnecting.", "😂 I would tell you a UDP joke, but you might not get it.", "🧑‍💻 Why do programmers prefer dark mode? Because light attracts bugs."]);
    case "meme":
      return randomChoice(["📱 Me: I'll sleep early. Also me at 2am: one more video.", "🧠 Brain: remember that awkward thing from 2017? Me: no. Brain: too late.", "📶 Wi-Fi: connected. Internet: emotionally unavailable.", "👀 Group chat goes quiet. One person sends 'guys'. Everyone returns."]);
    case "fortune":
      return "🔮 *Fortune:* " + randomChoice(["A surprisingly good idea is coming your way.", "Someone in this group is about to say something hilarious.", "Today has strong snack-energy. 🍪", "Your next win will probably involve good timing.", "A tiny decision may turn into a great story."]);
    case "fact":
      return "🧠 " + randomChoice(["Octopuses have three hearts.", "Hummingbirds can fly backwards.", "A day on Venus is longer than its year.", "Honeybees use a waggle dance to share directions to food.", "The Eiffel Tower can grow slightly taller in hot weather.", "Bananas are berries in botanical terms; strawberries aren't."]);
    case "quote":
      return "💬 " + randomChoice(["Small steps still move you forward.", "Your future self is quietly cheering for you.", "Show up, try again, and keep the snacks close.", "A good plan leaves room for a better idea."]) + " — FriendsBot";
    case "compliment":
      return "💛 " + (subject || "You") + ", you make this group more fun just by being here.";
    case "hug":
      return "🫂 Sending a virtual hug to " + (subject || "the group") + "!";
    case "roast":
      return "🔥 " + (subject || "You") + ", your Wi-Fi signal has more commitment than your plans. (Friendly roast!)";
    case "truth":
      return "🫢 Truth: " + randomChoice(["What's a tiny thing that instantly improves your day?", "What's the funniest excuse you've used to avoid plans?", "Which song do you know every word to?", "What's a harmless opinion you will defend forever?"]);
    case "dare":
      return "🎭 Dare: " + randomChoice(["Send the last emoji you used and explain it.", "Give someone in this group a genuine compliment.", "Describe your day using only three emojis.", "Share a fun fact you know without looking it up."]);
    case "riddle":
      return "🧩 I have keys but no locks, space but no room. You can enter, but you can't go outside. What am I?\nAnswer: a keyboard. 😄";
    case "reverse":
      return subject ? "🔁 " + Array.from(subject).reverse().join("") : "Use " + PREFIX + "reverse <text>";
    case "rate":
      return subject ? "⭐ " + subject + ": *" + (Math.floor(Math.random() * 10) + 1) + "/10*" : "Use " + PREFIX + "rate <thing>";
    default:
      return null;
  }
}

function normalizeJidSafe(value) {
  if (!value || typeof value !== "string") return "";
  try { return jidNormalizedUser(value); } catch { return value; }
}

function hasGroupAdminRole(participant) {
  return Boolean(participant && (participant.admin === "admin" || participant.admin === "superadmin" || participant.isAdmin || participant.isSuperAdmin));
}

function findGroupParticipant(participants, jid) {
  const normalized = normalizeJidSafe(jid);
  if (!normalized) return null;
  return participants.find((participant) => [participant.id, participant.lid].some((id) => normalizeJidSafe(id) === normalized)) || null;
}

function getCommandTargetJid(message) {
  let content = normalizeMessageContent(message && message.message) || (message && message.message) || {};
  for (let i = 0; i < 4 && content; i++) {
    const wrapper = content.ephemeralMessage || content.viewOnceMessage || content.viewOnceMessageV2 || content.documentWithCaptionMessage;
    if (wrapper && wrapper.message) content = wrapper.message;
    else break;
  }
  const context = content.extendedTextMessage?.contextInfo || content.imageMessage?.contextInfo || content.videoMessage?.contextInfo || content.documentMessage?.contextInfo;
  return context?.mentionedJid?.[0] || context?.participant || null;
}

async function handleGroupCommand(sock, message, groupJid, command, sender) {
  if (!groupJid.endsWith("@g.us")) return "⚠️ This command only works inside a group.";
  let metadata;
  try { metadata = await sock.groupMetadata(groupJid); }
  catch (error) { console.error("Group metadata failed:", error?.message || error); return "❌ Couldn't read this group's details. Try again."; }
  const participants = metadata.participants || [];
  const admins = participants.filter(hasGroupAdminRole);
  if (command === "groupinfo") return "👥 *" + (metadata.subject || "Group") + "*\nMembers: " + participants.length + "\nAdmins: " + admins.length;
  if (command === "admins") return admins.length ? "🛡️ Group admins:\n" + admins.map((p) => "• " + String(p.id || p.lid || "admin").split("@")[0].split(":")[0]).join("\n") : "🛡️ No admin list was returned.";

  const senderParticipant = findGroupParticipant(participants, sender);
  if (!hasGroupAdminRole(senderParticipant)) return "⛔ Only a group admin can use " + PREFIX + command + ".";
  const botJid = normalizeJidSafe(sock.user?.id);
  const botParticipant = findGroupParticipant(participants, botJid);
  if (!hasGroupAdminRole(botParticipant)) return "⚠️ Make the bot a group admin first; it needs admin rights for this action.";

  if (command === "lock" || command === "mute") {
    try { await sock.groupSettingUpdate(groupJid, "announcement"); return "🔒 Group locked — only admins can send messages."; }
    catch (error) { console.error("Group lock failed:", error?.message || error); return "❌ Couldn't lock the group. Check that the bot is still an admin."; }
  }
  if (command === "unlock" || command === "unmute") {
    try { await sock.groupSettingUpdate(groupJid, "not_announcement"); return "🔓 Group unlocked — everyone can send messages."; }
    catch (error) { console.error("Group unlock failed:", error?.message || error); return "❌ Couldn't unlock the group. Check that the bot is still an admin."; }
  }
  if (command === "kick" || command === "remove") {
    const requestedTarget = getCommandTargetJid(message);
    if (!requestedTarget) return "👢 Mention the member or reply to their message: " + PREFIX + "kick @member";
    const target = findGroupParticipant(participants, requestedTarget);
    if (!target) return "❓ I couldn't find that member in this group. Mention them or reply to their message.";
    if (normalizeJidSafe(target.id) === botJid) return "🤖 I can't remove myself from the group.";
    if (hasGroupAdminRole(target)) return "🛡️ I won't kick a group admin. Change their role in WhatsApp first if needed.";
    try {
      await sock.groupParticipantsUpdate(groupJid, [target.id], "remove");
      return "✅ Removed @" + String(target.id).split("@")[0].split(":")[0] + " from the group.";
    } catch (error) {
      console.error("Group kick failed:", error?.message || error);
      return "❌ Couldn't remove that member. Check the bot's admin role and try again.";
    }
  }
  return "❓ Unknown group command.";
}

async function sendText(sock, jid, text) {
  const startedAt = Date.now();
  const sent = await sock.sendMessage(jid, { text });
  const sentId = sent && sent.key && sent.key.id;
  if (sentId) {
    sentMessageIds.add(sentId);
    if (sentMessageIds.size > 2000) sentMessageIds.delete(sentMessageIds.values().next().value);
  }
  console.log("📤 WhatsApp send ack: " + (Date.now() - startedAt) + "ms");
  return sent;
}

async function notifyOwnerConnected(sock) {
  const ownerJid = OWNER_PHONE_NUMBER
    ? OWNER_PHONE_NUMBER + "@s.whatsapp.net"
    : sock.user && sock.user.id
      ? jidNormalizedUser(sock.user.id)
      : null;
  if (!ownerJid) {
    console.warn("⚠️ Connected, but no owner JID is available for the WhatsApp confirmation.");
    return false;
  }
  try {
    await sendText(sock, ownerJid, "✅ " + BOT_NAME + " connected successfully!\nPrefix: " + PREFIX + "\nUse " + PREFIX + "help in your friends group.");
    console.log("✅ Connected confirmation sent to the owner.");
    return true;
  } catch (error) {
    console.error("Could not send the WhatsApp connected confirmation:", error && error.message ? error.message : error);
    return false;
  }
}

async function handleIncomingMessage(sock, message) {
  const jid = message && message.key && message.key.remoteJid;
  if (!jid || jid === "status@broadcast") return;
  if (message.key && message.key.id && sentMessageIds.has(message.key.id)) return;

  const isGroup = jid.endsWith("@g.us");
  const text = getMessageText(message.message);
  if (!text.startsWith(PREFIX)) return;

  const body = text.slice(PREFIX.length).trim();
  if (!body) return;

  const parts = body.split(/\s+/);
  const command = parts.shift().toLowerCase();
  const args = parts;

  // Allow !groupid in any group so a stale ALLOWED_GROUP_ID can be corrected.
  if (ALLOWED_GROUP_ID && (!isGroup || jid !== ALLOWED_GROUP_ID) && !(isGroup && ["groupid", "id"].includes(command))) return;

  const sender = message.key?.fromMe && sock.user?.id
    ? normalizeJidSafe(sock.user.id)
    : normalizeJidSafe((message.key && message.key.participant) || jid);
  const cooldownKey = jid + ":" + sender;
  console.log("⚡ Command received: " + PREFIX + command + " | chat: " + jid);

  const coreCommands = ["ping", "help", "commands", "status", "about", "uptime", "prefix", "groupid", "id", "groupinfo", "admins"];
  if (!coreCommands.includes(command) && isCoolingDown(cooldownKey)) return;

  const groupCommands = ["kick", "remove", "lock", "mute", "unlock", "unmute", "admins", "groupinfo"];
  let response = groupCommands.includes(command)
    ? await handleGroupCommand(sock, message, jid, command, sender)
    : handleCommand(command, args, { jid, isGroup, sender });

  if (command === "ai") {
    const prompt = args.join(" ").trim();
    if (!prompt) {
      response = "🤖 Use " + PREFIX + "ai <message>\nExample: " + PREFIX + "ai tell me a fun fact";
    } else {
      try {
        if (prompt.length > 2000) {
        response = "⚠️ Keep AI prompts under 2,000 characters so I can answer quickly.";
      } else {
        response = await askGroq(prompt, sender);
      }
      } catch (error) {
        console.error("Groq AI error:", error && error.message ? error.message : error);
        response = "❌ *AI request failed.* Please try again in a moment.";
      }
    }
  }

  if (!response) {
    response = "❓ Unknown command: *" + PREFIX + command + "*\nUse *" + PREFIX + "help* to see every available command.";
  }

  try {
    await sendText(sock, jid, response);
  } catch (error) {
    console.error("Failed to send reply:", error && error.message ? error.message : error);
  }
}

async function connectToWhatsApp() {
  if (isConnecting) return;
  isConnecting = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    // A valid saved session must always win over pairing mode. This prevents
    // every Render restart from generating a new pairing code.
    const hasSavedSession = Boolean(state.creds.registered);
    if (hasSavedSession) {
      console.log("🔐 Saved WhatsApp session found. Reusing it; no new pairing code will be requested.");
    }

    let version;
    try {
      const latest = await fetchLatestWaWebVersion();
      version = latest.version;
      console.log("🌐 Using live WhatsApp Web version: " + version.join("."));
    } catch {
      console.warn("⚠️ Could not fetch live WhatsApp Web version; falling back to Baileys version.");
      try {
        const latest = await fetchLatestBaileysVersion();
        version = latest.version;
      } catch {
        version = undefined;
      }
    }

    const sock = makeWASocket({
      auth: state,
      version,
      logger: pino({ level: "silent" }),
      markOnlineOnConnect: true,
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      generateHighQualityLinkPreview: false
    });

    sock.ev.on("creds.update", saveCreds);

    // Save credentials immediately whenever WhatsApp updates the session.
    // This is what allows later restarts to reuse the same linked session.


    let pairingRequested = false;
    let pairingTimer = null;

    const requestPairingCode = async () => {
      if (pairingRequested || state.creds.registered || !PAIRING_PHONE_NUMBER) return;

      pairingRequested = true;
      try {
        // Give the socket time to establish its transport before requesting a code.
        await new Promise((resolve) => setTimeout(resolve, 5000));

        if (state.creds.registered) {
          console.log("ℹ️ WhatsApp became paired before the pairing code was requested.");
          pairingRequested = false;
          return;
        }

        const code = await sock.requestPairingCode(PAIRING_PHONE_NUMBER);
        console.log("");
        console.log("🔑 WhatsApp pairing code: " + code);
        console.log("📱 On your phone: WhatsApp → Settings → Linked devices → Link a device → Link with phone number.");
        console.log("⏱️ Enter the newest code promptly; do not reuse an older code.");
        console.log("🔒 Never share the pairing code with anyone.");
        console.log("");

      } catch (error) {
        pairingRequested = false;
        console.error("❌ Pairing code request failed:", error?.message || error);
      }
    };

    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      if (qr && !PAIRING_PHONE_NUMBER) {
        console.log("\n📱 Scan this QR with WhatsApp → Settings → Linked devices → Link a device\n");
        qrcode.generate(qr, { small: true });
        console.log("\n🔒 Never share this QR or your saved auth_info folder.\n");
      }

      if (connection === "connecting") {
        console.log("🔄 Connecting to WhatsApp...");

        if (PAIRING_PHONE_NUMBER && !state.creds.registered && !hasSavedSession && !pairingRequested && !pairingTimer) {
          pairingTimer = setTimeout(() => {
            pairingTimer = null;
            requestPairingCode().catch((error) => {
              pairingRequested = false;
              console.error("❌ Pairing flow failed:", error?.message || error);
            });
          }, 1500);
        }
      }

      if (connection === "open") {
        if (pairingTimer) {
          clearTimeout(pairingTimer);
          pairingTimer = null;
        }

        isConnecting = false;
        isWhatsAppConnected = true;
        console.log("✅ WhatsApp connected successfully!");
        console.log(state.creds.registered
          ? "🔐 WhatsApp authentication is saved."
          : "ℹ️ Connection opened without a registered pairing state.");

        if (!hasSentConnectionNotice) {
          const noticeSent = await notifyOwnerConnected(sock);
          if (noticeSent) hasSentConnectionNotice = true;
        }

        if (ALLOWED_GROUP_ID) {
          console.log("🔐 Group restriction enabled:", ALLOWED_GROUP_ID);
        } else {
          console.log("ℹ️ No group restriction is set yet.");
        }
      }

      if (connection === "close") {
        if (pairingTimer) {
          clearTimeout(pairingTimer);
          pairingTimer = null;
        }

        isConnecting = false;
        isWhatsAppConnected = false;
        const disconnectError = lastDisconnect && lastDisconnect.error;
        const statusCode = disconnectError ? new Boom(disconnectError).output?.statusCode : undefined;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        console.error(
          "❌ WhatsApp connection closed. Code: " +
          (statusCode ?? "unknown") +
          (loggedOut ? " (logged out)" : "") +
          (disconnectError && disconnectError.message ? " | " + String(disconnectError.message).slice(0, 180) : "")
        );

        if (loggedOut) {
          console.error("🔐 WhatsApp rejected/invalidated this auth session.");
          console.error("ℹ️ Because this is a fresh Render filesystem, redeploying alone will not restore an old logged-out session.");
          console.error("ℹ️ Start a fresh pairing attempt instead of reusing an old code.");
          return;
        }

        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          connectToWhatsApp().catch((error) => {
            isConnecting = false;
            console.error("Reconnect failed:", error?.message || error);
          });
        }, 3000);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      await Promise.allSettled(messages.map(async (message) => {
        try {
          await handleIncomingMessage(sock, message);
        } catch (error) {
          console.error("Message handler error:", error?.message || error);
        }
      }));
    });

    return sock;
  } catch (error) {
    isConnecting = false;
    console.error("❌ WhatsApp startup error:", error?.message || error);
    throw error;
  }
}

function startHealthServer() {
  const http = require("http");
  const port = Number(process.env.PORT || 10000);
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, whatsapp: WHATSAPP_ENABLED, connected: isWhatsAppConnected, prefix: PREFIX, uptime: Math.floor(process.uptime()) }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`${BOT_NAME} is running`);
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(`🌐 Health server listening on 0.0.0.0:${port}`);
  });
  return server;
}

async function start() {
  // Start the HTTP listener first so Render can detect the Web Service port immediately.
  startHealthServer();

  console.log("");
  console.log("╔══════════════════════════════════════╗");
  console.log("║         FRIENDS WHATSAPP BOT         ║");
  console.log("╚══════════════════════════════════════╝");
  console.log(`Bot: ${BOT_NAME}`);
  console.log(`Prefix: ${PREFIX}`);
  console.log(`WhatsApp: ${WHATSAPP_ENABLED ? "ENABLED" : "DISABLED"}`);
  console.log(`Cooldown: ${COOLDOWN_MS}ms`);
  console.log(`Pairing: ${PAIRING_PHONE_NUMBER ? "PHONE CODE" : "QR CODE"}`);
  console.log(`Auth directory: ${AUTH_DIR}`);
  console.log(`Try ${PREFIX}ping and ${PREFIX}help in a group after the bot connects.`);
  console.log("");

  if (!WHATSAPP_ENABLED) {
    console.log("✅ Safe development mode.");
    console.log("WhatsApp connection is disabled.");
    console.log(`Run ${PREFIX}ping, ${PREFIX}help, ${PREFIX}8ball <question>, ${PREFIX}coinflip, or ${PREFIX}dice after connection is enabled.`);
    return;
  }

  console.log("⚠️ WhatsApp automation is unofficial. Use it only for your own friends/group and avoid spam or bulk messaging.");
  await connectToWhatsApp();
}

process.on("SIGINT", () => {
  clearTimeout(reconnectTimer);
  console.log("\n👋 Shutting down safely...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  clearTimeout(reconnectTimer);
  console.log("\n👋 Shutting down safely...");
  process.exit(0);
});

start().catch((error) => {
  console.error("Fatal startup error:", error);
  process.exit(1);
});
