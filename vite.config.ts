import react from '@vitejs/plugin-react'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineConfig, loadEnv, type Plugin } from 'vite'

const MODEL = 'claude-sonnet-5-5'

const SYSTEM = `You are a voiceover director for short-form video. Split the user's script into segments (sentences, or clauses for long sentences) and direct each one.
Return ONLY a JSON array, no prose, where each item is:
{"text": string, "pace": "slow"|"normal"|"fast", "energy": "soft"|"normal"|"punch", "pauseAfter": "none"|"short"|"long", "emphasis": string[], "rising": boolean}
Pace: slow ≈120 wpm, normal ≈150, fast ≈180. Pauses: short 0.3s, long 0.8s.
Guidelines: the hook (first segment) is punch at normal pace; numbers, statistics and key claims are slow with the number (including its unit, e.g. "10%") in emphasis; lists and setup context are fast; questions are rising with a short pause; the segment before the punchline or CTA gets a long pause; the last segment (CTA) is slow + punch.
The script may contain manual markup — honour it and strip it from "text": [slow]…[/slow], [fast]…[/fast], [loud]…[/loud] (= punch), [soft]…[/soft], *word* (= emphasis), / (short pause), // (long pause).
"emphasis" items must be words copied exactly from "text" (without surrounding punctuation). Keep the original wording; do not rewrite the script.`

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

/** Dev-server proxy so ANTHROPIC_API_KEY stays on the server and never reaches the browser bundle. */
function claudeDirector(apiKey: string | undefined): Plugin {
  return {
    name: 'claude-director',
    configureServer(server) {
      server.middlewares.use('/api/direct', async (req, res) => {
        if (req.method === 'GET') return send(res, 200, { enabled: Boolean(apiKey) })
        if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
        if (!apiKey) return send(res, 503, { error: 'ANTHROPIC_API_KEY not set' })
        try {
          const { script } = JSON.parse(await readBody(req)) as { script?: string }
          if (!script?.trim()) return send(res, 400, { error: 'empty script' })
          const r = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: MODEL,
              max_tokens: 4096,
              system: SYSTEM,
              messages: [{ role: 'user', content: script }],
            }),
          })
          if (!r.ok) return send(res, 502, { error: `Claude API ${r.status}` })
          const j = (await r.json()) as { content?: { type: string; text?: string }[] }
          const text = j.content?.find((c) => c.type === 'text')?.text ?? ''
          const start = text.indexOf('[')
          const end = text.lastIndexOf(']')
          if (start < 0 || end < start) return send(res, 502, { error: 'no JSON array in response' })
          send(res, 200, { segments: JSON.parse(text.slice(start, end + 1)) })
        } catch (err) {
          send(res, 500, { error: String(err) })
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Empty prefix loads every var, but only into this Node process — nothing is exposed to client code.
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), claudeDirector(env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY)],
  }
})
