// FCM (Firebase Cloud Messaging) sender for Android push tokens.
// Uses the HTTP v1 API: signs a JWT with the Firebase service-account key,
// exchanges it for an OAuth2 access token, then POSTs messages.
// Credentials come from FCM_ACCOUNT (JSON string) or FCM_ACCOUNT_FILE (path).
import { promises as fs } from 'fs';
import jwt from 'jsonwebtoken';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

let account = null;
let accessToken = null;
let accessTokenExpiry = 0;

async function loadAccount() {
    if (account) return account;
    let raw = process.env.FCM_ACCOUNT;
    if (!raw && process.env.FCM_ACCOUNT_FILE) {
        raw = await fs.readFile(process.env.FCM_ACCOUNT_FILE, 'utf8');
    }
    if (!raw) return null;
    try {
        account = JSON.parse(raw);
    } catch {
        account = null;
    }
    return account;
}

export async function isFcmConfigured() {
    const acc = await loadAccount();
    return !!(acc && acc.client_email && acc.private_key && acc.project_id);
}

async function getAccessToken() {
    if (accessToken && Date.now() < accessTokenExpiry - 60_000) return accessToken;
    const acc = await loadAccount();
    if (!acc) throw new Error('FCM account not configured');
    const now = Math.floor(Date.now() / 1000);
    const assertion = jwt.sign(
        {
            iss: acc.client_email,
            scope: FCM_SCOPE,
            aud: TOKEN_URL,
            iat: now,
            exp: now + 3600
        },
        acc.private_key,
        { algorithm: 'RS256' }
    );
    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion
        })
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) {
        throw new Error('FCM token exchange failed: ' + JSON.stringify(data).slice(0, 200));
    }
    accessToken = data.access_token;
    accessTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
    return accessToken;
}

// Send a data+notification message to a single Android device token.
// Returns true on success. Throws on FCM hard errors (401/404 etc).
export async function sendFcmToToken(token, { title, body, url }) {
    const acc = await loadAccount();
    const bearer = await getAccessToken();
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${acc.project_id}/messages:send`, {
        method: 'POST',
        headers: {
            Authorization: 'Bearer ' + bearer,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            message: {
                token,
                notification: { title: title || 'SajiloRent', body: body || '' },
                data: { url: url || '/' }
            }
        })
    });
    if (!res.ok) {
        const text = await res.text();
        const err = new Error('FCM send failed: ' + res.status + ' ' + text.slice(0, 200));
        err.statusCode = res.status;
        err.fcmBody = text;
        throw err;
    }
    return true;
}
