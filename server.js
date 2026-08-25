const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 10000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID || "-1004479342350";
const BOT_USERNAME =
  process.env.BOT_USERNAME || "BettelX7ArenaSupportBot";

function clean(value, fallback = "N/A") {
  if (
    value === undefined ||
    value === null ||
    String(value).trim() === ""
  ) {
    return fallback;
  }

  return String(value).trim();
}

function escapeHtml(value) {
  return clean(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/* ================================
   PROOF TYPE
================================ */

function getProofType(category = "") {
  const c = String(category).toLowerCase();

  // Hack / Cheat / Player report = VIDEO
  if (
    c.includes("hack") ||
    c.includes("cheat") ||
    c.includes("hacking") ||
    c.includes("cheating") ||
    c.includes("player report") ||
    c.includes("report player")
  ) {
    return "video";
  }

  // बाकी सामान्य issues = SCREENSHOT
  return "screenshot";
}

function proofInstruction(type) {
  if (type === "video") {
    return (
      "🎥 Please send a clear VIDEO / screen recording " +
      "showing the issue."
    );
  }

  return (
    "📸 Please send a clear SCREENSHOT showing the issue."
  );
}

/* ================================
   TELEGRAM API
================================ */

async function telegram(method, body) {
  if (!BOT_TOKEN) {
    throw new Error("BOT_TOKEN is not configured");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(
      data.description || "Telegram API error"
    );
  }

  return data;
}

/* ================================
   TELEGRAM DEEP LINK
================================ */

function telegramUrl(ticketId, proofType) {
  const start =
    `ticket_${ticketId}_${proofType}`;

  return (
    `https://t.me/${BOT_USERNAME}` +
    `?start=${encodeURIComponent(start)}`
  );
}

/* ================================
   HOME
================================ */

app.get("/", (_req, res) => {
  res.json({
    status: "online",
    service:
      "BATTLE X7 ARENA Telegram Support Backend"
  });
});

/* ================================
   HEALTH
================================ */

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    telegramConfigured: Boolean(BOT_TOKEN)
  });
});

/* ================================
   SEND NEW TICKET
================================ */

app.post("/send-ticket", async (req, res) => {
  try {
    const ticketId = clean(
      req.body.ticketId,
      ""
    );

    if (!ticketId) {
      return res.status(400).json({
        ok: false,
        error: "ticketId is required"
      });
    }

    const ticket = {
      ticketId,

      category: clean(
        req.body.category
      ),

      tournamentId: clean(
        req.body.tournamentId
      ),

      problemSummary: clean(
        req.body.problemSummary
      ),

      description: clean(
        req.body.description
      ),

      uid: clean(
        req.body.uid
      ),

      freeFireName: clean(
        req.body.freeFireName
      ),

      username: clean(
        req.body.username
      ),

      mobile: clean(
        req.body.mobile
      ),

      email: clean(
        req.body.email
      )
    };

    /* Decide screenshot/video */
    const proofType =
      getProofType(ticket.category);

    /* Telegram group message */

    const message =
      `🎫 <b>NEW SUPPORT TICKET</b>\n\n` +

      `━━━━━━━━━━━━━━━━━━\n` +

      `🆔 <b>Ticket ID:</b> #` +
      `${escapeHtml(ticket.ticketId)}\n\n` +

      `👤 <b>USER DETAILS</b>\n` +

      `<b>UID:</b> ` +
      `${escapeHtml(ticket.uid)}\n` +

      `<b>Free Fire Name:</b> ` +
      `${escapeHtml(ticket.freeFireName)}\n` +

      `<b>Username:</b> ` +
      `${escapeHtml(ticket.username)}\n` +

      `<b>Mobile:</b> ` +
      `${escapeHtml(ticket.mobile)}\n` +

      `<b>Email:</b> ` +
      `${escapeHtml(ticket.email)}\n\n` +

      `━━━━━━━━━━━━━━━━━━\n` +

      `📋 <b>TICKET DETAILS</b>\n` +

      `<b>Category:</b> ` +
      `${escapeHtml(ticket.category)}\n` +

      `<b>Tournament ID:</b> ` +
      `${escapeHtml(ticket.tournamentId)}\n\n` +

      `<b>Problem:</b>\n` +
      `${escapeHtml(ticket.problemSummary)}\n\n` +

      `<b>Description:</b>\n` +
      `${escapeHtml(ticket.description)}\n\n` +

      `━━━━━━━━━━━━━━━━━━\n` +

      `🔴 <b>PROOF REQUIRED:</b> ` +
      `${proofType === "video"
        ? "VIDEO"
        : "SCREENSHOT"}\n\n` +

      `⚡ <b>BATTLE X7 ARENA SUPPORT</b>`;

    /* Send ticket to support group */

    const sent = await telegram(
      "sendMessage",
      {
        chat_id: CHAT_ID,
        text: message,
        parse_mode: "HTML",
        disable_web_page_preview: true
      }
    );

    /*
      IMPORTANT:
      Telegram is NOT opened here.
      Only the ticket is sent automatically.
    */

    res.json({
      ok: true,

      ticketId,

      proofType,

      proofInstruction:
        proofInstruction(proofType),

      telegramMessageId:
        sent.result?.message_id || null,

      telegramUrl:
        telegramUrl(
          ticketId,
          proofType
        )
    });

  } catch (error) {

    console.error(
      "send-ticket error:",
      error
    );

    res.status(500).json({
      ok: false,
      error:
        error.message ||
        "Failed to send ticket to Telegram"
    });
  }
});

/* ================================
   TELEGRAM WEBHOOK
================================ */

const activeTickets = new Map();

app.post(
  "/telegram/webhook",
  async (req, res) => {

    /* Telegram needs quick response */
    res.sendStatus(200);

    try {

      const message =
        req.body?.message;

      if (!message) {
        return;
      }

      const chatId =
        message.chat?.id;

      if (!chatId) {
        return;
      }

      const from =
        message.from || {};

      const name =
        clean(
          from.first_name,
          "User"
        );

      const text =
        clean(
          message.text,
          ""
        );

      /* ============================
         START TICKET
      ============================ */

      if (text.startsWith("/start")) {

        const param =
          text.split(/\s+/)[1] || "";

        if (
          !param.startsWith(
            "ticket_"
          )
        ) {

          await telegram(
            "sendMessage",
            {
              chat_id: chatId,

              text:
                `👋 Hello ` +
                `${escapeHtml(name)}!\n\n` +

                `Please open Telegram ` +
                `from the <b>Chat with Telegram</b> ` +
                `button inside your BATTLE X7 ARENA ticket.`,

              parse_mode: "HTML"
            }
          );

          return;
        }

        const parts =
          param.split("_");

        const ticketId =
          parts[1] || "";

        const proofType =
          parts[2] === "video"
            ? "video"
            : "screenshot";

        if (!ticketId) {
          return;
        }

        /* Connect Telegram user to ticket */

        activeTickets.set(
          String(chatId),
          {
            ticketId,
            proofType
          }
        );

        /* Automatic bot reply */

        await telegram(
          "sendMessage",
          {
            chat_id: chatId,

            text:
              `✅ <b>Ticket connected</b>\n\n` +

              `🎫 Ticket ID: <b>#` +
              `${escapeHtml(ticketId)}</b>\n\n` +

              `${proofInstruction(
                proofType
              )}\n\n` +

              `Send the proof here in this chat.`,

            parse_mode: "HTML"
          }
        );

        return;
      }

      /* ============================
         FIND CONNECTED TICKET
      ============================ */

      const session =
        activeTickets.get(
          String(chatId)
        );

      if (!session) {
        return;
      }

      const userLabel =
        from.username
          ? `@${from.username}`
          : name;

      /* ============================
         SCREENSHOT
      ============================ */

      if (
        message.photo &&
        message.photo.length > 0
      ) {

        const photo =
          message.photo[
            message.photo.length - 1
          ];

        await telegram(
          "sendPhoto",
          {
            chat_id: CHAT_ID,

            photo:
              photo.file_id,

            caption:
              `📸 PROOF FOR TICKET #` +
              `${session.ticketId}\n` +
              `User: ${userLabel}`
          }
        );

        await telegram(
          "sendMessage",
          {
            chat_id: chatId,

            text:
              `✅ Screenshot received for ` +
              `ticket <b>#` +
              `${escapeHtml(
                session.ticketId
              )}</b>.\n\n` +

              `Your proof has been sent ` +
              `to the support team.`,

            parse_mode: "HTML"
          }
        );

        return;
      }

      /* ============================
         VIDEO
      ============================ */

      if (message.video) {

        await telegram(
          "sendVideo",
          {
            chat_id: CHAT_ID,

            video:
              message.video.file_id,

            caption:
              `🎥 VIDEO PROOF FOR TICKET #` +
              `${session.ticketId}\n` +
              `User: ${userLabel}`
          }
        );

        await telegram(
          "sendMessage",
          {
            chat_id: chatId,

            text:
              `✅ Video received for ` +
              `ticket <b>#` +
              `${escapeHtml(
                session.ticketId
              )}</b>.\n\n` +

              `Your proof has been sent ` +
              `to the support team.`,

            parse_mode: "HTML"
          }
        );

        return;
      }

      /* ============================
         NORMAL USER MESSAGE
      ============================ */

      if (
        text &&
        !text.startsWith("/")
      ) {

        await telegram(
          "sendMessage",
          {
            chat_id: CHAT_ID,

            text:
              `💬 <b>MESSAGE FOR TICKET #` +
              `${escapeHtml(
                session.ticketId
              )}</b>\n\n` +

              `<b>User:</b> ` +
              `${escapeHtml(
                userLabel
              )}\n\n` +

              escapeHtml(text),

            parse_mode: "HTML"
          }
        );

        await telegram(
          "sendMessage",
          {
            chat_id: chatId,

            text:
              `✅ Your message has been ` +
              `sent to support for ticket ` +
              `<b>#${escapeHtml(
                session.ticketId
              )}</b>.`,

            parse_mode: "HTML"
          }
        );
      }

    } catch (error) {

      console.error(
        "telegram webhook error:",
        error
      );
    }
  }
);

/* ================================
   START SERVER
================================ */

app.listen(
  PORT,
  () => {
    console.log(
      `BATTLE X7 ARENA Telegram backend ` +
      `running on port ${PORT}`
    );
  }
);
