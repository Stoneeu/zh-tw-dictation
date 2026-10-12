/** Whether the API is correcting the prompt box; the band's button reads it. */
export type IsCorrecting = boolean

declare module 'claude-code' {
  interface PluginState {
    'zh-tw-dictation': { isCorrecting: IsCorrecting }
  }
}
