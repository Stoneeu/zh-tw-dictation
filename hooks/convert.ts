/**
 * OpenCC's s2twp (Simplified to Traditional, Taiwan standard with Taiwan
 * phrases), run from OpenCC 1.4.2's own dictionaries the way its
 * data/config/s2twp.json does: normalize compatibility ideographs, segment by
 * the longest phrase, then put each segment through two conversion steps.
 */

export const DICT_NAMES = [
  'CJK_Compatibility_Ideographs',
  'STPhrases',
  'STPhrases_GeneratedFromRegionalPhrases',
  'STCharacters',
  'TWPhrases',
  'TWVariantsPhrases',
  'TWVariants',
] as const

export type DictName = (typeof DICT_NAMES)[number]

/** One OpenCC text dictionary. Each line is `key<TAB>value [value...]`, and the first value is the one used. */
export type Dict = { entries: Map<string, [string, ...string[]]>; maxLength: number }

export function parseDict(text: string): Dict {
  const entries: Dict['entries'] = new Map()
  let maxLength = 0
  for (const line of text.split('\n')) {
    const [key, values] = line.trimEnd().split('\t')
    const [first, ...rest] = values?.split(' ') ?? []
    if (!key || !first || key.startsWith('#')) continue
    entries.set(key, [first, ...rest])
    maxLength = Math.max(maxLength, Array.from(key).length)
  }
  return { entries, maxLength }
}

type Match = { length: number; value: string }
type Matcher = (chars: string[], at: number) => Match | undefined

/** The longest key of `dict` that starts at `at`. */
const longest =
  (dict: Dict): Matcher =>
  (chars, at) => {
    for (let n = Math.min(dict.maxLength, chars.length - at); n > 0; n--) {
      const values = dict.entries.get(chars.slice(at, at + n).join(''))
      if (values) return { length: n, value: values[0] }
    }
  }

/** OpenCC's `union` group: the longest match any of them has, the earlier one on a tie. */
const union =
  (...matchers: Matcher[]): Matcher =>
  (chars, at) => {
    let best: Match | undefined
    for (const match of matchers) {
      const found = match(chars, at)
      if (found && (!best || found.length > best.length)) best = found
    }
    return best
  }

/** OpenCC's `short_circuit` group: the first one with any match decides. */
const firstOf =
  (...matchers: Matcher[]): Matcher =>
  (chars, at) => {
    for (const match of matchers) {
      const found = match(chars, at)
      if (found) return found
    }
  }

function convert(match: Matcher, chars: string[]): string {
  let out = ''
  for (let at = 0; at < chars.length; ) {
    const found = match(chars, at)
    out += found ? found.value : chars[at]
    at += found ? found.length : 1
  }
  return out
}

/** OpenCC's mmseg: each phrase it finds is a segment, and the characters between two phrases are one more. */
function segment(match: Matcher, chars: string[]): string[][] {
  const segments: string[][] = []
  let between: string[] = []
  for (let at = 0; at < chars.length; ) {
    const found = match(chars, at)
    if (!found) {
      between.push(chars[at++]!)
      continue
    }
    if (between.length) segments.push(between)
    between = []
    segments.push(chars.slice(at, at + found.length))
    at += found.length
  }
  if (between.length) segments.push(between)
  return segments
}

export function createS2twp(dicts: Record<DictName, Dict>): (text: string) => string {
  const normalize = longest(dicts.CJK_Compatibility_Ideographs)
  const phrases = union(longest(dicts.STPhrases), longest(dicts.STPhrases_GeneratedFromRegionalPhrases))
  const toTraditional = firstOf(phrases, longest(dicts.STCharacters))
  const toTaiwan = firstOf(longest(dicts.TWPhrases), longest(dicts.TWVariantsPhrases), longest(dicts.TWVariants))

  return text =>
    segment(phrases, Array.from(convert(normalize, Array.from(text))))
      .map(part => convert(toTaiwan, Array.from(convert(toTraditional, part))))
      .join('')
}

/** Code is quoted as written: a fenced block or an inline span. */
const CODE = /(```[\s\S]*?```|`[^`\n]*`)/
/** A clause: everything between whitespace and punctuation. No dictionary key spans either. */
const CLAUSE = /[^\s，。！？；：、「」『』（）《》〈〉【】…—,.!?;:()[\]{}<>"'`]+/gu

/**
 * Converts the Simplified Chinese in a prompt and leaves Traditional as it is.
 *
 * s2twp assumes Simplified input. Given Traditional, it rewrites valid text
 * (干擾 → 幹擾, 台灣 → 臺灣), so a prompt with no character only Simplified
 * uses is left alone, and so is text it has converted already. Otherwise each clause converts unless it has a character
 * only Traditional uses and none only Simplified uses, so Traditional typed
 * beside dictated Simplified stays as typed. Code is never touched.
 */
export function createDictationConverter(dicts: Record<DictName, Dict>): (text: string) => string {
  const s2twp = createS2twp(dicts)
  // Every character a conversion can write. Some are ones OpenCC also converts, such as
  // 群 (Taiwan's form of 羣) and 虱 (虱目魚), and counting those as Simplified would
  // convert typed Traditional, and text this mod already converted, a second time.
  const written = new Set<string>()
  for (const name of DICT_NAMES) {
    if (name === 'CJK_Compatibility_Ideographs') continue
    for (const values of dicts[name].entries.values()) for (const value of values) for (const char of value) written.add(char)
  }
  const simplifiedOnly = new Set<string>()
  const traditional = new Set<string>()
  for (const [key, values] of dicts.STCharacters.entries) {
    if (!values.includes(key) && !written.has(key)) simplifiedOnly.add(key)
    for (const value of values) traditional.add(value)
  }
  for (const values of dicts.TWVariants.entries.values()) for (const value of values) traditional.add(value)
  const traditionalOnly = new Set([...traditional].filter(char => !dicts.STCharacters.entries.has(char)))

  const has = (set: Set<string>, text: string) => Array.from(text).some(char => set.has(char))

  return text => {
    const parts = text.split(CODE)
    // split() puts the code it matched at the odd indexes.
    const prose = parts.filter((_, i) => i % 2 === 0)
    if (!prose.some(part => has(simplifiedOnly, part))) return text
    return parts
      .map((part, i) =>
        i % 2 === 1
          ? part
          : part.replace(CLAUSE, clause =>
              has(traditionalOnly, clause) && !has(simplifiedOnly, clause) ? clause : s2twp(clause),
            ),
      )
      .join('')
  }
}
