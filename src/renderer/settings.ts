// The Settings window: shows what's set up and what isn't, and saves each change as it is made.
import type { LicenceState } from '../main/licence'
import type { Settings } from '../main/settings'
import type { View } from '../main/settings-window'

declare global {
  interface Window {
    settingsBridge: {
      view(): Promise<View>
      set(patch: Partial<Settings>): Promise<{ ok: boolean; message?: string; restart?: boolean }>
      setKey(key: string | null): Promise<boolean>
      setLicence(key: string): Promise<LicenceState | null>
      grant(what: 'screen' | 'accessibility' | 'microphone'): Promise<void>
      forget(id: string | null): Promise<void>
      lesson(id: string, what: 'show' | 'delete'): Promise<void>
      copy(text: string): Promise<void>
      link(url: string): Promise<void>
      relaunch(): Promise<void>
    }
  }
}

const bridge = window.settingsBridge
const $ = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as T
let view: View

function toast(text: string, restart = false): void {
  const t = $<HTMLDivElement>('toast')
  t.querySelector('span')!.textContent = text
  t.querySelector('button')!.classList.toggle('hidden', !restart)
  t.classList.add('show')
  clearTimeout(Number(t.dataset.timer))
  t.dataset.timer = String(setTimeout(() => t.classList.remove('show'), restart ? 8000 : 2600))
}
$<HTMLDivElement>('toast').querySelector('button')!.addEventListener('click', () => void bridge.relaunch())

async function save(patch: Partial<Settings>): Promise<boolean> {
  const r = await bridge.set(patch)
  if (!r.ok) toast(r.message ?? "Couldn't save that.")
  else if (r.restart) toast('Restart screen-ink to hear the new voice.', true)
  await refresh()
  return r.ok
}

// ---- Setup

interface Check {
  ok: boolean
  title: string
  text: string
  action?: { label: string; run: () => Promise<unknown> }
}

function checks(v: View): Check[] {
  const mac = v.platform === 'darwin'
  const s = v.status
  const list: Check[] = [
    {
      ok: s.provider.ok,
      title: { 'claude-code': 'Claude Code', 'api-key': 'API key', codex: 'Codex' }[v.settings.provider],
      text: s.provider.text,
      action: { label: 'Check again', run: refresh },
    },
  ]
  if (!mac) return list
  return [
    {
      ok: s.screen === 'granted',
      title: 'Screen Recording',
      text: s.screen === 'granted' ? 'screen-ink can see the screen when you ask.' : 'Needed to see what you ask about. macOS may ask you to restart screen-ink after.',
      action: s.screen === 'granted' ? undefined : { label: 'Allow…', run: () => bridge.grant('screen') },
    },
    {
      ok: s.accessibility,
      title: 'Accessibility',
      text: s.accessibility
        ? 'Marks land exactly on buttons and menus, and walkthroughs see your clicks.'
        : 'Lets marks land exactly on buttons and menus, buttons type for you, and walkthroughs see your clicks.',
      action: s.accessibility ? undefined : { label: 'Allow…', run: () => bridge.grant('accessibility') },
    },
    {
      ok: s.microphone === 'granted',
      title: 'Microphone',
      text: s.microphone === 'granted' ? 'You can ask out loud.' : 'Optional: to ask out loud instead of typing.',
      action: s.microphone === 'granted' ? undefined : { label: 'Allow…', run: () => bridge.grant('microphone') },
    },
    ...list,
  ]
}

function renderSetup(v: View): void {
  const host = $<HTMLElement>('setup')
  host.replaceChildren(
    ...checks(v).map(c => {
      const row = document.createElement('div')
      row.className = 'row'
      const dot = document.createElement('span')
      dot.className = c.ok ? 'dot ok' : 'dot'
      const what = document.createElement('div')
      what.className = 'what'
      const b = document.createElement('b')
      b.textContent = c.title
      const small = document.createElement('small')
      small.textContent = c.text
      what.append(b, small)
      row.append(dot, what)
      if (c.action) {
        const button = document.createElement('button')
        button.textContent = c.action.label
        button.addEventListener('click', async () => {
          button.disabled = true
          await c.action!.run()
          setTimeout(refresh, 600)
        })
        row.append(button)
      }
      return row
    }),
  )
}

// ---- Who answers

const PROVIDERS: { id: Settings['provider']; title: string; text: string }[] = [
  { id: 'claude-code', title: 'Claude Code', text: 'Your installed Claude Code answers, signed in as it is.' },
  { id: 'api-key', title: 'Claude Code with your API key', text: 'Billed to your Anthropic account instead.' },
  { id: 'codex', title: 'Codex', text: 'Your installed Codex answers, signed in as it is.' },
]

function renderProviders(v: View): void {
  $<HTMLDivElement>('providers').replaceChildren(
    ...PROVIDERS.map(p => {
      const label = document.createElement('label')
      label.className = v.settings.provider === p.id ? 'choice on' : 'choice'
      const radio = document.createElement('input')
      radio.type = 'radio'
      radio.name = 'provider'
      radio.checked = v.settings.provider === p.id
      radio.addEventListener('change', () => void save({ provider: p.id }))
      const words = document.createElement('div')
      const b = document.createElement('b')
      b.textContent = p.title
      const small = document.createElement('small')
      small.textContent = p.text
      words.append(b, small)
      label.append(radio, words)
      return label
    }),
  )
  const codex = v.settings.provider === 'codex'
  $('key-row').classList.toggle('hidden', v.settings.provider !== 'api-key')
  $('key-hint').textContent = v.keyHint ? `Saved (${v.keyHint}), encrypted in your keychain.` : 'Kept encrypted in your keychain.'
  $('model-row').classList.toggle('hidden', codex)
  $('claude-row').classList.toggle('hidden', codex)
  $('codex-row').classList.toggle('hidden', !codex)
  $('codex-model-row').classList.toggle('hidden', !codex)
}

$('key-save').addEventListener('click', async () => {
  const key = $('key').value.trim()
  if (!(await bridge.setKey(key || null))) return toast("That doesn't look like an Anthropic API key.")
  $('key').value = ''
  toast(key ? 'Key saved.' : 'Key removed.')
  await refresh()
})

// ---- Fields that save as they change

const TEXT: (keyof Settings)[] = ['model', 'codexModel', 'claude', 'codex', 'hotkey']
const CHECKS: (keyof Settings)[] = ['speak', 'captions', 'listen', 'sounds', 'memory']
const SELECTS: (keyof Settings)[] = ['effort', 'check', 'voice']

for (const k of TEXT) $(k).addEventListener('change', () => void save({ [k]: $(k).value.trim() }))
for (const k of CHECKS) $(k).addEventListener('change', () => void save({ [k]: $(k).checked }))
for (const k of SELECTS) $(k).addEventListener('change', () => void save({ [k]: $<HTMLSelectElement>(k).value }))
$('ink').addEventListener('change', () => void save({ ink: $('ink').value.toUpperCase() }))
$('web').addEventListener('change', () => {
  const others = view.settings.tools.split(',').map(t => t.trim()).filter(t => t && t !== 'WebSearch')
  void save({ tools: [...($('web').checked ? ['WebSearch'] : []), ...others].join(',') })
})

function renderFields(v: View): void {
  const s = v.settings
  for (const k of TEXT) if (document.activeElement !== $(k)) $(k).value = String(s[k])
  for (const k of CHECKS) $(k).checked = Boolean(s[k])
  const voice = $<HTMLSelectElement>('voice')
  if (![...voice.options].some(o => o.value === s.voice)) voice.add(new Option(s.voice, s.voice))
  for (const k of SELECTS) $<HTMLSelectElement>(k).value = String(s[k])
  $('ink').value = s.ink
  $('web').checked = /\bWebSearch\b/.test(s.tools)
}

// ---- Memory

function renderMemory(v: View): void {
  $<HTMLDivElement>('memories').replaceChildren(
    ...v.memories.map(m => {
      const row = document.createElement('div')
      row.className = 'row'
      const what = document.createElement('div')
      what.className = 'what'
      what.textContent = m.text
      const small = document.createElement('small')
      small.textContent = `Kept ${m.at}`
      what.append(small)
      const forget = document.createElement('button')
      forget.textContent = 'Forget'
      forget.addEventListener('click', async () => {
        await bridge.forget(m.id)
        await refresh()
      })
      row.append(what, forget)
      return row
    }),
  )
  $('forget-row').classList.toggle('hidden', !v.memories.length)
  $('memory-count').textContent = `${v.memories.length} kept`
}

$('forget-all').addEventListener('click', async () => {
  await bridge.forget(null)
  await refresh()
})

// ---- Lessons

function renderLessons(v: View): void {
  $<HTMLDivElement>('lessons').replaceChildren(
    ...v.lessons.map(l => {
      const row = document.createElement('div')
      row.className = 'row'
      const what = document.createElement('div')
      what.className = 'what'
      what.textContent = l.title
      const small = document.createElement('small')
      small.textContent = `Saved ${new Date(l.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
      what.append(small)
      const buttons = (['show', 'delete'] as const).map(act => {
        const b = document.createElement('button')
        b.textContent = act === 'show' ? 'Show' : 'Delete'
        b.addEventListener('click', async () => {
          await bridge.lesson(l.id, act)
          if (act === 'delete') await refresh()
        })
        return b
      })
      row.append(what, ...buttons)
      return row
    }),
  )
  $('lessons-none').classList.toggle('hidden', v.lessons.length > 0)
}

// ---- Connecting, licence, version

$('mcp-copy').addEventListener('click', async () => {
  await bridge.copy(view.mcp.command)
  toast('Copied. Paste it into a terminal.')
})

function renderLicence(l: LicenceState): void {
  const [title, text] =
    l.state === 'licensed'
      ? [`Licensed to ${l.licence.name}`, `${l.licence.email}, ${l.licence.edition} edition, since ${l.licence.issued}.`]
      : l.state === 'invalid'
        ? ["That key isn't valid", 'Check it was pasted whole.']
        : l.state === 'no-public-key'
          ? ['Development build', 'This build has no licence key to check against.']
          : ['Unlicensed', 'Paste the key from your purchase email.']
  $('licence-title').textContent = title
  $('licence-text').textContent = text
}

$('licence-save').addEventListener('click', async () => {
  const state = await bridge.setLicence($('licence').value)
  if (!state) return
  renderLicence(state)
  if (state.state === 'licensed') $('licence').value = ''
})

async function refresh(): Promise<void> {
  view = await bridge.view()
  renderSetup(view)
  renderProviders(view)
  renderFields(view)
  renderLicence(view.licence)
  renderMemory(view)
  renderLessons(view)
  $('mcp-command').textContent = view.mcp.command
  $('version').textContent = `screen-ink ${view.version}`
}

addEventListener('focus', () => void refresh()) // permissions are often granted in System Settings meanwhile
void refresh()
