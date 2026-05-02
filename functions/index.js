const functions = require('firebase-functions');
const admin = require('firebase-admin');
const sgMail = require('@sendgrid/mail');

// Load environment variables
const fs = require('fs');
const path = require('path');
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split('\n').forEach(line => {
      const [key, value] = line.split('=');
      if (key && value) {
        process.env[key.trim()] = value.trim();
      }
    });
  }
} catch (e) {
  console.log('No .env file found, using runtime environment variables');
}

// Initialize Firebase
admin.initializeApp();

// Set SendGrid API key
const apiKey = process.env.SENDGRID_API_KEY;
if (!apiKey) {
  console.error('SENDGRID_API_KEY environment variable is not set!');
} else {
  sgMail.setApiKey(apiKey);
}

// Cloud Function triggered daily to send notification emails
exports.sendChallengeNotifications = functions.pubsub
  .schedule('0 8 * * *') // Run every day at 8am
  .timeZone('America/New_York')
  .onRun(async (context) => {
    try {
      const db = admin.firestore();
      const now = new Date();

      // Get all users
      const usersSnapshot = await db.collection('users').get();

      let emailsSent = 0;

      for (const userDoc of usersSnapshot.docs) {
        const user = userDoc.data();
        const userId = userDoc.id;

        if (!user.email) {
          console.log(`User ${userId} has no email, skipping`);
          continue;
        }

        // Get user's current challenge progress
        const progressSnapshot = await db
          .collection('users')
          .doc(userId)
          .collection('progress')
          .orderBy('completedAt', 'desc')
          .limit(1)
          .get();

        if (progressSnapshot.empty) {
          // User hasn't completed any challenges
          continue;
        }

        const lastProgress = progressSnapshot.docs[0].data();
        const completedAt = lastProgress.completedAt.toDate();
        const challengeDuration = lastProgress.duration || 24; // Default 24 hours

        // Calculate when next challenge unlocks
        const nextUnlockTime = new Date(completedAt.getTime() + challengeDuration * 60 * 60 * 1000);

        // Check if challenge just unlocked (within last hour)
        const timeSinceUnlock = now - nextUnlockTime;
        const oneHourMs = 60 * 60 * 1000;

        if (timeSinceUnlock > 0 && timeSinceUnlock < oneHourMs) {
          // Challenge just unlocked! Send email
          const nextChallengeNumber = lastProgress.challengeId + 1;

          // Get the next challenge's duration (hardcoded for now - update if challenge list changes)
          const challengeDurations = {
            1: 24,
            2: 48,
            3: 24,
            4: 48,
            5: 24,
            // Add more as needed
          };
          const nextChallengeDuration = challengeDurations[nextChallengeNumber] || 24;

          const msg = {
            to: user.email,
            from: process.env.SENDGRID_FROM_EMAIL || 'noreply@mycreativehq.com',
            subject: `🚀 Challenge ${nextChallengeNumber} is ready! (${nextChallengeDuration}-hour challenge)`,
            html: `
              <h2>Welcome back, ${user.displayName || 'Creator'}!</h2>
              <p>Great news! <strong>Challenge ${nextChallengeNumber}</strong> is now unlocked and ready for you to start.</p>
              <p>This is a <strong>${nextChallengeDuration}-hour challenge</strong> — you have ${nextChallengeDuration} hours to complete it once you start.</p>
              <p>
                <a href="https://creativehq-challenge.netlify.app/challenge.html"
                   style="background-color: #FF6B35; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold;">
                  Start Challenge ${nextChallengeNumber} Now
                </a>
              </p>
              <p style="margin-top: 20px; color: #666; font-size: 14px;">Once you click start, your ${nextChallengeDuration}-hour timer begins. You can submit anytime during the window.</p>
              <p>Keep the momentum going! 💪</p>
              <p>— MyCreativeHQ</p>
            `,
          };

          try {
            await sgMail.send(msg);
            console.log(`Email sent to ${user.email} for challenge ${nextChallengeNumber}`);
            emailsSent++;
          } catch (error) {
            console.error(`Failed to send email to ${user.email}:`, error);
          }
        }
      }

      console.log(`Challenge notification job complete. Emails sent: ${emailsSent}`);
      return { success: true, emailsSent };
    } catch (error) {
      console.error('Error in sendChallengeNotifications:', error);
      throw error;
    }
  });

// HTTP endpoint to manually trigger email sending (for testing)
exports.triggerChallengeEmails = functions.https.onRequest(async (req, res) => {
  // Add basic security check
  if (req.query.token !== process.env.TRIGGER_TOKEN) {
    res.status(403).send('Unauthorized');
    return;
  }

  try {
    const db = admin.firestore();
    const now = new Date();
    const usersSnapshot = await db.collection('users').get();

    let emailsSent = 0;

    for (const userDoc of usersSnapshot.docs) {
      const user = userDoc.data();
      const userId = userDoc.id;

      if (!user.email) continue;

      const progressSnapshot = await db
        .collection('users')
        .doc(userId)
        .collection('progress')
        .orderBy('completedAt', 'desc')
        .limit(1)
        .get();

      if (progressSnapshot.empty) continue;

      const lastProgress = progressSnapshot.docs[0].data();
      const completedAt = lastProgress.completedAt.toDate();
      const challengeDuration = lastProgress.duration || 24;
      const nextUnlockTime = new Date(completedAt.getTime() + challengeDuration * 60 * 60 * 1000);

      if (nextUnlockTime <= now) {
        const nextChallengeNumber = lastProgress.challengeId + 1;

        const msg = {
          to: user.email,
          from: process.env.SENDGRID_FROM_EMAIL || 'noreply@mycreativehq.com',
          subject: `🚀 Your next challenge is ready! Challenge ${nextChallengeNumber} unlocked`,
          html: `
            <h2>Welcome back, ${user.displayName || 'Creator'}!</h2>
            <p>Great news! Your next challenge is now available.</p>
            <p><strong>Challenge ${nextChallengeNumber}</strong> is ready for you to start.</p>
            <p>
              <a href="https://creativehq-challenge.netlify.app/challenge.html"
                 style="background-color: #FF6B35; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">
                Start Challenge ${nextChallengeNumber}
              </a>
            </p>
            <p>Keep the momentum going! 💪</p>
            <p>— MyCreativeHQ</p>
          `,
        };

        try {
          await sgMail.send(msg);
          emailsSent++;
        } catch (error) {
          console.error(`Failed to send email to ${user.email}:`, error);
        }
      }
    }

    res.json({ success: true, emailsSent, message: `Sent ${emailsSent} challenge notification emails` });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// HTTP endpoint to reset a user's challenge progress (for testing)
// Usage: call with ?token=TRIGGER_TOKEN to reset authenticated user's challenge
exports.resetUserChallenge = functions.https.onCall(async (data, context) => {
  // Require authentication
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  const uid = context.auth.uid;

  try {
    const db = admin.firestore();

    // Delete the challenge fields
    await db.collection('users').doc(uid).update({
      currentChallenge: admin.firestore.FieldValue.delete(),
      challengeStarted: admin.firestore.FieldValue.delete(),
      startTime: admin.firestore.FieldValue.delete()
    });

    return { success: true, message: 'Challenge data reset. Refresh the page.' };
  } catch (error) {
    console.error('Error:', error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});
