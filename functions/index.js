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

// Duration (hours) for each of the 16 challenges, indexed by challenge ID
const CHALLENGE_DURATIONS = {
  1: 24, 2: 48, 3: 48, 4: 72, 5: 24,
  6: 48, 7: 48, 8: 48, 9: 48, 10: 72,
  11: 24, 12: 48, 13: 48, 14: 24, 15: 48, 16: 72
};

const MS_PER_HOUR = 60 * 60 * 1000;

function formatTimeRemaining(ms) {
  const totalMinutes = Math.max(1, Math.ceil(ms / (60 * 1000)));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours && minutes) return `${hours} hour${hours === 1 ? '' : 's'} ${minutes} minute${minutes === 1 ? '' : 's'}`;
  if (hours) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function parseCompletionDate(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate();
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function getPendingChallengeNotification(user, now) {
  if (!user.email) return null;
  if (!Array.isArray(user.submissionHistory) || user.submissionHistory.length === 0) return null;

  const completedIds = new Set(user.submissionHistory.map(entry => Number(entry.challengeId)));
  let nextChallengeId = null;
  for (let i = 1; i <= 16; i++) {
    if (!completedIds.has(i)) {
      nextChallengeId = i;
      break;
    }
  }

  if (!nextChallengeId || nextChallengeId === 1) return null;
  if (user.challengeEmailSent && user.challengeEmailSent[nextChallengeId]) return null;

  const previousChallengeId = nextChallengeId - 1;
  const previousEntry = user.submissionHistory
    .filter(entry => Number(entry.challengeId) === previousChallengeId)
    .sort((a, b) => {
      const bDate = parseCompletionDate(b.completedAt);
      const aDate = parseCompletionDate(a.completedAt);
      return (bDate ? bDate.getTime() : 0) - (aDate ? aDate.getTime() : 0);
    })[0];
  if (!previousEntry) return null;

  const completedAt = parseCompletionDate(previousEntry.completedAt);
  if (!completedAt) return null;

  const previousDuration = CHALLENGE_DURATIONS[previousChallengeId] || 24;
  const nextDuration = CHALLENGE_DURATIONS[nextChallengeId] || 24;
  const unlockTime = completedAt.getTime() + previousDuration * MS_PER_HOUR;
  const endTime = unlockTime + nextDuration * MS_PER_HOUR;
  const remainingMs = endTime - now.getTime();

  if (now.getTime() < unlockTime || remainingMs <= 0) return null;

  return {
    nextChallengeId,
    remainingText: formatTimeRemaining(remainingMs)
  };
}

function buildChallengeEmail(user, nextChallengeId, remainingText) {
  const name = user.displayName || user.name || 'Creator';

  return {
    to: user.email,
    from: process.env.SENDGRID_FROM_EMAIL || 'noreply@mycreativehq.com',
    subject: `🔓 Your next challenge has started — ${remainingText} left ⏳`,
    html: `
      <h2>Your next challenge has started, ${name}!</h2>
      <p><strong>Challenge ${nextChallengeId}</strong> is now live and your timer is running.</p>
      <p>You have <strong>${remainingText} left</strong> to complete it before this challenge window closes.</p>
      <p>Head back to your dashboard, review the assignment, and mark it complete once you finish the work.</p>
      <p>
        <a href="https://creativehq-challenge.netlify.app/challenge.html"
           style="background-color: #8caf49; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold;">
          Go to Challenge ${nextChallengeId}
        </a>
      </p>
      <p style="margin-top: 20px; color: #666; font-size: 14px;">Don't wait — every hour counts.</p>
      <p>— MyCreativeHQ</p>
    `,
  };
}

// Cloud Function triggered hourly to send notification emails
exports.sendChallengeNotifications = functions.pubsub
  .schedule('0 * * * *') // Run every hour
  .timeZone('America/New_York')
  .onRun(async (context) => {
    try {
      const db = admin.firestore();
      const now = new Date();

      const usersSnapshot = await db.collection('users').get();
      let emailsSent = 0;

      for (const userDoc of usersSnapshot.docs) {
        const user = userDoc.data();
        const userId = userDoc.id;

        const notification = getPendingChallengeNotification(user, now);
        if (!notification) continue;

        const msg = buildChallengeEmail(user, notification.nextChallengeId, notification.remainingText);

        try {
          await sgMail.send(msg);
          await db.collection('users').doc(userId).update({
            [`challengeEmailSent.${notification.nextChallengeId}`]: admin.firestore.Timestamp.now()
          });
          console.log(`Email sent to ${user.email} for challenge ${notification.nextChallengeId}`);
          emailsSent++;
        } catch (error) {
          console.error(`Failed to send email to ${user.email}:`, error);
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
      const notification = getPendingChallengeNotification(user, now);
      if (!notification) continue;

      const msg = buildChallengeEmail(user, notification.nextChallengeId, notification.remainingText);

      try {
        await sgMail.send(msg);
        await db.collection('users').doc(userDoc.id).update({
          [`challengeEmailSent.${notification.nextChallengeId}`]: admin.firestore.Timestamp.now()
        });
        emailsSent++;
      } catch (error) {
        console.error(`Failed to send email to ${user.email}:`, error);
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
      startTime: admin.firestore.FieldValue.delete(),
      programStartDate: admin.firestore.FieldValue.delete(),
      completedCount: 0,
      submissionHistory: [],
      challengeEmailSent: admin.firestore.FieldValue.delete()
    });

    return { success: true, message: 'Challenge data reset. Refresh the page.' };
  } catch (error) {
    console.error('Error:', error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});
