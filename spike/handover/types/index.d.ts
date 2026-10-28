export type Band = { floor: string | null; last: string }

declare module 'claude-code' {
  interface PluginState {
    'handover-spike': { band: Band }
  }
}
