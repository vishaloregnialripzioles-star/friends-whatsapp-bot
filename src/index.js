require("dotenv").config();

const makeWASocket = require("@whiskeysockets/baileys").default;
const {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const qrcode = require("qrcode-terminal");
const pino = require("pino");
const Groq = require("groq-sdk");

const PREFIX = process.env.PREFIX || "!";
const BOT_NAME = process.env.BOT_NAME || "FriendsBot";
const WHATSAPP_ENABLED = String(process.env.WHATSAPP_ENABLED).toLowerCase() === "true";
const ALLOWED_GROUP_ID = (process.env.ALLOWED_GROUP_ID || "").trim();
const PAIRING_PHONE_NUMBER = (process.env.PAIRING_PHONE_NUMBER || "").replace(/\\D/g, "");
const COOLDOWN_MS = Math.max(0, Number(process.env.COOLDOWN_MS || 1500));
const GROQ_API_KEY = (process.env.GROQ_API_KEY || "").trim();
const AI_MODEL = (process.env.AI_MODEL || "llama-3.3-70b-versatile").trim();
const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;

const cooldowns = new Map();
let reconnectTimer = null;
let isConnecting = false;

function getMessageText(message) {
  if (!message) return "";
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
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
    return "⚠️ *AI is not configured yet.*\\nAdd GROQ_API_KEY in Render Environment Variables and redeploy.";
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
    max_tokens: 700,
    user: sender ? String(sender).slice(0, 64) : undefined
  });

  const answer = completion.choices?.[0]?.message?.content?.trim();
  if (!answer) throw new Error("Groq returned an empty response");
  return "🤖 *" + BOT_NAME + " AI*\\n\\n" + answer;
}
function helpText() {
  return [
    `✨ *${BOT_NAME}*`,
    "",
    `*Basic*`,
    `${PREFIX}ping — Check if I'm online`,
    `${PREFIX}help — Show this menu`,
    `${PREFIX}about — Bot information`,
    `${PREFIX}uptime — Show bot uptime`,
    "",
    `*Fun*`,
    `${PREFIX}8ball <question> — Magic 8-ball`,
    `${PREFIX}coinflip — Flip a coin`,
    `${PREFIX}dice — Roll a dice`,
    `${PREFIX}joke — Get a clean joke`,
    `${PREFIX}fortune — Random fun prediction`,
    `${PREFIX}ai <message> — Chat with Groq AI`,
    "",
    "More AI, games, XP and group features can be added on top of this stable core. ❤️"
  ].join("\n");
}

function handleCommand(command, args) {
  switch (command) {
    case "ping":
      return `🏓 *Pong!* ${BOT_NAME} is online and responding.`;

    case "help":
      return helpText();

    case "about":
      return [
        `🤖 *${BOT_NAME}*`,
        "",
        "Private friends-group bot",
        "Built with Node.js + Baileys",
        `Prefix: ${PREFIX}`,
        "",
        "🔒 Session files stay local and are ignored by Git."
      ].join("\n");

    case "uptime":
      return `⏱️ Uptime: *${formatUptime(process.uptime())}*`;

    case "8ball": {
      if (!args.length) return `🔮 Use *${PREFIX}8ball <question>*`;
      return `🔮 *${randomChoice([
        "Absolutely ✨",
        "Probably 😎",
        "Maybe... 👀",
        "Not looking good 😂",
        "Ask me again later.",
        "The answer is hidden in the clouds ☁️"
      ])}*`;
    }

    case "coinflip":
      return Math.random() < 0.5 ? "🪙 *Heads!*" : "🪙 *Tails!*";

    case "dice":
      return `🎲 You rolled *${Math.floor(Math.random() * 6) + 1}*`;

    case "joke":
      return randomChoice([
        "😂 Why did the computer go to the doctor? It had a bad byte.",
        "😎 I told my code I needed a break. It said: 'You already have 404.'",
        "🤖 My Wi-Fi and I have a complicated relationship. It's always disconnecting.",
        "😂 I would tell you a UDP joke, but you might not get it."
      ]);

    case "fortune":
      return `🔮 *Fortune:* ${randomChoice([
        "A surprisingly good idea is coming your way.",
        "Someone in this group is about to say something hilarious.",
        "Today has strong snack-energy. 🍪",
        "Your next win will probably involve good timing.",
        "A tiny decision may turn into a great story."
      ])}`;

    default:
      return null;
  }
}

async function sendText(sock, jid, text, quotedMessage) {
  await sock.sendMessage(jid, { text }, quotedMessage ? { quoted: quotedMessage } : undefined);
}

async function handleIncomingMessage(sock, message) {
  const jid = message.key.remoteJid;
  if (!jid || jid === "status@broadcast") return;
  if (message.key.fromMe) return;

  const isGroup = jid.endsWith("@g.us");
  if (ALLOWED_GROUP_ID && (!isGroup || jid !== ALLOWED_GROUP_ID)) return;

  const text = getMessageText(message.message);
  if (!text.startsWith(PREFIX)) return;

  const body = text.slice(PREFIX.length).trim();
  if (!body) return;

  const parts = body.split(/\s+/);
  const command = parts.shift().toLowerCase();
  const args = parts;

  const sender = message.key.participant || jid;
  if (isCoolingDown(sender)) return;

  let response = handleCommand(command, args);

  if (command === "ai") {
    const prompt = args.join(" ").trim();
    if (!prompt) {
      response = "🤖 Use *" + PREFIX + "ai <message>*\\nExample: *" + PREFIX + "ai tell me a fun fact*";
    } else {
      try {
        response = await askGroq(prompt, sender);
      } catch (error) {
        console.error("Groq AI error:", error?.message || error);
        response = "❌ *AI request failed.* Please try again in a moment.";
      }
    }
  }

  if (!response) return;

  try {
    await sendText(sock, jid, response, message);
  } catch (error) {
    console.error("Failed to send reply:", error?.message || error);
  }
}

async function connectToWhatsApp() {
  if (isConnecting) return;
  isConnecting = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info");

    let version;
    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
    } catch {
      version = undefined;
    }

    const sock = makeWASocket({
      auth: state,
      version,
      browser: Browsers.ubuntu("Chrome"),
      logger: pino({ level: "silent" }),
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    sock.ev.on("creds.update", saveCreds);

    let pairingRequested = false;

    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      if (qr && !PAIRING_PHONE_NUMBER) {
        console.log("\n📱 Scan this QR with WhatsApp → Settings → Linked devices → Link a device\n");
        qrcode.generate(qr, { small: true });
        console.log("\n🔒 Never share this QR or your saved auth_info folder.\n");
      }

      if (connection === "connecting" && PAIRING_PHONE_NUMBER && !state.creds.registered && !pairingRequested) {
        pairingRequested = true;
        setTimeout(async () => {
          try {
            if (state.creds.registered) {
              console.log("ℹ️ WhatsApp is already paired; skipping pairing code.");
              pairingRequested = false;
              return;
            }

            const code = await sock.requestPairingCode(PAIRING_PHONE_NUMBER);
            console.log("\n🔑 WhatsApp pairing code: " + code);
            console.log("On your phone: WhatsApp → Settings → Linked devices → Link a device → Link with phone number.");
            console.log("Enter the code above. Never share it with anyone else.\n");
          } catch (error) {
            pairingRequested = false;
            console.error("❌ Could not create pairing code:", error?.message || error);
          }
        }, 2500);
      }

      if (connection === "connecting") {
        console.log("🔄 Connecting to WhatsApp...");
      }

      if (connection === "open") {
        isConnecting = false;
        console.log("✅ WhatsApp connected successfully!");
        if (ALLOWED_GROUP_ID) {
          console.log("🔐 Group restriction enabled:", ALLOWED_GROUP_ID);
        } else {
          console.log("ℹ️ No group restriction is set yet.");
        }
      }

      if (connection === "close") {
        isConnecting = false;
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        console.error(
          `❌ WhatsApp connection closed. Code: ${statusCode ?? "unknown"}${loggedOut ? " (logged out)" : ""}`
        );

        if (!loggedOut) {
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            connectToWhatsApp().catch((error) => {
              isConnecting = false;
              console.error("Reconnect failed:", error?.message || error);
            });
          }, 3000);
        } else {
          console.error("Please remove the local auth_info folder and pair again if you intentionally logged out.");
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const message of messages) {
        try {
          await handleIncomingMessage(sock, message);
        } catch (error) {
          console.error("Message handler error:", error?.message || error);
        }
      }
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
      res.end(JSON.stringify({ ok: true, whatsapp: WHATSAPP_ENABLED, uptime: Math.floor(process.uptime()) }));
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
  console.log("");
  console.log("╔══════════════════════════════════════╗");
  console.log("║         FRIENDS WHATSAPP BOT         ║");
  console.log("╚══════════════════════════════════════╝");
  console.log(`Bot: ${BOT_NAME}`);
  console.log(`Prefix: ${PREFIX}`);
  console.log(`WhatsApp: ${WHATSAPP_ENABLED ? "ENABLED" : "DISABLED"}`);
  console.log(`Cooldown: ${COOLDOWN_MS}ms`);
  console.log(`Pairing: ${PAIRING_PHONE_NUMBER ? "PHONE CODE" : "QR CODE"}`);
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
