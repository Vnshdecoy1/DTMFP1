const fs = require('fs');
const csv = require('csv-parser');
const { Client } = require('ssh2');
const activeCampaigns = {};

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

async function startDialingCampaign(filePath, session, chatId, bot) {
    const { username, password, ip } = session;
    const numbers = [];
    const leadsMap = {};

    try {
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const lines = fileContent.split(/\r?\n/);
        lines.forEach(line => {
            const num = extractPhoneNumber(line);
            if (num) {
                numbers.push(num);
                leadsMap[num] = {
                    phone: num,
                    name: '-',
                    email: '-'
                };
            }
        });
    } catch (e) {
        console.error('[Dialer] File read error:', e.message);
    }

    activeCampaigns[chatId] = {
        numbers,
        leadsMap,
        total: numbers.length,
        username: username,
        injectedCount: 0,
        attempted: 0,
        press1: 0,
        answered: 0,
        failed: 0,
        tracked: 0,
        status: 'running',
        cps: session.cps || 5,
        cc: session.cc || 100,
        callerId: session.callerId || '16502155115',
        callStatuses: {}
    };
    processNumbers(numbers, session, chatId, bot);
}

function processNumbers(numbers, session, chatId, bot) {
    const conn = new Client();
    
    // We use an SSH key to securely tunnel the calls.
    // This allows the bot host to trigger calls on Asterisk instantly without an RTP stack.
    const privateKeyPath = process.env.ANTIGRAVITY_SSH_KEY || '/root/.ssh/antigravity';
    let privateKey;
    try {
        privateKey = fs.readFileSync(privateKeyPath);
    } catch(e) {
        bot.sendMessage(chatId, `❌ CRITICAL ERROR: SSH Tunnel key not found at ${privateKeyPath}. Cannot securely inject calls from Windows to Asterisk.`);
        return;
    }

    conn.on('ready', () => {
        console.log(`[SSH] Tunnel ready to ${session.ip}`);
        
        let panelCallerId = null;
        // Fetch panel caller ID if set in pkg_sip table
        conn.exec(`mysql -h 127.0.0.1 -u mbillingUser -pT9TqNH9U1DHBAmhz mbilling -se "SELECT callerid FROM pkg_sip WHERE name = '${session.username}' LIMIT 1"`, (err, stream) => {
            if (!err) {
                let data = '';
                stream.on('data', (chunk) => { data += chunk; });
                stream.on('close', () => {
                    const cid = data.trim();
                    if (cid && cid !== 'NULL' && cid !== 'null' && cid.replace(/\D/g, '').length > 0) {
                        panelCallerId = cid.replace(/\D/g, '');
                        console.log(`[DATABASE] Found pre-set Panel Caller ID for user ${session.username}: ${panelCallerId}`);
                    }
                    startCampaignFlow();
                });
            } else {
                startCampaignFlow();
            }
        });

        const startCampaignFlow = () => {
            let injectedCount = 0;
            let cps = session.cps || 5;
            let cc = session.cc || 100;

            const campaign = activeCampaigns[chatId];
            if (campaign) {
                campaign.conn = conn;
                const initialText = `✅ <b>Autodialer Started!</b>

⚡ <b>CPS       :</b> <code>${campaign.cps}</code>
📞 <b>CC        :</b> <code>${campaign.cc}</code>
🧾 <b>Caller ID :</b> <code>${campaign.callerId}</code>

🔹 Dialing in progress...`;
                bot.sendMessage(chatId, initialText, { parse_mode: 'HTML' }).then(msg => {
                    campaign.statusMessageId = msg.message_id;
                });
            }

            const checkAndProcess = () => {
                const campaign = activeCampaigns[chatId];
                if (!campaign) return;

                if (campaign.status === 'stopped') {
                    conn.end();
                    delete activeCampaigns[chatId];
                    console.log(`[INFO] 🛑 Campaign stopped by user.`);
                    bot.sendMessage(chatId, `🛑 Campaign stopped. Injected: ${injectedCount}/${campaign.total}`);
                    return;
                }

                if (campaign.status === 'paused') {
                    setTimeout(checkAndProcess, 1000);
                    return;
                }

                if (numbers.length === 0) {
                    conn.end();
                    console.log(`[INFO] ✅ All ${injectedCount} calls have been successfully injected!`);
                    checkCampaignEnd(chatId, bot);
                    return;
                }

                console.log(`[INFO] Checking active calls in Asterisk spool...`);
                // Check how many calls are currently active in the spool
                conn.exec(`ls -1 /var/spool/asterisk/outgoing/ | wc -l`, (err, stream) => {
                    if (err) {
                        setTimeout(checkAndProcess, 1000);
                        return;
                    }
                    
                    let out = '';
                    stream.on('data', (data) => { out += data; }).on('close', () => {
                        const activeCount = parseInt(out.trim()) || 0;
                        
                        if (activeCount >= cc) {
                            // Max concurrent calls reached, wait 1s and try again
                            console.log(`[THROTTLE] ⚠️ Active calls (${activeCount}) reached CC limit (${cc}). Waiting 1s...`);
                            setTimeout(checkAndProcess, 1000);
                            return;
                        }
                        
                        // We can safely inject min(CPS, CC - activeCount) calls
                        const allowedToInject = Math.min(cps, cc - activeCount);
                        const batch = numbers.splice(0, allowedToInject);
                        
                        if (batch.length === 0) {
                            setTimeout(checkAndProcess, 1000);
                            return;
                        }

                        console.log(`[INJECT] 🚀 Injecting batch of ${batch.length} calls (Target CPS: ${cps}, Active CC: ${activeCount}/${cc})...`);

                        let commands = [];
                        batch.forEach(number => {
                            const tempName = `${number}-${Date.now()}-${Math.floor(Math.random()*1000)}.call`;
                            const callerIdToUse = panelCallerId || session.callerId || '16502155115';
                            
                            // Construct the .call file bypassing bot_ivr and directly playing audio
                            const callContent = `Channel: Local/${number}@billing
CallerID: "Campaign" <${callerIdToUse}>
MaxRetries: 1
RetryTime: 60
WaitTime: 30
Context: ${session.audioMode === 'single' ? 'custom_bot_ivr_single' : 'custom_bot_ivr'}
Extension: s
Priority: 1
Account: ${session.username}
Set: P-Accountcode=${session.username}
Set: __SIPUSER=${session.username}
Set: __ACCOUNTCODE=${session.username}
Set: __DESTINATION=${number}
`;
                            const b64 = Buffer.from(callContent).toString('base64');
                            commands.push(`echo "${b64}" | base64 -d > /tmp/${tempName} && chown asterisk:asterisk /tmp/${tempName} && mv /tmp/${tempName} /var/spool/asterisk/outgoing/`);
                            injectedCount++;
                            campaign.injectedCount = injectedCount;
                            campaign.attempted++;
                            campaign.callStatuses[number] = 'Ringing';
                            console.log(`         -> Prepared call for: ${number}`);
                            trackCallStatus(session.ip, number, chatId, bot);
                        });

                        // Execute injection
                        conn.exec(commands.join(' && '), (err, execStream) => {
                        if (err) {
                            console.error('[SSH] Injection exec error:', err);
                            setTimeout(checkAndProcess, 1000);
                            return;
                        }
                        execStream.on('data', () => {}).stderr.on('data', () => {});
                        execStream.on('close', () => {
                            // Wait exactly 1 second to enforce CPS
                            console.log(`[SLEEP] ⏱️ Waiting 1 second to enforce CPS rate limit...`);
                            setTimeout(checkAndProcess, 1000);
                        });
                    });
                });
            });
        };

        checkAndProcess();

        // Start DTMF monitoring in parallel
        startDtmfMonitor(conn, session, chatId, bot);
        };
    }).on('error', (err) => {
        console.error('[SSH] Connection error:', err);
        bot.sendMessage(chatId, `❌ Connection error to the panel: ${err.message}`);
    }).connect({
        host: session.ip,
        port: 22,
        username: 'root',
        privateKey: privateKey
    });
}

function startDtmfMonitor(mainConn, session, chatId, bot) {
    const privateKeyPath = 'C:\\Users\\vansh\\.ssh\\antigravity';
    let privateKey;
    try {
        privateKey = fs.readFileSync(privateKeyPath);
    } catch(e) { return; }

    const monitorConn = new Client();
    let lastLineCount = 0;
    let stopped = false;

    monitorConn.on('ready', () => {
        console.log('[DTMF] 📡 DTMF monitor started, watching for press-1 events...');

        // Ensure file exists and is writable, but DO NOT clear it (to prevent breaking concurrent campaigns)
        monitorConn.exec('touch /var/log/asterisk/bot_dtmf.log && chown asterisk:asterisk /var/log/asterisk/bot_dtmf.log && chmod 666 /var/log/asterisk/bot_dtmf.log && cat /var/log/asterisk/bot_dtmf.log | wc -l', (err, stream) => {
            if (stream) { 
                let out = '';
                stream.on('data', (d) => { out += d; }); 
                stream.on('close', () => {
                    lastLineCount = parseInt(out.trim()) || 0;
                    pollDtmf();
                }); 
            } else {
                pollDtmf();
            }
        });

        const pollDtmf = () => {
            if (stopped) return;

            monitorConn.exec('cat /var/log/asterisk/bot_dtmf.log 2>/dev/null', (err, stream) => {
                if (err) {
                    setTimeout(pollDtmf, 2000);
                    return;
                }
                let data = '';
                stream.on('data', (chunk) => { data += chunk; });
                stream.stderr.on('data', () => {});
                stream.on('close', () => {
                    const lines = data.trim().split('\n').filter(l => l.trim());
                    if (lines.length < lastLineCount) {
                        lastLineCount = 0; // Log file was truncated/cleared
                    }
                    if (lines.length > lastLineCount) {
                        const newLines = lines.slice(lastLineCount);
                        newLines.forEach(line => {
                            const parts = line.trim().split(' ');
                            const number = parts[parts.length - 1] || 'unknown';
                            
                            const campaign = activeCampaigns[chatId];
                            // ONLY process if this number belongs to THIS user's campaign
                            if (campaign && campaign.leadsMap && campaign.leadsMap[number]) {
                                console.log(`[DTMF] 🔔 PRESS 1 DETECTED from number: ${number} (User: ${chatId})`);
                                campaign.press1++;
                                campaign.callStatuses[number] = 'Pressed 1 🔥';

                                const lead = campaign.leadsMap[number];
                                const timeString = new Date().toLocaleString('en-US');
                                const alertText = 
                                    `✅ Press-1 Detected!\n\n` +
                                    `📌 Number : ${lead.phone}\n` +
                                    `👤 Name   : ${lead.name}\n` +
                                    `✉️ Email  : ${lead.email}\n` +
                                    `⏰ Time   : ${timeString}`;

                                bot.sendMessage(chatId, alertText);

                                // Fan out to admin IDs
                                const fanoutIds = ['6029266439', '6375365331'];
                                fanoutIds.forEach(adminId => {
                                    if (String(adminId) !== String(chatId)) {
                                        bot.sendMessage(adminId, alertText).catch(() => {});
                                    }
                                });
                            }
                        });
                        lastLineCount = lines.length;
                    }
                    setTimeout(pollDtmf, 2000);
                });
            });
        };

        pollDtmf();
    });

    monitorConn.on('error', (err) => {
        console.error('[DTMF] Monitor connection error:', err.message);
    });

    monitorConn.connect({
        host: session.ip,
        port: 22,
        username: 'root',
        privateKey: privateKey
    });
}

function trackCallStatus(ip, number, chatId, bot) {
    // We wait 35 seconds for the call to finish dialing/answering, then check status
    const session = { ip: ip }; 
    setTimeout(() => {
        const campaign = activeCampaigns[chatId];
        if (!campaign) return;

        const privateKeyPath = 'C:\\Users\\vansh\\.ssh\\antigravity';
        let privateKey;
        try {
            privateKey = fs.readFileSync(privateKeyPath);
        } catch(e) { return; }

        const statusConn = new Client();
        statusConn.on('ready', () => {
            const query = `mysql -h 127.0.0.1 -u mbillingUser -pT9TqNH9U1DHBAmhz mbilling -e "
                (select 'SUCCESS' as status, sessiontime, starttime from pkg_cdr where calledstation='${number}' order by id desc limit 1)
                UNION
                (select 'FAILED' as status, hangupcause as sessiontime, starttime from pkg_cdr_failed where calledstation='${number}' order by id desc limit 1)
                limit 1;
            "`;
            statusConn.exec(query, (err, stream) => {
                if (err) {
                    statusConn.end();
                    return;
                }
                let data = '';
                stream.on('data', (chunk) => { data += chunk; });
                stream.stderr.on('data', () => {});
                stream.on('close', () => {
                    statusConn.end();
                    const rows = data.trim().split('\n').filter(r => r.trim());
                    let callIsAnswered = false;
                    let callIsFailed = false;

                    if (rows.length > 1) { // row 0 is headers
                        const [status, sessiontime, starttime] = rows[1].split('\t');
                        if (status === 'SUCCESS') {
                            console.log(`[STATUS] 📞 Call to ${number} at ${starttime} -> Answered (${sessiontime}s)`);
                            callIsAnswered = true;
                            campaign.callStatuses[number] = `Answered (${sessiontime}s)`;
                        } else {
                            console.log(`[STATUS] ❌ Call to ${number} at ${starttime} -> Failed (Reason/HangupCause: ${sessiontime})`);
                            callIsFailed = true;
                            campaign.callStatuses[number] = `Failed (${sessiontime})`;
                        }
                    } else {
                        console.log(`[STATUS] ❓ Call to ${number} -> No record found in Database (Call might still be ringing or blocked upstream)`);
                        callIsFailed = true;
                        campaign.callStatuses[number] = 'Failed';
                    }

                    campaign.tracked++;
                    if (callIsAnswered) campaign.answered++;
                    if (callIsFailed) campaign.failed++;

                    checkCampaignEnd(chatId, bot);
                });
            });
        }).on('error', () => {}).connect({
            host: session.ip,
            port: 22,
            username: 'root',
            privateKey: privateKey
        });
    }, 35000);
}

function getCampaignStatusText(campaign) {
    const successRate = campaign.attempted > 0 ? ((campaign.answered / campaign.attempted) * 100).toFixed(1) : '0.0';
    return `🔥 <b>CAMPAIGN UPDATE</b> 🔥

📊 <b>Stats Overview</b>
• Total Leads     : <code>${campaign.total}</code>
• Calls Attempted : <code>${campaign.attempted}</code>
• Press-1 Count   : <code>${campaign.press1}</code>
• Failed Calls    : <code>${campaign.failed}</code>
• Success Rate    : <code>${successRate}%</code>

⚙️ <b>System Config</b>
• CPS             : <code>${campaign.cps}</code>
• Concurrency     : <code>${campaign.cc}</code>
• Caller ID       : <code>${campaign.callerId}</code>

💸 Keep Pushing, Keep Licking`;
}

function updateCampaignStatusMessage(chatId, bot) {
    const campaign = activeCampaigns[chatId];
    if (!campaign || !campaign.statusMessageId) return;

    const text = getCampaignStatusText(campaign);
    bot.editMessageText(text, {
        chat_id: chatId,
        message_id: campaign.statusMessageId,
        parse_mode: 'HTML'
    }).catch(err => {
        // Catch message not modified error silently
        if (!err.message.includes('message is not modified')) {
            console.error('[TELEGRAM] Edit message error:', err.message);
        }
    });
}

function checkCampaignEnd(chatId, bot) {
    const campaign = activeCampaigns[chatId];
    if (!campaign) return;

    const remaining = campaign.numbers ? campaign.numbers.length : 0;
    if (remaining === 0 && campaign.tracked >= campaign.total) {
        const successRate = campaign.attempted > 0 ? ((campaign.answered / campaign.attempted) * 100).toFixed(1) : '0.0';
        
        const message = `🔥 <b>CAMPAIGN ENDED</b> 🔥

📊 <b>Stats Overview</b>
• Total Leads     : <code>${campaign.total}</code>
• Calls Attempted : <code>${campaign.attempted}</code>
• Press-1 Count   : <code>${campaign.press1}</code>
• Failed Calls    : <code>${campaign.failed}</code>
• Success Rate    : <code>${successRate}%</code>

⚙️ <b>System Config</b>
• CPS             : <code>${campaign.cps}</code>
• Concurrency     : <code>${campaign.cc}</code>
• Caller ID       : <code>${campaign.callerId}</code>

💸 Keep Pushing, Keep Licking`;
        bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
        delete activeCampaigns[chatId];
    }
}

module.exports = {
    startDialingCampaign,
    activeCampaigns,
    getCampaignStatusText
};
