import welcomeText from './assets/welcomeText.txt?raw'

/**
 * The greetings shipped with the app. Settings stores an override list; when it
 * is empty these are used, so "Reset to defaults" in the editor is just
 * clearing the stored value rather than re-seeding it.
 */
export const DEFAULT_WELCOME_LINES: string[] = welcomeText
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)

export const WELCOME_NAME_TOKEN = '[user first name]'

export function renderWelcomeLine(line: string, firstName: string): string {
  return line.replace(/\[user first name\]/gi, firstName)
}
