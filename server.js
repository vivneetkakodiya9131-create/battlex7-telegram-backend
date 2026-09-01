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


// ============================================================
// NEON POSTGRESQL
// ============================================================

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    })
  : null;


// ============================================================
// FIREBASE ADMIN
// ============================================================

let firebaseReady = false;
let firestore = null;

try {
  if (!admin.apps.length) {

    // --------------------------------------------------------
    // FIREBASE SERVICE ACCOUNT JSON
    // --------------------------------------------------------

    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {

      const rawJson =
        String(
          process.env.FIREBASE_SERVICE_ACCOUNT_JSON
        ).trim();

      const serviceAccount =
        JSON.parse(rawJson);

      admin.initializeApp({
        credential:
          admin.credential.cert(
            serviceAccount
          )
      });

    }

    // --------------------------------------------------------
    // FIREBASE SEPARATE ENVIRONMENT VARIABLES
    // --------------------------------------------------------

    else if (
      process.env.FIREBASE_PROJECT_ID &&
      process.env.FIREBASE_CLIENT_EMAIL &&
      process.env.FIREBASE_PRIVATE_KEY
    ) {

      let privateKey =
        String(
          process.env.FIREBASE_PRIVATE_KEY
        ).trim();

      // Remove accidental surrounding quotes.
      if (
        privateKey.startsWith('"') &&
        privateKey.endsWith('"')
      ) {
        privateKey =
          privateKey.slice(
            1,
            -1
          );
      }

      // Convert literal \n characters into real
      // new-line characters.
      privateKey =
        privateKey.replace(
          /\\n/g,
          "\n"
        );

      // Normalize Windows line endings.
      privateKey =
        privateKey.replace(
          /\r\n/g,
          "\n"
        );

      // Remove accidental spaces/newlines
      // around the complete PEM value.
      privateKey =
        privateKey.trim();

      // Validate PEM structure before initializing.
      if (
        !privateKey.includes(
          "-----BEGIN PRIVATE KEY-----"
        ) ||
        !privateKey.includes(
          "-----END PRIVATE KEY-----"
        )
      ) {

        throw new Error(
          "FIREBASE_PRIVATE_KEY does not contain a valid PEM private key"
        );
      }

      admin.initializeApp({
        credential:
          admin.credential.cert({
            projectId:
              String(
                process.env.FIREBASE_PROJECT_ID
              ).trim(),

            clientEmail:
              String(
                process.env.FIREBASE_CLIENT_EMAIL
              ).trim(),

            privateKey
          })
      });

    }

    // --------------------------------------------------------
    // MISSING FIREBASE CREDENTIALS
    // --------------------------------------------------------

    else {

      console.error(
        "FIREBASE ADMIN INIT ERROR: Firebase credentials missing"
      );
    }
  }

  // ----------------------------------------------------------
  // FIREBASE READY
  // ----------------------------------------------------------

  if (admin.apps.length) {

    firestore =
      admin.firestore();

    firebaseReady = true;

    console.log(
      "Firebase Admin initialized successfully."
    );
  }

} catch (error) {

  firebaseReady = false;
  firestore = null;

  console.error(
    "FIREBASE ADMIN INIT ERROR:",
    error.message
  );
}


// ============================================================
// FIREBASE AUTH
// ============================================================

async function requireFirebaseUser(req, res) {

  if (!firebaseReady) {

    res.status(503).json({
      ok: false,
      error:
        "Firebase server authentication is not configured"
    });

    return null;
  }

  const authHeader =
    String(
      req.headers.authorization || ""
    );

  if (
    !authHeader.startsWith(
      "Bearer "
    )
  ) {

    res.status(401).json({
      ok: false,
      error:
        "Firebase ID token is required"
    });

    return null;
  }

  const token =
    authHeader
      .substring(7)
      .trim();

  if (!token) {

    res.status(401).json({
      ok: false,
      error:
        "Firebase ID token is required"
    });

    return null;
  }

  try {

    return await admin
      .auth()
      .verifyIdToken(token);

  } catch (error) {

    res.status(401).json({
      ok: false,
      error:
        "Invalid or expired Firebase ID token"
    });

    return null;
  }
}


// ============================================================
// DATABASE INITIALIZATION
// ============================================================

async function initDatabase() {

  if (!pool) {

    console.log(
      "DATABASE: DATABASE_URL is not configured"
    );

    return;
  }

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

  await pool.query(`
    ALTER TABLE referrals
    ADD COLUMN IF NOT EXISTS referral_history_id TEXT
  `);

  console.log(
    "Database initialization complete"
  );
}


// ============================================================
// DATABASE HEALTH
// ============================================================

app.get(
  "/database/health",
  async (req, res) => {

    if (!pool) {

      return res.status(503).json({
        ok: false,
        databaseConfigured: false
      });
    }

    try {

      await pool.query(
        "SELECT 1"
      );

      res.json({
        ok: true,
        databaseConfigured: true
      });

    } catch (error) {

      res.status(500).json({
        ok: false,
        databaseConfigured: true,
        error:
          "Database connection failed"
      });
    }
  }
);


// ============================================================
// REFERRAL VALIDATE
// ============================================================

app.get(
  "/referral/validate",
  async (req, res) => {

    if (!pool) {

      return res.status(503).json({
        ok: false,
        error:
          "Database not configured"
      });
    }

    const code =
      String(
        req.query.code || ""
      )
        .trim()
        .toUpperCase();

    if (!code) {

      return res.status(400).json({
        ok: false,
        valid: false,
        error:
          "Referral code is required"
      });
    }

    try {

      const result =
        await pool.query(
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
            .collection(
              "referralCodes"
            )
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
              snap.data()?.userId ||
              null
          });
        }
      }

      res.json({
        ok: true,
        valid: false,
        inviterUserId: null
      });

    } catch (error) {

      console.error(
        "REFERRAL VALIDATE ERROR:",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          "Failed to validate referral code"
      });
    }
  }
);


// ============================================================
// USER REGISTRATION + REFERRAL + DEVICE LOCK
// ============================================================

app.post(
  "/users/register",
  async (req, res) => {

    if (!pool) {

      return res.status(503).json({
        ok: false,
        error:
          "Database not configured"
      });
    }

    const decoded =
      await requireFirebaseUser(
        req,
        res
      );

    if (!decoded) return;

    const userId =
      String(
        req.body.userId || ""
      ).trim();

    const referralCode =
      String(
        req.body.referralCode || ""
      )
        .trim()
        .toUpperCase();

    const deviceId =
      String(
        req.body.deviceId || ""
      ).trim();

    const ownReferralCode =
      String(
        req.body.ownReferralCode || ""
      )
        .trim()
        .toUpperCase();

    if (
      decoded.uid !== userId
    ) {

      return res.status(403).json({
        ok: false,
        error:
          "User identity mismatch"
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

    // --------------------------------------------------------
    // VERIFY USER'S OWN REFERRAL CODE
    // --------------------------------------------------------

    if (firebaseReady) {

      const ownCodeSnap =
        await firestore
          .collection(
            "referralCodes"
          )
          .doc(
            ownReferralCode
          )
          .get();

      if (
        !ownCodeSnap.exists ||
        ownCodeSnap.data()?.userId !==
          userId
      ) {

        return res.status(400).json({
          ok: false,
          error:
            "Invalid own referral code"
        });
      }
    }

    const client =
      await pool.connect();

    try {

      await client.query(
        "BEGIN"
      );

      // ------------------------------------------------------
      // EXISTING USER
      // ------------------------------------------------------

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

      if (
        existingUser.rowCount
      ) {

        const existing =
          existingUser.rows[0];

        if (
          !existing.device_id
        ) {

          await client.query(
            `
            UPDATE users
            SET device_id = $1
            WHERE user_id = $2
            `,
            [
              deviceId,
              userId
            ]
          );
        }

        await client.query(
          "COMMIT"
        );

        return res.json({
          ok: true,
          alreadyRegistered: true,
          referralAttached:
            !!existing.referred_by,
          referredBy:
            existing.referred_by ||
            null
        });
      }

      // ------------------------------------------------------
      // DEVICE FIRST REGISTRATION LOCK
      // ------------------------------------------------------

      const deviceResult =
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

      if (
        deviceResult.rowCount === 0 &&
        referralCode &&
        referralCode !==
          ownReferralCode
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
              .collection(
                "referralCodes"
              )
              .doc(
                referralCode
              )
              .get();

          if (
            codeSnap.exists &&
            codeSnap.data()?.active !==
              false
          ) {

            inviterId =
              String(
                codeSnap.data()?.userId ||
                  ""
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

      // ------------------------------------------------------
      // CREATE USER
      // ------------------------------------------------------

      await client.query(
        `
        INSERT INTO users
        (
          user_id,
          referral_code,
          referred_by,
          device_id,
          created_at,
          paid_matches,
          referral_eligible,
          referral_rewarded
        )
        VALUES
        (
          $1,
          $2,
          $3,
          $4,
          NOW(),
          0,
          FALSE,
          FALSE
        )
        `,
        [
          userId,
          ownReferralCode,
          referredBy,
          deviceId
        ]
      );

      // ------------------------------------------------------
      // REGISTER DEVICE
      // ------------------------------------------------------

      if (
        deviceResult.rowCount === 0
      ) {

        await client.query(
          `
          INSERT INTO device_registry
          (
            device_id,
            first_user_id,
            first_referral_code,
            created_at
          )
          VALUES
          (
            $1,
            $2,
            $3,
            NOW()
          )
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

      // ------------------------------------------------------
      // CREATE REFERRAL RECORD
      // ------------------------------------------------------

      if (referredBy) {

        if (firebaseReady) {

          const refDoc =
            firestore
              .collection(
                "referralHistory"
              )
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
                .slice(
                  0,
                  100
                ),

            referredEmail:
              String(
                req.body.email ||
                  ""
              )
                .trim()
                .slice(
                  0,
                  200
                ),

            referredFreeFireUid:
              String(
                req.body.freeFireUid ||
                  ""
              )
                .trim()
                .slice(
                  0,
                  30
                ),

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
          VALUES
          (
            $1,
            $2,
            $3,
            $4
          )
          ON CONFLICT
          (referred_user_id)
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

      await client.query(
        "COMMIT"
      );

      res.json({
        ok: true,
        alreadyRegistered: false,
        referralAttached,
        referredBy
      });

    } catch (error) {

      try {
        await client.query(
          "ROLLBACK"
        );
      } catch (_) {}

      console.error(
        "USER REGISTER ERROR:",
        error
      );

      if (
        error.code ===
        "23505"
      ) {

        return res.status(409).json({
          ok: false,
          error:
            "User or referral code already exists"
        });
      }

      res.status(500).json({
        ok: false,
        error:
          "Registration failed"
      });

    } finally {

      client.release();
    }
  }
);


// ============================================================
// REFERRAL REWARD
// ============================================================

async function creditReferralReward(
  referralRow
) {

  if (
    !firebaseReady ||
    !referralRow ||
    !referralRow.referral_history_id
  ) {

    throw new Error(
      "Firebase server reward configuration is missing"
    );
  }

  const reward = 10;

  const referralRef =
    firestore
      .collection(
        "referralHistory"
      )
      .doc(
        referralRow.referral_history_id
      );

  const referrerRef =
    firestore
      .collection(
        "users"
      )
      .doc(
        String(
          referralRow.inviter_user_id
        )
      );

  const walletTxRef =
    firestore
      .collection(
        "walletTransactions"
      )
      .doc(
        `referral_${referralRow.referral_history_id}`
      );

  await firestore.runTransaction(
    async (tx) => {

      const referralSnap =
        await tx.get(
          referralRef
        );

      if (!referralSnap.exists) {

        throw new Error(
          "Referral history record not found"
        );
      }

      const referral =
        referralSnap.data() ||
        {};

      if (
        referral.rewardCredited ===
          true ||
        referral.status ===
          "completed"
      ) {
        return;
      }

      const referrerSnap =
        await tx.get(
          referrerRef
        );

      if (!referrerSnap.exists) {

        throw new Error(
          "Inviter user not found"
        );
      }

      tx.set(
        referrerRef,
        {
          walletBalance:
            admin.firestore
              .FieldValue
              .increment(
                reward
              ),

          referralRewardsEarned:
            admin.firestore
              .FieldValue
              .increment(
                reward
              ),

          updatedAt:
            admin.firestore
              .FieldValue
              .serverTimestamp()
        },
        {
          merge: true
        }
      );

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
// DEPOSIT + WITHDRAWAL SYSTEM
// ============================================================

// ------------------------------------------------------------
// DATABASE TABLES
// ------------------------------------------------------------

async function initWalletDatabase() {

  if (!pool) {
    console.log(
      "WALLET DATABASE: DATABASE_URL is not configured"
    );
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS deposit_requests (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      utr TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS withdrawal_requests (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      upi_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS
      idx_deposit_requests_user
      ON deposit_requests(user_id);

    CREATE INDEX IF NOT EXISTS
      idx_deposit_requests_status
      ON deposit_requests(status);

    CREATE INDEX IF NOT EXISTS
      idx_withdrawal_requests_user
      ON withdrawal_requests(user_id);

    CREATE INDEX IF NOT EXISTS
      idx_withdrawal_requests_status
      ON withdrawal_requests(status);
  `);

  console.log(
    "Wallet database initialization complete"
  );
}


// ------------------------------------------------------------
// DEPOSIT REQUEST
// ------------------------------------------------------------

app.post(
  "/wallet/deposit",
  async (req, res) => {

    try {

      if (!pool) {
        return res.status(503).json({
          ok: false,
          error:
            "Database not configured"
        });
      }

      const decoded =
        await requireFirebaseUser(
          req,
          res
        );

      if (!decoded) return;

      const userId =
        decoded.uid;

      const amount =
        Number(
          req.body.amount
        );

      const utr =
        String(
          req.body.utr || ""
        ).trim();

      if (
        !Number.isFinite(amount) ||
        amount <= 0
      ) {

        return res.status(400).json({
          ok: false,
          error:
            "Valid deposit amount is required"
        });
      }

      if (!utr) {

        return res.status(400).json({
          ok: false,
          error:
            "UTR / Transaction ID is required"
        });
      }

      if (amount < 20) {

        return res.status(400).json({
          ok: false,
          error:
            "Minimum deposit amount is ₹20"
        });
      }

      if (amount > 10000) {

        return res.status(400).json({
          ok: false,
          error:
            "Maximum deposit amount is ₹10000"
        });
      }

      // Prevent same UTR from being submitted twice
      const duplicate =
        await pool.query(
          `
          SELECT id
          FROM deposit_requests
          WHERE utr = $1
          LIMIT 1
          `,
          [utr]
        );

      if (duplicate.rowCount) {

        return res.status(409).json({
          ok: false,
          error:
            "This UTR has already been submitted"
        });
      }

      const result =
        await pool.query(
          `
          INSERT INTO deposit_requests
          (
            user_id,
            amount,
            utr,
            status,
            created_at
          )
          VALUES
          (
            $1,
            $2,
            $3,
            'pending',
            NOW()
          )
          RETURNING id
          `,
          [
            userId,
            amount,
            utr
          ]
        );

      return res.json({
        ok: true,
        requestId:
          result.rows[0].id,
        status:
          "pending",
        message:
          "Deposit request submitted successfully"
      });

    } catch (error) {

      console.error(
        "DEPOSIT REQUEST ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "Failed to submit deposit request"
      });
    }
  }
);


// ------------------------------------------------------------
// WITHDRAWAL REQUEST
// ------------------------------------------------------------

app.post(
  "/wallet/withdraw",
  async (req, res) => {

    if (!pool) {

      return res.status(503).json({
        ok: false,
        error:
          "Database not configured"
      });
    }

    const decoded =
      await requireFirebaseUser(
        req,
        res
      );

    if (!decoded) return;

    const userId =
      decoded.uid;

    const amount =
      Number(
        req.body.amount
      );

    const upiId =
      String(
        req.body.upiId || ""
      ).trim();

    if (
      !Number.isFinite(amount) ||
      amount <= 0
    ) {

      return res.status(400).json({
        ok: false,
        error:
          "Valid withdrawal amount is required"
      });
    }

    if (!upiId) {

      return res.status(400).json({
        ok: false,
        error:
          "UPI ID is required"
      });
    }

    if (amount < 50) {

      return res.status(400).json({
        ok: false,
        error:
          "Minimum withdrawal amount is ₹50"
      });
    }

    if (amount > 10000) {

      return res.status(400).json({
        ok: false,
        error:
          "Maximum withdrawal amount is ₹10000"
      });
    }

    if (!firebaseReady) {

      return res.status(503).json({
        ok: false,
        error:
          "Firebase wallet system is not configured"
      });
    }

    try {

      const userRef =
        firestore
          .collection("users")
          .doc(userId);

      const result =
        await firestore.runTransaction(
          async (tx) => {

            const snap =
              await tx.get(
                userRef
              );

            if (!snap.exists) {

              throw new Error(
                "USER_NOT_FOUND"
              );
            }

            const user =
              snap.data() || {};

            const balance =
              Number(
                user.walletBalance || 0
              );

            if (
              balance < amount
            ) {

              throw new Error(
                "INSUFFICIENT_BALANCE"
              );
            }

            const requestRef =
              firestore
                .collection(
                  "withdrawalRequests"
                )
                .doc();

            tx.update(
              userRef,
              {
                walletBalance:
                  balance - amount,

                updatedAt:
                  admin.firestore
                    .FieldValue
                    .serverTimestamp()
              }
            );

            tx.set(
              requestRef,
              {
                userId,

                amount,

                upiId,

                status:
                  "pending",

                createdAt:
                  admin.firestore
                    .FieldValue
                    .serverTimestamp()
              }
            );

            return requestRef.id;
          }
        );

      return res.json({
        ok: true,
        requestId:
          result,
        status:
          "pending",
        message:
          "Withdrawal request submitted successfully"
      });

    } catch (error) {

      if (
        error.message ===
        "USER_NOT_FOUND"
      ) {

        return res.status(404).json({
          ok: false,
          error:
            "User not found"
        });
      }

      if (
        error.message ===
        "INSUFFICIENT_BALANCE"
      ) {

        return res.status(400).json({
          ok: false,
          error:
            "Insufficient wallet balance"
        });
      }

      console.error(
        "WITHDRAWAL ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "Failed to submit withdrawal request"
      });
    }
  }
);


// ------------------------------------------------------------
// USER DEPOSIT HISTORY
// ------------------------------------------------------------

app.get(
  "/wallet/deposits",
  async (req, res) => {

    if (!pool) {

      return res.status(503).json({
        ok: false,
        error:
          "Database not configured"
      });
    }

    const decoded =
      await requireFirebaseUser(
        req,
        res
      );

    if (!decoded) return;

    try {

      const result =
        await pool.query(
          `
          SELECT
            id,
            amount,
            utr,
            status,
            created_at,
            reviewed_at
          FROM deposit_requests
          WHERE user_id = $1
          ORDER BY created_at DESC
          `,
          [decoded.uid]
        );

      return res.json({
        ok: true,
        deposits:
          result.rows
      });

    } catch (error) {

      console.error(
        "DEPOSIT HISTORY ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "Failed to load deposit history"
      });
    }
  }
);


// ------------------------------------------------------------
// USER WITHDRAWAL HISTORY
// ------------------------------------------------------------

app.get(
  "/wallet/withdrawals",
  async (req, res) => {

    const decoded =
      await requireFirebaseUser(
        req,
        res
      );

    if (!decoded) return;

    if (!firebaseReady) {

      return res.status(503).json({
        ok: false,
        error:
          "Firebase is not configured"
      });
    }

    try {

      const snapshot =
        await firestore
          .collection(
            "withdrawalRequests"
          )
          .where(
            "userId",
            "==",
            decoded.uid
          )
          .get();

      const withdrawals =
        snapshot.docs
          .map(
            doc => ({
              id: doc.id,
              ...doc.data()
            })
          );

      withdrawals.sort(
        (a, b) => {

          const aTime =
            a.createdAt?.toMillis
              ? a.createdAt.toMillis()
              : 0;

          const bTime =
            b.createdAt?.toMillis
              ? b.createdAt.toMillis()
              : 0;

          return bTime - aTime;
        }
      );

      return res.json({
        ok: true,
        withdrawals
      });

    } catch (error) {

      console.error(
        "WITHDRAWAL HISTORY ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "Failed to load withdrawal history"
      });
    }
  }
);


// ------------------------------------------------------------
// INITIALIZE WALLET DATABASE
// ------------------------------------------------------------

initWalletDatabase()
  .catch(
    error => {

      console.error(
        "WALLET DATABASE INITIALIZATION ERROR:",
        error
      );

    }
  );


// ============================================================
// REAL PAID MATCH
// ============================================================

app.post(
  "/referral/paid-match",
  async (req, res) => {

    if (!pool) {

      return res.status(503).json({
        ok: false,
        error:
          "Database not configured"
      });
    }

    const decoded =
      await requireFirebaseUser(
        req,
        res
      );

    if (!decoded) return;

    const referredUserId =
      decoded.uid;

    const joinRequestId =
      String(
        req.body.joinRequestId ||
          ""
      ).trim();

    const tournamentId =
      String(
        req.body.tournamentId ||
          ""
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

      const joinSnap =
        await firestore
          .collection(
            "joinRequests"
          )
          .doc(
            joinRequestId
          )
          .get();

      if (!joinSnap.exists) {

        return res.status(404).json({
          ok: false,
          error:
            "Join request not found"
        });
      }

      const join =
        joinSnap.data() ||
        {};

      if (
        String(
          join.userId || ""
        ) !==
        referredUserId
      ) {

        return res.status(403).json({
          ok: false,
          error:
            "Join request does not belong to authenticated user"
        });
      }

      if (
        String(
          join.tournamentId || ""
        ) !==
        tournamentId
      ) {

        return res.status(403).json({
          ok: false,
          error:
            "Tournament mismatch"
        });
      }

      const entry =
        Number(
          join.entryFee ??
          join.entry ??
          0
        );

      if (!(entry > 0)) {

        return res.json({
          ok: true,
          tracked: false,
          reason:
            "free_match"
        });
      }

      const status =
        String(
          join.status ||
            "pending"
        )
          .trim()
          .toLowerCase();

      const successfulPaidStatuses =
        new Set([
          "approved",
          "accepted",
          "success",
          "successful",
          "paid",
          "confirmed",
          "joined",
          "completed"
        ]);

      const paymentConfirmed =
        successfulPaidStatuses.has(
          status
        ) ||

        join.paymentVerified ===
          true ||

        join.paymentConfirmed ===
          true ||

        join.paymentSuccess ===
          true ||

        join.paid === true ||

        String(
          join.paymentStatus ||
            ""
        )
          .trim()
          .toLowerCase() ===
          "paid";

      if (!paymentConfirmed) {

        return res.json({
          ok: true,
          tracked: false,
          reason:
            "paid_match_not_confirmed",
          status
        });
      }

      const client =
        await pool.connect();

      try {

        await client.query(
          "BEGIN"
        );

        const referralResult =
          await client.query(
            `
            SELECT *
            FROM referrals
            WHERE referred_user_id = $1
            FOR UPDATE
            `,
            [referredUserId]
          );

        if (
          !referralResult.rowCount
        ) {

          await client.query(
            "COMMIT"
          );

          return res.json({
            ok: true,
            tracked: false,
            eligible: false,
            reason:
              "not_referred"
          });
        }

        const row =
          referralResult.rows[0];

        if (row.rewarded) {

          await client.query(
            "COMMIT"
          );

          return res.json({
            ok: true,
            tracked: false,
            eligible: true,
            rewarded: true,
            paidMatches:
              row.paid_matches
          });
        }

        // ----------------------------------------------------
        // DUPLICATE EVENT PROTECTION
        // ----------------------------------------------------

        const eventResult =
          await client.query(
            `
            INSERT INTO referral_match_events
            (
              referred_user_id,
              tournament_id,
              join_request_id,
              created_at
            )
            VALUES
            (
              $1,
              $2,
              $3,
              NOW()
            )
            ON CONFLICT DO NOTHING
            RETURNING id
            `,
            [
              referredUserId,
              tournamentId,
              joinRequestId
            ]
          );

        if (
          !eventResult.rowCount
        ) {

          await client.query(
            "COMMIT"
          );

          let rewarded = false;

          if (
            row.eligible &&
            !row.rewarded
          ) {

            try {

              await creditReferralReward(
                row
              );

              const mark =
                await pool.query(
                  `
                  UPDATE referrals
                  SET
                    rewarded = TRUE,
                    rewarded_at = NOW()
                  WHERE
                    referred_user_id = $1
                    AND rewarded = FALSE
                  RETURNING rewarded
                  `,
                  [referredUserId]
                );

              if (
                mark.rowCount > 0
              ) {

                await pool.query(
                  `
                  UPDATE users
                  SET referral_rewarded = TRUE
                  WHERE user_id = $1
                  `,
                  [referredUserId]
                );

                rewarded = true;
              }

            } catch (
              rewardError
            ) {

              console.error(
                "REFERRAL REWARD RETRY ERROR:",
                rewardError
              );
            }
          }

          return res.json({
            ok: true,
            tracked: false,
            eligible:
              row.eligible,
            paidMatches:
              row.paid_matches,
            duplicate: true,
            rewarded
          });
        }

        // ----------------------------------------------------
        // COUNT MATCH
        // ----------------------------------------------------

        const nextMatches =
          Math.min(
            2,
            Number(
              row.paid_matches ||
                0
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
                WHEN $2 = TRUE
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

        // ----------------------------------------------------
        // UPDATE FIREBASE REFERRAL HISTORY
        // ----------------------------------------------------

        if (
          firebaseReady &&
          row.referral_history_id
        ) {

          await firestore
            .collection(
              "referralHistory"
            )
            .doc(
              row.referral_history_id
            )
            .set(
              {
                matchesCompleted:
                  nextMatches,

                requiredMatches:
                  2,

                status:
                  eligible
                    ? "eligible"
                    : "pending",

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

        await client.query(
          "COMMIT"
        );

        // ----------------------------------------------------
        // REWARD AFTER MATCH #2
        // ----------------------------------------------------

        let rewarded = false;

        if (eligible) {

          try {

            await creditReferralReward({
              ...row,
              paid_matches:
                nextMatches
            });

            const mark =
              await pool.query(
                `
                UPDATE referrals
                SET
                  rewarded = TRUE,
                  rewarded_at = NOW()
                WHERE
                  referred_user_id = $1
                  AND rewarded = FALSE
                RETURNING rewarded
                `,
                [referredUserId]
              );

            if (
              mark.rowCount > 0
            ) {

              await pool.query(
                `
                UPDATE users
                SET referral_rewarded = TRUE
                WHERE user_id = $1
                `,
                [referredUserId]
              );

              rewarded = true;
            }

          } catch (
            rewardError
          ) {

            console.error(
              "REFERRAL REWARD ERROR:",
              rewardError
            );
          }
        }

        return res.json({
          ok: true,
          tracked: true,
          paidMatches:
            nextMatches,
          eligible,
          rewarded
        });

      } catch (error) {

        try {
          await client.query(
            "ROLLBACK"
          );
        } catch (_) {}

        console.error(
          "PAID MATCH ERROR:",
          error
        );

        return res.status(500).json({
          ok: false,
          error:
            "Failed to track paid match"
        });

      } finally {

        client.release();
      }

    } catch (error) {

      console.error(
        "PAID MATCH VERIFY ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "Failed to verify paid match"
      });
    }
  }
);


// ============================================================
// 5-MIN ROOM UNLOCK + JOINED-USER-ONLY ROOM
// ============================================================

const ROOM_UNLOCK_MINUTES = 5;

// ------------------------------------------------------------
// ADMIN CHECK
// ------------------------------------------------------------

async function requireAdmin(req, res) {
  const decoded = await requireFirebaseUser(req, res);

  if (!decoded) return null;

  const adminUid = String(
    process.env.ADMIN_UID || ""
  ).trim();

  if (!adminUid) {
    res.status(503).json({
      ok: false,
      error: "ADMIN_UID is not configured"
    });

    return null;
  }

  if (decoded.uid !== adminUid) {
    res.status(403).json({
      ok: false,
      error: "Admin access required"
    });

    return null;
  }

  return decoded;
}


// ============================================================
// CREATE / UPDATE ROOM
// ADMIN ONLY
// ============================================================

app.post("/room/create", async (req, res) => {

  if (!firebaseReady) {
    return res.status(503).json({
      ok: false,
      error: "Firebase is not configured"
    });
  }

  const adminUser = await requireAdmin(req, res);

  if (!adminUser) return;

  const tournamentId = String(
    req.body.tournamentId || ""
  ).trim();

  const roomId = String(
    req.body.roomId || ""
  ).trim();

  const roomPassword = String(
    req.body.roomPassword || ""
  ).trim();

  const unlockMinutes = Number(
    req.body.unlockMinutes ??
    ROOM_UNLOCK_MINUTES
  );

  if (!tournamentId || !roomId || !roomPassword) {
    return res.status(400).json({
      ok: false,
      error:
        "tournamentId, roomId and roomPassword are required"
    });
  }

  if (
    !Number.isFinite(unlockMinutes) ||
    unlockMinutes < 1 ||
    unlockMinutes > 60
  ) {
    return res.status(400).json({
      ok: false,
      error:
        "unlockMinutes must be between 1 and 60"
    });
  }

  try {

    const roomRef = firestore
      .collection("tournamentRooms")
      .doc(tournamentId);

    const unlockAt = new Date(
      Date.now() +
      unlockMinutes * 60 * 1000
    );

    await roomRef.set(
      {
        tournamentId,
        roomId,
        roomPassword,

        unlockAt:
          admin.firestore.Timestamp.fromDate(
            unlockAt
          ),

        unlockMinutes,

        roomUnlocked: false,

        joinedUsersOnly: true,

        createdBy:
          adminUser.uid,

        createdAt:
          admin.firestore.FieldValue.serverTimestamp(),

        updatedAt:
          admin.firestore.FieldValue.serverTimestamp()
      },
      {
        merge: true
      }
    );

    return res.json({
      ok: true,
      tournamentId,
      unlockAt:
        unlockAt.toISOString(),
      unlockMinutes,
      joinedUsersOnly: true
    });

  } catch (error) {

    console.error(
      "ROOM CREATE ERROR:",
      error
    );

    return res.status(500).json({
      ok: false,
      error: "Failed to create room"
    });
  }
});


// ============================================================
// ROOM ACCESS
// ONLY JOINED USERS CAN GET ROOM DETAILS
// ============================================================

app.get(
  "/room/:tournamentId",
  async (req, res) => {

    if (!firebaseReady) {
      return res.status(503).json({
        ok: false,
        error: "Firebase is not configured"
      });
    }

    const decoded =
      await requireFirebaseUser(
        req,
        res
      );

    if (!decoded) return;

    const tournamentId =
      String(
        req.params.tournamentId || ""
      ).trim();

    if (!tournamentId) {
      return res.status(400).json({
        ok: false,
        error:
          "Tournament ID is required"
      });
    }

    try {

      // ------------------------------------------------------
      // FIND ROOM
      // ------------------------------------------------------

      const roomSnap =
        await firestore
          .collection(
            "tournamentRooms"
          )
          .doc(tournamentId)
          .get();

      if (!roomSnap.exists) {
        return res.status(404).json({
          ok: false,
          error:
            "Room not available"
        });
      }

      const room =
        roomSnap.data() || {};

      // ------------------------------------------------------
      // CHECK JOIN REQUEST
      // ------------------------------------------------------

      const joinQuery =
        await firestore
          .collection(
            "joinRequests"
          )
          .where(
            "userId",
            "==",
            decoded.uid
          )
          .where(
            "tournamentId",
            "==",
            tournamentId
          )
          .limit(10)
          .get();

      if (joinQuery.empty) {

        return res.status(403).json({
          ok: false,
          joined: false,
          roomUnlocked: false,
          error:
            "Only joined users can access the room"
        });
      }

      // ------------------------------------------------------
      // VERIFY JOIN STATUS
      // ------------------------------------------------------

      let joined = false;

      joinQuery.forEach((doc) => {

        const join =
          doc.data() || {};

        const status =
          String(
            join.status ||
            ""
          )
            .trim()
            .toLowerCase();

        const validStatuses =
          new Set([
            "approved",
            "accepted",
            "success",
            "successful",
            "paid",
            "confirmed",
            "joined",
            "completed"
          ]);

        if (
          validStatuses.has(status) ||
          join.paymentVerified === true ||
          join.paymentConfirmed === true ||
          join.paymentSuccess === true ||
          join.paid === true
        ) {
          joined = true;
        }
      });

      if (!joined) {

        return res.status(403).json({
          ok: false,
          joined: false,
          roomUnlocked: false,
          error:
            "Valid joined-user record not found"
        });
      }

      // ------------------------------------------------------
      // 5-MINUTE UNLOCK CHECK
      // ------------------------------------------------------

      let unlockAtMs = 0;

      if (room.unlockAt) {

        if (
          typeof room.unlockAt.toMillis ===
          "function"
        ) {
          unlockAtMs =
            room.unlockAt.toMillis();

        } else if (
          room.unlockAt._seconds
        ) {
          unlockAtMs =
            Number(
              room.unlockAt._seconds
            ) * 1000;

        } else {
          unlockAtMs =
            new Date(
              room.unlockAt
            ).getTime();
        }
      }

      const now =
        Date.now();

      const roomUnlocked =
        unlockAtMs > 0 &&
        now >= unlockAtMs;

      // ------------------------------------------------------
      // STILL LOCKED
      // ------------------------------------------------------

      if (!roomUnlocked) {

        const remainingMs =
          Math.max(
            0,
            unlockAtMs - now
          );

        return res.json({
          ok: true,

          joined: true,

          roomUnlocked: false,

          unlockAt:
            unlockAtMs
              ? new Date(
                  unlockAtMs
                ).toISOString()
              : null,

          remainingSeconds:
            Math.ceil(
              remainingMs / 1000
            ),

          remainingMinutes:
            Math.ceil(
              remainingMs / 60000
            ),

          message:
            "Room will unlock 5 minutes before the scheduled time"
        });
      }

      // ------------------------------------------------------
      // ROOM UNLOCKED
      // ------------------------------------------------------

      return res.json({
        ok: true,

        joined: true,

        roomUnlocked: true,

        tournamentId,

        roomId:
          room.roomId || "",

        roomPassword:
          room.roomPassword || "",

        unlockAt:
          new Date(
            unlockAtMs
          ).toISOString()
      });

    } catch (error) {

      console.error(
        "ROOM ACCESS ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "Failed to verify room access"
      });
    }
  }
);


// ============================================================
// MANUAL ROOM UNLOCK
// ADMIN ONLY
// ============================================================

app.post(
  "/room/:tournamentId/unlock",
  async (req, res) => {

    const adminUser =
      await requireAdmin(
        req,
        res
      );

    if (!adminUser) return;

    const tournamentId =
      String(
        req.params.tournamentId || ""
      ).trim();

    if (!tournamentId) {
      return res.status(400).json({
        ok: false,
        error:
          "Tournament ID is required"
      });
    }

    try {

      await firestore
        .collection(
          "tournamentRooms"
        )
        .doc(tournamentId)
        .set(
          {
            roomUnlocked: true,

            manuallyUnlocked: true,

            unlockedBy:
              adminUser.uid,

            unlockedAt:
              admin.firestore.FieldValue.serverTimestamp(),

            updatedAt:
              admin.firestore.FieldValue.serverTimestamp()
          },
          {
            merge: true
          }
        );

      return res.json({
        ok: true,
        tournamentId,
        roomUnlocked: true
      });

    } catch (error) {

      console.error(
        "ROOM MANUAL UNLOCK ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "Failed to unlock room"
      });
    }
  }
);


// ============================================================
// TELEGRAM HELPERS
// ============================================================

function telegramApi(method) {

  return `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
}

async function telegram(
  method,
  body
) {

  const response =
    await fetch(
      telegramApi(method),
      {
        method: "POST",
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
// PROOF TYPE
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

app.get(
  "/",
  (req, res) => {

    res.json({
      status: "online",
      service:
        "BATTLE X7 ARENA Telegram Support Backend"
    });
  }
);


// ============================================================
// HEALTH
// ============================================================

app.get(
  "/health",
  async (req, res) => {

    let database = false;

    if (pool) {

      try {

        await pool.query(
          "SELECT 1"
        );

        database = true;

      } catch (_) {

        database = false;
      }
    }

    res.json({
      ok: true,
      telegramConfigured:
        !!BOT_TOKEN,
      chatConfigured:
        !!CHAT_ID,
      database,
      firebaseConfigured:
        firebaseReady
    });
  }
);


// ============================================================
// SEND SUPPORT TICKET
// ============================================================

app.post(
  "/send-ticket",
  async (req, res) => {

    try {

      if (!BOT_TOKEN) {

        return res.status(500).json({
          ok: false,
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
      } = req.body || {};

      if (!ticketId) {

        return res.status(400).json({
          ok: false,
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

      if (
        !telegramResult.ok
      ) {

        console.error(
          "Telegram sendMessage failed:",
          telegramResult
        );

        return res.status(500).json({
          ok: false,
          error:
            "Telegram failed to receive ticket"
        });
      }

      const prefix =
        proofType === "video"
          ? "v_"
          : "p_";

      const telegramUrl =
        `https://t.me/${BOT_USERNAME}?start=${prefix}${ticketId}`;

      res.json({
        ok: true,
        ticketId,
        telegramMessageId:
          telegramResult.result
            ?.message_id ||
          null,
        proofType,
        telegramUrl
      });

    } catch (error) {

      console.error(
        "SEND TICKET ERROR:",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          "Failed to send ticket to Telegram"
      });
    }
  }
);


// ============================================================
// TELEGRAM WEBHOOK
// ============================================================

app.post(
  "/telegram/webhook",
  async (req, res) => {

    try {

      const update =
        req.body;

      console.log(
        "TELEGRAM UPDATE:",
        JSON.stringify(update)
      );

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

      // --------------------------------------------------------
      // /START
      // --------------------------------------------------------

      if (
        text.startsWith(
          "/start"
        )
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
          payload.startsWith(
            "v_"
          )
        ) {

          proofType =
            "video";

          ticketId =
            payload.substring(
              2
            );
        }

        if (
          payload.startsWith(
            "p_"
          )
        ) {

          proofType =
            "screenshot";

          ticketId =
            payload.substring(
              2
            );
        }

        if (
          proofType ===
          "video"
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

      // --------------------------------------------------------
      // PHOTO
      // --------------------------------------------------------

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
${
  message.from?.username
    ? "@" +
      message.from.username
    : "ID: " +
      message.from?.id
}

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

      // --------------------------------------------------------
      // VIDEO
      // --------------------------------------------------------

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
${
  message.from?.username
    ? "@" +
      message.from.username
    : "ID: " +
      message.from?.id
}

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

      // --------------------------------------------------------
      // OTHER TEXT
      // --------------------------------------------------------

      if (
        text &&
        !text.startsWith(
          "/start"
        )
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
    }
  }
);


// ============================================================
// SET WEBHOOK
// ============================================================

app.get(
  "/set-webhook",
  async (req, res) => {

    try {

      if (!BOT_TOKEN) {

        return res.status(500).json({
          ok: false,
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
        ok: false,
        error:
          error.message
      });
    }
  }
);


// ============================================================
// WEBHOOK INFO
// ============================================================

app.get(
  "/webhook-info",
  async (req, res) => {

    try {

      if (!BOT_TOKEN) {

        return res.status(500).json({
          ok: false,
          error:
            "BOT_TOKEN is not configured"
        });
      }

      const result =
        await telegram(
          "getWebhookInfo",
          {}
        );

      res.json(
        result
      );

    } catch (error) {

      console.error(
        "WEBHOOK INFO ERROR:",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);


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
