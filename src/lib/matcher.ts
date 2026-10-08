/** Lowercase and strip punctuation so script words and recognised words compare cleanly. */
export function normalizeWord(w: string): string {
  return w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
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

export function wordsMatch(script: string, heard: string): boolean {
  if (!script || !heard) return false
  if (script === heard) return true
  if (script.length >= 4 && heard.length >= 4 && (script.startsWith(heard) || heard.startsWith(script))) return true
  if (script.length > 3 && heard.length > 3) return editDistance(script, heard) <= 1
  return false
}

/**
 * Walk the recognised words through the script, only ever moving forward and only
 * within `lookahead` words of the current position. Returns the index of the next
 * unspoken script word.
 */
export function matchPosition(scriptWords: string[], startPos: number, heard: string[], lookahead = 8): number {
  let pos = startPos
  for (const raw of heard) {
    const h = normalizeWord(raw)
    if (!h) continue
    const end = Math.min(scriptWords.length, pos + lookahead)
    for (let j = pos; j < end; j++) {
      if (wordsMatch(scriptWords[j], h)) {
        pos = j + 1
        break
      }
    }
  }
  return pos
}
