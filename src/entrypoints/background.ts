import { defineBackground } from '#imports'
import { ProvideBackgroundAdapter, provideBackgroundCounter } from '@/message/background'

export default defineBackground({
  // type: 'module',
  main() {
    provideBackgroundCounter(new ProvideBackgroundAdapter())
  },
})
