/** 交互式提示的抽象层：生产用 @inquirer/prompts，测试注入脚本化的实现。 */
export interface PromptChoice<T> {
  name: string
  value: T
  description?: string
  checked?: boolean
}

export interface Prompter {
  input(opts: { message: string; default?: string; validate?: (value: string) => boolean | string }): Promise<string>
  password(opts: { message: string; mask?: boolean }): Promise<string>
  select<T>(opts: { message: string; choices: PromptChoice<T>[]; default?: T }): Promise<T>
  checkbox<T>(opts: { message: string; choices: PromptChoice<T>[]; required?: boolean }): Promise<T[]>
  confirm(opts: { message: string; default?: boolean }): Promise<boolean>
}