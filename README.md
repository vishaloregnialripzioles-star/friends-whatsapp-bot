# Friends WhatsApp Bot ❤️

A private friends-group WhatsApp bot built with Node.js and Baileys.

## Current features

- Safe development mode by default
- WhatsApp QR pairing
- Persistent local WhatsApp session
- Automatic reconnect after temporary disconnects
- `!ping`, `!help`, `!about`, `!uptime`
- `!8ball`, `!coinflip`, `!dice`, `!joke`, `!fortune`
- Per-user cooldown to reduce accidental spam
- Optional single-group restriction with `ALLOWED_GROUP_ID`
- Session/auth files excluded from Git

## Local setup

Requires Node.js 20+.

```bash
npm install
```

Copy `.env.example` to `.env`, then set:

```env
WHATSAPP_ENABLED=true
```

Start:

```bash
npm start
```

On first run, a QR code is printed in the terminal. On your phone, open WhatsApp → Settings → Linked devices → Link a device, then scan it. The saved session is reused on later starts.

**Never send the QR code, pairing code, or `auth_info` folder to anyone or commit it to GitHub.**

## Optional group restriction

After connecting, the bot can be restricted to one group by setting:

```env
ALLOWED_GROUP_ID=
```

The value must be that group's WhatsApp JID (normally ending in `@g.us`). Leave it empty while testing if you want commands to work in any chat.

## Important

Baileys is an unofficial WhatsApp Web-compatible library and is not affiliated with WhatsApp. Use the bot only for your own friends/group, keep activity low-volume, and follow WhatsApp's rules. Account restrictions are possible with unofficial automation.

## Planned next

AI chat, more games, XP/leaderboards, group utilities, welcome messages, polls, and other friends-only features—added on top of this stable connection layer.

Never commit `.env`, `auth_info/`, QR codes, pairing codes, API keys, or session credentials.
