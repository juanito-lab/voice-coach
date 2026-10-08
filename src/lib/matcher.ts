const NUMBER_WORDS: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16',
  seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20', thirty: '30', forty: '40', fifty: '50',
  sixty: '60', seventy: '70', eighty: '80', ninety: '90', hundred: '100',
}

/** Lowercase, strip punctuation and map number words to digits so "Ten" and "10%" compare equal. */
export function normalizeWord(w: string): string {
  const n = w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  return NUMBER_WORDS[n] ?? n
}

export function tokenize(text: string): string[] {
  return text.split(/\s+/).map(normalizeWord).filter(Boolean)
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return dp[b.length]
}

/** Exact for short words; fuzzy for longer ones ("damaged" ≈ "damage", "billed" ≈ "build"). */
export function wordsMatch(script: string, heard: string): boolean {
  if (!script || !heard) return false
  if (script === heard) return true
  const len = Math.max(script.length, heard.length)
  if (Math.min(script.length, heard.length) < 4) return false
  if (script.startsWith(heard) || heard.startsWith(script)) return true
  return editDistance(script, heard) <= (len >= 6 ? Math.floor(len / 2) : 1)
}

/** Short words like "a", "to", "so" only match very close to the current position. */
const SHORT_WINDOW = 3
/** How far a confirmed two-word phrase may jump ahead (recovers from missed words). */
const REANCHOR_WINDOW = 40

/**
 * Walk recognised words through the script, only ever moving forward. Returns the
 * index of the next unspoken script word.
 *
 * - Each heard word matches the nearest script word within `lookahead` (3 for short words).
 * - If that fails, two consecutive heard words that match two consecutive script words
 *   up to 40 words ahead re-anchor the position, so missing the start of a take or
 *   mangling a brand name never leaves the prompter stuck.
 */
export function matchPosition(scriptWords: string[], startPos: number, heard: string[], lookahead = 6): number {
  const h = heard.map(normalizeWord).filter(Boolean)
  let pos = startPos
  for (let i = 0; i < h.length; i++) {
    const word = h[i]
    const window = word.length <= 3 ? SHORT_WINDOW : lookahead
    let found = -1
    for (let j = pos; j < Math.min(scriptWords.length, pos + window); j++) {
      if (wordsMatch(scriptWords[j], word)) {
        found = j
        break
      }
    }
    if (found < 0 && i + 1 < h.length) {
      for (let j = pos; j < Math.min(scriptWords.length - 1, pos + REANCHOR_WINDOW); j++) {
        if (wordsMatch(scriptWords[j], word) && wordsMatch(scriptWords[j + 1], h[i + 1])) {
          found = j
          break
        }
      }
    }
    if (found >= 0) pos = found + 1
  }
  return pos
}
