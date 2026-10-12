import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import { DICT_NAMES, createDictationConverter, parseDict, type Dict, type DictName } from './convert'

/** Set once the dictionaries are read. Until then, prompts go through unchanged. */
let toTaiwan: ((text: string) => string) | undefined

/** What the mod last wrote into the box, its own conversion or the API's: never converted again, there or on submit. */
let filled = ''

/** True while the API is correcting the box. The timer leaves the box alone meanwhile, so the answer fits the text it was asked about. */
let isCorrecting = false
const correcting = atom({ plugin: 'zh-tw-dictation', key: 'isCorrecting' } as const, false)

/** How often the prompt box is read, and how long it has to sit unchanged before its Simplified is converted. */
const POLL_MS = 250
const SETTLE_MS = 1000

/** How long an API correction may take before the box is left as it was. */
const API_TIMEOUT_MS = 30_000

/**
 * The engine keybinding action whose chord presses the API button from the prompt.
 * A mod can't bind a key itself: the chord is the person's, bound to this action in
 * the Global context of ~/.claude/keybindings.json (bound under Chat, it never reaches
 * the button). Its engine handler only runs inside the diff dialog, so at the prompt
 * the chord reaches the button.
 */
const API_ACTION = 'diff:back'

type Answer = { text: string } | { error: string }

/** Asks Voice Hunter's POST /v1/text/optimize to correct `text`, as its API document describes. */
async function optimize($: EngineInterface, url: string, text: string): Promise<Answer> {
  const key = await $.env.get('VOICE_HUNTER_API_KEY')
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' }
  if (key) headers.authorization = `Bearer ${key}`
  let res
  try {
    res = await $.http.fetch(url, { method: 'POST', headers, body: JSON.stringify({ text, response_format: 'json' }) })
  } catch (err) {
    return { error: `連不上 ${url}：${err instanceof Error ? err.message : String(err)}` }
  }
  let body: any
  try {
    body = JSON.parse(res.text)
  } catch {
    body = undefined
  }
  if (!res.ok) return { error: `${res.status} ${body?.error?.message ?? res.text.slice(0, 200)}` }
  if (typeof body?.text !== 'string') return { error: `回應不是 {"text": ...}：${res.text.slice(0, 200)}` }
  return { text: body.text }
}

/** Resolves with an error after `ms`, unless `cancel` is called first. */
function deadline($: EngineInterface, ms: number) {
  let timer: { cancel: () => void } | undefined
  const answer = new Promise<Answer>(resolve => {
    timer = $.clock.after(ms, () => resolve({ error: `${ms / 1000} 秒內沒有回應` }))
  })
  return { answer, cancel: () => timer?.cancel() }
}

async function setCorrecting($: EngineInterface, value: boolean) {
  isCorrecting = value
  await update($, correcting, () => value)
}

/** Replaces the box with Voice Hunter's correction of it; on any failure the box keeps what it had. */
async function correctWithApi($: EngineInterface, url: string) {
  if (isCorrecting) return
  const { text } = await $.prompt.read()
  if (text.trim() === '') {
    $.ui.toast('輸入框沒有文字可以校正')
    return
  }
  await setCorrecting($, true)
  try {
    const timeout = deadline($, API_TIMEOUT_MS)
    const answer = await Promise.race([optimize($, url, text), timeout.answer])
    timeout.cancel()
    if ('error' in answer) {
      $.ui.toast(`API 校正失敗，保留原文。${answer.error}`)
      return
    }
    // Text added while the API worked would be lost under its answer.
    if ((await $.prompt.read()).text !== text) {
      $.ui.toast('輸入框在校正時有變動，沒有套用 API 結果')
      return
    }
    filled = answer.text
    if (answer.text !== text) await $.prompt.fill({ text: answer.text, mode: 'replace' })
  } finally {
    await setCorrecting($, false)
  }
}

export const register: Register = (on, options) => {
  const useApi = options.useApi === true
  const apiUrl = String(options.apiUrl)

  on('session.start', async ($, e, next) => {
    const dicts = {} as Record<DictName, Dict>
    for (const name of DICT_NAMES) dicts[name] = parseDict(await $.fs.read(`${$.plugin.root}/dict/${name}.txt`))
    const convert = createDictationConverter(dicts)
    toTaiwan = convert
    await setCorrecting($, false)

    // Dictation writes the box without raising any event a hook could take, so the box is
    // read on a timer instead. Waiting until it has stopped changing keeps the conversion
    // out of the way of text still being dictated or typed.
    let seen = ''
    let unchangedMs = 0
    let isBusy = false
    $.clock.every(POLL_MS, async () => {
      if (isBusy || isCorrecting) return
      isBusy = true
      try {
        const { text } = await $.prompt.read()
        unchangedMs = text === seen ? unchangedMs + POLL_MS : 0
        seen = text
        if (unchangedMs < SETTLE_MS || text === filled) return
        const converted = convert(text)
        if (converted === text) return
        filled = converted
        await $.prompt.fill({ text: converted, mode: 'replace' })
      } finally {
        isBusy = false
      }
    })
    return next(e)
  })

  // Only what the user sends from the prompt box, not a peer session's message or a task notification.
  // What the mod put in the box is sent as shown, the API's answer included.
  on('prompt.submit', ($, e, next) => {
    if (!toTaiwan || e.origin.kind !== 'composer' || e.text === filled) return next(e)
    const text = toTaiwan(e.text)
    return next(text === e.text ? e : { ...e, text })
  })

  // Converts dictated text as it lands in the box, when dictation edits the box this way.
  // A multi-line insert is a paste: it's left to prompt.submit, which keeps code as written.
  on('prompt.edit', ($, e, next) => {
    if (!toTaiwan || e.inputText.includes('\n')) return next(e)
    const inputText = toTaiwan(e.inputText)
    return next(inputText === e.inputText ? e : { ...e, inputText })
  })

  // The API runs only when the person asks: this button, or the chord bound to API_ACTION.
  // Enter and the settle timer never call it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!useApi || e.props.hasSurvey) return next(e)
    const { Box, Button } = $.ui.resolve(e)
    const isBusy = await read($, correcting)
    return (
      <Box>
        <Button
          key="api"
          label={isBusy ? 'API 校正中…' : 'API 校正'}
          action={API_ACTION}
          dimColor
          onPress={() => correctWithApi($, apiUrl)}
        />
      </Box>
    )
  })
}
