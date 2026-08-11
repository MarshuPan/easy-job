import { AgentMessage } from '@/ui/instrument'

import { safeStringify } from './safeJson'

export function exportJson(data: object, name: string) {
  const blob = new Blob([safeStringify(data)], {
    type: 'application/json',
  })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `${name}.json`
  link.click()
}

export async function importJson<T = any>(): Promise<T> {
  const fileInput = document.createElement('input')
  fileInput.type = 'file'
  return new Promise((resolve) => {
    fileInput.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file || !file.name.endsWith('.json')) {
        AgentMessage.warning('请选择 JSON 配置文件')
        return
      }

      const reader = new FileReader()
      reader.onload = async function (e) {
        try {
          const jsonData: T = JSON.parse(e.target!.result as string)

          const type = Object.prototype.toString.call(jsonData).slice(8, -1)
          if (!['Array', 'Object'].includes(type)) {
            AgentMessage.error('导入失败，请检查配置文件')
            return
          }
          resolve(jsonData)
        } catch {
          AgentMessage.error('导入失败，请检查配置文件')
          return
        }
      }
      reader.readAsText(file)
    })

    fileInput.click()
  })
}
