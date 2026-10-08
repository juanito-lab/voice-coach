# Voice Coach

A local recording studio for short-form video voiceovers. You write the script, and it is directed automatically: pace, energy, pauses and emphasis for every line. While you record, the screen shows one line at a time and coaches you with visual signals instead of instructions.

| Recording: one line, three signals | After the take: line-by-line review |
|---|---|
| ![Focus view](docs/focus.jpg) | ![Review](docs/review.jpg) |

## Run

```bash
npm install
npm run dev
```

Open the printed `http://localhost:…` URL in **Chrome on macOS** and allow microphone access.

```bash
npm test        # unit tests (Vitest)
npm run build   # type-check + production build
```

### Optional: Refine with Claude

Copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY=…`. A **Refine with Claude** button then appears under the script.

The key is read only by the Vite dev server, which proxies `POST /api/direct` to the Claude API. It is never sent to the browser. If the call fails or returns invalid JSON, the app falls back to the built-in heuristics and says so.

## Levels: what the numbers mean

Levels are in **dBFS** (decibels relative to digital full scale, where 0 is the loudest possible sample). They are **not dB SPL**: a browser can't measure real-world loudness without a calibrated mic.

| Measure | How |
|---|---|
| RMS level (big number, zones, status) | mean-square power, smoothed with a ~300 ms moving average |
| Sample peak | loudest sample per frame; the peak-hold marker sticks for 1.5 s |

Zones for the **normal** target (the standard voiceover range):

| RMS dBFS | Zone | Status |
|---|---|---|
| below −24 | too quiet (grey) | LOUDER |
| −24 to −20 | approaching (yellow) | LOUDER |
| **−20 to −12** | **good (green)** | **GOOD** |
| above −12 | hot (amber) | BACK OFF |
| any peak above −3 | red | BACK OFF |

Unprocessed speech peaks sit roughly 12–18 dB above its RMS level, so red is reserved for **near clipping (peaks above −3 dBFS)**. A red at −6 would flash on every good take. A sample at or above **−1 dBFS** counts as a clipped peak.

While recording, the green band moves to match each line's energy target:

| Energy | Green band (RMS dBFS) |
|---|---|
| soft | −26 to −18 |
| normal | −20 to −12 |
| punch | −16 to −9 |

### Check level (do this once per mic)

Built-in laptop mics with the audio filters off read about 20–25 dB below voiceover level, which would leave you permanently in "LOUDER". **Check level** takes 8 seconds: 3 s of silence (noise floor), then 5 s of you reading the first line. It then sets a digital input gain so your normal read averages about **−18 dBFS**, while keeping 95% of peaks under −3 dBFS. The gain applies to the meter and the recording, and is remembered in this browser. Test sources always run at 0 dB gain.

A noise floor above **−50 dBFS** (after gain) means the room is too noisy for clean takes. During a take, any frame within 6 dB of the floor counts as silence and is left out of the summary.

The mic is opened with echo cancellation, noise suppression and auto-gain **off**, because those filters distort level readings.

## Directing

The script is directed **as you type** (no button). It splits the script into sentences (and splits sentences over 20 words at `;` and `—`). It gives each segment:

- a pace: slow 120 / normal 150 / fast 180 wpm (blue / white / orange)
- an energy level: soft / normal / punch
- a pause after it: short 0.3 s `‖` / long 0.8 s `‖‖`
- emphasis words, shown in **bold**

Auto rules apply in this order. Later rules win, the longer pause always wins, and manual markup overrides everything:

1. lists (3+ comma-separated items) and setup lines → fast
2. numbers, %, $ → slow, with the number (and its unit) emphasised
3. questions → rising tone (↗) + short pause
4. hook (first line) → punch, normal pace
5. the line before the CTA → long pause
6. last line / CTA → slow + punch

### Markup

| Markup | Effect |
|---|---|
| `[slow]…[/slow]` `[fast]…[/fast]` | force pace |
| `[loud]…[/loud]` `[soft]…[/soft]` | force energy (loud = punch) |
| `*word*` or `*several words*` | emphasis |
| `/` | short pause (0.3 s) |
| `//` | long pause (0.8 s) |

Example: `[fast]Cars, vans, trucks[/fast] // *all* of them.`

## Recording: one line, three signals

Press **Space** (or **● Start take**). After a 3-2-1 countdown the screen shows only the current line, with the previous and next lines dimmed. You get no text instructions while recording, only signals:

| Signal | Meaning |
|---|---|
| Words light up | where you are: each word turns bright as speech recognition hears it |
| Bar under the words | where the target pace says you should be. **Green**: on pace · **blue**: you're rushing (ahead of the bar) · **amber**: you're dragging (behind it) |
| Draining ring before a line | hold the pause (0.3 s or 0.8 s) until it empties |
| Slim bar left of the line | your level against this line's target band (soft / normal / punch). Green = inside the bracket |

How following works:

- Speech recognition starts during the countdown, so your first words aren't lost while it warms up.
- Each recognised word is matched to the nearest script word ahead. Matching is fuzzy for longer words ("damage" ≈ "damaged", "build" ≈ "billed") and number words map to digits ("ten" = "10%").
- If words are missed or mangled (brand names often are), two consecutive matching words up to 40 words ahead put the prompter back on track.
- The pace bar starts each line when you say its first word. It carries over from the previous line, so starting a line early or cutting a pause short still shows as rushing; starting late is forgiven.
- A pace colour has to hold for 0.5 s before it shows, so recognition bursts don't make it flicker.
- The take stops by itself 1.5 s after the last word, or press **Space**.

If speech recognition isn't available or is blocked, the prompter falls back to **timed** scrolling at the target pace.

⚠️ Chrome's speech recognition sends audio to Google's servers. The level meter and the recordings themselves stay local.

## After the take

- A summary row shows % of speaking time in the green, average level, clipped peaks and average wpm (over the words actually reached).
- Each line gets its own result: pace (● on target, ▲ too fast, ▼ too slow; lines under 4 words aren't judged) and level against that line's band (● good, ▼ quiet, ▲ hot).
- Play the take, or download it as **.webm** (Opus) or **.wav** (16-bit PCM, converted in the browser).

### Shortcuts

| Key | Action |
|---|---|
| Space | start / stop a take |
| Esc | stop |
| R | restart following from the top |
| ↑ / ↓ | nudge the prompter (±1 word in speech mode, ±1 s in timed mode) |

Shortcuts are ignored while you type in the script box.

### Testing without a mic

The **Input** menu has test sources: tones at −30, −16 and −3 dBFS RMS, or any audio file. They go through the same meter and recorder as the mic.

## Storage

The last script, any Claude direction for it, and your mic gain and noise floor are saved in `localStorage`.

In dev, each take also posts a diagnostics line (tracking mode, words followed, per-line results) to the dev-server console. Nothing leaves your machine.

## License

MIT
