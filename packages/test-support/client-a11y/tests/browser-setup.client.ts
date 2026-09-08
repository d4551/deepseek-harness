import { Context } from '@deepseek-ai/cordis'
import { afterAll, beforeAll } from 'vitest'
import { installThemeStyles } from '../../../client/ui-theme/src/client/styles.ts'
import './browser-page.css'

const context = new Context()

beforeAll(() => {
  installThemeStyles(context)
})

afterAll(async () => {
  await context.fiber.dispose()
})
