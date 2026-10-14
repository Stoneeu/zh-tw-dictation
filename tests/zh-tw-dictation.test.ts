import { expect, mock, test } from 'claude-code/testing'

/**
 * A few real entries from each of OpenCC's dictionaries, enough for these
 * prompts. That the full dictionaries convert as OpenCC does is checked
 * against OpenCC itself, outside these tests.
 */
const DICTS: Record<string, string> = {
  CJK_Compatibility_Ideographs: '',
  STPhrases: '干扰\t干擾\n',
  STPhrases_GeneratedFromRegionalPhrases: '',
  STCharacters: '这\t這\n个\t個\n软\t軟\n扰\t擾\n干\t幹 乾 干\n后\t後 后\n台\t臺 檯 颱 台\n群\t羣\n',
  TWPhrases: '軟件\t軟體\n',
  TWVariantsPhrases: '',
  TWVariants: '裏\t裡\n羣\t群\n',
}

/**
 * Answers the mod's dictionary reads, and its read of the files in `files` by path, then starts
 * the session, which loads them. Time moves only when the test moves it.
 *
 * The engine hands the hook an absolute path for this platform (`C:\home\me\...` on Windows),
 * so a file is matched by the end of its path, with `/` for separators.
 */
async function start($: any, on: any, env: Record<string, string> = {}, files: Record<string, string> = {}) {
  const clock = mock.clock(on)
  mock.env(on, env)
  on('fs.read', async (_$: any, e: any) => {
    const path = e.path.replaceAll('\\', '/')
    const file = Object.keys(files).find(name => path.endsWith(name))
    if (file !== undefined) return { value: files[file] }
    if (/keybindings\.json$/.test(e.path)) throw new Error(`ENOENT: no such file or directory, open '${e.path}'`)
    const name = /[\\/]dict[\\/](\w+)\.txt$/.exec(e.path)?.[1]
    if (name === undefined || !(name in DICTS)) throw new Error(`unexpected read: ${e.path}`)
    return { value: DICTS[name] }
  })
  on('session.start', async (_$: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  return clock
}

/** Stands for the prompt box: dictation writes `box.text` directly, and the mod reads and fills it. */
function promptBox(on: any) {
  const box = { text: '', fills: [] as string[] }
  on('prompt.read', async () => ({ value: { text: box.text, cursor: box.text.length } }))
  on('prompt.fill', async (_$: any, e: any) => {
    box.fills.push(e.text)
    box.text = e.text
    return { isFilled: true }
  })
  return box
}

/** Sends `text` the way the user would, and returns what reached Claude. */
async function submit($: any, on: any, text: string, origin: { kind: string } = { kind: 'composer' }) {
  on('prompt.submit', async (_$: any, e: any) => ({ text: e.text }))
  await start($, on)
  return (await $.prompt.submit({ text, wait: false, origin })).text
}

test('dictated Simplified reaches Claude in Traditional with Taiwan phrasing', async ($, on) => {
  // 软件 becomes 軟體, the Taiwan word, not just 軟件 with the characters swapped.
  expect(await submit($, on, '这个软件在后面')).toBe('這個軟體在後面')
})

test('Traditional the user typed is sent exactly as typed', async ($, on) => {
  // s2twp alone would rewrite this to 這個幹擾在臺灣.
  expect(await submit($, on, '這個干擾在台灣')).toBe('這個干擾在台灣')
})

test('a typed prompt with no character only Simplified uses is never converted', async ($, on) => {
  // No character here says Traditional either, and s2twp would send 我在臺北.
  expect(await submit($, on, '我在台北')).toBe('我在台北')
})

test("a character OpenCC itself writes for Taiwan isn't taken for Simplified", async ($, on) => {
  // OpenCC maps 群 to 羣 and then back to 群 for Taiwan. Read as Simplified, 群 would
  // open this prompt to conversion, and 台北 would go out as 臺北.
  expect(await submit($, on, '台北一群人')).toBe('台北一群人')
})

test('in a prompt that mixes the two, only the Simplified clause changes', async ($, on) => {
  expect(await submit($, on, '這個干擾很大，那个软件也是')).toBe('這個干擾很大，那個軟體也是')
})

test('code in a prompt is kept as written', async ($, on) => {
  // A string being discussed has to match the file it came from.
  const code = '`软件` 改掉，这个软件\n```\nconst name = "软件"\n```'
  expect(await submit($, on, code)).toBe('`软件` 改掉，這個軟體\n```\nconst name = "软件"\n```')
})

test("another session's message is not the user's dictation and passes unchanged", async ($, on) => {
  expect(await submit($, on, '这个软件', { kind: 'peer' })).toBe('这个软件')
})

test('text dictated into the box converts as it lands, and a pasted block is left for submit', async ($, on) => {
  // Stands for the editor: applies the splice the way core does.
  on('prompt.edit', async (_$: any, e: any) => {
    const text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
    return { text, cursor: e.start + e.inputText.length }
  })
  await start($, on)
  // The kit's types list only the $.prompt methods, but the test's engine raises
  // prompt.edit too, through the mod's hook.
  const insert = (inputText: string) =>
    ($.prompt as any).edit({ origin: { kind: 'composer' }, text: '請看', cursor: 2, start: 2, end: 2, inputText })

  expect(await insert('后面这个软件')).toEqual({ text: '請看後面這個軟體', cursor: 8 })
  expect((await insert('第一行\n这个软件')).text).toBe('請看第一行\n这个软件')
})

test('dictated text left in the box turns Traditional there once it has sat for a second', async ($, on) => {
  // Dictation writes the box without an event, so this is the only way it changes before Enter.
  const box = promptBox(on)
  const clock = await start($, on)
  box.text = '这个软件'

  await clock.advance(750)
  expect(box.fills).toEqual([])
  await clock.advance(750)
  expect(box.fills).toEqual(['這個軟體'])
  // Converted once: its own output isn't written again on every tick.
  await clock.advance(5000)
  expect(box.fills).toEqual(['這個軟體'])
})

test('a box that is still changing, or holds only Traditional, is left alone', async ($, on) => {
  const box = promptBox(on)
  const clock = await start($, on)

  // Typed Traditional, sitting for seconds: s2twp would turn it into 這個幹擾在臺灣.
  box.text = '這個干擾在台灣'
  await clock.advance(3000)
  expect(box.fills).toEqual([])

  // Dictation still coming in: rewriting the box now would fight it.
  for (const text of ['这', '这个', '这个软', '这个软件']) {
    box.text = text
    await clock.advance(500)
  }
  expect(box.fills).toEqual([])
  await clock.advance(1250)
  expect(box.fills).toEqual(['這個軟體'])
})

const API_URL = 'http://voice-hunter.test:8766/v1/text/optimize'

/** The API is off until the person turns it on in /config. */
const API_ON = { options: { useApi: true } }

const BAND = {
  plugin: 'zh-tw-dictation',
  surface: 'terminal',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

/** Stands for Voice Hunter: records each request and answers with what `reply` gives for it. */
function voiceHunter(on: any, reply: (text: string) => unknown) {
  const requests: { url: string; init: any }[] = []
  on('http.fetch', async (_$: any, e: any) => {
    requests.push({ url: e.url, init: e.init })
    return { value: await reply(JSON.parse(e.init.body).text) }
  })
  return requests
}

const answer = (text: string) => ({ status: 200, ok: true, headers: { 'content-type': 'application/json' }, text: JSON.stringify({ text }) })

/** Collects what the mod tells the person. */
function toasts(on: any) {
  const shown: string[] = []
  on('ui.toast', async (_$: any, e: any) => {
    shown.push(e.text)
    return { value: undefined }
  })
  return shown
}

test('until the person turns the API on there is no button, so nothing reaches a service they never chose', async ($, on) => {
  // Stands for the engine's own band, which draws nothing here.
  on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }))
  await start($, on)
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ key: 'api' })).toBeUndefined()
})

/** The person's keybindings.json: the API chord under Global, where it reaches the button, and one under Chat, where it doesn't. */
const KEYBINDINGS = JSON.stringify({
  bindings: [
    { context: 'Chat', bindings: { 'ctrl+k': 'diff:back' } },
    { context: 'Global', bindings: { 'ctrl+t': 'app:toggleTodos', 'alt+j': 'diff:back' } },
  ],
})

test('the chord the person bound shows beside the button, so they need not open keybindings.json to recall it', API_ON, async ($, on) => {
  await start($, on, { HOME: '/home/me' }, { '/home/me/.claude/keybindings.json': KEYBINDINGS })
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ key: 'api' })).toBeDefined()
  // ctrl+k is bound under Chat, where it never reaches the button: showing it would name a key that does nothing.
  expect((await ui.findAll({ type: 'Text' })).map(text => text.text)).toEqual(['alt+j'])
})

test("keybindings.json is read where CLAUDE_CONFIG_DIR moves Claude Code's config, as Claude Code reads it", API_ON, async ($, on) => {
  await start($, on, { HOME: '/home/me', CLAUDE_CONFIG_DIR: '/srv/claude' }, { '/srv/claude/keybindings.json': KEYBINDINGS })
  expect((await (await $.ui.mount(BAND)).find({ type: 'Text' }))?.text).toBe('alt+j')
})

test('with no chord bound, nothing beside the button promises a shortcut', API_ON, async ($, on) => {
  await start($, on, { HOME: '/home/me' })
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ key: 'api' })).toBeDefined()
  expect(await ui.findAll({ type: 'Text' })).toEqual([])
})

test("pressing API 校正 sends the box to the configured URL and leaves Voice Hunter's answer as it came", { options: { useApi: true, apiUrl: API_URL } }, async ($, on) => {
  const box = promptBox(on)
  // 个 is still Simplified: the timer or Enter converting it would mean the person sends something other than the answer they saw.
  const requests = voiceHunter(on, () => answer('那个軟體'))
  on('prompt.submit', async (_$: any, e: any) => ({ text: e.text }))
  const clock = await start($, on)
  box.text = '这个软件'

  await (await $.ui.mount(BAND)).press({ key: 'api' })
  expect(requests).toHaveLength(1)
  expect(requests[0]!.url).toBe(API_URL)
  expect(requests[0]!.init.method).toBe('POST')
  expect(requests[0]!.init.headers['content-type']).toBe('application/json; charset=utf-8')
  expect(requests[0]!.init.headers.authorization).toBeUndefined()
  // The endpoint refuses unknown fields such as model or prompt.
  expect(JSON.parse(requests[0]!.init.body)).toEqual({ text: '这个软件', response_format: 'json' })
  expect(box.fills).toEqual(['那个軟體'])

  await clock.advance(5000)
  expect(box.fills).toEqual(['那个軟體'])
  expect((await $.prompt.submit({ text: box.text, wait: false, origin: { kind: 'composer' } })).text).toBe('那个軟體')
})

test('a key set in VOICE_HUNTER_API_KEY goes as a Bearer token, for a service that requires one', API_ON, async ($, on) => {
  const box = promptBox(on)
  const requests = voiceHunter(on, text => answer(text))
  await start($, on, { VOICE_HUNTER_API_KEY: 'secret' })
  box.text = '这个软件'

  await (await $.ui.mount(BAND)).press({ key: 'api' })
  expect(requests[0]!.init.headers.authorization).toBe('Bearer secret')
})

test('when the API fails, the box keeps what it had and the person is told why', API_ON, async ($, on) => {
  const box = promptBox(on)
  const shown = toasts(on)
  let isDown = false
  voiceHunter(on, () => {
    if (isDown) throw new Error('connection refused')
    return { status: 502, ok: false, headers: {}, text: JSON.stringify({ error: { message: 'AI 校正失敗', type: 'api_error', param: null, code: '502' } }) }
  })
  await start($, on)
  const ui = await $.ui.mount(BAND)
  box.text = '这个软件'

  await ui.press({ key: 'api' })
  isDown = true
  await ui.press({ key: 'api' })
  expect(box.fills).toEqual([])
  expect(shown).toHaveLength(2)
  expect(shown[0]).toContain('保留原文')
  expect(shown[0]).toContain('502 AI 校正失敗')
  // A request that never got an answer names the URL, the first thing to check:
  // left unset, it is the address Voice Hunter's API document gives.
  expect(shown[1]).toContain('保留原文')
  expect(shown[1]).toContain('連不上 http://127.0.0.1:8765/v1/text/optimize')
})

test('text added to the box while the API works is not overwritten by its answer', API_ON, async ($, on) => {
  const box = promptBox(on)
  const shown = toasts(on)
  voiceHunter(on, text => {
    box.text = '这个软件，还有'
    return answer(text)
  })
  await start($, on)
  box.text = '这个软件'

  await (await $.ui.mount(BAND)).press({ key: 'api' })
  expect(box.fills).toEqual([])
  expect(shown).toEqual(['輸入框在校正時有變動，沒有套用 API 結果'])
})

test('the timer leaves the box to the API while it works, and an API that never answers gives up after 30 seconds', API_ON, async ($, on) => {
  const box = promptBox(on)
  const shown = toasts(on)
  const late: ((value: unknown) => void)[] = []
  voiceHunter(on, () => new Promise(resolve => late.push(resolve)))
  const clock = await start($, on)
  const ui = await $.ui.mount(BAND)
  box.text = '这个软件'

  const pressed = ui.press({ key: 'api' })
  // Left alone, the timer would convert this after a second.
  await clock.advance(29_000)
  expect(box.fills).toEqual([])
  expect(shown).toEqual([])
  await clock.advance(1000)
  late[0]!(answer('來得太晚'))
  await pressed
  expect(shown).toEqual(['API 校正失敗，保留原文。30 秒內沒有回應'])
  expect(box.fills).toEqual([])

  // Once the API is done, the timer goes back to converting the box.
  await clock.advance(1250)
  expect(box.fills).toEqual(['這個軟體'])
})

test('an empty box is not sent', API_ON, async ($, on) => {
  promptBox(on)
  const shown = toasts(on)
  const requests = voiceHunter(on, text => answer(text))
  await start($, on)

  await (await $.ui.mount(BAND)).press({ key: 'api' })
  expect(requests).toEqual([])
  expect(shown).toEqual(['輸入框沒有文字可以校正'])
})
