export function defineUnlistedScript<T extends () => unknown>(entrypoint: T) {
  return entrypoint
}

export function defineContentScript<T>(definition: T) {
  return definition
}

export async function injectScript() {
  const script = document.createElement('script')
  document.documentElement.append(script)
  return { script }
}
