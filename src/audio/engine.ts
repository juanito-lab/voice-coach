import {
  ampToDb,
  classify,
  CLIP_DB,
  emaAlpha,
  ENERGY_BANDS,
  meanSquare,
  peakAbs,
  PEAK_RED_DB,
  powerToDb,
  sineAmpForRmsDb,
  statusWord,
  type Zone,
} from '../lib/levels'
import type { Frame } from '../lib/levelcheck'
import type { Energy } from '../lib/types'
import { encodeWav } from '../lib/wav'

export type { Frame }
export type SourceKind = 'mic' | 'tone-30' | 'tone-16' | 'tone-3' | 'file'

/** DOM targets the engine paints directly, bypassing React. */
export interface MeterTargets {
  meter?: HTMLCanvasElement | null
  readout?: HTMLElement | null
  status?: HTMLElement | null
}

export interface TakeStats {
  takeSec: number
  speakingSec: number
  greenPct: number
  avgDb: number
  clips: number
}

const SMOOTH_MS = 300
const PEAK_HOLD_MS = 1500
const DB_MIN = -60
const DEFAULT_FLOOR = -60
const SILENCE_MARGIN_DB = 6

const ZONE_COLOR: Record<Zone, string> = {
  quiet: '#6e7681',
  approach: '#d29922',
  good: '#3fb950',
  hot: '#f0883e',
  clip: '#f85149',
}


const RAW_AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
/** Mic to use whenever it is plugged in; falls back to the system default. */
const PREFERRED_MIC = /mvx2u|shure/i

async function openPreferredMic(): Promise<MediaStream> {
  // First call grants permission so device labels become readable.
  const stream = await navigator.mediaDevices.getUserMedia({ audio: RAW_AUDIO })
  const devices = await navigator.mediaDevices.enumerateDevices()
  const want = devices.find((d) => d.kind === 'audioinput' && PREFERRED_MIC.test(d.label))
  const current = stream.getAudioTracks()[0]?.getSettings().deviceId
  if (!want || want.deviceId === current) return stream
  stream.getTracks().forEach((t) => t.stop())
  return navigator.mediaDevices.getUserMedia({ audio: { ...RAW_AUDIO, deviceId: { exact: want.deviceId } } })
}

export class AudioEngine {
  ctx: AudioContext | null = null
  targets: MeterTargets = {}
  /** Noise floor in dBFS, measured after gain. */
  noiseFloor: number | null = null
  /** Digital input gain in dB, set by the level check. */
  gainDb = 0

  private analyser: AnalyserNode | null = null
  private gain: GainNode | null = null
  private dest: MediaStreamAudioDestinationNode | null = null
  private sourceNode: AudioNode | null = null
  private micStream: MediaStream | null = null
  private buf = new Float32Array(2048)
  private raf = 0
  private lastT = 0
  private ema = 0
  private rmsDb = -100
  private framePeakDb = -100
  private holdDb = -100
  private holdT = 0
  private band: [number, number] = ENERGY_BANDS.normal
  private lastReadout = ''
  private lastStatus = ''

  private collector: { until: number; frames: Frame[]; resolve: (frames: Frame[]) => void } | null = null

  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private recStart = 0
  private stats = { speaking: 0, green: 0, powerSum: 0, clips: 0, clipping: false }

  async init(): Promise<void> {
    if (this.ctx) {
      await this.ctx.resume()
      return
    }
    this.ctx = new AudioContext()
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 2048
    this.analyser.smoothingTimeConstant = 0
    this.buf = new Float32Array(this.analyser.fftSize)
    this.dest = this.ctx.createMediaStreamDestination()
    // source → gain → analyser + recorder
    this.gain = this.ctx.createGain()
    this.gain.gain.value = Math.pow(10, this.gainDb / 20)
    this.gain.connect(this.analyser)
    this.gain.connect(this.dest)
    // Keep the analyser pulled by the graph without making any sound.
    const mute = this.ctx.createGain()
    mute.gain.value = 0
    this.analyser.connect(mute).connect(this.ctx.destination)
    this.lastT = performance.now()
    this.raf = requestAnimationFrame(this.tick)
  }

  /** Switch the input. Every source feeds the same analyser and recorder path. */
  async setSource(kind: SourceKind, file?: File): Promise<void> {
    await this.init()
    const ctx = this.ctx!
    this.disconnectSource()
    let node: AudioNode
    if (kind === 'mic') {
      this.micStream = await openPreferredMic()
      node = ctx.createMediaStreamSource(this.micStream)
    } else if (kind === 'file') {
      if (!file) throw new Error('No file selected')
      const audio = await ctx.decodeAudioData(await file.arrayBuffer())
      const src = ctx.createBufferSource()
      src.buffer = audio
      src.loop = true
      src.start()
      node = src
    } else {
      const db = kind === 'tone-30' ? -30 : kind === 'tone-16' ? -16 : -3
      const osc = ctx.createOscillator()
      osc.frequency.value = 440
      const gain = ctx.createGain()
      gain.gain.value = sineAmpForRmsDb(db)
      osc.connect(gain)
      osc.start()
      node = gain
    }
    node.connect(this.gain!)
    this.sourceNode = node
  }

  private disconnectSource() {
    this.sourceNode?.disconnect()
    this.sourceNode = null
    this.micStream?.getTracks().forEach((t) => t.stop())
    this.micStream = null
  }

  setNoiseFloor(db: number | null) {
    this.noiseFloor = db
  }

  setGainDb(db: number) {
    this.gainDb = db
    if (this.gain) this.gain.gain.value = Math.pow(10, db / 20)
  }

  setTargets(t: MeterTargets) {
    this.targets = t
    // New elements: force the next frame to repaint text.
    this.lastReadout = ''
    this.lastStatus = ''
  }

  setBand(energy: Energy) {
    this.band = ENERGY_BANDS[energy]
  }

  get bandNow(): [number, number] {
    return this.band
  }

  get levelDb(): number {
    return this.rmsDb
  }

  /** True when the smoothed level is clearly above the noise floor. */
  get speaking(): boolean {
    return this.rmsDb > (this.noiseFloor ?? DEFAULT_FLOOR) + SILENCE_MARGIN_DB
  }

  /** Collect per-frame power and peak (at the current gain) for `ms`. */
  collect(ms: number): Promise<Frame[]> {
    return new Promise((resolve) => {
      this.collector = { until: performance.now() + ms, frames: [], resolve }
    })
  }

  get recording(): boolean {
    return this.recorder?.state === 'recording'
  }

  startRecording() {
    if (!this.dest) throw new Error('Audio not started')
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
    this.chunks = []
    this.recorder = new MediaRecorder(this.dest.stream, { mimeType })
    this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data)
    this.stats = { speaking: 0, green: 0, powerSum: 0, clips: 0, clipping: false }
    this.recStart = performance.now()
    this.recorder.start(250)
  }

  stopRecording(): Promise<{ webm: Blob; stats: TakeStats }> {
    const rec = this.recorder
    if (!rec) return Promise.reject(new Error('Not recording'))
    return new Promise((resolve) => {
      rec.onstop = () => {
        const takeSec = (performance.now() - this.recStart) / 1000
        const s = this.stats
        resolve({
          webm: new Blob(this.chunks, { type: rec.mimeType || 'audio/webm' }),
          stats: {
            takeSec,
            speakingSec: s.speaking,
            greenPct: s.speaking ? (100 * s.green) / s.speaking : 0,
            avgDb: s.speaking ? powerToDb(s.powerSum / s.speaking) : -100,
            clips: s.clips,
          },
        })
        this.recorder = null
      }
      rec.stop()
    })
  }

  /** Decode the recorded webm and re-encode it as 16-bit PCM WAV. */
  async toWav(webm: Blob): Promise<Blob> {
    const audio = await this.ctx!.decodeAudioData(await webm.arrayBuffer())
    const chans = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i))
    return new Blob([encodeWav(chans, audio.sampleRate)], { type: 'audio/wav' })
  }

  dispose() {
    cancelAnimationFrame(this.raf)
    this.disconnectSource()
    void this.ctx?.close()
    this.ctx = null
  }

  private tick = (t: number) => {
    this.raf = requestAnimationFrame(this.tick)
    if (!this.analyser) return
    const dt = t - this.lastT
    this.lastT = t
    this.analyser.getFloatTimeDomainData(this.buf)
    const ms = meanSquare(this.buf)
    this.ema += emaAlpha(dt, SMOOTH_MS) * (ms - this.ema)
    this.rmsDb = powerToDb(this.ema)
    this.framePeakDb = ampToDb(peakAbs(this.buf))
    if (this.framePeakDb >= this.holdDb || t - this.holdT > PEAK_HOLD_MS) {
      this.holdDb = this.framePeakDb
      this.holdT = t
    }
    const zone = classify(this.rmsDb, this.framePeakDb, this.band)

    if (this.collector) {
      this.collector.frames.push({ ms, peak: peakAbs(this.buf) })
      if (t >= this.collector.until) {
        const c = this.collector
        this.collector = null
        c.resolve(c.frames)
      }
    }

    if (this.recording) {
      const sec = dt / 1000
      const floor = this.noiseFloor ?? DEFAULT_FLOOR
      if (this.rmsDb > floor + SILENCE_MARGIN_DB) {
        this.stats.speaking += sec
        this.stats.powerSum += this.ema * sec
        if (zone === 'good') this.stats.green += sec
      }
      const clipping = this.framePeakDb >= CLIP_DB
      if (clipping && !this.stats.clipping) this.stats.clips++
      this.stats.clipping = clipping
    }

    this.paint(zone)
  }

  private paint(zone: Zone) {
    const { readout, status, meter } = this.targets
    const r = this.rmsDb <= -99 ? '−∞' : this.rmsDb.toFixed(1).replace('-', '−')
    if (readout && r !== this.lastReadout) {
      readout.textContent = r
      this.lastReadout = r
    }
    const word = statusWord(zone)
    const sKey = word + zone
    if (status && sKey !== this.lastStatus) {
      status.textContent = word
      status.style.color = ZONE_COLOR[zone]
      this.lastStatus = sKey
    }
    if (meter) this.drawMeter(meter, zone)
  }

  private fit(c: HTMLCanvasElement): CanvasRenderingContext2D {
    const dpr = window.devicePixelRatio || 1
    const w = Math.round(c.clientWidth * dpr)
    const h = Math.round(c.clientHeight * dpr)
    if (c.width !== w || c.height !== h) {
      c.width = w
      c.height = h
    }
    const g = c.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    return g
  }

  private zoneBands(): [number, number, string][] {
    const [lo, hi] = this.band
    return [
      [DB_MIN, lo - 4, ZONE_COLOR.quiet],
      [lo - 4, lo, ZONE_COLOR.approach],
      [lo, hi, ZONE_COLOR.good],
      [hi, PEAK_RED_DB, ZONE_COLOR.hot],
      [PEAK_RED_DB, 0, ZONE_COLOR.clip],
    ]
  }

  private drawMeter(c: HTMLCanvasElement, zone: Zone) {
    const g = this.fit(c)
    const W = c.clientWidth
    const H = c.clientHeight
    const y = (db: number) => H - ((Math.max(DB_MIN, Math.min(0, db)) - DB_MIN) / -DB_MIN) * H
    // Slim meters (focus screen) drop the scale and fill the canvas.
    const slim = W < 60
    const barX = slim ? 0 : 44
    const barW = slim ? W : W - barX - 8
    g.clearRect(0, 0, W, H)
    for (const [a, b, col] of this.zoneBands()) {
      g.fillStyle = col
      g.globalAlpha = 0.16
      g.fillRect(barX, y(b), barW, y(a) - y(b))
    }
    g.globalAlpha = 1
    // level bar
    g.fillStyle = ZONE_COLOR[zone]
    const top = y(this.rmsDb)
    if (slim) g.fillRect(barX, top, barW, H - top)
    else g.fillRect(barX + barW * 0.2, top, barW * 0.6, H - top)
    // green-band outline so the target is always visible
    const [lo, hi] = this.band
    g.strokeStyle = ZONE_COLOR.good
    g.lineWidth = 2
    g.strokeRect(barX + 1, y(hi), barW - 2, y(lo) - y(hi))
    // peak-hold marker
    g.fillStyle = this.holdDb > PEAK_RED_DB ? ZONE_COLOR.clip : '#e6edf3'
    g.fillRect(barX, y(this.holdDb) - 2, barW, 4)
    if (slim) return
    // scale
    g.fillStyle = '#8b949e'
    g.font = '12px ui-monospace, Menlo, monospace'
    g.textAlign = 'right'
    g.textBaseline = 'middle'
    for (let db = 0; db >= DB_MIN; db -= 6) {
      g.fillText(String(db), barX - 8, Math.min(H - 7, Math.max(7, y(db))))
      g.fillRect(barX - 5, y(db), 4, 1)
    }
  }
}
