const dgram = require('dgram');
const crypto = require('crypto');

function md5(str) {
    return crypto.createHash('md5').update(str).digest('hex');
}

function generateCallId() {
    return crypto.randomBytes(16).toString('hex') + '@127.0.0.1';
}

function parseSipResponse(msg) {
    const lines = msg.split('\r\n');
    const statusLine = lines[0];
    const match = statusLine.match(/^SIP\/2\.0\s+(\d+)\s+(.+)$/);
    if (!match) return null;
    
    const statusCode = parseInt(match[1]);
    const headers = {};
    
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line === '') break;
        const colonIndex = line.indexOf(':');
        if (colonIndex > 0) {
            const key = line.substring(0, colonIndex).trim().toLowerCase();
            const value = line.substring(colonIndex + 1).trim();
            headers[key] = value;
        }
    }
    
    return { statusCode, headers };
}

function verifySipCredentials(username, password, ip) {
    return new Promise((resolve, reject) => {
        const client = dgram.createSocket('udp4');
        const sipPort = 5060;
        const localPort = 5060 + Math.floor(Math.random() * 10000);
        
        // Listen to dynamic port
        client.bind(localPort);

        let timeout = setTimeout(() => {
            try { client.close(); } catch(e){}
            reject(new Error('SIP Server Timeout (No response from ' + ip + ')'));
        }, 5000);

        const callId = generateCallId();
        const fromTag = crypto.randomBytes(4).toString('hex');
        let cseq = 1;
        let attempts = 0;

        function sendRegister(authHeader = '') {
            const uri = `sip:${ip}`;
            const packet = [
                `REGISTER ${uri} SIP/2.0`,
                `Via: SIP/2.0/UDP 127.0.0.1:${localPort};branch=z9hG4bK-${crypto.randomBytes(4).toString('hex')}`,
                `Max-Forwards: 70`,
                `From: <sip:${username}@${ip}>;tag=${fromTag}`,
                `To: <sip:${username}@${ip}>`,
                `Call-ID: ${callId}`,
                `CSeq: ${cseq} REGISTER`,
                `Contact: <sip:${username}@127.0.0.1:${localPort}>`,
                `Expires: 3600`,
                `User-Agent: LocalBot SIP Check`,
                authHeader ? authHeader : '',
                `Content-Length: 0`,
                '',
                ''
            ].filter(line => line !== '').join('\r\n');

            client.send(packet, sipPort, ip, (err) => {
                if (err) {
                    try { client.close(); } catch(e){}
                    clearTimeout(timeout);
                    reject(err);
                }
            });
        }

        client.on('message', (msg, rinfo) => {
            const response = parseSipResponse(msg.toString());
            if (!response) return;

            if (response.statusCode === 200) {
                // Success!
                clearTimeout(timeout);
                try { client.close(); } catch(e){}
                resolve(true);
            } else if (response.statusCode === 401 || response.statusCode === 407) {
                if (attempts >= 1) {
                    clearTimeout(timeout);
                    try { client.close(); } catch(e){}
                    reject(new Error('Invalid SIP Credentials (401 Unauthorized twice)'));
                    return;
                }
                attempts++;

                // Handle Digest Auth Challenge
                const wwwAuth = response.headers['www-authenticate'] || response.headers['proxy-authenticate'];
                if (!wwwAuth) {
                    clearTimeout(timeout);
                    try { client.close(); } catch(e){}
                    reject(new Error('401 but no WWW-Authenticate header'));
                    return;
                }

                // Extract realm and nonce
                const realmMatch = wwwAuth.match(/realm="([^"]+)"/i);
                const nonceMatch = wwwAuth.match(/nonce="([^"]+)"/i);
                
                if (!realmMatch || !nonceMatch) {
                    clearTimeout(timeout);
                    try { client.close(); } catch(e){}
                    reject(new Error('Failed to parse WWW-Authenticate challenge'));
                    return;
                }

                const realm = realmMatch[1];
                const nonce = nonceMatch[1];
                const uri = `sip:${ip}`;

                const ha1 = md5(`${username}:${realm}:${password}`);
                const ha2 = md5(`REGISTER:${uri}`);
                const digestResponse = md5(`${ha1}:${nonce}:${ha2}`);

                const authHeader = `Authorization: Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${digestResponse}", algorithm=MD5`;
                
                cseq++;
                sendRegister(authHeader);

            } else if (response.statusCode >= 400) {
                clearTimeout(timeout);
                try { client.close(); } catch(e){}
                reject(new Error(`SIP Error ${response.statusCode}`));
            }
        });

        // Start flow
        sendRegister();
    });
}

module.exports = { verifySipCredentials };
