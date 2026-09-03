import { pemToArrayBuffer, base64UrlEncode, arrayBufferToBase64 } from '../../../core/encoding.js';

// ========================================================
// 🔔 مزود الإشعارات: Firebase Cloud Messaging (FCM)
// ========================================================

let cachedToken = null;
let cachedTokenExp = 0;

async function getGoogleAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < cachedTokenExp - 60) return cachedToken;
  if (!env.FIREBASE_CREDENTIALS_JSON) return null;

  const keyData = JSON.parse(env.FIREBASE_CREDENTIALS_JSON);

  const header = JSON.stringify({ alg: 'RS256', typ: 'JWT' });
  const payload = JSON.stringify({
    iss: keyData.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  });
  const unsigned = `${base64UrlEncode(header)}.${base64UrlEncode(payload)}`;

  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(keyData.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${arrayBufferToBase64(signature)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  }).then((r) => r.json());

  if (!tokenRes.access_token) {
    console.error('Google OAuth token error:', tokenRes);
    return null;
  }
  cachedToken = tokenRes.access_token;
  cachedTokenExp = now + (tokenRes.expires_in || 3600);
  return cachedToken;
}

export async function sendFcmNotification(env, fcmToken, title, body, data = {}) {
  try {
    if (!fcmToken) return;
    const accessToken = await getGoogleAccessToken(env);
    if (!accessToken) return;

    const keyData = JSON.parse(env.FIREBASE_CREDENTIALS_JSON);
    const payload = {
      message: {
        token: fcmToken,
        notification: { title, body },
        data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
        webpush: {
          notification: { icon: '/images/icons/icon-192x192.png' },
          fcm_options: { link: '/' },
        },
      },
    };

    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${keyData.project_id}/messages:send`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );
    if (!res.ok) console.error('FCM send error:', await res.text());
  } catch (e) {
    console.error('sendFcmNotification error:', e);
  }
}
