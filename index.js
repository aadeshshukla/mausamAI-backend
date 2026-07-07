const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const { randomUUID } = require('crypto');
require('dotenv').config();

// ---------- Startup env validation ----------
const REQUIRED_ENV = ['GROQ_API_KEY'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[FATAL] Missing required env var: ${key}`);
    process.exit(1);
  }
}

const PORT = process.env.PORT || 5000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map((s) => s.trim());

// Models tried in order — first is primary, rest are fallbacks if the call fails
const MODEL_CHAIN = [
  'openai/gpt-oss-120b',
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
];

const SYSTEM_PROMPT =
  'You are mausamAI, a helpful assistant developed by Aadesh Shukla. Be concise, accurate, and friendly.';

const MAX_MESSAGE_LENGTH = 4000;
const MAX_HISTORY_TURNS = 10; // user+assistant pairs kept per session
const SESSION_TTL_MS = 1000 * 60 * 60; // 1 hour idle expiry

// ---------- In-memory session store ----------
// sessionId -> { history: [{role, content}], lastActive: timestamp }
const sessions = new Map();

function getSession(sessionId) {
  let session = sessions.get(sessionId);
  if (!session) {
    session = { history: [], lastActive: Date.now() };
    sessions.set(sessionId, session);
  }
  session.lastActive = Date.now();
  return session;
}

function pushToHistory(session, role, content) {
  session.history.push({ role, content });
  // Keep only the last N turns (each turn = 1 user + 1 assistant message)
  const maxMessages = MAX_HISTORY_TURNS * 2;
  if (session.history.length > maxMessages) {
    session.history = session.history.slice(-maxMessages);
  }
}

// Periodic cleanup of stale sessions
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.lastActive > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}, 1000 * 60 * 10).unref();

// ---------- Logging helper ----------
function log(level, msg, meta = {}) {
  const entry = { ts: new Date().toISOString(), level, msg, ...meta };
  console.log(JSON.stringify(entry));
}

// ---------- Groq call with retry + model fallback ----------
async function callGroq(messages, { stream = false, onChunk = null } = {}) {
  let lastError;

  for (const model of MODEL_CHAIN) {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (!stream) {
          const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            { model, messages, temperature: 0.7, max_tokens: 1024 },
            {
              headers: {
                Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
                'Content-Type': 'application/json',
              },
              timeout: 20000,
            }
          );
          return { reply: response.data.choices[0].message.content, model };
        } else {
          const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            { model, messages, temperature: 0.7, max_tokens: 1024, stream: true },
            {
              headers: {
                Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
                'Content-Type': 'application/json',
              },
              responseType: 'stream',
              timeout: 30000,
            }
          );

          let fullReply = '';
          await new Promise((resolve, reject) => {
            response.data.on('data', (chunk) => {
              const lines = chunk
                .toString('utf8')
                .split('\n')
                .filter((line) => line.trim().startsWith('data:'));

              for (const line of lines) {
                const payload = line.replace(/^data:\s*/, '');
                if (payload === '[DONE]') continue;
                try {
                  const parsed = JSON.parse(payload);
                  const delta = parsed.choices?.[0]?.delta?.content;
                  if (delta) {
                    fullReply += delta;
                    if (onChunk) onChunk(delta);
                  }
                } catch {
                  // ignore partial/malformed JSON fragments
                }
              }
            });
            response.data.on('end', resolve);
            response.data.on('error', reject);
          });

          return { reply: fullReply, model };
        }
      } catch (error) {
        lastError = error;
        const status = error?.response?.status;
        log('warn', 'Groq call failed', {
          model,
          attempt,
          status,
          detail: error?.response?.data || error.message,
        });

        // Don't retry on client errors (bad request, auth) — move to next model instead
        if (status && status < 500 && status !== 429) break;

        // Exponential backoff before retrying same model
        if (attempt < maxAttempts) {
          const delay = 300 * 2 ** (attempt - 1);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
  }

  throw lastError || new Error('All models failed');
}

// ---------- App setup ----------
const app = express();

// Render (and most PaaS hosts) sit behind a reverse proxy, so Express needs
// to trust the X-Forwarded-For header to determine the real client IP.
// '1' trusts only the first hop (the platform's own proxy) rather than any
// arbitrary upstream, which is what express-rate-limit needs to key on IP safely.
app.set('trust proxy', 1);

app.use(helmet());
app.use(
  cors({
    origin: ALLOWED_ORIGINS.includes('*') ? true : ALLOWED_ORIGINS,
  })
);
app.use(express.json({ limit: '100kb' }));

// Basic request logging
app.use((req, res, next) => {
  req.id = randomUUID();
  const start = Date.now();
  res.on('finish', () => {
    log('info', 'request', {
      id: req.id,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - start,
    });
  });
  next();
});

// Rate limiting — protects the Groq key from abuse
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20, // 20 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});

// ---------- Validation ----------
function validateChatBody(req, res, next) {
  const { message } = req.body || {};
  if (typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'message is required and must be a non-empty string' });
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return res
      .status(400)
      .json({ error: `message must be under ${MAX_MESSAGE_LENGTH} characters` });
  }
  next();
}

// ---------- Routes ----------

// Standard (non-streaming) chat, with per-session memory
app.post('/chat', chatLimiter, validateChatBody, async (req, res) => {
  const { message, sessionId: incomingSessionId } = req.body;
  const sessionId = incomingSessionId || randomUUID();
  const session = getSession(sessionId);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...session.history,
    { role: 'user', content: message },
  ];

  try {
    const { reply, model } = await callGroq(messages);
    pushToHistory(session, 'user', message);
    pushToHistory(session, 'assistant', reply);

    res.json({ reply, sessionId, model });
  } catch (error) {
    log('error', 'Groq API Error', {
      detail: error?.response?.data || error.message,
    });
    res.status(500).json({ error: 'mausamAI is temporarily unavailable' });
  }
});

// Streaming chat via Server-Sent Events
app.post('/chat/stream', chatLimiter, validateChatBody, async (req, res) => {
  const { message, sessionId: incomingSessionId } = req.body;
  const sessionId = incomingSessionId || randomUUID();
  const session = getSession(sessionId);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...session.history,
    { role: 'user', content: message },
  ];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Session-Id', sessionId);
  res.flushHeaders();

  try {
    const { reply } = await callGroq(messages, {
      stream: true,
      onChunk: (delta) => {
        res.write(`data: ${JSON.stringify({ delta })}\n\n`);
      },
    });

    pushToHistory(session, 'user', message);
    pushToHistory(session, 'assistant', reply);

    res.write(`data: ${JSON.stringify({ done: true, sessionId })}\n\n`);
    res.end();
  } catch (error) {
    log('error', 'Groq stream error', {
      detail: error?.response?.data || error.message,
    });
    res.write(`data: ${JSON.stringify({ error: 'mausamAI is temporarily unavailable' })}\n\n`);
    res.end();
  }
});

// Clear a session's conversation history
app.delete('/chat/session/:id', (req, res) => {
  const existed = sessions.delete(req.params.id);
  res.json({ cleared: existed });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'mausamAI backend is running on Groq',
    env: NODE_ENV,
    activeSessions: sessions.size,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Centralized error handler (catches sync throws / malformed JSON body etc.)
app.use((err, req, res, next) => {
  log('error', 'Unhandled error', { detail: err.message });
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  log('info', `mausamAI backend running on http://localhost:${PORT}`, { env: NODE_ENV });
});

// ---------- Graceful shutdown ----------
function shutdown(signal) {
  log('info', `Received ${signal}, shutting down gracefully`);
  server.close(() => {
    log('info', 'Server closed');
    process.exit(0);
  });
  // Force exit if it hangs
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));