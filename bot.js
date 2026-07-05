require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { startDialingCampaign, activeCampaigns, getCampaignStatusText } = require('./dialer');
const { verifySipCredentials } = require('./sip-auth');

// CLI args for child mode
const args = process.argv.slice(2);
let isChild = false;
let childConfigPath = '';
let childConfig = null;

if (args.includes('--child')) {
    isChild = true;
    childConfigPath = args[args.indexOf('--child') + 1];
    try {
        childConfig = JSON.parse(fs.readFileSync(childConfigPath, 'utf-8'));
    } catch (e) {
        console.error('[CHILD] Failed to parse child config:', e.message);
        process.exit(1);
    }
}

// Paths
const botsDir = path.join(__dirname, 'bots');
if (!fs.existsSync(botsDir)) fs.mkdirSync(botsDir, { recursive: true });

const sessionFile = isChild
    ? path.join(botsDir, `${path.basename(childConfigPath, '.json')}_sessions.json`)
    : path.join(__dirname, 'sessions.json');

const permissionsFile = isChild
    ? path.join(botsDir, `${path.basename(childConfigPath, '.json')}_permissions.json`)
    : path.join(__dirname, 'permissions.json');

// Token & Bot
const token = isChild
    ? childConfig.token
    : (process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN || '8829064516:AAFT8Aw2rWxlvQtbEAxiAf73hYMm3T3KFoA');

const bot = new TelegramBot(token, { polling: true });

// Save PID for child lifecycle tracking
if (isChild) {
    childConfig.pid = process.pid;
    try { fs.writeFileSync(childConfigPath, JSON.stringify(childConfig, null, 2)); } catch (_) {}
}

// Auto-spawn saved child bots on master startup
if (!isChild) {
    try {
        const files = fs.readdirSync(botsDir);
        files.forEach(file => {
            if (file.endsWith('.json') && !file.includes('_permissions') && !file.includes('_sessions')) {
                const cfgPath = path.join(botsDir, file);
                console.log(`[MASTER] Auto-spawning child bot: ${file}`);
                const cp = spawn('node', ['bot.js', '--child', cfgPath], {
                    detached: true, stdio: 'ignore', cwd: __dirname
                });
                cp.unref();
            }
        });
    } catch (err) {
        console.error('[MASTER] Auto-spawn error:', err.message);
    }
}

// Sessions
const activeSessions = {};
const userState = {};

let globalSip = null;
const globalSipFile = path.join(__dirname, 'global_sip.json');
if (fs.existsSync(globalSipFile)) {
    try { globalSip = JSON.parse(fs.readFileSync(globalSipFile)); } catch (_) {}
}

function saveGlobalSip() {
    fs.writeFileSync(globalSipFile, JSON.stringify(globalSip, null, 2));
}

if (fs.existsSync(sessionFile)) {
    try { Object.assign(activeSessions, JSON.parse(fs.readFileSync(sessionFile))); } catch (_) {}
}

function saveSessions() {
    fs.writeFileSync(sessionFile, JSON.stringify(activeSessions, null, 2));
}

// Permissions
const permissions = { users: {}, groups: {} };

if (fs.existsSync(permissionsFile)) {
    try { Object.assign(permissions, JSON.parse(fs.readFileSync(permissionsFile))); } catch (_) {}
}

function savePermissions() {
    fs.writeFileSync(permissionsFile, JSON.stringify(permissions, null, 2));
}

// Admin IDs (master bot supports multiple admins)
const ADMIN_IDS = isChild ? [childConfig.adminId] : [8703731319, 6375365331];
const ADMIN_ID = ADMIN_IDS[0]; // primary admin (backwards compat)
function isAdmin(userId) { return ADMIN_IDS.includes(userId); }

// Permission check
async function hasPermissionAsync(msg) {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    if (isAdmin(userId)) return true;
    if (permissions.users[String(userId)]) return true;
    if (permissions.groups[String(chatId)]) return true;
    for (const groupId of Object.keys(permissions.groups)) {
        try {
            const member = await bot.getChatMember(groupId, userId);
            if (member && ['creator', 'administrator', 'member'].includes(member.status)) return true;
        } catch (_) {}
    }
    return false;
}

// Menus
function sendMainMenu(chatId) {
    bot.sendMessage(chatId, 'Main Menu', {
        reply_markup: {
            keyboard: [
                [{ text: '▶️ Resume' }, { text: '⏸️ Pause' }, { text: '🔴 Stop' }],
                [{ text: '📋 List Campaign' }],
                [{ text: '🛠️ Set Caller ID' }, { text: '🎵 Change Audio' }],
                [{ text: '❓ Help' }]
            ],
            resize_keyboard: true
        }
    });
}

function sendAdminMenu(chatId) {
    let rows;
    if (isChild) {
        rows = [
            [{ text: '✅ Permit User' }, { text: '🚫 Revoke User' }],
            [{ text: '🏢 Permit Group' }, { text: '🚫 Revoke Group' }],
            [{ text: '👥 Show Permitted' }]
        ];
    } else {
        rows = [
            [{ text: '✅ Permit User' }, { text: '🚫 Revoke User' }],
            [{ text: '🏢 Permit Group' }, { text: '🚫 Revoke Group' }],
            [{ text: '👥 Show Permitted' }],
            [{ text: '🌐 Set Global SIP' }],
            [{ text: '🔀 Change Route' }, { text: '📤 Upload Audio' }],
            [{ text: '🧁 Host New Bot' }, { text: '🧁 List Bots' }, { text: '🗑️ Delete Bot' }]
        ];
    }
    bot.sendMessage(chatId, 'Admin Control Panel', {
        reply_markup: { keyboard: rows, resize_keyboard: true }
    });
}

// Get or create session, injecting SIP from config for child bots
function getOrCreateSession(chatId) {
    if (!activeSessions[chatId]) activeSessions[chatId] = {};
    const s = activeSessions[chatId];
    if (isChild && childConfig && childConfig.sip) {
        if (!s.username) {
            s.username = childConfig.sip.username;
            s.password = childConfig.sip.password;
            s.ip = childConfig.sip.ip;
        }
    } else if (!isChild && globalSip) {
        if (!s.username || s.username !== globalSip.username) {
            s.username = globalSip.username;
            s.password = globalSip.password;
            s.ip = globalSip.ip;
        }
    }
    return activeSessions[chatId];
}

function extractPhoneNumber(line) {
    if (!line || !line.trim()) return null;
    const fields = line.split(',');
    for (let field of fields) {
        field = field.trim().replace(/^["']|["']$/g, '');
        const stripped = field.replace(/[\s\-\(\)\+]/g, '');
        if (/^\d+$/.test(stripped)) {
            if (stripped.length >= 10 && stripped.length <= 15) {
                return stripped;
            }
        }
    }
    const cleanDigits = line.replace(/\D/g, '');
    if (cleanDigits.length >= 10 && cleanDigits.length <= 15) {
        if (cleanDigits.length > line.length * 0.5) {
            return cleanDigits;
        }
    }
    return null;
}

// Parse numbers from file
function parseNumbersFromFile(filePath) {
    return new Promise((resolve) => {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split(/\r?\n/);
            const nums = lines.map(l => extractPhoneNumber(l)).filter(Boolean);
            resolve(nums.length);
        } catch (_) { resolve(0); }
    });
}

console.log(`🤖 ${isChild ? '[CHILD]' : '[MASTER]'} SIP Bot is running...`);

// /start
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    if (!(await hasPermissionAsync(msg))) {
        bot.sendMessage(chatId, '<b>❌ You do not have permission to use this bot.</b>', { parse_mode: 'HTML' });
        return;
    }
    const welcomeText = `📤 Upload Your Number List\n\nPlease send your .txt file containing numbers. Supported formats:\n\n1️⃣ Single number per line:  \n1234567890\n\n2️⃣ Number with email and name:  \n1234567890,email@example.com,John Doe`;
    bot.sendMessage(chatId, welcomeText, {
        reply_markup: {
            keyboard: [
                [{ text: '▶️ Resume' }, { text: '⏸️ Pause' }, { text: '🔴 Stop' }],
                [{ text: '📋 List Campaign' }],
                [{ text: '🛠️ Set Caller ID' }, { text: '🎵 Change Audio' }],
                [{ text: '❓ Help' }]
            ],
            resize_keyboard: true
        }
    });
});

// /admin
bot.onText(/\/admin/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAdmin(msg.from.id)) {
        bot.sendMessage(chatId, '<b>❌ You do not have permission to access the Admin Panel.</b>', { parse_mode: 'HTML' });
        return;
    }
    sendAdminMenu(chatId);
});

// Main message handler
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!text && !msg.document) return;
    if (text === '/start' || text === '/admin') return;

    if (!(await hasPermissionAsync(msg))) {
        bot.sendMessage(chatId, '❌ You do not have permission to use this bot.');
        return;
    }

    if (text) {
        // ADMIN: Permit User
        if (text === '✅ Permit User') {
            if (msg.from.id !== ADMIN_ID) { bot.sendMessage(chatId, '❌ Admin only.'); return; }
            userState[chatId] = 'ADMIN_PERMIT_USER';
            bot.sendMessage(chatId, '<b>👤 Enter the User ID to permit:</b>', { parse_mode: 'HTML' });
            return;
        }
        if (userState[chatId] === 'ADMIN_PERMIT_USER') {
            const uid = text.trim();
            if (!uid || isNaN(uid)) { bot.sendMessage(chatId, '❌ Enter a valid numerical User ID.'); return; }
            permissions.users[uid] = true;
            savePermissions();
            delete userState[chatId];
            bot.sendMessage(chatId, `✅ User \`${uid}\` has been permitted.`, { parse_mode: 'Markdown' });
            return;
        }

        // ADMIN: Revoke User
        if (text === '🚫 Revoke User') {
            if (msg.from.id !== ADMIN_ID) { bot.sendMessage(chatId, '❌ Admin only.'); return; }
            userState[chatId] = 'ADMIN_REVOKE_USER';
            bot.sendMessage(chatId, '<b>👤 Enter the User ID to revoke:</b>', { parse_mode: 'HTML' });
            return;
        }
        if (userState[chatId] === 'ADMIN_REVOKE_USER') {
            const uid = text.trim();
            if (!uid || isNaN(uid)) { bot.sendMessage(chatId, '❌ Enter a valid numerical User ID.'); return; }
            delete permissions.users[uid];
            savePermissions();
            delete userState[chatId];
            bot.sendMessage(chatId, `✅ User \`${uid}\` has been revoked.`, { parse_mode: 'Markdown' });
            return;
        }

        // ADMIN: Permit Group
        if (text === '🏢 Permit Group') {
            if (msg.from.id !== ADMIN_ID) { bot.sendMessage(chatId, '❌ Admin only.'); return; }
            userState[chatId] = 'ADMIN_PERMIT_GROUP';
            bot.sendMessage(chatId, '<b>🏢 Enter the Group ID to permit (e.g. -100123456789):</b>', { parse_mode: 'HTML' });
            return;
        }
        if (userState[chatId] === 'ADMIN_PERMIT_GROUP') {
            const gid = text.trim();
            if (!gid || isNaN(gid)) { bot.sendMessage(chatId, '❌ Enter a valid numerical Group ID.'); return; }
            permissions.groups[gid] = true;
            savePermissions();
            delete userState[chatId];
            bot.sendMessage(chatId, `✅ Group \`${gid}\` has been permitted.`, { parse_mode: 'Markdown' });
            return;
        }

        // ADMIN: Revoke Group
        if (text === '🚫 Revoke Group') {
            if (msg.from.id !== ADMIN_ID) { bot.sendMessage(chatId, '❌ Admin only.'); return; }
            userState[chatId] = 'ADMIN_REVOKE_GROUP';
            bot.sendMessage(chatId, '<b>🏢 Enter the Group ID to revoke:</b>', { parse_mode: 'HTML' });
            return;
        }
        if (userState[chatId] === 'ADMIN_REVOKE_GROUP') {
            const gid = text.trim();
            if (!gid || isNaN(gid)) { bot.sendMessage(chatId, '❌ Enter a valid numerical Group ID.'); return; }
            delete permissions.groups[gid];
            savePermissions();
            delete userState[chatId];
            bot.sendMessage(chatId, `✅ Group \`${gid}\` has been revoked.`, { parse_mode: 'Markdown' });
            return;
        }

        // ADMIN: Show Permitted
        if (text === '👥 Show Permitted') {
            if (msg.from.id !== ADMIN_ID) { bot.sendMessage(chatId, '❌ Admin only.'); return; }
            const users = Object.keys(permissions.users);
            const groups = Object.keys(permissions.groups);
            let out = `🤖 *Permitted Users:*\n`;
            out += users.length ? users.map(u => `� \`${u}\``).join('\n') : '� None';
            out += `\n\n?? *Permitted Groups:*\n`;
            out += groups.length ? groups.map(g => `� \`${g}\``).join('\n') : '� None';
            bot.sendMessage(chatId, out, { parse_mode: 'Markdown' });
            return;
        }

        // MASTER ONLY: Host New Bot
        if (text === '🧁 Host New Bot') {
            if (isChild || msg.from.id !== ADMIN_ID) { bot.sendMessage(chatId, '❌ Admin only.'); return; }
            userState[chatId] = 'NEW_BOT_TOKEN';
            bot.sendMessage(chatId, '<b>🤖 Enter the Telegram Bot Token for the new bot:</b>', { parse_mode: 'HTML' });
            return;
        }
        if (userState[chatId] === 'NEW_BOT_TOKEN') {
            const newToken = text.trim();
            if (!newToken.includes(':')) {
                bot.sendMessage(chatId, '❌ Invalid token format. Must be like `123456:ABC-DEF...`', { parse_mode: 'Markdown' });
                return;
            }
            userState[`${chatId}_newbot`] = { token: newToken };
            userState[chatId] = 'NEW_BOT_SIP';
            bot.sendMessage(chatId, '<b>🔑 Enter SIP credentials:</b>\n\n<code>username password ip</code>\n\nExample: <code>test pass123 87.120.165.229</code>', { parse_mode: 'HTML' });
            return;
        }
        if (userState[chatId] === 'NEW_BOT_SIP') {
            const parts = text.trim().split(/\s+/);
            if (parts.length !== 3) {
                bot.sendMessage(chatId, '❌ Invalid format. Enter as: `username password ip`', { parse_mode: 'Markdown' });
                return;
            }
            const [username, password, ip] = parts;
            // Store SIP credentials directly — no pre-verification (avoids timeout issues)
            userState[`${chatId}_newbot`].sip = { username, password, ip };
            userState[chatId] = 'NEW_BOT_ADMIN';
            bot.sendMessage(chatId, `<b>✅ SIP credentials saved!</b>\n\n• <b>User:</b> <code>${username}</code>\n• <b>Server:</b> <code>${ip}</code>\n\n<b>Now enter the Telegram User ID to set as admin for this bot:</b>`, { parse_mode: 'HTML' });
            return;
        }
        if (userState[chatId] === 'NEW_BOT_ADMIN') {
            const adminUserId = text.trim();
            if (!adminUserId || isNaN(adminUserId)) {
                bot.sendMessage(chatId, '❌ Enter a valid numerical User ID.');
                return;
            }
            const nb = userState[`${chatId}_newbot`];
            const botId = nb.token.split(':')[0];
            const cfgPath = path.join(botsDir, `${botId}.json`);
            const childConfigData = {
                token: nb.token,
                sip: nb.sip,
                adminId: parseInt(adminUserId)
            };
            fs.writeFileSync(cfgPath, JSON.stringify(childConfigData, null, 2));
            const childPermPath = path.join(botsDir, `${botId}_permissions.json`);
            fs.writeFileSync(childPermPath, JSON.stringify({
                users: { [adminUserId]: true },
                groups: {}
            }, null, 2));
            const cp = spawn('node', ['bot.js', '--child', cfgPath], {
                detached: true, stdio: 'ignore', cwd: __dirname
            });
            cp.unref();
            delete userState[`${chatId}_newbot`];
            delete userState[chatId];
            bot.sendMessage(chatId, `✅ Bot deployed!\n\n� Bot ID: \`${botId}\`\n� SIP User: \`${nb.sip.username}\`\n� Admin: \`${adminUserId}\``, { parse_mode: 'Markdown' });
            return;
        }

        // MASTER ONLY: List Bots
        if (text === '🧁 List Bots') {
            if (isChild || msg.from.id !== ADMIN_ID) { bot.sendMessage(chatId, '❌ Admin only.'); return; }
            try {
                const files = fs.readdirSync(botsDir).filter(f =>
                    f.endsWith('.json') && !f.includes('_permissions') && !f.includes('_sessions')
                );
                if (files.length === 0) { bot.sendMessage(chatId, 'ℹ️ No deployed bots found.'); return; }
                let out = `🤖 *Deployed Bots (${files.length}):*\n`;
                files.forEach(file => {
                    try {
                        const cfg = JSON.parse(fs.readFileSync(path.join(botsDir, file), 'utf-8'));
                        const bid = file.replace('.json', '');
                        const tok = cfg.token.slice(0, 8) + '...' + cfg.token.slice(-4);
                        out += `\n?? ID: \`${bid}\`\n� Token: \`${tok}\`\n� SIP: \`${cfg.sip.username}@${cfg.sip.ip}\`\n� Admin: \`${cfg.adminId}\`\n� PID: \`${cfg.pid || 'unknown'}\`\n`;
                    } catch (_) {}
                });
                bot.sendMessage(chatId, out, { parse_mode: 'Markdown' });
            } catch (err) {
                bot.sendMessage(chatId, `❌ Failed to list bots: ${err.message}`);
            }
            return;
        }

        // MASTER ONLY: Delete Bot
        if (text === '🗑️ Delete Bot') {
            if (isChild || msg.from.id !== ADMIN_ID) { bot.sendMessage(chatId, '❌ Admin only.'); return; }
            userState[chatId] = 'DELETE_BOT';
            bot.sendMessage(chatId, '<b>🗑️ Enter the Bot ID (numeric prefix) to delete:</b>', { parse_mode: 'HTML' });
            return;
        }
        if (userState[chatId] === 'DELETE_BOT') {
            const botId = text.trim();
            const cfgPath = path.join(botsDir, `${botId}.json`);
            if (!fs.existsSync(cfgPath)) { bot.sendMessage(chatId, '❌ No bot found with that ID.'); return; }
            try {
                const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
                if (cfg.pid) {
                    try { process.kill(cfg.pid, 'SIGTERM'); } catch (_) {}
                    const { exec } = require('child_process');
                    exec(`taskkill /F /PID ${cfg.pid}`);
                }
            } catch (_) {}
            [cfgPath,
             path.join(botsDir, `${botId}_permissions.json`),
             path.join(botsDir, `${botId}_sessions.json`)
            ].forEach(p => { try { fs.unlinkSync(p); } catch (_) {} });
            delete userState[chatId];
            bot.sendMessage(chatId, `<b>✅ Bot <code>${botId}</code> deleted and stopped.</b>`, { parse_mode: 'HTML' });
            return;
        }

        // Admin stubs
        if (['?? Change Route', '?? Upload Audio'].includes(text)) {
            bot.sendMessage(chatId, `🛠️ Feature *${text}* is under development.`, { parse_mode: 'Markdown' });
            return;
        }

        // MAIN MENU: Resume
        if (text === '▶️ Resume') {
            const c = activeCampaigns[chatId];
            if (c && c.status === 'paused') { c.status = 'running'; bot.sendMessage(chatId, '<b>▶️ Campaign resumed!</b>', { parse_mode: 'HTML' }); }
            else bot.sendMessage(chatId, '<b>❌ No paused campaign found.</b>', { parse_mode: 'HTML' });
            return;
        }

        // MAIN MENU: Pause
        if (text === '⏸️ Pause') {
            const c = activeCampaigns[chatId];
            if (c && c.status === 'running') { c.status = 'paused'; bot.sendMessage(chatId, '<b>⏸️ Campaign paused!</b>', { parse_mode: 'HTML' }); }
            else bot.sendMessage(chatId, '<b>❌ No active campaign running.</b>', { parse_mode: 'HTML' });
            return;
        }

        // MAIN MENU: Stop
        if (text === '🔴 Stop') {
            const c = activeCampaigns[chatId];
            if (c) { c.status = 'stopped'; bot.sendMessage(chatId, '<b>🔴 Stop command sent...</b>', { parse_mode: 'HTML' }); }
            else bot.sendMessage(chatId, '<b>❌ No campaign found to stop.</b>', { parse_mode: 'HTML' });
            return;
        }

        // MAIN MENU: List Campaign
        if (text === '📋 List Campaign') {
            const c = activeCampaigns[chatId];
            if (c) {
                bot.sendMessage(chatId, getCampaignStatusText(c), { parse_mode: 'HTML' });
            } else bot.sendMessage(chatId, '❌ No campaign currently active.');
            return;
        }

        // MAIN MENU: Set Caller ID
        if (text === '🛠️ Set Caller ID') {
            userState[chatId] = 'WAITING_CALLERID';
            bot.sendMessage(chatId, '<b>🛠 Enter the Caller ID (digits only):</b>', { parse_mode: 'HTML' });
            return;
        }
        if (userState[chatId] === 'WAITING_CALLERID') {
            const cid = text.trim().replace(/\D/g, '');
            if (!cid) { bot.sendMessage(chatId, '❌ Enter a valid numerical Caller ID.'); return; }
            const s = getOrCreateSession(chatId);
            s.callerId = cid;
            saveSessions();
            delete userState[chatId];
            bot.sendMessage(chatId, `<b>✅ Caller ID set to <a href=\"tel:${cid}\"><code>${cid}</code></a>.</b>`, { parse_mode: 'HTML' });
            return;
        }

        // MAIN MENU: Change Audio
        if (text === '🎵 Change Audio') {
            bot.sendMessage(chatId, '🎧 Choose an audio profile:', {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Crypto.com', callback_data: 'audio_crypto' }, { text: 'Google', callback_data: 'audio_google' }],
                        [{ text: 'Coinbase', callback_data: 'audio_coinbase' }, { text: 'Ledger', callback_data: 'audio_ledger' }],
                        [{ text: 'Gemini', callback_data: 'audio_gemini' }]
                    ]
                }
            });
            return;
        }

        // MAIN MENU: Help
        if (text === '❓ Help') {
            let helpText = `❓ *Help & Documentation*\n\n`;
            if (!isChild && isAdmin(msg.from.id)) helpText += ` Admin: Use the Admin Panel to set Global SIP credentials.\n`;
            helpText += ` Drop a *.txt* file with phone numbers to start a campaign.\n Pause, Resume, or Stop anytime from the menu.\n Set a custom Caller ID or change the audio profile.`;
            bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
            return;
        }

        // Set Global SIP Button (Master Only)
        if (text === '🌐 Set Global SIP') {
            if (isChild || !isAdmin(msg.from.id)) {
                bot.sendMessage(chatId, '❌ Only the Admin can configure the global SIP account.');
                return;
            }
            userState[chatId] = 'WAITING_GLOBAL_SIP';
            bot.sendMessage(chatId, '<b>🌐 Enter Global SIP Credentials:</b>\nFormat: <code>username password ip</code>\nExample: <code>test pass123 87.120.165.229</code>', { parse_mode: 'HTML' });
            return;
        }

        // Handling Global SIP input
        if (userState[chatId] === 'WAITING_GLOBAL_SIP') {
            const parts = text.trim().split(/\s+/);
            if (parts.length === 3 && parts[2].includes('.')) {
                const [username, password, ip] = parts;
                bot.sendMessage(chatId, `⧗ Connecting to panel at ${ip} as '${username}'...`);
                try {
                    await verifySipCredentials(username, password, ip);
                    globalSip = { username, password, ip, connectedAt: new Date().toISOString() };
                    saveGlobalSip();
                    
                    // Update admin's own session immediately
                    if (!activeSessions[chatId]) activeSessions[chatId] = {};
                    activeSessions[chatId].username = username;
                    activeSessions[chatId].password = password;
                    activeSessions[chatId].ip = ip;
                    saveSessions();

                    delete userState[chatId];
                    bot.sendMessage(chatId, `<b>✅ Global SIP Authentication Success!</b>\nAll permitted users will now automatically route through <code>${username}</code>.\n\nNow upload a <b>.txt</b> file with numbers.`, { parse_mode: 'HTML' });
                } catch (err) {
                    bot.sendMessage(chatId, `<b>❌ Authentication Failed:</b> <i>${err.message}</i>\nTry again: <code>username password ip</code>`, { parse_mode: 'HTML' });
                }
            } else {
                bot.sendMessage(chatId, '❌ Invalid format. Please enter: <code>username password ip</code>', { parse_mode: 'HTML' });
            }
            return;
        }

        // CPS state
        if (userState[chatId] === 'WAITING_CPS') {
            const cps = parseInt(text.trim());
            if (isNaN(cps) || cps <= 0) { bot.sendMessage(chatId, '❌ Enter a valid CPS number (e.g. 5).'); return; }
            getOrCreateSession(chatId).cps = cps;
            saveSessions();
            userState[chatId] = 'WAITING_CC';
            bot.sendMessage(chatId, '⚙️ <b>Set CC (Concurrent Calls)</b>\n\nEnter the number of simultaneous calls for this campaign.\n<i>Example: 20</i>', { parse_mode: 'HTML' });
            return;
        }

        // CC state ? launch campaign
        if (userState[chatId] === 'WAITING_CC') {
            const cc = parseInt(text.trim());
            if (isNaN(cc) || cc <= 0) { bot.sendMessage(chatId, '❌ Enter a valid CC number (e.g. 10).'); return; }
            const session = getOrCreateSession(chatId);
            session.cc = cc;
            saveSessions();
            delete userState[chatId];
            if (session.pendingFile) {
                startDialingCampaign(session.pendingFile, session, chatId, bot);
            } else {
                bot.sendMessage(chatId, '❌ No pending file. Please re-upload your number list.');
            }
            return;
        }
    }

    // File upload
    if (msg.document) {
        const session = getOrCreateSession(chatId);
        if (!isChild && !session.username) {
            bot.sendMessage(chatId, '❌ No global SIP account configured. Please ask the Admin to set it up.');
            return;
        }
        const fileName = msg.document.file_name;
        if (!fileName.endsWith('.csv') && !fileName.endsWith('.txt')) {
            bot.sendMessage(chatId, '❌ Upload a valid .csv or .txt file.');
            return;
        }
        const fileStream = bot.getFileStream(msg.document.file_id);
        const ext = path.extname(fileName) || '.txt';
        const filePath = path.join(__dirname, `${chatId}_campaign${ext}`);
        const writeStream = fs.createWriteStream(filePath);
        fileStream.pipe(writeStream);
        writeStream.on('finish', async () => {
            session.pendingFile = filePath;
            const count = await parseNumbersFromFile(filePath);
            session.pendingTotal = count;
            saveSessions();
            userState[chatId] = 'WAITING_CPS';
            bot.sendMessage(chatId, '⚡ <b>Set CPS (Calls Per Second)</b>\n\nEnter how many calls should be initiated per second.\n<i>Example: 2</i>', { parse_mode: 'HTML' });
        });
        writeStream.on('error', (err) => {
            bot.sendMessage(chatId, `❌ Failed to download file: ${err.message}`);
        });
    }
});

// Callback query handler
bot.on('callback_query', async (callbackQuery) => {
    const message = callbackQuery.message;
    const chatId = message.chat.id;
    const data = callbackQuery.data;
    if (!(await hasPermissionAsync({ from: callbackQuery.from, chat: message.chat }))) {
        bot.answerCallbackQuery(callbackQuery.id, { text: '❌ No permission.', show_alert: true });
        return;
    }
    const audioMap = {
        audio_crypto: 'Crypto.com',
        audio_google: 'Google',
        audio_coinbase: 'Coinbase',
        audio_ledger: 'Ledger',
        audio_gemini: 'Gemini'
    };
    if (audioMap[data]) {
        const session = getOrCreateSession(chatId);
        session.audioProfile = audioMap[data];
        session.audioMode = 'single';
        saveSessions();
        bot.answerCallbackQuery(callbackQuery.id);
        bot.sendMessage(chatId, `✅ Audio set to *${audioMap[data]}*.`, { parse_mode: 'Markdown' });
    }
});
