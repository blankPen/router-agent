export interface PublishResultInput {
  stdout: string
  stderr: string
  exitCode: number
  expectedName: string
  expectedVersion: string
}

export interface PublishResult {
  ok: boolean
  code: string | null
  message: string
  id: string | null
  name: string | null
  version: string | null
  staged: boolean
}

export function parsePublishJson(raw: string): unknown
export function evaluatePublishResult(input: PublishResultInput): PublishResult
