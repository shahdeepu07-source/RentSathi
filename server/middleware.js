import 'dotenv/config';
import jwt from 'jsonwebtoken';

if (!process.env.JWT_SECRET) {
    console.warn('[WARN] JWT_SECRET is not set. Using a development fallback secret. For a stable deployment set JWT_SECRET in the platform env vars (Railway: Settings > Variables).');
    process.env.JWT_SECRET = 'sajilorent-dev-fallback-secret';
}

const SECRET = process.env.JWT_SECRET;

export function verifyToken(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ error: 'No token provided' });
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}
