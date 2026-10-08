/* Minimal wrapper around Chrome's webkitSpeechRecognition. Audio is processed by Google's servers. */

interface RecResult {
  isFinal: boolean
  0: { transcript: string }
}
interface RecEvent {
  resultIndex: number
  results: ArrayLike<RecResult>
}
interface Recognition {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((e: RecEvent) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}
type RecognitionCtor = new () => Recognition

function ctor(): RecognitionCtor | null {
  const w = window as unknown as { webkitSpeechRecognition?: RecognitionCtor; SpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export function speechAvailable(): boolean {
  return ctor() !== null
}

export class SpeechTracker {
  private rec: Recognition | null = null
  private active = false
  private finals: string[] = []
  private interim: string[] = []

  /** onWords receives every word heard since start (finals + current interim). */
  start(onWords: (words: string[]) => void, onFail: (reason: string) => void): void {
    const C = ctor()
    if (!C) {
      onFail('unavailable')
      return
    }
    this.active = true
    this.finals = []
    this.interim = []
    const rec = new C()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = 'en-US'
    rec.onresult = (e) => {
      const interim: string[] = []
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        const words = r[0].transcript.trim().split(/\s+/).filter(Boolean)
        if (r.isFinal) this.finals.push(...words)
        else interim.push(...words)
      }
      this.interim = interim
      onWords([...this.finals, ...this.interim])
    }
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return
      this.active = false
      onFail(e.error)
    }
    rec.onend = () => {
      // Chrome ends sessions after silence; keep listening while recording.
      if (this.active) {
        this.finals.push(...this.interim)
        this.interim = []
        try {
          rec.start()
        } catch {
          /* already started */
        }
      }
    }
    this.rec = rec
    try {
      rec.start()
    } catch (err) {
      this.active = false
      onFail(String(err))
    }
  }

  stop(): number {
    this.active = false
    this.rec?.stop()
    this.rec = null
    return this.finals.length + this.interim.length
  }
}
