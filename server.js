const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID || "-1004479342350";

const BOT_USERNAME = "BettelX7ArenaSupportBot";


// ============================================================
// BASIC HELPERS
// ============================================================

function telegramApi(method) {
  return `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
}

async function telegram(method, body) {
  const response = await fetch(telegramApi(method), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  return await response.json();
}


// ============================================================
// DECIDE REQUIRED PROOF
// ============================================================

function getProofType(category, problemSummary, description) {

  const text = `
    ${category || ""}
    ${problemSummary || ""}
    ${description || ""}
  `.toLowerCase();


  // Video proof cases
  const videoKeywords = [
    "hack",
    "hacked",
    "cheat",
    "cheating",
    "hacker",
    "account hack",
    "account hacked",
    "fake",
    "fraud",
    "scam",
    "abuse",
    "bug abuse"
  ];

  for (const keyword of videoKeywords) {
    if (text.includes(keyword)) {
      return "video";
    }
  }


  // Screenshot proof cases
  return "screenshot";
}


// ============================================================
// HOME
// ============================================================

app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "BATTLE X7 ARENA Telegram Support Backend"
  });
});


// ============================================================
// HEALTH
// ============================================================

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    telegramConfigured: !!BOT_TOKEN,
    chatConfigured: !!CHAT_ID
  });
});


// ============================================================
// SEND NEW TICKET TO TELEGRAM GROUP
// ============================================================

app.post("/send-ticket", async (req, res) => {

  try {

    if (!BOT_TOKEN) {
      return res.status(500).json({
        ok: false,
        error: "BOT_TOKEN is not configured on Render"
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


    if (!ticketId) {
      return res.status(400).json({
        ok: false,
        error: "ticketId is required"
      });
    }


    // Decide whether screenshot or video is required
    const proofType = getProofType(
      category,
      problemSummary,
      description
    );


    const proofText =
      proofType === "video"
        ? "🎥 Required Proof: VIDEO"
        : "📸 Required Proof: SCREENSHOT";


    const message = `
🎫 NEW SUPPORT TICKET

━━━━━━━━━━━━━━━━━━
🆔 Ticket ID: ${ticketId}

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
${proofText}

The user will be asked for this proof in Telegram.

⚡ BATTLE X7 ARENA SUPPORT
`;


    const telegramResult = await telegram("sendMessage", {
      chat_id: CHAT_ID,
      text: message
    });


    if (!telegramResult.ok) {

      console.error(
        "Telegram sendMessage failed:",
        telegramResult
      );

      return res.status(500).json({
        ok: false,
        error: "Telegram failed to receive ticket",
        telegram: telegramResult
      });
    }


    // ========================================================
    // TELEGRAM DEEP LINK
    // ========================================================
    //
    // p_ = screenshot
    // v_ = video
    //
    // Example:
    // https://t.me/BettelX7ArenaSupportBot?start=p_WCX0LFGW
    //

    const prefix =
      proofType === "video" ? "v_" : "p_";


    const telegramUrl =
      `https://t.me/${BOT_USERNAME}?start=${prefix}${ticketId}`;


    res.json({
      ok: true,

      ticketId: ticketId,

      telegramMessageId:
        telegramResult.result?.message_id || null,

      proofType: proofType,

      telegramUrl: telegramUrl
    });


  } catch (error) {

    console.error(
      "SEND TICKET ERROR:",
      error
    );

    res.status(500).json({
      ok: false,
      error: "Failed to send ticket to Telegram"
    });

  }

});


// ============================================================
// TELEGRAM WEBHOOK
// ============================================================

app.post("/telegram/webhook", async (req, res) => {

  try {

    const update = req.body;

    console.log(
      "TELEGRAM UPDATE:",
      JSON.stringify(update)
    );


    // Always immediately tell Telegram that update was received
    res.sendStatus(200);


    if (!BOT_TOKEN) {
      console.error(
        "BOT_TOKEN is missing"
      );

      return;
    }


    // ========================================================
    // MESSAGE
    // ========================================================

    const message = update.message;

    if (!message) {
      return;
    }


    const chatId = message.chat.id;

    const text =
      message.text || "";


    // ========================================================
    // /START
    // ========================================================

    if (
      text.startsWith("/start")
    ) {

      const parts =
        text.trim().split(/\s+/);

      const payload =
        parts[1] || "";


      // --------------------------------------------
      // No ticket ID
      // --------------------------------------------

      if (!payload) {

        await telegram("sendMessage", {

          chat_id: chatId,

          text:
`👋 Welcome to BATTLE X7 ARENA Support.

Please open your ticket from the app using:

"Open Ticket in Telegram"

This will connect your Telegram chat with your support ticket.`
        });

        return;
      }


      // --------------------------------------------
      // Detect proof type
      // --------------------------------------------

      let proofType = "screenshot";

      let ticketId = payload;


      if (payload.startsWith("v_")) {

        proofType = "video";

        ticketId =
          payload.substring(2);

      }


      if (payload.startsWith("p_")) {

        proofType = "screenshot";

        ticketId =
          payload.substring(2);

      }


      // --------------------------------------------
      // Ask for required proof
      // --------------------------------------------

      if (proofType === "video") {

        await telegram("sendMessage", {

          chat_id: chatId,

          text:
`🎫 Ticket: #${ticketId}

⚠️ Your ticket requires VIDEO proof.

Please send the required video here in this Telegram chat.

🎥 Send the video directly in this chat.

Once received, our support team will review it.`
        });

      } else {

        await telegram("sendMessage", {

          chat_id: chatId,

          text:
`🎫 Ticket: #${ticketId}

📸 Your ticket requires SCREENSHOT proof.

Please send the required screenshot here in this Telegram chat.

🖼️ Send the screenshot directly in this chat.

Once received, our support team will review it.`
        });

      }


      return;
    }


    // ========================================================
    // PHOTO / SCREENSHOT
    // ========================================================

    if (
      message.photo &&
      message.photo.length > 0
    ) {

      const photo =
        message.photo[
          message.photo.length - 1
        ];


      const caption =
        message.caption || "No caption";


      const groupCaption =
`📸 SUPPORT PROOF RECEIVED

👤 Telegram User:
${message.from?.username
  ? "@" + message.from.username
  : "ID: " + message.from?.id}

🆔 Telegram ID:
${message.from?.id || "N/A"}

📋 Caption:
${caption}

━━━━━━━━━━━━━━━━━━
Screenshot received from user.
`;


      // Send photo to support group
      await telegram("sendPhoto", {

        chat_id: CHAT_ID,

        photo: photo.file_id,

        caption: groupCaption
      });


      // Confirm to user
      await telegram("sendMessage", {

        chat_id: chatId,

        text:
`✅ Screenshot received successfully.

Your proof has been sent to the BATTLE X7 ARENA support team.

🎫 Your ticket is now under review.`
      });


      return;
    }


    // ========================================================
    // VIDEO
    // ========================================================

    if (message.video) {

      const video =
        message.video.file_id;


      const caption =
        message.caption || "No caption";


      const groupCaption =
`🎥 SUPPORT VIDEO PROOF RECEIVED

👤 Telegram User:
${message.from?.username
  ? "@" + message.from.username
  : "ID: " + message.from?.id}

🆔 Telegram ID:
${message.from?.id || "N/A"}

📋 Caption:
${caption}

━━━━━━━━━━━━━━━━━━
Video proof received from user.
`;


      // Send video to support group
      await telegram("sendVideo", {

        chat_id: CHAT_ID,

        video: video,

        caption: groupCaption
      });


      // Confirm to user
      await telegram("sendMessage", {

        chat_id: chatId,

        text:
`✅ Video received successfully.

Your proof has been sent to the BATTLE X7 ARENA support team.

🎫 Your ticket is now under review.`
      });


      return;
    }


    // ========================================================
    // OTHER TEXT MESSAGE
    // ========================================================

    if (
      text &&
      !text.startsWith("/start")
    ) {

      await telegram("sendMessage", {

        chat_id: chatId,

        text:
`📩 Message received.

For an existing support ticket, please send the screenshot or video requested by the bot.

If you have not connected your ticket yet, please open "Open Ticket in Telegram" from the BATTLE X7 ARENA app.`
      });

    }

  } catch (error) {

    console.error(
      "WEBHOOK ERROR:",
      error
    );

    // Do not try to send another HTTP response here.
    // Telegram already received 200 above.

  }

});


// ============================================================
// SET WEBHOOK
// ============================================================

app.get("/set-webhook", async (req, res) => {

  try {

    if (!BOT_TOKEN) {

      return res.status(500).json({
        ok: false,
        error: "BOT_TOKEN is not configured"
      });

    }


    const webhookUrl =
      "https://battlex7-telegram-backend-2.onrender.com/telegram/webhook";


    const result =
      await telegram("setWebhook", {
        url: webhookUrl
      });


    res.json({
      ok: result.ok,
      webhookUrl: webhookUrl,
      telegram: result
    });


  } catch (error) {

    console.error(
      "SET WEBHOOK ERROR:",
      error
    );

    res.status(500).json({
      ok: false,
      error: error.message
    });

  }

});


// ============================================================
// WEBHOOK INFO
// ============================================================

app.get("/webhook-info", async (req, res) => {

  try {

    if (!BOT_TOKEN) {

      return res.status(500).json({
        ok: false,
        error: "BOT_TOKEN is not configured"
      });

    }


    const result =
      await telegram("getWebhookInfo", {});


    res.json(result);


  } catch (error) {

    console.error(
      "WEBHOOK INFO ERROR:",
      error
    );

    res.status(500).json({
      ok: false,
      error: error.message
    });

  }

});


// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {

  console.log(
    `BATTLE X7 ARENA backend running on port ${PORT}`
  );

});
