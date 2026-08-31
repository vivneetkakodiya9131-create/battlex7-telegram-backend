const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const admin = require("firebase-admin");

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID || "-1004479342350";

const BOT_USERNAME = "BettelX7ArenaSupportBot";

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    })
  : null;

let firebaseReady = false;
let firestore = null;

try {
  if (!admin.apps.length) {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      const serviceAccount = JSON.parse(
        process.env.FIREBASE_SERVICE_ACCOUNT_JSON
      );

      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
    } else if (
      process.env.FIREBASE_PROJECT_ID &&
      process.env.FIREBASE_CLIENT_EMAIL &&
      process.env.FIREBASE_PRIVATE_KEY
    ) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
        })
      });
    }
  }

  if (admin.apps.length) {
    firestore = admin.firestore();
    firebaseReady = true;
  }
} catch (e) {
  console.error("FIREBASE ADMIN INIT ERROR:", e.message);
}


// ============================================================
// FIREBASE AUTHENTICATION
// ============================================================

async function requireFirebaseUser(req, res) {

  if (!firebaseReady) {

    res.status(503).json({
      ok: false,
      error: "Firebase server authentication is not configured"
    });

    return null;
  }

  const authHeader =
    String(req.headers.authorization || "");

  if (!authHeader.startsWith("Bearer ")) {

    res.status(401).json({
      ok: false,
      error: "Firebase ID token is required"
    });

    return null;
  }

  try {

    return await admin.auth().verifyIdToken(
      authHeader.slice(7)
    );

  } catch (e) {

    res.status(401).json({
      ok: false,
      error: "Invalid or expired Firebase ID token"
    });

    return null;
  }
}


// ============================================================
// DATABASE INITIALIZATION
// ============================================================

async function initDatabase() {

  if (!pool) return;

  await pool.query(`

    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      referral_code TEXT NOT NULL UNIQUE,
      referred_by TEXT,
      device_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      paid_matches INTEGER NOT NULL DEFAULT 0,
      referral_eligible BOOLEAN NOT NULL DEFAULT FALSE,
      referral_rewarded BOOLEAN NOT NULL DEFAULT FALSE
    );

    CREATE TABLE IF NOT EXISTS device_registry (
      device_id TEXT PRIMARY KEY,
      first_user_id TEXT NOT NULL,
      first_referral_code TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS referrals (
      id SERIAL PRIMARY KEY,
      inviter_user_id TEXT NOT NULL,
      referred_user_id TEXT NOT NULL UNIQUE,
      referral_code TEXT NOT NULL,
      paid_matches INTEGER NOT NULL DEFAULT 0,
      eligible BOOLEAN NOT NULL DEFAULT FALSE,
      rewarded BOOLEAN NOT NULL DEFAULT FALSE,
      referral_history_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      eligible_at TIMESTAMPTZ,
      rewarded_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS referral_match_events (
      id SERIAL PRIMARY KEY,
      referred_user_id TEXT NOT NULL,
      tournament_id TEXT NOT NULL,
      join_request_id TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),

      UNIQUE (referred_user_id, tournament_id),
      UNIQUE (join_request_id)
    );

    CREATE INDEX IF NOT EXISTS
      idx_users_referred_by
      ON users(referred_by);

    CREATE INDEX IF NOT EXISTS
      idx_referral_match_events_user
      ON referral_match_events(referred_user_id);

  `);


  // ==========================================================
  // SAFE MIGRATIONS FOR EXISTING DATABASE
  // ==========================================================

  await pool.query(`

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS referred_by TEXT;

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS device_id TEXT;

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS paid_matches
      INTEGER NOT NULL DEFAULT 0;

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS referral_eligible
      BOOLEAN NOT NULL DEFAULT FALSE;

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS referral_rewarded
      BOOLEAN NOT NULL DEFAULT FALSE;

    ALTER TABLE referrals
      ADD COLUMN IF NOT EXISTS paid_matches
      INTEGER NOT NULL DEFAULT 0;

    ALTER TABLE referrals
      ADD COLUMN IF NOT EXISTS eligible
      BOOLEAN NOT NULL DEFAULT FALSE;

    ALTER TABLE referrals
      ADD COLUMN IF NOT EXISTS rewarded
      BOOLEAN NOT NULL DEFAULT FALSE;

    ALTER TABLE referrals
      ADD COLUMN IF NOT EXISTS referral_history_id TEXT;

    ALTER TABLE referrals
      ADD COLUMN IF NOT EXISTS eligible_at
      TIMESTAMPTZ;

    ALTER TABLE referrals
      ADD COLUMN IF NOT EXISTS rewarded_at
      TIMESTAMPTZ;

  `);
}


// ============================================================
// DATABASE HEALTH
// ============================================================

app.get("/database/health", async (req, res) => {

  if (!pool) {

    return res.status(503).json({
      ok: false,
      databaseConfigured: false
    });
  }

  try {

    await pool.query("SELECT 1");

    res.json({
      ok: true,
      databaseConfigured: true
    });

  } catch (e) {

    res.status(500).json({
      ok: false,
      databaseConfigured: true,
      error: "Database connection failed"
    });
  }
});


// ============================================================
// REFERRAL VALIDATION
// ============================================================

app.get("/referral/validate", async (req, res) => {

  if (!pool) {

    return res.status(503).json({
      ok: false,
      error: "Database not configured"
    });
  }

  const code =
    String(req.query.code || "")
      .trim()
      .toUpperCase();

  if (!code) {

    return res.status(400).json({
      ok: false,
      valid: false,
      error: "Referral code is required"
    });
  }

  try {

    const result = await pool.query(
      `
      SELECT user_id, referral_code
      FROM users
      WHERE referral_code = $1
      LIMIT 1
      `,
      [code]
    );

    if (result.rowCount) {

      return res.json({
        ok: true,
        valid: true,
        inviterUserId:
          result.rows[0].user_id
      });
    }


    if (firebaseReady) {

      const snap =
        await firestore
          .collection("referralCodes")
          .doc(code)
          .get();

      if (
        snap.exists &&
        snap.data()?.active !== false
      ) {

        return res.json({
          ok: true,
          valid: true,
          inviterUserId:
            snap.data()?.userId || null
        });
      }
    }


    res.json({
      ok: true,
      valid: false,
      inviterUserId: null
    });

  } catch (e) {

    console.error(
      "REFERRAL VALIDATE ERROR:",
      e
    );

    res.status(500).json({
      ok: false,
      error: "Failed to validate referral code"
    });
  }
});


// ============================================================
// USER REGISTRATION + DEVICE REFERRAL LOCK
// ============================================================

app.post("/users/register", async (req, res) => {

  if (!pool) {

    return res.status(503).json({
      ok: false,
      error: "Database not configured"
    });
  }

  const decoded =
    await requireFirebaseUser(req, res);

  if (!decoded) return;


  const userId =
    String(req.body.userId || "").trim();

  const referralCode =
    String(req.body.referralCode || "")
      .trim()
      .toUpperCase();

  const deviceId =
    String(req.body.deviceId || "").trim();

  const ownReferralCode =
    String(req.body.ownReferralCode || "")
      .trim()
      .toUpperCase();


  if (decoded.uid !== userId) {

    return res.status(403).json({
      ok: false,
      error: "User identity mismatch"
    });
  }


  if (
    !userId ||
    !deviceId ||
    !ownReferralCode
  ) {

    return res.status(400).json({
      ok: false,
      error:
        "userId, deviceId and ownReferralCode are required"
    });
  }


  if (firebaseReady) {

    const ownCodeSnap =
      await firestore
        .collection("referralCodes")
        .doc(ownReferralCode)
        .get();

    if (
      !ownCodeSnap.exists ||
      ownCodeSnap.data()?.userId !== userId
    ) {

      return res.status(400).json({
        ok: false,
        error: "Invalid own referral code"
      });
    }
  }


  const client =
    await pool.connect();

  try {

    await client.query("BEGIN");


    // ========================================================
    // EXISTING USER
    // ========================================================

    const existingUser =
      await client.query(
        `
        SELECT *
        FROM users
        WHERE user_id = $1
        FOR UPDATE
        `,
        [userId]
      );


    if (existingUser.rowCount) {

      const existing =
        existingUser.rows[0];

      let attached = false;


      if (
        !existing.referred_by &&
        referralCode &&
        referralCode !== ownReferralCode
      ) {

        const device =
          await client.query(
            `
            SELECT first_user_id
            FROM device_registry
            WHERE device_id = $1
            `,
            [deviceId]
          );


        // Only the original user of the device
        // can receive the device's referral.
        if (
          device.rowCount &&
          device.rows[0].first_user_id === userId
        ) {

          let inviterId = null;


          const inviter =
            await client.query(
              `
              SELECT user_id
              FROM users
              WHERE referral_code = $1
              LIMIT 1
              `,
              [referralCode]
            );


          if (inviter.rowCount) {

            inviterId =
              inviter.rows[0].user_id;

          } else if (firebaseReady) {

            const codeSnap =
              await firestore
                .collection("referralCodes")
                .doc(referralCode)
                .get();

            if (
              codeSnap.exists &&
              codeSnap.data()?.active !== false
            ) {

              inviterId =
                String(
                  codeSnap.data()?.userId || ""
                ).trim() || null;
            }
          }


          if (
            inviterId &&
            inviterId !== userId
          ) {

            const existingReferral =
              await client.query(
                `
                SELECT id
                FROM referrals
                WHERE referred_user_id = $1
                `,
                [userId]
              );


            if (!existingReferral.rowCount) {

              let historyId = null;


              if (firebaseReady) {

                const hs =
                  await firestore
                    .collection("referralHistory")
                    .where(
                      "referredUserId",
                      "==",
                      userId
                    )
                    .limit(1)
                    .get();


                if (!hs.empty) {

                  historyId =
                    hs.docs[0].id;

                } else {

                  const refDoc =
                    firestore
                      .collection("referralHistory")
                      .doc();

                  historyId =
                    refDoc.id;


                  await refDoc.set({

                    referrerId:
                      inviterId,

                    referredUserId:
                      userId,

                    referredUsername:
                      String(
                        req.body.username ||
                        "User"
                      )
                        .trim()
                        .slice(0, 100),

                    referredEmail:
                      String(
                        req.body.email || ""
                      )
                        .trim()
                        .slice(0, 200),

                    referredFreeFireUid:
                      String(
                        req.body.freeFireUid || ""
                      )
                        .trim()
                        .slice(0, 30),

                    signupDate:
                      admin.firestore
                        .FieldValue
                        .serverTimestamp(),

                    status:
                      "pending",

                    matchesCompleted:
                      0,

                    requiredMatches:
                      2,

                    rewardAmount:
                      10,

                    bonusEarned:
                      0,

                    rewardCredited:
                      false,

                    source:
                      "server"

                  });
                }
              }


              await client.query(
                `
                UPDATE users
                SET referred_by = $1
                WHERE user_id = $2
                `,
                [inviterId, userId]
              );


              await client.query(
                `
                INSERT INTO referrals
                (
                  inviter_user_id,
                  referred_user_id,
                  referral_code,
                  referral_history_id
                )
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (referred_user_id)
                DO NOTHING
                `,
                [
                  inviterId,
                  userId,
                  referralCode,
                  historyId
                ]
              );


              attached = true;
            }
          }
        }
      }


      await client.query("COMMIT");


      return res.json({
        ok: true,
        alreadyRegistered: true,
        referralAttached: attached
      });
    }


    // ========================================================
    // FIRST REGISTRATION ON DEVICE
    // ========================================================

    const device =
      await client.query(
        `
        SELECT
          first_user_id,
          first_referral_code
        FROM device_registry
        WHERE device_id = $1
        FOR UPDATE
        `,
        [deviceId]
      );


    let referredBy = null;
    let referralAttached = false;
    let historyId = null;


    // Only first registration on this physical/device
    // can receive the referral.
    if (
      device.rowCount === 0 &&
      referralCode &&
      referralCode !== ownReferralCode
    ) {

      let inviterId = null;


      const inviter =
        await client.query(
          `
          SELECT user_id
          FROM users
          WHERE referral_code = $1
          LIMIT 1
          `,
          [referralCode]
        );


      if (inviter.rowCount) {

        inviterId =
          inviter.rows[0].user_id;

      } else if (firebaseReady) {

        const codeSnap =
          await firestore
            .collection("referralCodes")
            .doc(referralCode)
            .get();


        if (
          codeSnap.exists &&
          codeSnap.data()?.active !== false
        ) {

          inviterId =
            String(
              codeSnap.data()?.userId || ""
            ).trim() || null;
        }
      }


      if (
        inviterId &&
        inviterId !== userId
      ) {

        referredBy =
          inviterId;

        referralAttached =
          true;
      }
    }


    // ========================================================
    // CREATE NEON USER
    // ========================================================

    await client.query(
      `
      INSERT INTO users
      (
        user_id,
        referral_code,
        referred_by,
        device_id
      )
      VALUES ($1, $2, $3, $4)
      `,
      [
        userId,
        ownReferralCode,
        referredBy,
        deviceId
      ]
    );


    // ========================================================
    // REGISTER DEVICE FIRST USER
    // ========================================================

    if (device.rowCount === 0) {

      await client.query(
        `
        INSERT INTO device_registry
        (
          device_id,
          first_user_id,
          first_referral_code
        )
        VALUES ($1, $2, $3)
        `,
        [
          deviceId,
          userId,
          referredBy
            ? referralCode
            : null
        ]
      );
    }


    // ========================================================
    // CREATE REFERRAL HISTORY
    // ========================================================

    if (referredBy) {

      if (firebaseReady) {

        const refDoc =
          firestore
            .collection("referralHistory")
            .doc();

        historyId =
          refDoc.id;


        await refDoc.set({

          referrerId:
            referredBy,

          referredUserId:
            userId,

          referredUsername:
            String(
              req.body.username ||
              "User"
            )
              .trim()
              .slice(0, 100),

          referredEmail:
            String(
              req.body.email || ""
            )
              .trim()
              .slice(0, 200),

          referredFreeFireUid:
            String(
              req.body.freeFireUid || ""
            )
              .trim()
              .slice(0, 30),

          signupDate:
            admin.firestore
              .FieldValue
              .serverTimestamp(),

          status:
            "pending",

          matchesCompleted:
            0,

          requiredMatches:
            2,

          rewardAmount:
            10,

          bonusEarned:
            0,

          rewardCredited:
            false,

          source:
            "server"

        });
      }


      await client.query(
        `
        INSERT INTO referrals
        (
          inviter_user_id,
          referred_user_id,
          referral_code,
          referral_history_id
        )
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (referred_user_id)
        DO NOTHING
        `,
        [
          referredBy,
          userId,
          referralCode,
          historyId
        ]
      );
    }


    await client.query("COMMIT");


    return res.json({
      ok: true,
      alreadyRegistered: false,
      referralAttached,
      referredBy
    });


  } catch (e) {

    await client.query("ROLLBACK");

    console.error(
      "USER REGISTER ERROR:",
      e
    );


    if (e.code === "23505") {

      return res.status(409).json({
        ok: false,
        error:
          "User or referral code already exists"
      });
    }


    return res.status(500).json({
      ok: false,
      error: "Registration failed"
    });


  } finally {

    client.release();
  }
});


// ============================================================
// ONE-TIME REFERRAL REWARD
// ============================================================

async function creditReferralReward(referralRow) {

  if (
    !firebaseReady ||
    !referralRow?.referral_history_id
  ) {

    throw new Error(
      "Firebase server reward configuration is missing"
    );
  }


  const referralRef =
    firestore
      .collection("referralHistory")
      .doc(
        referralRow.referral_history_id
      );


  const referrerRef =
    firestore
      .collection("users")
      .doc(
        referralRow.inviter_user_id
      );


  // Deterministic transaction document.
  // This makes the reward idempotent.
  const walletTxRef =
    firestore
      .collection("walletTransactions")
      .doc(
        `referral_${referralRow.referral_history_id}`
      );


  const reward = 10;


  await firestore.runTransaction(
    async (tx) => {

      const referralSnap =
        await tx.get(referralRef);


      if (!referralSnap.exists) {

        throw new Error(
          "Referral history record not found"
        );
      }


      const referral =
        referralSnap.data() || {};


      // Already rewarded = do absolutely nothing.
      if (
        referral.rewardCredited === true ||
        referral.status === "completed"
      ) {

        return;
      }


      const referrerSnap =
        await tx.get(referrerRef);


      if (!referrerSnap.exists) {

        throw new Error(
          "Inviter user not found"
        );
      }


      // ======================================================
      // WALLET CREDIT
      // ======================================================

      tx.set(
        referrerRef,
        {

          walletBalance:
            admin.firestore
              .FieldValue
              .increment(reward),

          referralRewardsEarned:
            admin.firestore
              .FieldValue
              .increment(reward),

          updatedAt:
            admin.firestore
              .FieldValue
              .serverTimestamp()

        },
        {
          merge: true
        }
      );


      // ======================================================
      // WALLET TRANSACTION HISTORY
      // ======================================================

      tx.set(
        walletTxRef,
        {

          userId:
            referralRow.inviter_user_id,

          type:
            "referral",

          kind:
            "bonus",

          amount:
            reward,

          direction:
            "credit",

          status:
            "completed",

          name:
            "Referral Reward",

          detail:
            "Referral reward after 2 paid matches",

          referredUserId:
            referralRow.referred_user_id,

          createdAt:
            admin.firestore
              .FieldValue
              .serverTimestamp()

        },
        {
          merge: false
        }
      );


      // ======================================================
      // MARK REFERRAL COMPLETED
      // ======================================================

      tx.set(
        referralRef,
        {

          status:
            "completed",

          matchesCompleted:
            2,

          requiredMatches:
            2,

          bonusEarned:
            reward,

          rewardCredited:
            true,

          qualifiedAt:
            admin.firestore
              .FieldValue
              .serverTimestamp(),

          updatedAt:
            admin.firestore
              .FieldValue
              .serverTimestamp(),

          source:
            "server"

        },
        {
          merge: true
        }
      );

    }
  );
}


// ============================================================
// REAL PAID MATCH REFERRAL TRACKING
// ============================================================

app.post("/referral/paid-match", async (req, res) => {

  if (!pool) {

    return res.status(503).json({
      ok: false,
      error: "Database not configured"
    });
  }


  const decoded =
    await requireFirebaseUser(req, res);

  if (!decoded) return;


  const referredUserId =
    decoded.uid;


  const joinRequestId =
    String(
      req.body.joinRequestId || ""
    ).trim();


  const tournamentId =
    String(
      req.body.tournamentId || ""
    ).trim();


  if (
    !joinRequestId ||
    !tournamentId
  ) {

    return res.status(400).json({
      ok: false,
      error:
        "joinRequestId and tournamentId are required"
    });
  }


  if (!firebaseReady) {

    return res.status(503).json({
      ok: false,
      error:
        "Firebase server verification is not configured"
    });
  }


  try {

    // ========================================================
    // VERIFY REAL FIRESTORE JOIN REQUEST
    // ========================================================

    const joinSnap =
      await firestore
        .collection("joinRequests")
        .doc(joinRequestId)
        .get();


    if (!joinSnap.exists) {

      return res.status(404).json({
        ok: false,
        error:
          "Join request not found"
      });
    }


    const join =
      joinSnap.data() || {};


    if (
      String(join.userId || "") !==
        referredUserId ||

      String(join.tournamentId || "") !==
        tournamentId
    ) {

      return res.status(403).json({
        ok: false,
        error:
          "Join request does not belong to authenticated user"
      });
    }


    // ========================================================
    // REAL PAID ENTRY VERIFICATION
    // ========================================================

    const entry =
      Number(
        join.entryFee ??
        join.entry ??
        0
      );


    const status =
      String(
        join.status ||
        "pending"
      )
        .trim()
        .toLowerCase();


    if (!(entry > 0)) {

      return res.json({
        ok: true,
        tracked: false,
        reason:
          "free_match"
      });
    }


    if (
      [
        "rejected",
        "cancelled",
        "canceled",
        "refunded"
      ].includes(status)
    ) {

      return res.json({
        ok: true,
        tracked: false,
        reason:
          "invalid_join_status"
      });
    }


    const client =
      await pool.connect();


    try {

      await client.query("BEGIN");


      // ======================================================
      // LOCK REFERRAL ROW
      // ======================================================

      const referral =
        await client.query(
          `
          SELECT *
          FROM referrals
          WHERE referred_user_id = $1
          FOR UPDATE
          `,
          [referredUserId]
        );


      if (!referral.rowCount) {

        await client.query("COMMIT");

        return res.json({
          ok: true,
          tracked: false,
          eligible: false,
          reason:
            "not_referred"
        });
      }


      const row =
        referral.rows[0];


      // Already rewarded.
      if (row.rewarded) {

        await client.query("COMMIT");

        return res.json({

          ok: true,

          tracked:
            false,

          eligible:
            true,

          rewarded:
            true,

          paidMatches:
            Number(
              row.paid_matches || 2
            )

        });
      }


      // ======================================================
      // DUPLICATE MATCH PROTECTION
      // ======================================================

      const event =
        await client.query(
          `
          INSERT INTO referral_match_events
          (
            referred_user_id,
            tournament_id,
            join_request_id
          )
          VALUES ($1, $2, $3)

          ON CONFLICT DO NOTHING

          RETURNING id
          `,
          [
            referredUserId,
            tournamentId,
            joinRequestId
          ]
        );


      if (!event.rowCount) {

        await client.query("COMMIT");

        return res.json({

          ok: true,

          tracked:
            false,

          eligible:
            !!row.eligible,

          paidMatches:
            Number(
              row.paid_matches || 0
            ),

          duplicate:
            true

        });
      }


      // ======================================================
      // MAXIMUM TWO QUALIFYING MATCHES
      // ======================================================

      const nextMatches =
        Math.min(
          2,
          Number(
            row.paid_matches || 0
          ) + 1
        );


      const eligible =
        nextMatches >= 2;


      await client.query(
        `
        UPDATE referrals

        SET
          paid_matches = $1,

          eligible = $2,

          eligible_at =
            CASE
              WHEN $2
              THEN COALESCE(
                eligible_at,
                NOW()
              )
              ELSE eligible_at
            END

        WHERE id = $3
        `,
        [
          nextMatches,
          eligible,
          row.id
        ]
      );


      await client.query(
        `
        UPDATE users

        SET
          paid_matches = $1,
          referral_eligible = $2

        WHERE user_id = $3
        `,
        [
          nextMatches,
          eligible,
          referredUserId
        ]
      );


      let rewarded = false;


      // ======================================================
      // SECOND PAID MATCH → ONE-TIME REWARD
      // ======================================================

      if (
        eligible &&
        !row.rewarded
      ) {

        /*
         * PostgreSQL referral row is still locked here.
         *
         * Firestore reward transaction is idempotent:
         * the same referral_history_id can never receive
         * the wallet reward twice.
         */

        await creditReferralReward({

          ...row,

          paid_matches:
            nextMatches,

          referral_history_id:
            row.referral_history_id

        });


        await client.query(
          `
          UPDATE referrals

          SET
            rewarded = TRUE,
            rewarded_at = NOW()

          WHERE referred_user_id = $1
            AND rewarded = FALSE
          `,
          [referredUserId]
        );


        await client.query(
          `
          UPDATE users

          SET referral_rewarded = TRUE

          WHERE user_id = $1
          `,
          [referredUserId]
        );


        rewarded = true;
      }


      await client.query("COMMIT");


      return res.json({

        ok: true,

        tracked:
          true,

        paidMatches:
          nextMatches,

        eligible:
          eligible,

        rewarded:
          rewarded

      });


    } catch (e) {

      await client.query("ROLLBACK");

      console.error(
        "PAID MATCH ERROR:",
        e
      );


      return res.status(500).json({
        ok: false,
        error:
          "Failed to track paid match"
      });


    } finally {

      client.release();
    }


  } catch (e) {

    console.error(
      "PAID MATCH VERIFY ERROR:",
      e
    );


    return res.status(500).json({
      ok: false,
      error:
        "Failed to verify paid match"
    });
  }
});


// ============================================================
// TELEGRAM BASIC HELPERS
// ============================================================

function telegramApi(method) {

  return `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
}


async function telegram(method, body) {

  const response =
    await fetch(
      telegramApi(method),
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify(body)
      }
    );


  return await response.json();
}


// ============================================================
// DECIDE REQUIRED PROOF
// ============================================================

function getProofType(
  category,
  problemSummary,
  description
) {

  const text = `
    ${category || ""}
    ${problemSummary || ""}
    ${description || ""}
  `.toLowerCase();


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


  for (
    const keyword of videoKeywords
  ) {

    if (
      text.includes(keyword)
    ) {

      return "video";
    }
  }


  return "screenshot";
}


// ============================================================
// HOME
// ============================================================

app.get("/", (req, res) => {

  res.json({

    status:
      "online",

    service:
      "BATTLE X7 ARENA Telegram Support Backend"

  });
});


// ============================================================
// HEALTH
// ============================================================

app.get("/health", (req, res) => {

  res.json({

    ok:
      true,

    telegramConfigured:
      !!BOT_TOKEN,

    chatConfigured:
      !!CHAT_ID

  });
});


// ============================================================
// SEND NEW TICKET TO TELEGRAM GROUP
// ============================================================

app.post("/send-ticket", async (req, res) => {

  try {

    if (!BOT_TOKEN) {

      return res.status(500).json({

        ok:
          false,

        error:
          "BOT_TOKEN is not configured on Render"

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

        ok:
          false,

        error:
          "ticketId is required"

      });
    }


    const proofType =
      getProofType(
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


    const telegramResult =
      await telegram(
        "sendMessage",
        {
          chat_id:
            CHAT_ID,

          text:
            message
        }
      );


    if (!telegramResult.ok) {

      console.error(
        "Telegram sendMessage failed:",
        telegramResult
      );


      return res.status(500).json({

        ok:
          false,

        error:
          "Telegram failed to receive ticket",

        telegram:
          telegramResult

      });
    }


    const prefix =
      proofType === "video"
        ? "v_"
        : "p_";


    const telegramUrl =
      `https://t.me/${BOT_USERNAME}?start=${prefix}${ticketId}`;


    res.json({

      ok:
        true,

      ticketId:
        ticketId,

      telegramMessageId:
        telegramResult.result?.message_id ||
        null,

      proofType:
        proofType,

      telegramUrl:
        telegramUrl

    });


  } catch (error) {

    console.error(
      "SEND TICKET ERROR:",
      error
    );


    res.status(500).json({

      ok:
        false,

      error:
        "Failed to send ticket to Telegram"

    });
  }
});


// ============================================================
// TELEGRAM WEBHOOK
// ============================================================

app.post("/telegram/webhook", async (req, res) => {

  try {

    const update =
      req.body;


    console.log(
      "TELEGRAM UPDATE:",
      JSON.stringify(update)
    );


    // Immediately acknowledge Telegram.
    res.sendStatus(200);


    if (!BOT_TOKEN) {

      console.error(
        "BOT_TOKEN is missing"
      );

      return;
    }


    const message =
      update.message;


    if (!message) {

      return;
    }


    const chatId =
      message.chat.id;


    const text =
      message.text || "";


    // ========================================================
    // /START
    // ========================================================

    if (
      text.startsWith("/start")
    ) {

      const parts =
        text
          .trim()
          .split(/\s+/);


      const payload =
        parts[1] || "";


      if (!payload) {

        await telegram(
          "sendMessage",
          {

            chat_id:
              chatId,

            text:
`👋 Welcome to BATTLE X7 ARENA Support.

Please open your ticket from the app using:

"Open Ticket in Telegram"

This will connect your Telegram chat with your support ticket.`

          }
        );


        return;
      }


      let proofType =
        "screenshot";


      let ticketId =
        payload;


      if (
        payload.startsWith("v_")
      ) {

        proofType =
          "video";

        ticketId =
          payload.substring(2);
      }


      if (
        payload.startsWith("p_")
      ) {

        proofType =
          "screenshot";

        ticketId =
          payload.substring(2);
      }


      if (
        proofType === "video"
      ) {

        await telegram(
          "sendMessage",
          {

            chat_id:
              chatId,

            text:
`🎫 Ticket: #${ticketId}

⚠️ Your ticket requires VIDEO proof.

Please send the required video here in this Telegram chat.

🎥 Send the video directly in this chat.

Once received, our support team will review it.`

          }
        );

      } else {

        await telegram(
          "sendMessage",
          {

            chat_id:
              chatId,

            text:
`🎫 Ticket: #${ticketId}

📸 Your ticket requires SCREENSHOT proof.

Please send the required screenshot here in this Telegram chat.

🖼️ Send the screenshot directly in this chat.

Once received, our support team will review it.`

          }
        );
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
        message.caption ||
        "No caption";


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


      await telegram(
        "sendPhoto",
        {

          chat_id:
            CHAT_ID,

          photo:
            photo.file_id,

          caption:
            groupCaption

        }
      );


      await telegram(
        "sendMessage",
        {

          chat_id:
            chatId,

          text:
`✅ Screenshot received successfully.

Your proof has been sent to the BATTLE X7 ARENA support team.

🎫 Your ticket is now under review.`

        }
      );


      return;
    }


    // ========================================================
    // VIDEO
    // ========================================================

    if (
      message.video
    ) {

      const video =
        message.video.file_id;


      const caption =
        message.caption ||
        "No caption";


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


      await telegram(
        "sendVideo",
        {

          chat_id:
            CHAT_ID,

          video:
            video,

          caption:
            groupCaption

        }
      );


      await telegram(
        "sendMessage",
        {

          chat_id:
            chatId,

          text:
`✅ Video received successfully.

Your proof has been sent to the BATTLE X7 ARENA support team.

🎫 Your ticket is now under review.`

        }
      );


      return;
    }


    // ========================================================
    // OTHER TEXT MESSAGE
    // ========================================================

    if (
      text &&
      !text.startsWith("/start")
    ) {

      await telegram(
        "sendMessage",
        {

          chat_id:
            chatId,

          text:
`📩 Message received.

For an existing support ticket, please send the screenshot or video requested by the bot.

If you have not connected your ticket yet, please open "Open Ticket in Telegram" from the BATTLE X7 ARENA app.`

        }
      );
    }


  } catch (error) {

    console.error(
      "WEBHOOK ERROR:",
      error
    );

    // Telegram has already received HTTP 200.
  }
});


// ============================================================
// SET WEBHOOK
// ============================================================

app.get("/set-webhook", async (req, res) => {

  try {

    if (!BOT_TOKEN) {

      return res.status(500).json({

        ok:
          false,

        error:
          "BOT_TOKEN is not configured"

      });
    }


    const webhookUrl =
      "https://battlex7-telegram-backend-2.onrender.com/telegram/webhook";


    const result =
      await telegram(
        "setWebhook",
        {
          url:
            webhookUrl
        }
      );


    res.json({

      ok:
        result.ok,

      webhookUrl:
        webhookUrl,

      telegram:
        result

    });


  } catch (error) {

    console.error(
      "SET WEBHOOK ERROR:",
      error
    );


    res.status(500).json({

      ok:
        false,

      error:
        error.message

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

        ok:
          false,

        error:
          "BOT_TOKEN is not configured"

      });
    }


    const result =
      await telegram(
        "getWebhookInfo",
        {}
      );


    res.json(result);


  } catch (error) {

    console.error(
      "WEBHOOK INFO ERROR:",
      error
    );


    res.status(500).json({

      ok:
        false,

      error:
        error.message

    });
  }
});


// ============================================================
// START SERVER
// ============================================================

initDatabase()

  .then(() => {

    console.log(
      "Database initialization complete"
    );

  })

  .catch((error) => {

    console.error(
      "Database initialization failed:",
      error
    );

  });


app.listen(
  PORT,
  () => {

    console.log(
      `BATTLE X7 ARENA backend running on port ${PORT}`
    );

  }
);
