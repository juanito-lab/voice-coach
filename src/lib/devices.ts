/** Microphone selection: pure helpers around navigator.mediaDevices.enumerateDevices() results. */

export interface DeviceLike {
  kind: string
  deviceId: string
  label: string
}

export interface InputDevice {
  deviceId: string
  label: string
}

/** The mic the user picked. Null means "system default". */
export interface MicChoice {
  deviceId: string
  label: string
}

/** Chrome lists the OS default (and on Windows the communications device) as extra pseudo entries. */
const PSEUDO_IDS = new Set(['default', 'communications'])

export function isPseudoDevice(deviceId: string): boolean {
  return PSEUDO_IDS.has(deviceId)
}

/** Strip Chrome's "Default - " / "Communications - " prefix so one physical mic has one name. */
export function cleanLabel(label: string): string {
  return label.replace(/^(default|communications)\s+-\s+/i, '').trim()
}

/** Stable key for per-device settings such as mic gain: the device's label, else its id. */
export function deviceKey(d: { deviceId: string; label: string }): string {
  return cleanLabel(d.label) || d.deviceId
}

/**
 * Real audio inputs, in the order the OS lists them. Drops pseudo entries and the anonymous
 * placeholder browsers return before mic permission is granted (empty id and label).
 */
export function audioInputs(devices: readonly DeviceLike[]): InputDevice[] {
  return devices
    .filter((d) => d.kind === 'audioinput' && d.deviceId && !isPseudoDevice(d.deviceId))
    .map((d) => ({ deviceId: d.deviceId, label: d.label }))
}

/** True once the browser exposes device labels (after the first mic permission grant). */
export function labelsVisible(devices: readonly DeviceLike[]): boolean {
  return devices.some((d) => d.kind === 'audioinput' && d.label !== '')
}

/** Name of the OS default input, when the browser lists a "default" entry (Chrome does). */
export function defaultInputLabel(devices: readonly DeviceLike[]): string | null {
  const d = devices.find((x) => x.kind === 'audioinput' && x.deviceId === 'default')
  return d && cleanLabel(d.label) ? cleanLabel(d.label) : null
}

/**
 * Find a saved choice among the devices present now: same id first (ids are stable per site),
 * then same label (ids change when site data is cleared). Null = not plugged in → use the default.
 */
export function matchDevice(inputs: readonly InputDevice[], wanted: MicChoice | null): InputDevice | null {
  if (!wanted) return null
  const byId = wanted.deviceId ? inputs.find((d) => d.deviceId === wanted.deviceId) : undefined
  if (byId) return byId
  const label = cleanLabel(wanted.label)
  return (label && inputs.find((d) => cleanLabel(d.label) === label)) || null
}

/**
 * After a devicechange: should the open mic be reopened? Yes when its track ended (unplugged),
 * when the chosen mic is back but a fallback is open, or when the chosen mic went away
 * (so we fall back to the default instead of recording silence).
 */
export function micNeedsReopen(
  devices: readonly DeviceLike[],
  choice: MicChoice | null,
  active: { deviceId: string; label: string } | null,
  activeLive: boolean,
): boolean {
  if (!active || !activeLive) return true
  const inputs = audioInputs(devices)
  const want = matchDevice(inputs, choice)
  const wantName = want ? deviceKey(want) : defaultInputLabel(devices)
  if (wantName === null) return false
  return deviceKey(active) !== wantName
}
