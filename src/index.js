require("dotenv").config();

const PREFIX = process.env.PREFIX || "!";
const BOT_NAME = process.env.BOT_NAME || "FriendsBot";
const WHATSAPP_ENABLED = String(process.env.WHATSAPP_ENABLED).toLowerCase() === "true";

function handleCommand(command, args, sender) {
  switch (command) {
    case "ping":
      return "🏓 Pong! " + BOT_NAME + " is alive.";

    case "help":
      return [
        "✨ *" + BOT_NAME + "*",
        "",
        PREFIX + "ping — Check if the bot is alive",
        PREFIX + "help — Show commands",
        PREFIX + "8ball <question> — Ask the magic 8-ball",
        PREFIX + "coinflip — Flip a coin",
        PREFIX + "dice — Roll a dice"
      ].join("\n");

    case "8ball": {
      if (!args.length) return "🔮 Ask me a question after " + PREFIX + "8ball";
      const answers = [
        "Absolutely ✨",
        "Probably 😎",
        "Maybe... 👀",
        "Not looking good 😂",
        "Ask me again later 🔮",
        "The bot refuses to reveal that 🤫"
      ];
      return "🔮 " + answers[Math.floor(Math.random() * answers.length)];
    }

    case "coinflip":
      return Math.random() < 0.5 ? "🪙 Heads!" : "🪙 Tails!";

    case "dice":
      return "🎲 You rolled **" + (Math.floor(Math.random() * 6) + 1) + "**";

    default:
      return null;
  }
}

async function start() {
  console.log("");
  console.log("╔════════════════════════════════════╗");
  console.log("║        FRIENDS WHATSAPP BOT        ║");
  console.log("╚════════════════════════════════════╝");
  console.log("Bot:", BOT_NAME);
  console.log("Prefix:", PREFIX);
  console.log("WhatsApp:", WHATSAPP_ENABLED ? "ENABLED" : "DISABLED");
  console.log("");

  if (!WHATSAPP_ENABLED) {
    console.log("✅ Safe development mode.");
    console.log("WhatsApp connection is disabled.");
    console.log("Next stage will connect the bot after the core is tested.");
    console.log("");
    console.log("Test commands:");
    console.log(PREFIX + "ping");
    console.log(PREFIX + "help");
    console.log(PREFIX + "8ball <question>");
    console.log(PREFIX + "coinflip");
    console.log(PREFIX + "dice");
    return;
  }

  // WhatsApp connection will be added in the next stage.
  // Keeping it isolated prevents accidental login of your personal account
  // while the project is still being configured.
  console.log("⚠️ WhatsApp mode is enabled, but the connector is not configured yet.");
}

start().catch((error) => {
  console.error("Fatal startup error:", error);
  process.exit(1);
});
