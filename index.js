const {
    default: makeWASocket,
    useMultiFileAuthState,
    downloadMediaMessage,
    DisconnectReason
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const {
    GoogleGenerativeAI
} = require('@google/generative-ai');
require('dotenv').config();

// הגדרת Gemini API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
    model: 'gemini-pro'
});
const visionModel = genAI.getGenerativeModel({
    model: 'gemini-pro-vision'
});


// פונקציה להמרת קובץ לבסיס 64
function fileToGenerativePart(path, mimeType) {
    return {
        inlineData: {
            data: Buffer.from(fs.readFileSync(path)).toString("base64"),
            mimeType
        },
    };
}

async function startBot() {
    const {
        state,
        saveCreds
    } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({
            level: 'silent'
        })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const {
            connection,
            lastDisconnect
        } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect);
            if (shouldReconnect) {
                startBot();
            }
        } else if (connection === 'open') {
            console.log('Connection opened!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const jid = msg.key.remoteJid;
        const messageType = Object.keys(msg.message)[0];
        const messageText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

        // בדיקה אם ההודעה היא תגובה להודעה קולית והיא מכילה פקודה
        const isReplyToAudio = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.audioMessage;
        const command = messageText.trim();

        if (isReplyToAudio && (command === '!תמלל' || command === '!סכם')) {
            try {
                // שליחת הודעת "מעבד..."
                await sock.sendMessage(jid, {
                    text: 'מעבד בקשה, אנא המתן...'
                }, {
                    quoted: msg
                });

                // הורדת ההודעה הקולית
                const buffer = await downloadMediaMessage(
                    msg.message.extendedTextMessage.contextInfo.quotedMessage,
                    'buffer', {}, {
                        logger: pino({
                            level: 'silent'
                        })
                    }
                );

                // שמירת הקובץ הזמני
                const tempFilePath = 'temp_audio.ogg';
                fs.writeFileSync(tempFilePath, buffer);

                // הכנת הקובץ לשליחה ל-Gemini
                const audioPart = fileToGenerativePart(tempFilePath, 'audio/ogg');

                // תמלול ההודעה הקולית
                const prompt = "תמלל בבקשה את התוכן של קובץ השמע הזה לשפה העברית.";
                const result = await visionModel.generateContent([prompt, audioPart]);
                const response = await result.response;
                const transcription = response.text();

                // מחיקת הקובץ הזמני
                fs.unlinkSync(tempFilePath);

                if (!transcription) {
                    await sock.sendMessage(jid, {
                        text: 'לא הצלחתי לתמלל את ההודעה הקולית.'
                    }, {
                        quoted: msg
                    });
                    return;
                }

                if (command === '!תמלל') {
                    const replyText = `📝 *תמלול:*\n\n${transcription}`;
                    await sock.sendMessage(jid, {
                        text: replyText
                    }, {
                        quoted: msg
                    });
                } else if (command === '!סכם') {
                    // יצירת בקשה לסיכום התמלול
                    const summarizationPrompt = `סכם את הטקסט הבא בעברית בצורה ברורה ותמציתית:\n\n"${transcription}"`;
                    const summarizationResult = await model.generateContent(summarizationPrompt);
                    const summarizationResponse = await summarizationResult.response;
                    const summary = summarizationResponse.text();

                    const replyText = `📄 *סיכום:*\n\n${summary}`;
                    await sock.sendMessage(jid, {
                        text: replyText
                    }, {
                        quoted: msg
                    });
                }
            } catch (error) {
                console.error("Error processing request:", error);
                await sock.sendMessage(jid, {
                    text: 'אופס, משהו השתבש בעיבוד הבקשה. נסה שוב מאוחר יותר.'
                }, {
                    quoted: msg
                });
            }
        }
    });
}

startBot();
