const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;

// Telegram credentials Render Environment Variables se aayenge
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID || "-1004479342350";

app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "BATTLE X7 ARENA Telegram Support Backend"
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/send-ticket", async (req, res) => {
  try {
    if (!BOT_TOKEN) {
      return res.status(500).json({
        ok: false,
        error: "BOT_TOKEN is not configured"
      });
    }

    const {
      ticketId,
      category,
      tournamentId,
      problemSummary,
      description,
      uid,
      freeFireName,
      username,
      mobile,
      email
    } = req.body;

    const message = `
🎫 NEW SUPPORT TICKET

━━━━━━━━━━━━━━━━━━
🆔 Ticket ID: ${ticketId || "N/A"}

👤 USER DETAILS
UID: ${uid || "N/A"}
Free Fire Name: ${freeFireName || "N/A"}
Username: ${username || "N/A"}
Mobile: ${mobile || "N/A"}
Email: ${email || "N/A"}

━━━━━━━━━━━━━━━━━━
📋 TICKET DETAILS
Category: ${category || "N/A"}
Tournament ID: ${tournamentId || "N/A"}

Problem:
${problemSummary || "N/A"}

Description:
${description || "N/A"}

━━━━━━━━━━━━━━━━━━
⚡ BATTLE X7 ARENA SUPPORT
`;

    const telegramUrl =
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

    const response = await fetch(telegramUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: message
      })
    });

    const data = await response.json();

    if (!data.ok) {
      return res.status(500).json({
        ok: false,
        telegram: data
      });
    }

    res.json({
      ok: true,
      ticketId: ticketId || null,
      telegramMessageId: data.result?.message_id || null
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      error: "Failed to send ticket to Telegram"
    });
  }
});

app.listen(PORT, () => {
  console.log(`BATTLE X7 ARENA backend running on port ${PORT}`);
});
