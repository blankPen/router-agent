export class RuntimePluginError extends Error {
  constructor(
    readonly code: 'plugin:invalid' | 'plugin:not-found' | 'plugin:load-failed',
    message: string,
  ) {
    super(message)
    this.name = 'RuntimePluginError'
  }
}
