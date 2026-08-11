import { migrateBuiltInAiGreetingPrompt } from './defaults'

export function migrateLegacyUserPrompt(value: unknown, fallback: string) {
  if (typeof value !== 'string' || value.trim() === '') return fallback

  // V1 stores writing preferences only. Legacy complete templates included runtime placeholders.
  return /\{\{\s*[A-Za-z_$]/.test(value) ? fallback : value
}

export function migrateAiGreetingUserPrompt(value: unknown, fallback: string) {
  return migrateBuiltInAiGreetingPrompt(migrateLegacyUserPrompt(value, fallback))
}
